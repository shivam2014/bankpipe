import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCashflow, parseCsv, parsePayouts } from "./digifinn.js";
import { parseReportFile } from "./digifinn-reports.js";
import { detectImportFile } from "./import-flow.js";

// The fixtures are synthetic copies of the shapes the portal actually exports,
// kept under web/fixtures/import/digifinn. The private files they mirror never
// enter the repository; this suite proves the shapes, not the holder.
const fixture = (name) => readFileSync(
  new URL(`./fixtures/import/digifinn/${name}`, import.meta.url), "utf8");

const toCsv = (rows) => rows
  .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
  .join("\n");

test("the holdings fixture reads its rows and keeps identity out of them", () => {
  const p = parseReportFile(fixture("holdings-report.csv"), "holdings-report.csv");
  assert.equal(p.kind, "portfolio");
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].isin, "INE000000001");
  assert.equal(p.rows[0].quantity, 10);
  assert.equal(p.rows[0].cost_paise, 10000000);
  assert.equal(p.rows[0].purchase_date, "2026-10-23");
  assert.equal(p.demat, "1200000000000001");
  assert.equal(p.asOf, "2026-10-26");
  assert.ok(!JSON.stringify(p.rows).includes("TEST HOLDER ONE"));
  assert.ok(!JSON.stringify(p.rows).includes("ABCDE1234F"));
});

test("the investment fixture reads coupon, yield and invested amount", () => {
  const i = parseReportFile(fixture("investment-report.csv"), "investment-report.csv");
  assert.equal(i.kind, "investment");
  assert.equal(i.rows.length, 2);
  assert.equal(i.rows[1].issuer, "TEST ISSUER TWO LIMITED");
  assert.equal(i.rows[1].coupon_pct, 9.5);
  assert.equal(i.rows[1].yield_pct, 9.5);
  assert.equal(i.rows[1].invested_paise, 20000000);
  assert.equal(i.rows[1].maturity, "2027-12-31");
});

test("a transactions report stacks ORDER SETTLED and ORDER CANCELLED", () => {
  const t = parseReportFile(fixture("transaction-report.csv"), "transaction-report.csv");
  assert.equal(t.kind, "transactions");
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows.map((r) => r.isin), ["INE000000001", "INE000000002"]);
  assert.equal(t.rows[0].value_paise, 1000000);
  // A cancelled order is not a trade: it is counted, not imported.
  assert.equal(t.cancelled, 1);
  assert.equal(t.skipped, 4);
});

test("the Cashflow Future sheet reads every group by its own labels", () => {
  const c = parseCashflow(fixture("portfolio-cashflow-future.csv"), "future.csv", "2026-11-18");
  assert.equal(c.kind, "cashflow");
  assert.equal(c.groups.length, 2);
  const [a, b] = c.groups;
  assert.equal(a.isin, "INE000000001");
  assert.equal(a.yieldPct, 10);
  assert.equal(a.frequency, "Monthly Payout");
  assert.equal(a.maturity, "2026-12-31");
  assert.equal(a.investment_paise, 10000000);
  assert.equal(a.investment_date, "2024-02-15");
  assert.equal(a.next_payout_date, "2026-11-30");
  assert.equal(a.next_payout_paise, 100000);
  assert.equal(a.future_interest_paise, 200000);
  assert.equal(a.future_principal_paise, 10000000);
  assert.deepEqual(a.principal_dates, ["2026-12-31"]);
  assert.equal(b.frequency, "Quarterly Payout");
  assert.equal(b.maturity, "2027-12-31");
  assert.equal(b.investment_paise, 20000000);
  assert.equal(b.investment_date, "2025-03-01");
  assert.equal(b.future_interest_paise, 665000);
  assert.deepEqual(b.principal_dates, ["2027-12-31"]);
});

test("the All-Cashflow sheet adds paid-to-date blocks and keeps the same groups", () => {
  const future = parseCashflow(fixture("portfolio-cashflow-future.csv"), "future.csv", "2026-11-18");
  const all = parseCashflow(fixture("portfolio-cashflow-all.csv"), "all.csv", "2026-11-18");
  assert.equal(all.groups.length, 2);
  assert.deepEqual(all.groups, future.groups);
});

