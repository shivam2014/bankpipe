#!/usr/bin/env node
// One plan per resolved account, measured before and after. Synthetic only:
// every name, ISIN and number here is invented. Run from the repo root.
//
// Before, the inbox grouped by report family, so a CAS and a broker report for
// one demat were two bundles with two previews and two confirmations. After, the
// files resolve first and the plans group by the account they landed on.
//
// The write model calls the same planners the page calls: casReplacePlan for a
// CAS target, planMerge plus mergeRowsFromPlan for a broker file. Nothing here
// writes to a database.

import assert from "node:assert/strict";
import { accountFieldState, accountMatches, groupBundles, groupResolvedPlans,
  mergeRowsFromPlan, planImportChains, planMerge } from "../web/import-flow.js";
import { casReplacePlan } from "../web/cas-apply.js";

const BO = "IN99990001344321";
const FOLIO = "91062983856";
const TODAY = "2026-11-15";
const CAS_AS_OF = "2026-10-31";
const MOTILAL_AS_OF = "2026-11-05";
const ZERODHA_AS_OF = "2026-11-12";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const baseAccount = {
  id: "demat-1", label: "Demat · Test DP · …4321", category: "demat",
  subtype: "equity", number: BO,
  meta: JSON.stringify({ ucid: "TEST0001", client_id: "TEST500" }),
};

const casRows = [1, 2, 3, 4].map((n) => ({
  isin: isin(n), label: `9.00% TEST BOND ${n} 31 Dec 2028`, category: "bond", kind: "bond",
  quantity: 10 * n, valuePaise: 100000 * n, costPaise: null, purchaseDate: "",
}));
const motilalRows = [1, 2, 3, 4].map((n) => ({
  isin: isin(n), label: `9.00% TEST BOND ${n} 31 Dec 2028`, category: "bond",
  quantity: 10 * n, valuePaise: null, costPaise: 200000 * n, purchaseDate: "2024-06-06",
}));
const zerodhaRows = [5, 6, 7, 8].map((n) => ({
  isin: isin(n), label: `TESTSTOCK${n}`, category: "equity", quantity: n,
  valuePaise: null, costPaise: 50000 * n, purchaseDate: "",
}));

const casFile = {
  kind: "cas", name: "cas.pdf", asOf: CAS_AS_OF, accountKey: BO, accountKind: "bo",
  rows: casRows, entryId: "cas",
  parsed: {
    depository: "CDSL", demat: BO, asOf: CAS_AS_OF, counts: { quarantined: 0 },
    printedTotalPaise: null, transactions: [],
    accounts: [{ boId: BO, dpName: "Test DP", holdings: casRows }],
    holdings: casRows,
  },
  accounts: [{ boId: BO, dpName: "Test DP", rows: casRows }],
};
const motilalFile = { kind: "motilal", name: "motilal.pdf", asOf: MOTILAL_AS_OF,
  accountKey: "TEST0001", accountKind: "ucid", rows: motilalRows, entryId: "motilal" };
const zerodhaFile = { kind: "zerodha-holdings", name: "holdings.xlsx", asOf: ZERODHA_AS_OF,
  accountKey: "TEST500", accountKind: "client", rows: zerodhaRows, entryId: "zerodha" };

function makeStore() {
  let meta = JSON.parse(baseAccount.meta);
  let holdings = [];
  const writes = [];
  const account = () => ({ ...baseAccount, meta: JSON.stringify(meta) });
  return {
    account,
    holdings: () => holdings.map((row) => ({ ...row })),
    fieldState: () => ({ ...accountFieldState(account(), holdings), holdings }),
    replace: (rows, asOf) => {
      holdings = rows.map((row) => ({ ...row }));
      writes.push({ rows: holdings.length, asOf });
      return holdings;
    },
    keepFieldState: (state) => {
      meta = { ...meta, ...(state.identity.source
        ? { identity_source: state.identity.source,
          identity_as_of: state.identity.asOf || "" } : {}),
      ...(state.snapshot.source
        ? { holdings_source: state.snapshot.source,
          holdings_as_of: state.snapshot.asOf || "" } : {}),
      cost_source: state.cost.source || "",
      cost_as_of: state.cost.asOf || "" };
    },
    writes: () => writes.slice(),
    clearWrites: () => { writes.length = 0; },
  };
}

