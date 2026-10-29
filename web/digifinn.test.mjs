import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv, parsePayouts, parseCashflow, parseDigiFinnFile,
  mergeDigiFinn, nameScore, scorePortfolio,
} from "./digifinn.js";

const payCsv = `Date,Issuer,ISIN,Amount,Frequency,Units
2026-10-18,"10.00% PGL 18 AUG 2028",INE0B2O07011,2465.75,Monthly Payout,30
2026-11-18,"10.00% PGL 18 AUG 2028",INE0B2O07011,2465.75,Monthly Payout,30
2026-10-19,"13.00% RFL 19 DEC 2028",INE964R07093,2136.99,Monthly Payout,20
`;

// A two-bond wide cashflow sheet in the portal's layout: names row, header
// row, values row, investment row, then the cashflow table.
function cashflowCsv() {
  const blank = Array(13).fill("");
  const names = [...blank]; names[2] = "PGL"; names[6] = "RFL";
  const header = [...blank]; header[2] = "Yield"; header[3] = "Frequency";
  header[4] = "Maturity"; header[5] = "*All indicative values";
  header[6] = "Yield"; header[7] = "Frequency"; header[8] = "Maturity";
  header[9] = "*All indicative values";
  const values = [...blank]; values[2] = "0.110012"; values[3] = "Monthly Payout";
  values[4] = "2028-08-18"; values[6] = "0.13"; values[7] = "Monthly Payout";
  values[8] = "2028-12-19";
  const invest = [...blank]; invest[2] = "Investment Value"; invest[3] = "50000";
  invest[4] = "Investment date"; invest[5] = "2025-08-18";
  invest[6] = "Investment Value"; invest[7] = "20000";
  invest[8] = "Investment date"; invest[9] = "2025-12-19";
  const totals = [...blank]; totals[2] = "Interest"; totals[3] = "Interest Post TDS";
  totals[4] = "Principal"; totals[5] = "Total";
  totals[6] = "Interest"; totals[7] = "Interest Post TDS"; totals[8] = "Principal";
  totals[9] = "Total";
  const row = [...blank]; row[1] = "2026-10-18"; row[2] = "458.33"; row[3] = "412.50";
  row[4] = "0"; row[5] = "412.50"; row[6] = "216.67"; row[7] = "195";
  row[8] = "0"; row[9] = "195";
  const lines = [["Note: indicative"], [], [], names, header, values, invest, totals, row]
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","));
  return lines.join("\n");
}

test("csv reader keeps commas and newlines inside quotes", () => {
  const rows = parseCsv('a,"b, c","d\ne"\n1,2,3');
  assert.deepEqual(rows[0], ["a", "b, c", "d\ne"]);
  assert.deepEqual(rows[1], ["1", "2", "3"]);
});

test("payouts parser reads ISIN, units and the next date", () => {
  const p = parsePayouts(payCsv);
  assert.equal(p.kind, "payouts");
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].isin, "INE0B2O07011");
  assert.equal(p.rows[0].units, 30);
  assert.equal(p.rows[1].date, "2026-11-18");
});

test("cashflow parser finds both bond groups", () => {
  const c = parseCashflow(cashflowCsv());
  assert.equal(c.kind, "cashflow");
  assert.equal(c.groups.length, 2);
  assert.equal(c.groups[0].name, "PGL");
  assert.equal(c.groups[0].yieldPct, 11.0);
  assert.equal(c.groups[0].maturity, "2028-08-18");
  assert.equal(c.groups[0].investment_paise, 5000000);
  assert.equal(c.groups[0].investment_date, "2025-08-18");
  assert.equal(c.groups[1].investment_paise, 2000000);
});

test("cashflow parser finds the next payout gross of TDS", () => {
  const c = parseCashflow(cashflowCsv());
  assert.equal(c.groups[0].next_payout_date, "2026-10-18");
  // 458.33 gross; the sheet's Total column is 412.50 after TDS. This app keeps
  // every bond figure gross, so the gross interest is what it reports.
  assert.equal(c.groups[0].next_payout_paise, 45833);
  assert.equal(c.groups[1].next_payout_date, "2026-10-18");
  assert.equal(c.groups[1].next_payout_paise, 21667);
});

test("file detection distinguishes the two exports", () => {
  assert.equal(parseDigiFinnFile(payCsv).kind, "payouts");
  assert.equal(parseDigiFinnFile(cashflowCsv()).kind, "cashflow");
  assert.equal(parseDigiFinnFile("a,b\n1,2").kind, "unknown");
});

test("cashflow names expose the ISIN", () => {
  const c = parseCashflow(cashflowCsv().replace('"PGL"',
    '"10.00% PGL 18 AUG 2028 - INE0B2O07011"'));
  assert.equal(c.groups[0].isin, "INE0B2O07011");
});

