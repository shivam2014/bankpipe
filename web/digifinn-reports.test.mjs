import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortfolioReport, parseInvestmentReport, parsePayoutReport,
  parseReportFile, buildBondSync, scorePortfolio } from "./digifinn-reports.js";

const portfolioCsv = `"DIGIFINN - HOLDINGS REPORT"
"Name","TEST USER"
"Phone No.","9999999999"
"Email","test@example.com"
"Demat Account No.","1201000000000000"
"PAN","ABCDE1234F"
"As Of","26 Oct 2026"
""
"ISIN","Bond Name","Purchase date","Qty","Investment Value (₹)"
"INE000000001","10.00% TEST 31 DEC 2030","23 Oct 2026","2","200000.00"
"INE000000002","9.50% OLD 31 DEC 2025","1 Jan 2025","1","100000.00"
`;

const transactionCsv = `DIGI FINN – TRANSACTIONS REPORT,,,,,,,,,
,,,,,,,,,
A/C Type,Self,,ISIN No.,All ISINs,,Financial Year,FY 2026-27,,
,,,,,,,,,
 TRANSACTIONS SUMMARY,,,,,,,,,
ORDER SETTLED,,,,,,,,,
Date,ISIN,Bond Name,Transaction Type,Quantity (Units),Price / Unit (INR),Total Value (INR),Face Value (INR),Coupon Rate (%),Maturity Date
01/09/2026,INE000000001,"10.00% TEST 31 DEC 2030",BUY,2,1000,2000,2000,10,31/12/2030
`;

const investmentCsv = `Investment Report,,,,,,
Name,TEST USER,,,,,
As of 26 October 2026  |  All values in INR,,,,,,
,,,,
Bond Name,Issuer,Coupon,Maturity Date,Purchase Date,Yield,Invested Amount
10.00% TEST 31 DEC 2030,TEST ISSUER LIMITED,10.00%,12/31/30,10/23/26,10.5,200000.00
9.50% OLD 31 DEC 2025,OLD ISSUER LIMITED,9.50%,12/31/25,1/1/25,9.8,100000.00
`;

const payoutCsv = `Date,Issuer,ISIN,Amount,Frequency,Units
2026-11-30,"10.00% TEST 31 DEC 2030",INE000000001,1000.00,Quarterly Payout,2
2027-02-28,"10.00% TEST 31 DEC 2030",INE000000001,1000.00,Quarterly Payout,2
`;

// The Cashflow Future export: one column group per bond (name row, header row,
// values row, investment row), then one row per future month.
function cashflowCsv() {
  const blank = Array(8).fill("");
  const names = [...blank];
  names[1] = "10.25% NAVI FINSERV LIMITED 31 DEC 2026 INE342T07429";
  const header = [...blank];
  header[1] = "Yield"; header[2] = "Frequency"; header[3] = "Maturity";
  header[4] = "*All indicative values";
  const values = [...blank];
  values[1] = "0.1025"; values[2] = "Monthly Payout"; values[3] = "2030-12-31";
  const invest = [...blank];
  invest[2] = "199000"; invest[4] = "2024-02-15";
  const totals = [...blank];
  totals[1] = "Interest"; totals[2] = "Interest Post TDS";
  totals[3] = "Principal"; totals[4] = "Total";
  const rows = [
    ["2030-01-31", "1708", "1537", "0", "1537"],
    ["2030-06-30", "1708", "1537", "0", "1537"],
    ["2030-12-31", "1708", "1537", "200000", "201708"],
  ];
  const lines = [["Note: indicative"], [], names, header, values, invest, totals, ...rows]
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","));
  return lines.join("\n");
}

test("the transactions report is recognised and parsed", () => {
  const p = parseReportFile(transactionCsv, "transaction-report.csv");
  assert.equal(p.kind, "transactions");
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].type, "BUY");
  assert.equal(p.rows[0].isin, "INE000000001");
  assert.equal(p.rows[0].quantity, 2);
  assert.equal(p.rows[0].value_paise, 200000);
  assert.equal(p.rows[0].maturity, "2030-12-31");
});

