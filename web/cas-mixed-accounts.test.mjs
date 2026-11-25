import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountFieldState, accountMatches, groupBundles, movementAccountGap,
  planMerge } from "./import-flow.js";
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

// A statement can name four demats where one is already on file. The one on
// file attaches; the other three are new and each is created. One press writes
// all four. The card says the split before the press, and a genuine candidate
// still stops it. The page's own resolver and card run over a synthetic
// statement; every name, ISIN and number here is invented.

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

const AS_OF = "2026-10-31";
const TODAY = "2026-11-19";
const EXISTING_BO = "IN99990001344321";
const NEW_BOS = ["9999000012345678", "9999000098765432", "9999000043218765"];
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

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
  return new Function(
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
}

// planMerge is only called by the plan builder the page already ships. The
// harness takes it as a dependency so the resolver runs unchanged.
const money = (paise) => String(paise);

const holding = (n, bo, over = {}) => ({
  isin: isin(n), label: `TEST EQUITY ${n}`, kind: "equity",
  quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "",
  couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
  account: bo, folio: "", amc: "", amcFull: "", ...over,
});

const stored = (n, quantity = 10) => ({
  security_id: isin(n), label: `TEST EQUITY ${n}`, category: "equity",
  quantity, cost_paise: null, value_paise: 100000, purchase_date: "",
  as_of: AS_OF, value_source: "cas", source: "report",
});

const statement = () => {
  const accounts = [
    { boId: EXISTING_BO, dpName: "Test DP One",
      holdings: [holding(101, EXISTING_BO), holding(102, EXISTING_BO),
        holding(103, EXISTING_BO)] },
    { boId: NEW_BOS[0], dpName: "Test DP Two",
      holdings: [holding(201, NEW_BOS[0]), holding(202, NEW_BOS[0])] },
    { boId: NEW_BOS[1], dpName: "Test DP Three",
      holdings: [holding(301, NEW_BOS[1]), holding(302, NEW_BOS[1])] },
    { boId: NEW_BOS[2], dpName: "Test DP Four",
      holdings: [holding(401, NEW_BOS[2])] },
  ];
  const holdings = accounts.flatMap((account) => account.holdings);
  return {
    depository: "CDSL", demat: EXISTING_BO, asOf: AS_OF, accounts, holdings,
    transactions: [], counts: { rows: holdings.length, quarantined: 0 },
    printedTotalPaise: holdings.reduce((total, row) => total + row.valuePaise, 0),
  };
};

const existingAccount = (bo = EXISTING_BO, rows = [stored(101), stored(102)]) => ({
  id: "demat-existing", label: "Demat · Test DP One · …4321", bank: "Test DP One",
  category: "demat", subtype: "equity", type: "equity", number: bo,
  meta: JSON.stringify({ depository: "CDSL", dp: "Test DP One",
    holdings_source: "cas", holdings_as_of: AS_OF }),
  rows,
});

function casBundle(page, parsed) {
  const rowOf = (row) => page.bpImportCasRow(row);
  const entry = {
    kind: "cas", name: "cas.pdf", asOf: AS_OF, accountKey: EXISTING_BO,
    accountKind: "bo",
    rows: parsed.holdings.map(rowOf), parsed,
    accounts: parsed.accounts.map((account) => ({ boId: account.boId,
      dpName: account.dpName, rows: account.holdings.map(rowOf) })),
    entryId: "cas-entry",
  };
  const bundle = groupBundles([entry])[0];
  bundle.acceptAsk = false;
  return bundle;
}

// The writer creates one account per homeless BO ID, then routes again. The
// same three steps the page runs before bpCasImport: scope, create, re-route.
function writeAll(parsed, targets, assets, { create = true } = {}) {
  const scoped = casImportHoldings({ parsed, targets });
  const cas = { ...parsed, accounts: scoped.accounts, holdings: scoped.holdings };
  const all = [...assets];
  const first = casRoute(cas, all);
  const units = casImportUnits({ accounts: all, routeAccounts: first.accounts,
    groups: [...first.groups, ...first.homeless], movements: [] });
  if (create) {
    for (const group of first.homeless) {
      if (!group.boId || !units.has(`bo:${group.boId}`)) continue;
      if (all.some((account) => boId(account.number).boId === boId(group.boId).boId)) continue;
      all.push({ id: `created-${group.boId}`, label: `Demat · …${group.boId.slice(-4)}`,
        category: "demat", subtype: "equity", number: group.boId });
    }
  }
  const route = casRoute(cas, all);
  const byAsset = casGroupByAsset({ holdings: cas.holdings, groups: route.groups,
    importDay: TODAY, picked: units });
  const writes = new Map();
  for (const account of all) {
    const rows = byAsset.get(account.id) || [];
    const plan = casReplacePlan({ parsed: cas, existing: account.rows || [],
      holdings: rows, events: [], assetId: account.id, accounts: [account.number],
      route: true, asOf: AS_OF, confirmed: true });
    writes.set(account.id, plan);
  }
  return { cas, all, route, units, byAsset, writes };
}

