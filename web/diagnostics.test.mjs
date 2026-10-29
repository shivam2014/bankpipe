import test from "node:test";
import assert from "node:assert/strict";
import { shape, maskLabel, sheetReport, buildReport, dateFormat } from "./diagnostics.js";
import { parseStatement } from "./parse.js";

const rows = [
  ["HDFC Bank", "", ""],
  ["Account No: 99990234567890", "", ""],
  ["Date", "Narration", "Amount"],
  ["01/04/2024", "UPI-SWIGGY LTD 9876543210", "-1,250.00"],
];
const parsed = {
  header: 3,
  mapping: ["date", "description", "amount"],
  rows: [{
    date: "2024-04-01", description: "UPI-SWIGGY LTD 9876543210",
    amount: -125000, balance: 5000000,
  }],
};

test("a shape keeps structure and drops content", () => {
  assert.equal(shape("01/04/2024"), "99/99/9{4}");
  assert.equal(shape("1250.00"), "9{4}.99");
  assert.equal(shape("2024"), "9{4}");
  assert.equal(shape("123"), "999");
  assert.equal(shape(""), "");
});

test("headers keep their words but lose long digit runs", () => {
  assert.equal(maskLabel("Account No 99990234567890"), "Account No ########");
});

test("date formats are classified, not echoed", () => {
  assert.equal(dateFormat("01/04/2024"), "dd/mm/yyyy");
  assert.equal(dateFormat("2024-04-01"), "iso");
  assert.equal(dateFormat("garbage"), "text");
});

test("the report contains no account number, amount, narration or ISIN", () => {
  const rep = buildReport({ ext: "xlsx", bytes: 12345, sha256: "abcdef0123456789ff" },
    [sheetReport("ICICI 5010", rows, parsed, { inserted: 1, duplicates: 0 })]);
  for (const secret of ["99990234567890", "SWIGGY", "1250", "-1,250.00",
    "9876543210", "INE002A01018", "HDFC Bank"]) {
    assert.equal(rep.includes(secret), false, `leaked: ${secret}`);
  }
});

test("header labels travel as shapes, never as text", () => {
  const rep = buildReport({ ext: "xlsx", bytes: 1, sha256: "x" },
    [sheetReport("ICICI", rows, parsed)]);
  assert.match(rep, /columns: A\{4\} \| A\{9\} \| A\{6\}/);
  assert.equal(rep.includes("Narration"), false);
});

test("the report still carries what a fix needs", () => {
  const rep = buildReport({ ext: "xlsx", bytes: 1, sha256: "x" },
    [sheetReport("ICICI", rows, parsed)]);
  assert.match(rep, /header_row=3/);
  assert.match(rep, /mapping: date@0, description@1, amount@2/);
  assert.match(rep, /raw_rows=4 rows=1 parsed=1 skipped=0 dated=1 amounts=1 missing_amount=0/);
  assert.match(rep, /dd\/mm\/yyyy/);
  assert.match(rep, /unparsed_dates=0/);
});

test("raw date formats are counted before they are normalised", () => {
  const raw = [
    ["Date", "Narration", "Amount"],
    ["01/04/2024", "A", "1,250.00"],
    ["2024-04-02", "B", "500.00"],
    ["n/a", "C", "10.00"],
  ];
  const rep = buildReport({ ext: "csv", bytes: 1, sha256: "x" },
    [sheetReport("S", raw, parseStatement(raw))]);
  assert.match(rep, /raw_dates=3/);
  assert.match(rep, /"dd\/mm\/yyyy":1/);
  assert.match(rep, /"iso":1/);
  assert.match(rep, /"text":1/);
  assert.match(rep, /unparsed_dates=1/);
});

test("sheet names are masked, not printed", () => {
  const rep = buildReport({ ext: "csv", bytes: 1, sha256: "x" },
    [sheetReport("PNB 9999001000765843", rows, parsed)]);
  assert.equal(rep.includes("9999001000765843"), false);
  assert.equal(rep.includes("PNB"), false);
  assert.match(rep, /SHEET 1 \(AAA 9\{16\}\)/);
});

test("a failed sheet reports the reason and no values", () => {
  const rep = buildReport({ ext: "csv", bytes: 1, sha256: "x" },
    [sheetReport("1092", rows,
      { header: null, rows: [], error: "no recognisable header row" })]);
  assert.match(rep, /error=no recognisable header row/);
  assert.match(rep, /header_row=none/);
  assert.match(rep, /raw_rows=4 rows=0 parsed=0/);
});

test("the file name is never printed, only its extension", () => {
  const rep = buildReport({ ext: "xlsx", bytes: 10, sha256: "0123456789abcdef" },
    [sheetReport("S", rows, parsed)]);
  assert.match(rep, /file: \*xlsx/);
  assert.match(rep, /sha256_16: 0123456789abcdef/);
  assert.equal(rep.includes("0123456789abcdef99"), false);
});