test("a paid row in the All sheet does not become the next payout", () => {
  const rows = parseCsv(fixture("portfolio-cashflow-all.csv"));
  const header = rows.findIndex((row) => row[6] === "Frequency");
  const paid = [...rows[header + 4]];
  paid[2] = "2026-09-30";
  paid[5] = "1000"; paid[6] = "900"; paid[7] = "0"; paid[8] = "900";
  paid[9] = "0"; paid[10] = "0"; paid[11] = "0"; paid[12] = "0";
  rows.splice(header + 4, 0, paid);
  const text = toCsv(rows).replace('"307785"', '"308685"');
  const c = parseCashflow(text, "all-with-history.csv", "2026-11-18");
  assert.equal(c.groups.length, 2);
  assert.ok(c.groups.every((g) => g.next_payout_date >= "2026-11-18"));
});

test("a cashflow group that reorders its labels still reads by name", () => {
  const rows = parseCsv(fixture("portfolio-cashflow-future.csv"));
  const header = rows.findIndex((row) => row[5] === "Yield" && row[6] === "Frequency");
  assert.ok(header > 0);
  // Move Frequency after Maturity in the first group, label and value together.
  for (const row of [rows[header], rows[header + 1]]) {
    [row[6], row[7]] = [row[7], row[6]];
  }
  const c = parseCashflow(toCsv(rows), "reordered.csv", "2026-11-18");
  assert.equal(c.groups.length, 2);
  assert.equal(c.groups[0].frequency, "Monthly Payout");
  assert.equal(c.groups[0].maturity, "2026-12-31");
  assert.equal(c.groups[1].frequency, "Quarterly Payout");
  assert.equal(c.groups[1].maturity, "2027-12-31");
});

test("a cashflow sheet whose rows do not add up to its printed total refuses", () => {
  const text = fixture("portfolio-cashflow-future.csv").replace('"100900"', '"100800"');
  const flow = parseCashflow(text, "portfolio-cashflow-future.csv", "2026-11-18");
  assert.equal(flow.groups.length, 0);
  assert.match(flow.error, /portfolio-cashflow-future\.csv → Cashflow/);
  assert.match(flow.error, /"Total Cashflow" does not match the schedule/);
});

test("a group that does not name Frequency refuses instead of guessing a column", () => {
  const text = fixture("portfolio-cashflow-future.csv").replace('"Yield","Frequency"', '"Yield","Cadence"');
  const c = parseCashflow(text, "portfolio-cashflow-future.csv", "2026-11-18");
  assert.equal(c.groups.length, 0);
  assert.match(c.error, /"Frequency" is not named inside the group at column F/);
});

test("the report reader carries a cashflow refusal to the screen", () => {
  const text = fixture("portfolio-cashflow-future.csv").replace('"100900"', '"100800"');
  const parsed = parseReportFile(text, "portfolio-cashflow-future.csv");
  assert.equal(parsed.kind, "payouts");
  assert.equal(parsed.source, "cashflow");
  assert.equal(parsed.groups.length, 0);
  assert.match(parsed.error, /Total Cashflow/);
});

test("an unreadable Investment Value refuses by column and row", () => {
  const text = fixture("portfolio-cashflow-future.csv").replace('"100000"', '"lots"');
  const c = parseCashflow(text, "portfolio-cashflow-future.csv", "2026-11-18");
  assert.equal(c.groups.length, 0);
  assert.match(c.error, /"Investment Value" is not a number \("lots"\)/);
});

test("both cashflow exports are detected from the sheet, not the file name", () => {
  for (const name of ["portfolio-cashflow-future.csv", "portfolio-cashflow-all.csv"]) {
    const detected = detectImportFile({ name, text: fixture(name) });
    assert.equal(detected.kind, "digifinn-cashflow", name);
    assert.equal(detected.confidence, "content", name);
  }
  const renamed = detectImportFile({ name: "download.csv", text: fixture("portfolio-cashflow-all.csv") });
  assert.equal(renamed.kind, "digifinn-cashflow");
  assert.equal(renamed.confidence, "content");
});

test("the payouts fixture still reads one series per ISIN and units", () => {
  const p = parsePayouts(fixture("upcoming-payouts.csv"), "upcoming-payouts.csv");
  assert.equal(p.rows.length, 4);
  assert.equal(p.rows[0].units, 10);
  assert.equal(p.rows[0].amount_paise, 100000);
});
