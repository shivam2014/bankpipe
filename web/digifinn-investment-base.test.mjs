import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseInvestmentReport, parsePortfolioReport } from "./digifinn-reports.js";
import { accountFieldState, accountMatches, groupBundles,
  mergeRowsFromPlan, planMerge, planNetChange } from "./import-flow.js";

// The two real-shaped DigiFinn exports. Names, ISINs and amounts are synthetic.
const fixture = (name) => readFileSync(
  new URL(`./fixtures/import/digifinn/${name}`, import.meta.url), "utf8");
const investmentText = fixture("investment-report.csv");
const holdingsText = fixture("holdings-report.csv");
const TODAY = "2026-11-27";

function investmentFile(name = "investment-report.csv") {
  const parsed = parseInvestmentReport(investmentText, name);
  return {
    kind: "digifinn-investment", name, asOf: parsed.asOf,
    accountKey: "", accountKind: "", parsed,
    rows: parsed.rows.map((row) => ({
      isin: "", label: row.label, category: "bond", quantity: null,
      costPaise: row.invested_paise, purchaseDate: row.purchase_date,
      couponPct: row.coupon_pct, maturity: row.maturity, issuer: row.issuer,
      yieldPct: row.yield_pct, sourceRow: row.source_row,
    })),
    termsByLabel: parsed.rows.map((row) => ({
      label: row.label, couponPct: row.coupon_pct, maturity: row.maturity,
      issuer: row.issuer, yieldPct: row.yield_pct, purchaseDate: row.purchase_date,
    })),
  };
}

function holdingsFile(name = "holdings-report.csv") {
  const parsed = parsePortfolioReport(holdingsText, name);
  return {
    kind: "digifinn-portfolio", name, asOf: parsed.asOf,
    accountKey: parsed.demat, accountKind: "bo", parsed,
    rows: parsed.rows.map((row) => ({
      isin: row.isin, label: row.label, category: "bond", quantity: row.quantity,
      valuePaise: null, costPaise: row.cost_paise, purchaseDate: row.purchase_date,
      sourceRow: row.source_row,
    })),
  };
}

const emptyState = () => ({
  identity: { source: "", asOf: "", value: "" },
  snapshot: { source: "", asOf: "" },
  cost: { source: "", asOf: "", manual: false },
  manualAsOf: "",
  holdings: [],
});

function stateOf(account) {
  return { ...accountFieldState(account, account.holdings || []),
    holdings: account.holdings || [] };
}

// One import: plan the bundle against the account, then project the rows the
// writer would store. This is the page's broker path without the DOM.
function importBundle(bundle, account) {
  const existing = account ? stateOf(account) : emptyState();
  const identity = bundle.accountKey
    ? { kind: bundle.accountKind || "bo", value: bundle.accountKey } : null;
  const plan = planMerge({
    incoming: {
      kind: bundle.family, label: bundle.kind, asOf: bundle.asOf, identity,
      categories: [...new Set(bundle.rows.map((row) => row.category).filter(Boolean))],
      rows: bundle.rows,
    },
    existing,
    today: TODAY,
  });
  const source = { family: bundle.family, label: bundle.kind, asOf: bundle.asOf };
  const rows = mergeRowsFromPlan(existing.holdings, plan, source, false);
  return { plan, rows, net: planNetChange(existing.holdings, rows) };
}

function accountFor(bundle) {
  const rows = importBundle(bundle, null).rows;
  const account = {
    id: "digifinn-investment", label: "Demat · DigiFinn · TEST HOLDER ONE",
    category: "demat", subtype: "equity", number: bundle.accountKey || "",
    meta: JSON.stringify({ dp: "DigiFinn", broker_source: "digifinn",
      identity_source: "digifinn", holdings_source: "digifinn",
      holdings_as_of: bundle.asOf, cost_source: "DigiFinn bundle",
      cost_as_of: bundle.asOf }),
    holdings: rows,
  };
  return account;
}

test("the Investment Report row shape carries terms, cost and no ISIN or units", () => {
  const parsed = parseInvestmentReport(investmentText, "investment-report.csv");
  assert.equal(parsed.identity.name, "TEST HOLDER ONE");
  assert.equal(parsed.identity.pan, "ABCDE1234F");
  assert.equal(parsed.identity.demat, undefined);
  assert.equal(parsed.rows[0].isin, undefined);
  assert.equal(parsed.rows[0].quantity, null);
  assert.equal(parsed.rows[0].label, "10.00% TEST BOND A 31 DEC 2030");
  assert.equal(parsed.rows[0].coupon_pct, 10);
  assert.equal(parsed.rows[0].yield_pct, 0.105);
  assert.equal(parsed.rows[0].maturity, "2030-12-31");
  assert.equal(parsed.rows[0].invested_paise, 10000000);
  // The report prints 11/5/26 month-first, the same day as the holdings
  // report's 05-Nov-2026. The two must not disagree at merge time.
  assert.equal(parsed.rows[1].purchase_date, "2026-11-05");
  assert.equal(parsed.ambiguousDates, 0);
});