function labelOf(bundle) {
  return bundle.family === "cas" ? "CDSL CAS"
    : bundle.family === "motilal" ? "Motilal Oswal holdings report"
      : "Zerodha holdings";
}

// The page's two writers, modelled with the same planners and the same order.
function writeCas(store, bundle, target) {
  if (target.plan?.identityOnly && !target.plan.summary.updated
    && !target.plan.summary.history) return null;
  const existing = store.holdings();
  const plan = casReplacePlan({ parsed: bundle.parsed, existing,
    holdings: target.rawRows || existing, asOf: bundle.asOf, events: [],
    assetId: target.targetId, accounts: [target.boId], route: true });
  assert.equal(plan.ok, true, "the CAS planner refuses an unsafe statement");
  store.replace(plan.rows, bundle.asOf);
  store.keepFieldState({ identity: { source: "cas", asOf: bundle.asOf },
    snapshot: { source: "cas", asOf: bundle.asOf },
    cost: store.fieldState().cost });
  return { family: "cas", rows: plan.rows };
}

function writeBroker(store, bundle) {
  const state = store.fieldState();
  const plan = planMerge({
    incoming: { kind: bundle.family, label: labelOf(bundle), asOf: bundle.asOf,
      identity: bundle.accountKey
        ? { kind: bundle.accountKind || "bo", value: bundle.accountKey } : null,
      categories: [...new Set(bundle.rows.map((row) => row.category).filter(Boolean))],
      rows: bundle.rows },
    existing: state,
    today: TODAY,
  });
  const total = plan.summary.added + plan.summary.updated + plan.summary.history;
  if (!total) return null;
  const rows = mergeRowsFromPlan(state.holdings, plan,
    { family: bundle.family, label: labelOf(bundle), asOf: bundle.asOf }, false);
  store.replace(rows, bundle.asOf);
  store.keepFieldState({
    identity: { source: state.identity.source, asOf: state.identity.asOf },
    snapshot: { source: bundle.family, asOf: bundle.asOf },
    cost: { ...state.cost, source: bundle.family, asOf: bundle.asOf },
  });
  return { family: bundle.family, rows };
}

// --- resolve, then group ----------------------------------------------------

function resolveBundles(account = baseAccount, holdings = []) {
  const replies = [casFile, motilalFile, zerodhaFile];
  const bundles = groupBundles(replies.map((file) => ({ ...file })));
  const pool = [{ ...account, holdings }];
  const state = { ...accountFieldState(account, holdings), holdings };
  for (const bundle of bundles) {
    if (bundle.family === "cas") {
      const casAccounts = bundle.base?.accounts || [{ boId: BO, dpName: "Test DP", rows: casRows }];
      bundle.casTargets = casAccounts.map((entry) => {
        const rows = entry.rows || casRows;
        const match = accountMatches({ accountKey: entry.boId, accountKind: "bo", rows },
          pool, { forCas: true });
        const targetId = match.attachId || "";
        const targetState = targetId ? state
          : { identity: { source: "", asOf: "" }, snapshot: { source: "", asOf: "" },
            cost: { source: "", asOf: "", manual: false }, holdings: [] };
        const plan = planMerge({
          incoming: { kind: "cas", label: labelOf(bundle), asOf: bundle.asOf,
            identity: { kind: "bo", value: entry.boId },
            categories: [...new Set(rows.map((row) => row.category).filter(Boolean))],
            rows },
          existing: targetState, today: TODAY,
        });
        return { boId: entry.boId, dpName: entry.dpName || "", rows, rawRows: rows,
          match, targetId, plan, folio: false };
      });
      bundle.accounts = bundle.casTargets.map((target) => target.targetId).filter(Boolean);
      bundle.plan = bundle.casTargets[0]?.plan;
    } else {
      const match = accountMatches({ accountKey: bundle.accountKey,
        accountKind: bundle.accountKind, rows: bundle.rows }, pool);
      bundle.match = match;
      bundle.targetId = match.attachId || "";
      bundle.accounts = bundle.targetId ? [bundle.targetId] : [];
      bundle.plan = planMerge({
        incoming: { kind: bundle.family, label: labelOf(bundle), asOf: bundle.asOf,
          identity: bundle.accountKey
            ? { kind: bundle.accountKind || "bo", value: bundle.accountKey } : null,
          categories: [...new Set(bundle.rows.map((row) => row.category).filter(Boolean))],
          rows: bundle.rows },
        existing: state, today: TODAY,
      });
    }
  }
  return bundles;
}