test("portfolio identity is read from the preamble", () => {
  const p = parsePortfolioReport(portfolioCsv);
  assert.equal(p.identity.name, "TEST USER");
  assert.equal(p.identity.pan, "ABCDE1234F");
  assert.equal(p.identity.phone, "9999999999");
  assert.equal(p.identity.email, "test@example.com");
  assert.equal(p.identity.demat, "1201000000000000");
});

test("portfolio parser reads only the table and keeps the demat number", () => {
  const p = parsePortfolioReport(portfolioCsv);
  assert.equal(p.kind, "portfolio");
  assert.equal(p.demat, "1201000000000000");
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].isin, "INE000000001");
  assert.equal(p.rows[0].quantity, 2);
  assert.equal(p.rows[0].cost_paise, 20000000);
  assert.equal(p.rows[0].purchase_date, "2026-10-23");
  const keys = Object.keys(p.rows[0]);
  assert.deepEqual(keys.sort(), ["cost_paise", "isin", "label", "purchase_date",
    "quantity", "source_row"].sort());
  // The identity stays in its own block; no holding row may carry it.
  assert.ok(!JSON.stringify(p.rows).includes("TEST USER"));
  assert.ok(!JSON.stringify(p.rows).includes("ABCDE1234F"));
  assert.ok(!JSON.stringify(p.rows).includes("9999999999"));
});

test("investment parser reads coupon and purchase yield", () => {
  const i = parseInvestmentReport(investmentCsv);
  assert.equal(i.kind, "investment");
  assert.equal(i.rows.length, 2);
  assert.equal(i.rows[0].issuer, "TEST ISSUER LIMITED");
  assert.equal(i.rows[0].coupon_pct, 10);
  assert.equal(i.rows[0].yield_pct, 10.5);
  assert.equal(i.rows[0].invested_paise, 20000000);
  assert.equal(i.rows[0].maturity, "2030-12-31");
  assert.equal(i.asOf, "2026-10-26");
});

test("payout parser keeps the earliest amount per unit series", () => {
  const p = parsePayoutReport(payoutCsv);
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].date, "2026-11-30");
  assert.equal(p.groups[0].amount_paise, 100000);
  assert.equal(p.groups[0].frequency, "Quarterly Payout");
});

test("report detection does not depend on file names", () => {
  assert.equal(parseReportFile(portfolioCsv).kind, "portfolio");
  assert.equal(parseReportFile(investmentCsv).kind, "investment");
  assert.equal(parseReportFile(payoutCsv).kind, "payouts");
});

test("sync excludes matured lots and preserves manual fields", () => {
  const portfolio = parsePortfolioReport(portfolioCsv);
  const investment = parseInvestmentReport(investmentCsv);
  const payouts = parsePayoutReport(payoutCsv);
  const existing = [{ security_id: "INE000000001", label: "10.00% TEST 31 DEC 2030",
    quantity: 2, cost_paise: 20000000, value_paise: 21000000,
    purchase_date: "2026-10-23", interest_date: "", rating: "AA", frequency: "",
    yield_bps: null, payout_paise: null }];
  const sync = buildBondSync({ portfolio, investment, payouts, existing,
    today: "2026-10-26" });
  assert.equal(sync.current, 1);
  assert.equal(sync.matured.length, 1);
  assert.equal(sync.updated, 1);
  assert.equal(sync.added, 0);
  assert.equal(sync.holdings[0].rating, "AA");
  assert.equal(sync.holdings[0].value_paise, 21000000);
  assert.equal(sync.holdings[0].yield_bps, 1050);
  assert.equal(sync.holdings[0].payout_paise, 100000);
  assert.equal(sync.holdings[0].frequency, "Quarterly Payout");
  assert.equal(sync.holdings[0].interest_date, "2026-11-30");
});