test("the Investment Report alone is a ready bundle with two bonds", () => {
  const bundles = groupBundles([investmentFile()]);
  assert.equal(bundles.length, 1);
  const bundle = bundles[0];
  assert.equal(bundle.ready, true);
  assert.equal(bundle.base.kind, "digifinn-investment");
  assert.equal(bundle.rows.length, 2);
  assert.equal(bundle.rows[0].isin, "");
  assert.equal(bundle.rows[0].quantity, null);
  assert.equal(bundle.rows[0].costPaise, 10000000);
  assert.match(bundle.warnings.join(" "), /no ISIN or units/i);
  const imported = importBundle(bundle, null);
  assert.equal(imported.plan.summary.added, 2);
  assert.equal(imported.rows.length, 2);
  assert.deepEqual(imported.rows.map((row) => row.security_id), ["", ""]);
});

test("the holdings report after the investment report pairs each bond, not two rows", () => {
  const investment = groupBundles([investmentFile()])[0];
  const account = accountFor(investment);
  const holdings = groupBundles([holdingsFile()])[0];
  const match = accountMatches({ ...holdings, family: "digifinn",
    rows: holdings.rows }, [account]);
  assert.equal(match.attachId, "digifinn-investment");
  const imported = importBundle(holdings, account);
  assert.equal(imported.rows.length, 2);
  assert.deepEqual(imported.rows.map((row) => row.security_id).sort(),
    ["INE000000001", "INE000000002"]);
  assert.deepEqual(imported.rows.map((row) => row.quantity), [10, 20]);
  assert.equal(imported.plan.summary.added, 0);
  assert.equal(imported.plan.summary.updated, 2);
  assert.equal(imported.plan.summary.ask, 0);
  assert.equal(imported.rows[1].purchase_date, "2026-11-05");
  assert.equal(imported.net.added, 0);
  assert.equal(imported.net.updated, 2);
  assert.equal(imported.net.removed, 0);
});

test("the investment report after the holdings report fills terms without a duplicate", () => {
  const holdings = groupBundles([holdingsFile()])[0];
  const account = accountFor(holdings);
  const investment = groupBundles([investmentFile()])[0];
  const match = accountMatches({ ...investment, family: "digifinn",
    rows: investment.rows }, [account]);
  assert.equal(match.attachId, "digifinn-investment");
  assert.equal(match.matches[0].basis, "bond");
  const imported = importBundle(investment, account);
  assert.equal(imported.rows.length, 2);
  assert.deepEqual(imported.rows.map((row) => row.security_id).sort(),
    ["INE000000001", "INE000000002"]);
  assert.deepEqual(imported.rows.map((row) => row.coupon_pct), [10, 9.5]);
  assert.deepEqual(imported.rows.map((row) => row.maturity),
    ["2030-12-31", "2027-12-31"]);
  assert.equal(imported.plan.summary.added, 0);
  assert.equal(imported.plan.summary.updated, 2);
  assert.equal(imported.plan.summary.ask, 0);
  assert.equal(imported.rows[1].purchase_date, "2026-11-05");
  assert.equal(imported.net.added, 0);
  assert.equal(imported.net.updated, 2);
  assert.equal(imported.net.removed, 0);
});

test("both files in one set are one bundle with one row per bond", () => {
  const bundles = groupBundles([holdingsFile(), investmentFile()]);
  assert.equal(bundles.length, 1);
  const bundle = bundles[0];
  assert.equal(bundle.base.kind, "digifinn-portfolio");
  assert.equal(bundle.rows.length, 2);
  assert.deepEqual(bundle.rows.map((row) => row.isin),
    ["INE000000001", "INE000000002"]);
  assert.deepEqual(bundle.rows.map((row) => row.couponPct), [10, 9.5]);
  assert.deepEqual(bundle.rows.map((row) => row.yieldPct), [0.105, 9.5]);
});

test("a bond name alone never attaches a DigiFinn report to another broker's demat", () => {
  const investment = groupBundles([investmentFile()])[0];
  const rows = importBundle(investment, null).rows;
  const zerodha = {
    id: "zerodha", label: "Demat · Zerodha · …8054", category: "demat",
    subtype: "equity", number: "1200000000000002",
    meta: JSON.stringify({ dp: "Zerodha", broker_source: "zerodha" }),
    holdings: rows,
  };
  const match = accountMatches({ family: "digifinn", rows: investment.rows },
    [zerodha]);
  assert.equal(match.attachId, "");
  assert.equal(match.matches.length, 0);
});

test("two stored lots with one name are not merged into a third guess", () => {
  const label = "10.00% TEST BOND A 31 DEC 2030";
  const lot = { security_id: "", label, category: "bond", quantity: null,
    cost_paise: 10000000, purchase_date: "2026-10-23", as_of: "2026-10-26" };
  const existing = {
    ...emptyState(),
    snapshot: { source: "digifinn", asOf: "2026-10-26" },
    holdings: [lot, { ...lot }],
  };
  const plan = planMerge({
    incoming: {
      kind: "digifinn", asOf: "2026-10-26",
      identity: { kind: "bo", value: "1200000000000001" }, categories: ["bond"],
      rows: [{ isin: "INE000000001", label, category: "bond", quantity: 10,
        valuePaise: null, costPaise: 10000000, purchaseDate: "2026-10-23" }],
    },
    existing,
    today: TODAY,
  });
  assert.equal(plan.summary.added, 1);
  assert.ok(plan.warnings.some((line) =>
    /2 stored rows share this bond's name/.test(line)));
  assert.deepEqual(plan.decisions.find((item) => item.action === "add").flags,
    ["ambiguous-name"]);
});