function plansOf(bundles) {
  return groupResolvedPlans(bundles.map((bundle) => ({
    key: bundle.key, family: bundle.family, accounts: bundle.accounts || [],
  })));
}

function contributionsOf(bundle, bid) {
  if (bundle.family === "cas") {
    return bundle.casTargets.map((target) => ({
      key: `${bundle.key}:${target.boId}`, bundleKey: bundle.key, family: "cas",
      label: labelOf(bundle), asOf: bundle.asOf, accountKey: target.boId,
      identity: { kind: "bo", value: target.boId }, rows: target.rows,
      plan: target.plan, bundle, target, attributed: false,
    }));
  }
  return [{ key: bundle.key, bundleKey: bundle.key, family: bundle.family,
    label: labelOf(bundle), asOf: bundle.asOf, accountKey: bundle.accountKey || "",
    identity: bundle.accountKey
      ? { kind: bundle.accountKind || "bo", value: bundle.accountKey } : null,
    rows: bundle.rows, bundle, attributed: bid > 0 }];
}

function applySeparate(store, bundles) {
  const calls = [];
  for (const bundle of bundles) {
    const done = bundle.family === "cas"
      ? writeCas(store, bundle, bundle.casTargets[0]) : writeBroker(store, bundle);
    if (done) calls.push(done);
  }
  return calls;
}

function applyMerged(store, bundles, plan) {
  const members = plan.members.map((key) => bundles.find((bundle) => bundle.key === key));
  const contributions = members.flatMap((bundle, index) =>
    contributionsOf(bundle, index));
  const calls = [];
  for (const contribution of contributions) {
    const done = contribution.family === "cas"
      ? writeCas(store, contribution.bundle, contribution.target)
      : writeBroker(store, contribution.bundle);
    if (done) calls.push(done);
  }
  return calls;
}

const pick = (row) => ({
  security_id: row.security_id, quantity: row.quantity, cost_paise: row.cost_paise,
  value_paise: row.value_paise, purchase_date: row.purchase_date, as_of: row.as_of,
  value_source: row.value_source,
});
const stored = (rows) => rows.map(pick)
  .sort((a, b) => String(a.security_id).localeCompare(String(b.security_id)));

// --- the run ----------------------------------------------------------------

const bundles = resolveBundles();
assert.equal(bundles.length, 3, "three files, three family bundles before grouping");
const plans = plansOf(bundles);
assert.equal(plans.length, 1, "one plan for the one resolved account");
assert.equal(plans[0].accounts.length, 1);
console.log("import plan probe · synthetic CAS + Motilal + Zerodha for one demat");
console.log(`resolve  cas ${bundles[0].accounts[0]} · motilal ${bundles[1].accounts[0]}`
  + ` · zerodha ${bundles[2].accounts[0]}`);
console.log(`before   bundles ${bundles.length} · plans ${bundles.length}`
  + ` · previews ${bundles.length} · confirmations ${bundles.length} · write calls 3`);
console.log(`after    bundles ${bundles.length} · plans ${plans.length}`
  + ` · previews ${plans.length} · confirmations ${plans.length} · write calls 3`);

const separateStore = makeStore();
const separateCalls = applySeparate(separateStore, bundles);
const mergedStore = makeStore();
const mergedCalls = applyMerged(mergedStore, bundles, plans[0]);
assert.deepEqual(stored(mergedStore.holdings()), stored(separateStore.holdings()),
  "the merged plan writes the same rows as the separate plans");
assert.equal(mergedCalls.length, separateCalls.length, "one writer call per file");
assert.equal(mergedStore.holdings().length, 8, "eight equities");

