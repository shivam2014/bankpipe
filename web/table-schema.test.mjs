import test from "node:test";
import assert from "node:assert/strict";
import {
  headerKey, columnLetter, resolveColumns, findHeaderRow, headerMessage,
  parseAmount, parseMoney, normaliseNumber, parseDate, parseDateDetail,
  isBlank, readNumber, readDate, RefusalError, tableWhere, refusalOf,
} from "./table-schema.js";

const schema = {
  isin: { label: "ISIN", aliases: ["isin", "isin code"], required: true },
  qty: { label: "Quantity", aliases: ["quantity available", "quantity", "qty", "units"], required: true },
  avg: { label: "Average Price", aliases: ["average price", "avg price", "average cost"] },
};

test("a header key ignores case, punctuation and spacing", () => {
  assert.equal(headerKey("  Quantity (Available) "), "quantity available");
  assert.equal(headerKey("Qty."), "qty");
  assert.equal(headerKey("Investment Value (₹)"), "investment value");
  assert.equal(headerKey(null), "");
});

test("columns are resolved by name through aliases, in one row", () => {
  const header = resolveColumns(["Symbol", "ISIN", "Qty", "Average Price"], schema);
  assert.deepEqual(header.columns, { isin: 1, qty: 2, avg: 3 });
  assert.deepEqual(header.missing, []);
  assert.equal(header.aliases.qty, "qty");
});

test("a column no field names is ignored", () => {
  const header = resolveColumns(["ISIN", "Mystery", "Quantity"], schema);
  assert.deepEqual(header.columns, { isin: 0, qty: 2 });
  assert.equal(header.missing.length, 0);
});

test("a missing required column is named with the aliases that were tried", () => {
  const header = resolveColumns(["ISIN", "Average Price"], schema);
  assert.equal(header.missing.length, 1);
  assert.equal(header.missing[0].label, "Quantity");
  assert.deepEqual(header.missing[0].aliases, ["quantity available", "quantity", "qty", "units"]);
});

test("one name printed twice is ambiguous, not guessed", () => {
  const header = resolveColumns(["ISIN", "Quantity", "Quantity"], schema);
  assert.equal(header.columns.isin, 0);
  assert.equal(header.columns.qty, undefined);
  assert.equal(header.missing[0].reason, "ambiguous");
  assert.deepEqual(header.missing[0].columns, [1, 2]);
});

test("a later alias can resolve a field when an earlier one is ambiguous", () => {
  const header = resolveColumns(["Quantity", "Quantity", "Qty", "ISIN"], schema);
  assert.equal(header.columns.qty, 2);
  assert.equal(header.missing.length, 0);
});

test("the header row is the first row that carries every required name", () => {
  const rows = [
    ["Summary", "Invested Value"],
    ["ISIN", "Quantity"],
    ["INE000000001", 10],
  ];
  const header = findHeaderRow(rows, schema);
  assert.equal(header.index, 1);
  assert.deepEqual(header.columns, { isin: 0, qty: 1 });
});

test("a preamble longer than a dozen rows is still scanned", () => {
  const rows = Array.from({ length: 25 }, (_, i) => [`Note ${i}`]);
  rows.push(["ISIN", "Qty"]);
  assert.equal(findHeaderRow(rows, schema).index, 25);
});

test("no header names the closest row and every required column", () => {
  const rows = [["ISIN", "Average Price"], ["INE000000001", 10]];
  const header = findHeaderRow(rows, schema);
  assert.equal(header.index, -1);
  assert.equal(header.nearest.index, 0);
  const message = headerMessage({ file: "kite.xlsx", sheet: "Equity" }, schema, header);
  assert.match(message, /kite\.xlsx → Equity/);
  assert.match(message, /row 1/);
  assert.match(message, /"Quantity"/);
});

test("a refusal names the file, the sheet, the column, the row and the value", () => {
  const where = { file: "kite.xlsx", sheet: "Equity" };
  const columns = { qty: 0 };
  assert.throws(() => readNumber(["1O"], columns, "qty",
    { where, schema, rowNumber: 7 }), (error) => {
    assert.ok(error instanceof RefusalError);
    assert.equal(error.refusal.column, "Quantity");
    assert.equal(error.refusal.row, 7);
    assert.equal(error.refusal.value, "1O");
    assert.match(error.message, /kite\.xlsx → Equity, row 7/);
    assert.match(error.message, /"Quantity" is not a number \("1O"\)/);
    return true;
  });
});

test("a blank numeric cell is null unless the caller requires a number", () => {
  assert.equal(readNumber([""], { qty: 0 }, "qty", { where: {}, schema }), null);
  assert.equal(readNumber(["  "], { qty: 0 }, "qty", { where: {}, schema }), null);
  assert.equal(readNumber(["-"], { qty: 0 }, "qty", { where: {}, schema }), null);
  assert.throws(() => readNumber([""], { qty: 0 }, "qty",
    { where: { file: "f.csv" }, schema, rowNumber: 4, required: true }),
    /"Quantity" is empty, and a number is required/);
});

test("a date cell refuses a shape it cannot read, and reports ambiguity", () => {
  const parsed = readDate(["05/06/2026"], { date: 0 }, "date",
    { where: {}, schema: { date: { label: "Date", aliases: ["date"] } } });
  assert.equal(parsed.iso, "2026-06-05");
  assert.equal(parsed.ambiguous, true);
  assert.throws(() => readDate(["31/02/2026"], { date: 0 }, "date",
    { where: { file: "f.csv" }, schema: { date: { label: "Date", aliases: ["date"] } }, rowNumber: 3 }),
    /"Date" is not a readable date \("31\/02\/2026"\)/);
});

