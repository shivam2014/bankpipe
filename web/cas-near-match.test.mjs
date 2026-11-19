import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountFieldState, accountMatches, groupBundles, movementAccountGap, planMerge }
  from "./import-flow.js";
import { casClosedRow, casGroupByAsset, casHoldingLabel, casImportHoldings,
  casImportUnits, casManualTargetEvents, casPreviewAccounts, casReplacePlan, casSafety,
  casWritableHoldings, linkedCostPortfolios, planLinkedSales } from "./cas-apply.js";
import { casRoute } from "./cas.js";
import { boId } from "./bo-id.js";
import { folioAdoptionPlan, folioKey, folioTail, isFolioAccount, normalizeFolio }
  from "./folio.js";
import { casSoldLines } from "./sold-view.js";
import { escapeHtml as esc, jsArg } from "./escape.js";
import { createProposal } from "./import-queue.js";

// The inbox planner and its card live in index.html. This reads the page and
// runs its own resolver and card, with the shipped matcher and writers. The
// fixture is synthetic: every name, ISIN, number and amount is invented.

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

const BO = "IN99990001344321";
const BROKER_AS_OF = "2026-10-15";
const CAS_AS_OF = "2026-10-31";
const TODAY = "2026-11-19";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const bondIsins = Array.from({ length: 17 }, (_, at) => isin(101 + at));
const equityIsins = Array.from({ length: 6 }, (_, at) => isin(201 + at));

// The page's own resolver and card, run with its module imports.
function pageHarness(state) {
  const source = [
    between("function shortDp", "window.bpCasFiles"),
    between("function bpImportBundleLabel", "function bpImportBrokerName"),
    between("function bpImportPlanFor(", "function bpImportAggregatePlans"),
    between("function bpImportAggregatePlans", "function bpImportResolveBroker"),
    between("function bpImportDematPlanRows", "function bpImportResolveCas"),
    between("function bpImportResolveCas", "function bpImportPlanFiles"),
    between("function bpImportCasAccountsHtml", "function bpImportFieldLabel"),
    between("function casFolioOfferHtml", "// In-memory only"),
    between("function casEventLines", "function casSaleHtml"),
    between("function bpImportCasRow(", "function bpImportInboxPassword"),
  ].join("\n");
  const page = new Function(
    "accountMatches", "planMerge", "accountFieldState", "bpImportAccountRow",
    "bpImportInboxState", "folioAdoptionPlan", "folioKey", "casClosedRow",
    "casManualTargetEvents", "casWritableHoldings", "casReplacePlan",
    "linkedCostPortfolios", "planLinkedSales", "casPreviewAccounts",
    "movementAccountGap", "casSafety", "isFolioAccount", "normalizeFolio",
    "folioTail", "esc", "jsArg", "money", "casSoldLines", "casHoldingLabel", "boId",
    "createProposal",
    `${source}
     return { bpImportResolveCas, bpImportCasRow, bpImportCasAccountsHtml };`,
  )(accountMatches, planMerge, accountFieldState,
    (id) => (state.accountRows || []).find((row) => row.account.id === id) || null,
    () => state, folioAdoptionPlan, folioKey, casClosedRow, casManualTargetEvents,
    casWritableHoldings, casReplacePlan, linkedCostPortfolios, planLinkedSales,
    casPreviewAccounts, movementAccountGap, casSafety, isFolioAccount,
    normalizeFolio, folioTail, esc, jsArg, money, casSoldLines, casHoldingLabel, boId,
    createProposal);
  return page;
}

const money = (paise) => String(paise);

