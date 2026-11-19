import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { casReplacePlan, casSafety, casWritableHoldings } from "./cas-apply.js";
import { duplicateFundPositions } from "./folio.js";
import { accountFieldState, importNoWorkCopy, planImportChains, planMerge,
  statementAccounts } from "./import-flow.js";

// The inbox planner and its card copy live in index.html, so the test reads the
// page and runs its own functions. Nothing here reimplements the rule under
// test; the fixture is synthetic and every number is invented.

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

const BO = "IN99990001344321";
const AS_OF = "2026-10-31";
const TODAY = "2026-11-19";
const FOLIOS = ["99990003001", "99990003002", "99990003003"];
const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const fundIsin = (n) => `INF${String(n).padStart(9, "0")}`;

// 15 live non-fund rows and three fund rows the statement prints with no folio.
// The demat on file still holds all three fund copies; a folio account already
// holds each one at a different value.
function fixture() {
  const nonFund = [
    ...Array.from({ length: 12 }, (_, at) => ({ isin: isin(301 + at),
      label: `TEST EQUITY ${at + 1}`, kind: "equity", quantity: 10, valuePaise: 100000 })),
    ...Array.from({ length: 3 }, (_, at) => ({ isin: isin(401 + at),
      label: `9.25% TEST BOND ${at + 1} 31 Dec 2028`, kind: "bond", quantity: 10,
      valuePaise: 100000 })),
  ];
  const funds = [
    { isin: fundIsin(901), label: "TEST FUND ONE", kind: "mf", quantity: 100,
      valuePaise: 31715234 },
    { isin: fundIsin(902), label: "TEST FUND TWO", kind: "mf", quantity: 10,
      valuePaise: 10000 },
    { isin: fundIsin(903), label: "TEST FUND THREE", kind: "mf", quantity: 5,
      valuePaise: 11039 },
  ];
  const statement = [...nonFund, ...funds];
  const parsed = {
    depository: "NSDL", demat: BO, asOf: AS_OF,
    accounts: [{ boId: BO, dpName: "Test DP",
      holdings: statement.map((row) => ({ ...row, account: BO })) }],
    holdings: statement.map((row) => ({ ...row, account: BO })),
    transactions: [],
    counts: { rows: statement.length, quarantined: 0 },
    printedTotalPaise: statement.reduce((total, row) => total + row.valuePaise, 0),
  };
  const account = { id: "demat-1", label: "Demat · Test DP · …4321",
    category: "demat", subtype: "equity", type: "equity", number: BO,
    holder: "TEST HOLDER",
    meta: JSON.stringify({ depository: "NSDL", dp: "Test DP",
      holdings_source: "cas", holdings_as_of: AS_OF }) };
  const holdings = statement.map((row) => ({
    security_id: row.isin, label: row.label, category: row.kind,
    quantity: row.quantity, value_paise: row.valuePaise, as_of: AS_OF,
    source: "cas",
  }));
  const folioValues = [31357941, 9500, 10000];
  const accountRows = [
    { account, holdings },
    ...funds.map((fund, at) => ({
      account: { id: `mf-${at + 1}`, label: `Test Mutual Fund ${at + 1} · folio …${
        FOLIOS[at].slice(-4)}`, category: "demat", subtype: "mutual fund",
        type: "mf", number: FOLIOS[at],
        meta: JSON.stringify({ amc: `TESTAMC${at + 1}`, folios: [FOLIOS[at]] }) },
      holdings: [{ security_id: fund.isin, label: fund.label, category: "mf",
        quantity: fund.quantity, value_paise: folioValues[at], as_of: AS_OF,
        source: "cas" }],
    })),
  ];
  const statementRows = statement.map((row) => ({
    isin: row.isin, label: row.label, category: row.kind, quantity: row.quantity,
    valuePaise: row.valuePaise, costPaise: null, purchaseDate: "", couponPct: null,
    frequency: "", maturity: "", facePaise: null, account: BO, folio: "", amc: "",
    amcFull: "", sourceRow: 0,
  }));
  const rows = casWritableHoldings(statementRows, TODAY);
  return { account, holdings, accountRows, statementRows, rows, parsed,
    folioValues, funds, targetRow: { account, holdings } };
}