test("numbers accept grouping, currency, parentheses and signs", () => {
  assert.equal(parseAmount("1,23,456.78"), 123456.78);
  assert.equal(parseAmount("1,234,567.89"), 1234567.89);
  assert.equal(parseAmount("₹ 1,000"), 1000);
  assert.equal(parseAmount("Rs. 1,000.50"), 1000.5);
  assert.equal(parseAmount("INR 250"), 250);
  assert.equal(parseAmount("(1,000)"), -1000);
  assert.equal(parseAmount("(₹1,000.50)"), -1000.5);
  assert.equal(parseAmount("-1,000"), -1000);
  assert.equal(parseAmount("1,000-"), -1000);
  assert.equal(parseAmount("9.00%"), 9);
  assert.equal(parseAmount(12.5), 12.5);
  assert.equal(parseAmount("0.5"), 0.5);
});

test("numbers refuse what they cannot read instead of guessing", () => {
  assert.equal(parseAmount("1O"), null);
  assert.equal(parseAmount("10 units"), null);
  assert.equal(parseAmount("1.234,567.89"), null);
  assert.equal(parseAmount("1,2,3"), null);
  assert.equal(parseAmount("₹1₹2"), null);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(NaN), null);
  assert.equal(normaliseNumber("1,23,456"), "123456");
});

test("money is the same number in paise", () => {
  assert.equal(parseMoney("₹1,000.50"), 100050);
  assert.equal(parseMoney("(1,000)"), -100000);
  assert.equal(parseMoney(""), null);
});

test("celebrated date shapes read the same", () => {
  const cases = [
    ["2026-11-12", "2026-11-12"],
    ["12/11/2026", "2026-11-12"],
    ["12-11-2026", "2026-11-12"],
    ["12.11.2026", "2026-11-12"],
    ["12-Nov-2026", "2026-11-12"],
    ["12 Nov 26", "2026-11-12"],
    ["Nov 12, 2026", "2026-11-12"],
    ["20261112", "2026-11-12"],
    ["12112026", "2026-11-12"],
    ["12/11/26", "2026-11-12"],
    ["11/2026", "2026-11-01"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseDate(input), expected, input);
  }
});

test("a day above 12 settles the order; both fitting a month is day-first and flagged", () => {
  assert.deepEqual(parseDateDetail("31/12/2026"),
    { iso: "2026-12-31", ambiguous: false, order: "day-first" });
  assert.deepEqual(parseDateDetail("12/31/2026"),
    { iso: "2026-12-31", ambiguous: false, order: "month-first" });
  assert.deepEqual(parseDateDetail("05/06/2026"),
    { iso: "2026-06-05", ambiguous: true, order: "day-first" });
  assert.deepEqual(parseDateDetail("05/05/2026"),
    { iso: "2026-05-05", ambiguous: false, order: "day-first" });
});

test("two-digit years follow the bond rule", () => {
  assert.equal(parseDate("01/01/79"), "2079-01-01");
  assert.equal(parseDate("01/01/80"), "1980-01-01");
});

test("impossible calendar days and junk are refused", () => {
  for (const input of ["31/02/2026", "13/13/2026", "2026-02-30", "not a date", "", null, 12]) {
    assert.equal(parseDate(input), "", String(input));
  }
});

test("an Excel serial date reads as a date, not a year or an amount", () => {
  assert.equal(parseDate(46344), "2026-11-18");
  assert.equal(parseDate("46344"), "2026-11-18");
});

test("blank markers are blank, not zero and not unreadable", () => {
  for (const value of [null, undefined, "", "  ", "-", "--", "—", "N/A", "nil"]) {
    assert.equal(isBlank(value), true, String(value));
  }
  assert.equal(isBlank(0), false);
  assert.equal(isBlank("0"), false);
});

test("a loose field accepts a unit suffix, a strict field does not", () => {
  const loose = { quantity: { label: "Quantity", loose: true, aliases: ["quantity"] } };
  assert.equal(resolveColumns(["Quantity (Units)"], loose).columns.quantity, 0);
  assert.equal(resolveColumns(["Holding Quantity"], loose).columns.quantity, 0);
  const strict = {
    isin: { label: "ISIN", aliases: ["isin"], required: true },
    quantity: { label: "Quantity", aliases: ["quantity"], required: true },
  };
  // "Quantity Discrepant" must not stand in for "Quantity" in a Kite export.
  const header = resolveColumns(["ISIN", "Quantity Discrepant"], strict);
  assert.equal(header.columns.quantity, undefined);
  assert.equal(header.missing[0].label, "Quantity");
});

test("a table location reads as file, sheet and table in one phrase", () => {
  assert.equal(tableWhere({ file: "a.xlsx", sheet: "Equity" }), "a.xlsx → Equity");
  assert.equal(tableWhere({ file: "a.csv" }), "a.csv");
  assert.equal(tableWhere({}), "this file");
  assert.match(refusalOf({ file: "a.csv" }, { column: "Qty", reason: "is missing" }).message,
    /a\.csv: "Qty" is missing\./);
});

test("spreadsheet column letters run past Z", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
});
