import test from "node:test";
import assert from "node:assert/strict";
import { parseIciciHoldings, looksLikeIciciHoldings, iciciCategory }
  from "./icici.js";
import { detectImportFile } from "./import-flow.js";
import { looksLikeZerodhaHoldings } from "./zerodha.js";
import { parseCsv } from "./digifinn.js";
import { DETECTION_CASES, ICICI_HOLDINGS_MATRIX, ICICI_HOLDINGS_TEXT,
  KITE_CONSOLE_SHEETS, ZERODHA_HOLDINGS_MATRIX } from "./fixtures/import/samples.mjs";

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const permute = (rows, order) => rows.map((row) => order.map((i) => row[i] ?? ""));
const rename = (rows, from, to) => rows.map((row) => row.map((cell) =>
  text(cell) === from ? to : cell));
const extra = (rows, name, value) => rows.map((row, index) =>
  index === 0 ? [...row, name] : [...row, value]);
const csv = (rows) => rows.map((row) => row.map((cell) => {
  const s = String(cell ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\n");

test("reads an ICICI Direct holdings export by header, not by position", () => {
  const parsed = parseIciciHoldings(ICICI_HOLDINGS_MATRIX,
    { file: "ICICI_Holdings.csv", asOf: "2026-11-19" });
  assert.equal(parsed.error, null);
  assert.equal(parsed.asOf, "2026-11-19");
  assert.equal(parsed.asOfSource, "download");
  assert.equal(parsed.headerRow, 0);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(parsed.rows.map((row) => row.category),
    ["equity", "bond", "bond", "bond"]);
  const equity = parsed.rows[0];
  assert.equal(equity.label, "TEST EQUITY ONE");
  assert.equal(equity.symbol, "TEONE");
  assert.equal(equity.isin, "INE000001010");
  assert.equal(equity.quantity, 3);
  assert.equal(equity.valuePaise, 30375);
  assert.equal(equity.costPaise, null);
  assert.equal(equity.sourceRow, 2);
  const blankSymbol = parsed.rows[2];
  assert.equal(blankSymbol.symbol, "");
  assert.equal(blankSymbol.label, "8.50% TEST BOND 2031");
  assert.equal(blankSymbol.valuePaise, 500000);
});

test("the file prints no date, so the import day is the snapshot date", () => {
  const before = new Date().toISOString().slice(0, 10);
  const parsed = parseIciciHoldings(ICICI_HOLDINGS_MATRIX, { file: "holdings.csv" });
  const after = new Date().toISOString().slice(0, 10);
  assert.ok([before, after].includes(parsed.asOf));
  assert.equal(parsed.asOfSource, "download");
  assert.equal(parsed.error, null);
});

test("classifies 01 as equity and 07, 08 and 09 as bonds", () => {
  assert.equal(iciciCategory("INE000001010"), "equity");
  assert.equal(iciciCategory("INE000007020"), "bond");
  assert.equal(iciciCategory("INE000008030"), "bond");
  assert.equal(iciciCategory("INE000009040"), "bond");
  assert.equal(iciciCategory("INE000002040"), null);
  assert.equal(iciciCategory("INF000001010"), null);
  assert.equal(iciciCategory("not-an-isin"), null);
});

test("an unrecognised security type is refused by file, row, ISIN and code", () => {
  const matrix = ICICI_HOLDINGS_MATRIX.map((row) => [...row]);
  matrix[1][2] = "INE000002040";
  const parsed = parseIciciHoldings(matrix, { file: "ICICI_Holdings.csv" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /ICICI_Holdings\.csv → Holdings, row 2/);
  assert.match(parsed.error, /"ISIN" has security type "02" \(Postal Savings Scheme\)/);
  assert.match(parsed.error, /INE000002040/);
  assert.equal(parsed.refusal?.column, "ISIN");
  assert.equal(parsed.refusal?.row, 2);
});

test("a fund or government ISIN is not mistaken for a company equity", () => {
  const matrix = ICICI_HOLDINGS_MATRIX.map((row) => [...row]);
  matrix[1][2] = "INF000001010";
  const parsed = parseIciciHoldings(matrix, { file: "ICICI_Holdings.csv" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /ICICI_Holdings\.csv → Holdings, row 2/);
  assert.match(parsed.error, /not a company security ISIN/);
});

test("reordered, renamed, extra column and CSV forms agree", () => {
  const base = parseIciciHoldings(ICICI_HOLDINGS_MATRIX, { asOf: "2026-11-19" });
  assert.equal(base.error, null);
  const order = [9, 8, 2, 3, 4, 5, 6, 7, 0, 1];
  const variants = {
    reordered: parseIciciHoldings(permute(ICICI_HOLDINGS_MATRIX, order),
      { asOf: "2026-11-19" }),
    renamed: parseIciciHoldings(rename(rename(ICICI_HOLDINGS_MATRIX,
      "Current Market Price", "LTP"), "Block For Margin", "Blocked for Margin"),
    { asOf: "2026-11-19" }),
    extra: parseIciciHoldings(extra(ICICI_HOLDINGS_MATRIX, "Notes", "ignored"),
      { asOf: "2026-11-19" }),
    csv: parseIciciHoldings(parseCsv(csv(ICICI_HOLDINGS_MATRIX)),
      { asOf: "2026-11-19" }),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same holdings`);
    assert.equal(parsed.asOf, "2026-11-19", name);
  }
});

test("a renamed required column refuses by file, column and row", () => {
  const broken = rename(ICICI_HOLDINGS_MATRIX, "Allocated Quantity", "Quantity Held");
  const parsed = parseIciciHoldings(broken, { file: "ICICI_Holdings.csv" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /ICICI_Holdings\.csv → Holdings/);
  assert.match(parsed.error, /"Allocated Quantity"/);
  assert.match(parsed.error, /row 1/);
});

test("an unreadable Market Value refuses by file, column and row", () => {
  const matrix = ICICI_HOLDINGS_MATRIX.map((row) => [...row]);
  matrix[2][8] = "5O,OOO";
  const parsed = parseIciciHoldings(matrix, { file: "ICICI_Holdings.csv" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /ICICI_Holdings\.csv → Holdings, row 3/);
  assert.match(parsed.error, /"Market Value" is not a number \("5O,OOO"\)/);
});

test("the exact ICICI header is detected as ICICI, never as DigiFinn or Zerodha", () => {
  for (const name of ["ICICI_Holdings.csv", "holdings.csv", "holdings-report.csv"]) {
    const detected = detectImportFile({ name, text: ICICI_HOLDINGS_TEXT });
    assert.equal(detected.kind, "icici-holdings", name);
    assert.equal(detected.family, "icici", name);
    assert.equal(detected.confidence, "content", name);
  }
  assert.equal(detectImportFile({ name: "ICICI_Holdings.xlsx",
    matrix: ICICI_HOLDINGS_MATRIX }).kind, "icici-holdings");
  assert.equal(looksLikeIciciHoldings(ICICI_HOLDINGS_MATRIX), true);
  assert.equal(looksLikeZerodhaHoldings(ICICI_HOLDINGS_MATRIX), false);
  assert.equal(looksLikeIciciHoldings(ZERODHA_HOLDINGS_MATRIX), false);
  for (const sheet of Object.values(KITE_CONSOLE_SHEETS)) {
    assert.equal(looksLikeIciciHoldings(sheet), false);
  }
});

test("no other fixture is claimed by the ICICI detector", () => {
  for (const item of DETECTION_CASES.filter((entry) => entry.kind !== "icici-holdings")) {
    const detected = detectImportFile({ name: item.name, text: item.text || "",
      matrix: item.matrix || null });
    assert.notEqual(detected.kind, "icici-holdings", item.name);
  }
});

test("malformed input fails closed instead of throwing", () => {
  for (const input of [undefined, null, [], [["hello", "world"]]]) {
    const parsed = parseIciciHoldings(input);
    assert.ok(parsed.error);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.refusal, null);
  }
});