// The page's own functions, extracted and run with its module imports.
function pagePlanner() {
  const source = [
    between("function bpImportBundleLabel", "function bpImportBrokerName"),
    between("function bpImportDematPlanRows", "function bpImportResolveCas"),
    between("function bpImportPlanFor(", "function bpImportAggregatePlans"),
    between("function bpImportPlanFiles", "function bpImportBundleEntryIds"),
    between("function bpImportBrokerContribution", "function bpImportCasContribution"),
    between("function bpImportCasContribution", "function bpImportBrokerChain"),
    between("function bpImportBrokerChain", "function bpImportPlanChanges"),
    between("function bpImportPlanChanges", "function bpImportPlanForBundles"),
    between("function bpImportPlanForBundles", "function bpImportPlans"),
    between("function bpImportPrimaryLabel", "function bpImportPlanHtml"),
    between("function bpImportRemovalLine", "function bpImportPlanItems"),
    between("function bpImportReceiptLead", "window.bpImportApplyPlan"),
  ].join("\n");
  let accountRow = null;
  let accountRows = [];
  const page = new Function(
    "statementAccounts", "planImportChains", "importNoWorkCopy", "accountFieldState",
    "planMerge", "duplicateFundPositions", "money", "bpImportAccountRow",
    "bpImportInboxState",
    `${source}
     return { bpImportDematPlanRows, bpImportPlanFor, bpImportPlanForBundles,
       bpImportPrimaryLabel, bpImportRemovalLine, bpImportRemovals,
       bpImportReceiptLead };`,
  )(statementAccounts, planImportChains, importNoWorkCopy, accountFieldState,
    planMerge, duplicateFundPositions, (paise) => String(paise),
    (id) => (accountRow && accountRow.account.id === id ? accountRow : null),
    () => ({ accountRows }));
  return { page, setRows: (row, rows) => { accountRow = row; accountRows = rows; } };
}

// The resolver's plan and event plan for the one demat target, with its own
// row-set rule and the writer's preview. Everything the card reads comes from
// the page functions above or from the shipped planner.
function planFixture(data, { printedTotal = true } = {}) {
  const parsed = printedTotal ? data.parsed
    : { ...data.parsed, printedTotalPaise: null };
  const planRows = data.page.bpImportDematPlanRows(data.rows);
  const plan = data.page.bpImportPlanFor(
    { key: "cas", family: "cas", asOf: AS_OF, base: { parsed } },
    data.targetRow, planRows, { kind: "bo", value: BO });
  const eventRows = planRows.filter((row) => {
    const decision = plan?.decisions?.find((item) =>
      String(item.isin || "").toUpperCase() === String(row.isin || "").toUpperCase());
    return !decision || decision.action !== "skip";
  });
  const eventPlan = casReplacePlan({ parsed, existing: data.holdings, holdings: eventRows,
    events: [], assetId: "demat-1", accounts: [BO], route: true, asOf: AS_OF,
    confirmed: false });
  const bundle = { key: "cas", family: "cas", asOf: AS_OF, rows: data.rows,
    files: [], bundles: [], base: { parsed }, plan, casSafety: casSafety(parsed),
    ready: true, needsChoice: false, movementBlocked: false,
    casTargets: [{ boId: BO, dpName: "Test DP", rows: data.rows, targetId: "demat-1",
      plan, eventPlan, action: "update", folio: false }] };
  const composed = data.page.bpImportPlanForBundles(
    { key: "cas", accounts: ["demat-1"] }, [bundle]);
  return { parsed, planRows, plan, eventPlan, bundle, composed };
}