function fixture() {
  const bonds = bondIsins.map((code, at) => ({
    isin: code, label: `TEST BOND ${at + 1}`, kind: "bond",
    quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "",
    couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
    account: BO, folio: "", amc: "", amcFull: "",
  }));
  const equities = equityIsins.map((code, at) => ({
    isin: code, label: `TEST EQUITY ${at + 1}`, kind: "equity",
    quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "",
    couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
    account: BO, folio: "", amc: "", amcFull: "",
  }));
  const statement = [...bonds, ...equities];
  const parsed = {
    depository: "CDSL", demat: BO, asOf: CAS_AS_OF,
    accounts: [{ boId: BO, dpName: "Test DP", holdings: statement }],
    holdings: statement, transactions: [], counts: { rows: statement.length, quarantined: 0 },
    printedTotalPaise: statement.reduce((sum, row) => sum + row.valuePaise, 0),
  };
  const account = {
    id: "demat-broker", label: "Demat · Test Broker · 9990001", category: "demat",
    subtype: "equity", type: "equity", number: "",
    meta: JSON.stringify({ broker_only: "1", broker_source: "motilal",
      identity_source: "motilal", identity_as_of: BROKER_AS_OF,
      holdings_source: "motilal", holdings_as_of: BROKER_AS_OF, ucid: "9990001" }),
  };
  const holdings = bonds.map((bond) => ({
    security_id: bond.isin, label: bond.label, category: "bond", quantity: 10,
    value_paise: 100000, as_of: BROKER_AS_OF, source: "motilal",
  }));
  return { parsed, statement, account, holdings };
}

function casBundle(page, data) {
  const writable = casWritableHoldings(data.parsed.holdings, TODAY);
  const entry = {
    kind: "cas", name: "cas.pdf", asOf: CAS_AS_OF, accountKey: BO, accountKind: "bo",
    rows: writable.map((row) => page.bpImportCasRow(row)), parsed: data.parsed,
    accounts: data.parsed.accounts.map((account) => ({ boId: account.boId,
      dpName: account.dpName,
      rows: casWritableHoldings(account.holdings, TODAY)
        .map((row) => page.bpImportCasRow(row)) })),
    entryId: "cas-entry",
  };
  const bundle = groupBundles([entry])[0];
  bundle.acceptAsk = false;
  return bundle;
}

test("a near-match CAS asks before it writes, then lands every row in one demat", () => {
  const data = fixture();
  const state = { accountRows: [{ account: data.account, holdings: data.holdings }],
    choices: {}, acceptAsk: {} };
  const page = pageHarness(state);
  const bundle = casBundle(page, data);
  page.bpImportResolveCas(bundle);

  const target = bundle.casTargets[0];
  assert.equal(target.match.matches.length, 1);
  assert.equal(target.match.matches[0].hits, 17);
  assert.equal(target.match.matches[0].of, 23);
  assert.equal(target.match.attachId, "", "17 of 23 is below the shared attach rule");
  assert.equal(target.targetId, "", "an overlap is a candidate, not a target");
  assert.equal(target.needsChoice, true, "the near match is a question");
  assert.equal(bundle.needsChoice, true);
  assert.equal(bundle.ready, false, "Import is disabled until the person chooses");
  assert.equal(bundle.create, false, "creation is not the default beside a candidate");

  const card = page.bpImportCasAccountsHtml(bundle);
  assert.match(card, /ISIN overlap/);
  assert.match(card, /17 of 23/);
  assert.match(card, /__create__/, "the explicit create answer stays available");
  assert.doesNotMatch(card, /import-account-choice on/,
    "neither the candidate nor Create is preselected");

  // The explicit Create answer releases the plan without an account.
  state.choices[`${bundle.key}:${BO}`] = "__create__";
  page.bpImportResolveCas(bundle);
  assert.equal(bundle.casTargets[0].needsChoice, false);
  assert.equal(bundle.ready, true, "an explicit Create is a decision");
  assert.equal(bundle.create, true);

  // Picking the account on file targets it instead of making a second demat.
  state.choices[`${bundle.key}:${BO}`] = data.account.id;
  page.bpImportResolveCas(bundle);
  const chosen = bundle.casTargets[0];
  assert.equal(chosen.targetId, data.account.id);
  assert.equal(chosen.action, "update");
  assert.equal(bundle.ready, true);
  assert.equal(bundle.needsChoice, false);
  assert.equal(chosen.plan.identityChange?.value, BO,
    "the plan attaches the statement's BO ID to the chosen account");
  assert.match(page.bpImportCasAccountsHtml(bundle),
    /Update Demat · Test Broker · 9990001 · 17 of 23 ISINs match/,
    "the card names the chosen account instead of offering a second one");

  // The writer's account patch fills the empty number, then routes and writes.
  // Scope and group with the shipped functions the inbox writer calls.
  const scoped = casImportHoldings({ parsed: data.parsed, targets: bundle.casTargets });
  const cas = { ...data.parsed, accounts: scoped.accounts, holdings: scoped.holdings };
  const assets = [{ ...data.account, number: BO, holdings: data.holdings }];
  const route = casRoute(cas, assets);
  assert.deepEqual(route.accounts.map((account) => account.assetId), [data.account.id],
    "one demat owns the whole statement");
  assert.equal(route.homeless.length, 0, "no row is left without the account");
  const units = casImportUnits({ accounts: assets, routeAccounts: route.accounts,
    groups: route.groups, movements: [] });
  const byAsset = casGroupByAsset({ holdings: cas.holdings, groups: route.groups,
    importDay: TODAY, picked: units });
  assert.deepEqual([...byAsset.keys()], [data.account.id], "the writer creates no second demat");
  assert.equal(byAsset.get(data.account.id).length, 23);
  const write = casReplacePlan({ parsed: cas, existing: data.holdings,
    holdings: byAsset.get(data.account.id), events: [], assetId: data.account.id,
    accounts: [BO], route: true, asOf: CAS_AS_OF, confirmed: true });
  assert.equal(write.ok, true);
  assert.equal(write.rows.length, 23, "all 17 existing and 6 new rows survive");
  assert.deepEqual(new Set(write.rows.map((row) => row.security_id)),
    new Set(data.statement.map((row) => row.isin)));
  // The same statement again attaches by the BO ID the choice left behind.
  const again = accountMatches({ accountKey: BO, accountKind: "bo",
    rows: data.statement }, [{ ...assets[0], holdings: write.rows }], { forCas: true });
  assert.equal(again.attachId, data.account.id, "the re-import needs no second choice");
});