// The merged preview is composed in the order the writers run: the CAS target
// first, then each broker against the rows the CAS leaves.
const members = plans[0].members.map((key) =>
  bundles.find((bundle) => bundle.key === key));
const head = members[0];
const chains = head.casTargets.map((target) => ({
  accountId: target.targetId, account: baseAccount, holdings: [],
  contributions: [
    contributionsOf(head, 0).find((item) => item.key.endsWith(`:${target.boId}`)),
    ...members.slice(1).filter((bundle) => bundle.targetId === target.targetId)
      .map((bundle) => contributionsOf(bundle, 1)[0]),
  ],
}));
const preview = planImportChains({ chains, today: TODAY });
assert.equal(preview.summary.added, 8, "the preview adds eight rows");
assert.equal(preview.summary.updated, 4, "four of them have their cost filled");
assert.equal(preview.summary.ask, 0, "the merged plan asks nothing");
assert.equal(preview.chains[0].receipts.length, 3);
console.log(`rows     merged == separate · ${mergedStore.holdings().length} rows`
  + ` · write calls ${mergedCalls.length}`);
console.log(`preview  added ${preview.summary.added} · updated ${preview.summary.updated}`
  + ` · ask ${preview.summary.ask}`);
for (const receipt of preview.chains[0].receipts) {
  console.log(`  ${receipt.label}: added ${receipt.plan.summary.added}`
    + ` · updated ${receipt.plan.summary.updated}`);
}

// The same set again. The CAS is identity-only with nothing to fill, and each
// broker plan has no field left to change, so no writer runs.
// The same set again, planned from the rows and identity the first run left.
// A second confirmation changes no field and runs no writer.
mergedStore.clearWrites();
const againBundles = resolveBundles(mergedStore.account(), mergedStore.holdings());
const againCalls = applySeparate(mergedStore, againBundles);
assert.equal(againCalls.length, 0, "the second import changes nothing");
assert.equal(mergedStore.writes().length, 0, "the second import writes nothing");
assert.deepEqual(stored(mergedStore.holdings()), stored(separateStore.holdings()));
console.log(`second   import · ${againCalls.length} field changes`
  + ` · ${mergedStore.writes().length} write calls`);

// Two files for the same demat is the smallest case the defect names.
const pair = resolveBundles().filter((bundle) => bundle.family !== "zerodha");
const pairPlans = plansOf(pair);
assert.equal(pair.length, 2);
assert.equal(pairPlans.length, 1);
console.log(`pair     CAS + Motilal · bundles ${pair.length} → plans ${pairPlans.length}`);

// A folio the CAS carries is a second account of its own. The broker joins the
// demat only, never the folio.
const folioAccount = { id: "mf-1", label: "Test mutual fund · folio …3856",
  category: "demat", subtype: "mutual fund", number: FOLIO,
  meta: JSON.stringify({ amc: "Test", folios: [FOLIO] }) };
const folioTarget = { boId: `mf:${FOLIO}`, dpName: "Test mutual fund", targetId: "mf-1",
  rows: [], folio: true, folioNo: FOLIO };
const folioBundles = resolveBundles().filter((bundle) => bundle.family !== "zerodha");
folioBundles[0].casTargets.push(folioTarget);
folioBundles[0].accounts = folioBundles[0].casTargets.map((target) => target.targetId)
  .filter(Boolean);
const folioPlans = plansOf(folioBundles);
assert.equal(folioPlans.length, 1);
assert.deepEqual(folioPlans[0].accounts, ["demat-1", "mf-1"]);
const folioContributions = contributionsOf(folioBundles[0], 0);
const motilalContributions = contributionsOf(folioBundles[1], 1);
assert.deepEqual(folioContributions.map((item) => item.accountKey), [BO, `mf:${FOLIO}`]);
assert.equal(motilalContributions[0].accountKey, "TEST0001");
console.log(`folio    plan records ${folioContributions.length}`
  + ` (demat + folio) · broker attaches to the demat only`);
console.log(`accounts ${folioAccount.id} exists, untouched by the broker`);