test("a re-imported NSDL statement offers the demat fund rows it will not write", () => {
  const data = fixture();
  const harness = pagePlanner();
  harness.setRows(data.targetRow, data.accountRows);
  data.page = harness.page;
  const { planRows, eventPlan, composed } = planFixture(data);

  assert.equal(planRows.length, 15, "the three positive fund rows leave the demat plan");
  assert.equal(eventPlan.wouldDrop.length, 3, "the writer's preview names three removals");
  assert.equal(eventPlan.wouldDropPaise, 31736273, "the removal value is the demat rows");
  assert.equal(composed.net.added, 0, "the statement adds nothing");
  assert.equal(composed.net.updated, 0, "it updates nothing");
  assert.equal(composed.removals, 3, "the card counts the removal as work");
  assert.equal(composed.removalPaise, 31736273,
    "the demat rows are the value, not the folio copies");
  assert.notEqual(composed.removalPaise,
    data.folioValues.reduce((total, value) => total + value, 0));
  assert.equal(composed.noWork, false, "a removal is not nothing to import");
  assert.equal(composed.ready, true, "the card can run the replace");
  assert.equal(data.page.bpImportPrimaryLabel(composed, 0),
    "Remove 3 demat holdings and import");
  const line = data.page.bpImportRemovalLine(composed);
  assert.match(line, /holds 3 fund rows/);
  assert.match(line, /31736273 here/);
  assert.match(line, /31377441 in the folio/);
  assert.match(line, /counted once/);
});

test("a missing printed total never offers the removal", () => {
  const data = fixture();
  const harness = pagePlanner();
  harness.setRows(data.targetRow, data.accountRows);
  data.page = harness.page;
  const { eventPlan, composed } = planFixture(data, { printedTotal: false });

  assert.equal(eventPlan.wouldDrop.length, 3,
    "the preview still knows which rows a replace would take");
  assert.equal(composed.removals, 0, "without proof the card counts no removal");
  assert.equal(composed.removalPaise, 0);
  assert.equal(composed.noWork, true, "the card stays closed");
  assert.equal(data.page.bpImportPrimaryLabel(composed, 0), "",
    "no removal primary is offered");
});

test("the receipt names the removal instead of claiming nothing was added", () => {
  const data = fixture();
  const harness = pagePlanner();
  harness.setRows(data.targetRow, data.accountRows);
  data.page = harness.page;
  const lead = data.page.bpImportReceiptLead;

  assert.deepEqual(lead({ live: 0, removed: 3 }), ["3 demat holdings removed"]);
  assert.deepEqual(lead({ live: 0, removed: 0, extraText: "" }), ["Nothing added"]);
  assert.deepEqual(lead({ live: 2, removed: 3 }), ["2 holdings imported", "3 demat holdings removed"]);
  assert.deepEqual(lead({ live: 1, extraText: ", 1 sale recorded" }),
    ["1 holding imported, 1 sale recorded"]);
  assert.deepEqual(lead({ identityOnly: true }), ["Identity attached"]);
  assert.equal(lead({ live: 0, removed: 3 }).includes("Nothing added"), false);
});

test("the writer drops the three named rows and writes fifteen", () => {
  const data = fixture();
  const harness = pagePlanner();
  harness.setRows(data.targetRow, data.accountRows);
  data.page = harness.page;
  const { planRows, parsed } = planFixture(data);
  const write = casReplacePlan({ parsed, existing: data.holdings, holdings: planRows,
    events: [], assetId: "demat-1", accounts: [BO], route: true, asOf: AS_OF,
    confirmed: true });

  assert.equal(write.preserveAbsent, false, "a complete statement may replace");
  assert.equal(write.rows.length, 15, "fifteen rows survive");
  assert.equal(write.dropped.length, 3, "exactly the three named rows are deleted");
  assert.deepEqual(write.dropped.map((row) => row.isin).sort(),
    data.funds.map((row) => row.isin).sort());
  assert.equal(write.rows.some((row) =>
    data.funds.some((fund) => fund.isin === row.security_id)), false);

  const kept = casReplacePlan({ parsed: { ...parsed, printedTotalPaise: null },
    existing: data.holdings, holdings: planRows, events: [], assetId: "demat-1",
    accounts: [BO], route: true, asOf: AS_OF, confirmed: true });
  assert.equal(kept.preserveAbsent, true, "a missing total keeps every row");
  assert.equal(kept.rows.length, 18);
});