test("portfolio scoring counts current ISINs", () => {
  const p = parsePortfolioReport(portfolioCsv);
  const rows = [{ security_id: "INE000000001" }, { security_id: "INE999999999" }];
  const score = scorePortfolio(rows, p);
  assert.equal(score.matched, 1);
  assert.equal(score.of, 2);
});

test("the cashflow schedule reaches the holding, pre-tax", () => {
  const portfolio = { kind: "portfolio", rows: [{
    isin: "INE342T07429", label: "10.25% NAVI FINSERV LIMITED 31 DEC 2026",
    quantity: 2, cost_paise: 19900000, purchase_date: "2024-02-15" }] };
  const payouts = { kind: "payouts", source: "cashflow", groups: [{
    isin: "INE342T07429", amount_paise: 170800, interest_date: "2026-11-30",
    frequency: "Monthly", future_interest_paise: 4100000,
    future_principal_paise: 20000000, principal_dates: ["2028-02-27", "2028-11-27"] }] };
  const out = buildBondSync({ portfolio, payouts, today: "2026-10-29" });
  const h = out.holdings[0];
  assert.equal(h.future_interest_paise, 4100000);
  assert.equal(h.future_principal_paise, 20000000);
  assert.equal(h.principal_dates, "2028-02-27,2028-11-27");
});

test("the Cashflow Future sheet is accepted as the payouts slot and reaches the sync", () => {
  const parsed = parseReportFile(cashflowCsv(), "portfolio-cashflow-future.csv");
  assert.equal(parsed.kind, "payouts");
  assert.equal(parsed.source, "cashflow");
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].future_interest_paise, 512400);
  const portfolio = { kind: "portfolio", demat: "1201000000001234", rows: [{
    isin: "INE342T07429", label: "10.25% NAVI FINSERV LIMITED 31 DEC 2026",
    quantity: 2, cost_paise: 19900000, purchase_date: "2024-02-15" }] };
  const out = buildBondSync({ portfolio, payouts: parsed, today: "2026-10-29" });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].payout_paise, 170800);
  assert.equal(out.holdings[0].interest_date, "2030-01-31");
  assert.equal(out.holdings[0].future_interest_paise, 512400);
  assert.equal(out.holdings[0].future_principal_paise, 20000000);
  assert.equal(out.holdings[0].principal_dates, "2030-12-31");
});

test("the old Upcoming Payouts export still parses, so the page can name it", () => {
  const p = parseReportFile(payoutCsv, "upcoming-payouts.csv");
  assert.equal(p.kind, "payouts");
  assert.equal(p.source, "payouts");
});

test("two lots of one ISIN get their own cashflow block, not the first one", () => {
  const portfolio = { kind: "portfolio", rows: [
    { isin: "INE00XL07015", label: "9.75% B N AGRITECH LIMITED 27 NOV 2028",
      quantity: 10, cost_paise: 9896959, purchase_date: "2025-11-27" },
    { isin: "INE00XL07015", label: "9.75% B N AGRITECH LIMITED 27 NOV 2028",
      quantity: 20, cost_paise: 19529612, purchase_date: "2026-02-10" },
  ] };
  const payouts = { kind: "payouts", source: "cashflow", groups: [
    { isin: "INE00XL07015", investment_paise: 9896959, units: null,
      future_interest_paise: 1220752, future_principal_paise: 10000000, principal_dates: [] },
    { isin: "INE00XL07015", investment_paise: 19529612, units: null,
      future_interest_paise: 2441507, future_principal_paise: 20000000, principal_dates: [] },
  ] };
  const out = buildBondSync({ portfolio, payouts, today: "2026-10-29" });
  const byQty = new Map(out.holdings.map((h) => [h.quantity, h]));
  assert.equal(byQty.get(10).future_principal_paise, 10000000);
  assert.equal(byQty.get(20).future_principal_paise, 20000000);
  assert.equal(byQty.get(20).future_interest_paise, 2441507);
});