test("a tie and a near match are the same question", () => {
  const data = fixture();
  const twin = { ...data.account, id: "demat-twin", label: "Demat · Test Twin · 8880002",
    meta: JSON.stringify({ broker_only: "1", broker_source: "zerodha",
      identity_source: "zerodha", holdings_source: "zerodha", client_id: "8880002" }) };
  const state = { accountRows: [{ account: data.account, holdings: data.holdings },
    { account: twin, holdings: data.holdings }], choices: {}, acceptAsk: {} };
  const page = pageHarness(state);
  const bundle = casBundle(page, data);
  page.bpImportResolveCas(bundle);

  const target = bundle.casTargets[0];
  assert.equal(target.match.tie, true);
  assert.equal(target.match.matches.length, 2);
  assert.equal(target.needsChoice, true, "a tie is not a reason to create either");
  assert.equal(bundle.create, false);
  assert.equal(bundle.ready, false);
  assert.doesNotMatch(page.bpImportCasAccountsHtml(bundle), /import-account-choice on/,
    "the tie leaves both accounts and Create unselected");

  state.choices[`${bundle.key}:${BO}`] = "__create__";
  page.bpImportResolveCas(bundle);
  assert.equal(bundle.ready, true, "the same explicit Create answer releases a tie");
});

test("the chosen account is written through the existing number column", () => {
  const apply = between("async function bpImportApplyCas", "function bpImportPlanBlockedReceipt");
  assert.match(apply,
    /if \(!String\(account\.number \|\| ""\)\.trim\(\) && target\.boId[\s\S]*?patch\.number = target\.boId/,
    "a chosen account with no number takes the statement's BO ID");
});

test("the card names the choice while Import waits", () => {
  const card = between("function bpImportPlanHtml", "function bpImportPlanMissing");
  assert.match(card, /: plan\.needsChoice \? "Choose an account"/,
    "the disabled primary says what to do, not what a create would write");
});