test("one press attaches the matched demat and creates the other three", () => {
  const parsed = statement();
  const account = existingAccount();
  const state = { accountRows: [{ account, holdings: account.rows }],
    choices: {}, acceptAsk: {} };
  const page = pageHarness(state);
  const bundle = casBundle(page, parsed);
  page.bpImportResolveCas(bundle);

  assert.equal(bundle.casTargets.length, 4);
  assert.equal(bundle.ready, true, "the statement is one press, not a chooser");
  assert.equal(bundle.needsChoice, false);
  assert.equal(bundle.createAccounts, 3);

  const matched = bundle.casTargets.find((target) => target.boId === EXISTING_BO);
  assert.equal(matched.targetId, account.id, "the BO ID attaches the account on file");
  assert.equal(matched.action, "update");
  assert.equal(matched.autoCreate, false);
  for (const bo of NEW_BOS) {
    const target = bundle.casTargets.find((item) => item.boId === bo);
    assert.equal(target.targetId, "", `${bo} has no account on file`);
    assert.equal(target.action, "create");
    assert.equal(target.autoCreate, true, `${bo} is safe to create without a question`);
  }

  const card = page.bpImportCasAccountsHtml(bundle);
  assert.match(card, /1 matched · 3 new/, "the card states the split before the press");
  assert.match(card, /Matched Demat · Test DP One · …4321/,
    "the matched account line says it is matched");
  assert.equal((card.match(/New demat account/g) || []).length, 3,
    "each new account line says it is new");
  assert.doesNotMatch(card, /__create__/,
    "no create button is needed for an account with no candidate");

  const assets = [{ ...account, holdings: account.rows }];
  const written = writeAll(parsed, bundle.casTargets, assets);
  assert.equal(written.all.length, 4,
    "one existing demat plus the three the statement creates");
  assert.deepEqual(written.all.map((item) => boId(item.number).boId).sort(),
    [EXISTING_BO, ...NEW_BOS].sort(), "the four accounts are the four the statement names");
  assert.equal(written.all.filter((item) => item.number === EXISTING_BO).length, 1,
    "the matched demat is not duplicated");

  const existingWrite = written.writes.get(account.id);
  assert.equal(existingWrite.ok, true);
  assert.deepEqual(existingWrite.rows.map((row) => row.security_id).sort(),
    [isin(101), isin(102), isin(103)], "the matched demat gained the row it did not hold");
  for (const bo of NEW_BOS) {
    const created = written.all.find((item) => item.number === bo);
    const plan = written.writes.get(created.id);
    assert.equal(plan.ok, true);
    assert.ok(plan.rows.length > 0, `${bo} was created with its rows`);
  }
});

test("two existing candidates still ask, even beside three new accounts", () => {
  const parsed = statement();
  const first = existingAccount("9999000011112222");
  const second = { ...existingAccount("9999000033334444"), id: "demat-twin",
    label: "Demat · Test DP Twin · …4444" };
  // Both hold two of the statement's first-account ISINs and neither carries its
  // BO ID. Equal overlap, no identity: a tie, which is the person's choice.
  first.rows = [stored(101), stored(102), stored(103)];
  second.rows = [stored(101), stored(102), stored(103)];
  const state = { accountRows: [
    { account: first, holdings: first.rows },
    { account: second, holdings: second.rows },
  ], choices: {}, acceptAsk: {} };
  const page = pageHarness(state);
  const bundle = casBundle(page, parsed);
  page.bpImportResolveCas(bundle);

  const contested = bundle.casTargets.find((target) => target.boId === EXISTING_BO);
  assert.equal(contested.match.matches.length, 2);
  assert.equal(contested.match.tie, true);
  assert.equal(contested.needsChoice, true, "two look-alike accounts are not a default");
  assert.equal(contested.targetId, "");
  assert.equal(bundle.needsChoice, true);
  assert.equal(bundle.ready, false, "the press waits for the account choice");
  assert.equal(bundle.createAccounts, 3, "the three new accounts do not answer the tie");

  const card = page.bpImportCasAccountsHtml(bundle);
  assert.match(card, /3 new · 1 to choose/, "the card names the creates and the question");
  assert.match(card, /__create__/, "the tie still offers the explicit create answer");
  assert.doesNotMatch(card, /import-account-choice on/,
    "the tie preselects neither account");
});