test("merge keeps two purchase lots for the same ISIN", () => {
  const payouts = [
    { date: "2026-11-27", issuer: "9.75% BNAL 27 NOV 2028", isin: "INE00XL07015",
      amount_paise: 491507, frequency: "Quarterly Payout", units: 20, source_row: 2 },
    { date: "2026-11-27", issuer: "9.75% BNAL 27 NOV 2028", isin: "INE00XL07015",
      amount_paise: 245753, frequency: "Quarterly Payout", units: 10, source_row: 3 },
  ];
  const cashflow = [
    { index: 0, name: "9.75% BNAL 27 NOV 2028 - INE00XL07015", isin: "INE00XL07015",
      yieldPct: 11.64, frequency: "Quarterly Payout", maturity: "2027-11-27",
      investment_paise: 19529612, investment_date: "2025-12-02" },
    { index: 1, name: "9.75% BNAL 27 NOV 2028 - INE00XL07015", isin: "INE00XL07015",
      yieldPct: 11.93, frequency: "Quarterly Payout", maturity: "2027-11-27",
      investment_paise: 9896959, investment_date: "2026-01-30" },
  ];
  const existing = [{ security_id: "INE00XL07015", label: "9.75% BNAL 27 NOV 2028",
    quantity: 20, cost_paise: 9896959, value_paise: null, rating: "AA",
    frequency: "Quarterly Payout", yield_bps: 1164 }];
  const out = mergeDigiFinn({ payouts, cashflow, existing });
  const lots = out.holdings.filter((h) => h.security_id === "INE00XL07015")
    .sort((a, b) => b.quantity - a.quantity);
  assert.equal(lots.length, 2);
  assert.equal(lots[0].quantity, 20);
  assert.equal(lots[0].cost_paise, 19529612);
  assert.equal(lots[0].purchase_date, "2025-12-02");
  assert.equal(lots[0].payout_paise, 491507);
  assert.equal(lots[0].rating, "AA");
  assert.equal(lots[1].quantity, 10);
  assert.equal(lots[1].cost_paise, 9896959);
  assert.equal(lots[1].purchase_date, "2026-01-30");
  assert.ok(/lot 1/.test(lots[0].label));
  assert.ok(/lot 2/.test(lots[1].label));
  assert.equal(out.added, 1);
});

test("merge upserts by ISIN, adds cost and does not duplicate", () => {
  const payouts = parsePayouts(payCsv).rows;
  const cashflow = parseCashflow(cashflowCsv()).groups;
  const existing = [{ id: 1, security_id: "INE0B2O07011", label: "Old PGL",
    rating: "AA", frequency: "Annual Payout", yield_bps: 1000,
    quantity: 10, cost_paise: 5000000, value_paise: null, purchase_date: "2025-08-18",
    interest_date: "2026-09-18" }];
  const once = mergeDigiFinn({ payouts, cashflow, existing });
  assert.equal(once.added, 1);
  assert.equal(once.updated, 1);
  assert.equal(once.holdings.length, 2);
  const pgl = once.holdings.find((h) => h.security_id === "INE0B2O07011");
  assert.equal(pgl.quantity, 30);
  assert.equal(pgl.interest_date, "2026-10-18");
  assert.equal(pgl.cost_paise, 5000000);
  assert.equal(pgl.rating, "AA");
  assert.equal(pgl.frequency, "Monthly Payout");
  assert.equal(pgl.yield_bps, 1100);
  assert.equal(pgl.payout_paise, 246575);
  const again = mergeDigiFinn({ payouts, cashflow, existing: once.holdings });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.holdings.length, 2);
});

test("ambiguous cashflow maturity does not overwrite cost", () => {
  const payouts = [{ isin: "INE000000001", issuer: "10.00% ABC 27 NOV 2027",
    date: "2026-10-27", units: 5 }];
  const cashflow = [
    { index: 0, name: "ABC", maturity: "2027-11-27", investment_paise: 100 },
    { index: 1, name: "ABC CAPITAL", maturity: "2027-11-27", investment_paise: 200 },
  ];
  const existing = [{ security_id: "INE000000001", label: "ABC 27 NOV 2027",
    quantity: 5, cost_paise: 999, value_paise: null }];
  const out = mergeDigiFinn({ payouts, cashflow, existing });
  const row = out.holdings.find((h) => h.security_id === "INE000000001");
  assert.equal(row.cost_paise, 999);
  assert.equal(out.cashflowMatched, 0);
});

test("merge keeps stale rows, replace removes them", () => {
  const payouts = [{ isin: "INE000000002", issuer: "10.00% NEW 31 DEC 2026",
    date: "2026-10-31", units: 2 }];
  const existing = [{ security_id: "INE000000001", label: "OLD 31 DEC 2026",
    quantity: 1, cost_paise: 100, value_paise: null }];
  assert.equal(mergeDigiFinn({ payouts, existing }).holdings.length, 2);
  assert.equal(mergeDigiFinn({ payouts, existing, mode: "replace" }).holdings.length, 1);
});

test("portfolio scoring prefers the ISIN overlap", () => {
  const files = { payouts: { rows: [
    { isin: "INE000000001" }, { isin: "INE000000002" },
  ] } };
  const a = scorePortfolio([{ security_id: "INE000000001" }], files);
  const b = scorePortfolio([{ security_id: "INE999999999" }], files);
  const duplicate = scorePortfolio([{ security_id: "INE000000001" },
    { security_id: "INE000000001" }], files);
  assert.equal(a.score, 1);
  assert.equal(b.score, 0);
  assert.equal(duplicate.score, 1);
  assert.equal(a.basis, "ISIN");
});

test("short issuer names still score against full bond labels", () => {
  assert.ok(nameScore("PGL", "10.00% PGL 18 AUG 2028") > 0.9);
  assert.ok(nameScore("IIFL SAMASTA", "9.25% IIFL SAMASTA FINANCE LTD 24 DEC 2028") > 0.9);
});

test("the cashflow schedule gives the future interest and principal", () => {
  const c = parseCashflow(cashflowCsv(), "x.csv", "2026-10-01");
  assert.equal(c.groups[0].future_interest_paise, 45833);
  assert.equal(c.groups[0].future_principal_paise, 0);
  assert.deepEqual(c.groups[0].principal_dates, []);
  assert.equal(c.groups[1].future_interest_paise, 21667);
  // A row already behind us is not future money.
  const stale = parseCashflow(cashflowCsv(), "x.csv", "2026-11-01");
  assert.equal(stale.groups[0].future_interest_paise, null);
  assert.equal(stale.groups[0].future_principal_paise, null);
});
