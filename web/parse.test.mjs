import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseStatement, chronological, rowsFromCsv, parseDate, parseDateInText } from "./parse.js";
import { makeStore } from "./db.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const XLSX = require("./vendor/xlsx.full.min.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});
const DIR = new URL("./fixtures/banks/", import.meta.url).pathname;

function rowsFor(name) {
  if (name.endsWith(".csv")) {
    return rowsFromCsv(readFileSync(join(DIR, name), "utf8").replace(/^\uFEFF/, ""));
  }
  const wb = XLSX.read(readFileSync(join(DIR, name)), { type: "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
    { header: 1, raw: false, defval: "" });
}
const parsed = (name) => parseStatement(rowsFor(name));
const files = readdirSync(DIR).filter((f) => /\.(csv|xlsx)$/i.test(f));
const dated = (p) => p.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)).length;

// Counts cross-checked against the Python normalizer's output for the same files.
const EXPECTED_DATED = {
  "scb-savings-2026-10.csv": 13,
  "scb-current-2026-10.csv": 52,
  "icici-savings-2026-08.xlsx": 52,
  "icici-savings-2026-10.xlsx": 113,
  "sbi-savings-2026-07.xlsx": 4,
};

test("all six bank export fixtures are present", () => {
  assert.equal(files.length, 6, files.join(", "));
});

test("each dated export parses to the same transaction count as the Python normalizer", () => {
  for (const [name, want] of Object.entries(EXPECTED_DATED)) {
    const p = parsed(name);
    assert.ok(!p.error, `${name}: ${p.error}`);
    assert.equal(dated(p), want, `${name}: dated rows`);
  }
});

test("the irregular PDF-style export is read without throwing, and is flagged", () => {
  const name = files.find((f) => f.startsWith("pnb-"));
  const p = parsed(name);
  assert.ok(p.rows.length > 0, "rows were extracted");
  assert.equal(dated(p), 0, "no ISO dates in a headerless ragged layout");
  assert.equal(p.rows.filter((r) => r.amount !== null).length, 22);
});

test("dates are ISO and never month-first", () => {
  for (const f of files) {
    for (const r of parsed(f).rows) {
      if (!r.date) continue;
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${f}: ${r.date}`);
      const [, m, d] = r.date.split("-").map(Number);
      assert.ok(m >= 1 && m <= 12 && d >= 1 && d <= 31, `${f}: ${r.date}`);
    }
  }
});

test("amounts are integer paise", () => {
  for (const f of files) {
    for (const r of parsed(f).rows) {
      if (r.amount !== null) assert.ok(Number.isInteger(r.amount), `${f}: ${r.amount}`);
      if (r.balance !== null) assert.ok(Number.isInteger(r.balance), `${f}: ${r.balance}`);
    }
  }
});

test("a real export imported twice stores each transaction once", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const name = "scb-savings-2026-10.csv";
  const p = parsed(name);
  const want = dated(p);
  const first = store.importRows("scb-mom", p.rows);
  const second = store.importRows("scb-mom", p.rows);
  assert.equal(first.inserted, want);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, want);
  assert.equal(store.summary().facts, want);
});

test("an overlapping statement imports only the new rows", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const p = parsed("scb-current-2026-10.csv");
  const first = store.importRows("scb-mom", p.rows);
  const extra = { date: "2026-12-01", amount: -12345, balance: 46775186,
                  description: "OVERLAP NEW ROW", source_row: 99 };
  const res = store.importRows("scb-mom", [...p.rows, extra]);
  assert.equal(first.inserted, dated(p));
  assert.equal(res.inserted, 1);
  assert.equal(res.duplicates, dated(p));
  assert.equal(store.summary().facts, dated(p) + 1);
});

import { scanPreamble, guessAccount, sameAccountNumber } from "./parse.js";

test("the preamble yields account numbers and an IFSC", () => {
  const rows = [
    ["HDFC Bank Ltd", "", ""],
    ["Account No: 99990234567890", "", ""],
    ["IFSC: HDFC0001234  Branch: Koramangala", "", ""],
    ["Statement of account", "", ""],
    ["Date", "Narration", "Amount"],
    ["01/04/2024", "x", "10"],
  ];
  const p = scanPreamble(rows, 4);
  assert.ok(p.numbers.includes("99990234567890"));
  assert.equal(p.ifsc, "HDFC0001234");
});

test("an account number matches the right account, high confidence", () => {
  const p = scanPreamble([["A/C 99990048219300"]], 0);
  const hit = guessAccount(p, [
    { id: "icici-dad", number: "9999 1111 2222", bank: "ICICI" },
    { id: "hdfc-dad", number: "9999 0048 2193 00", bank: "HDFC" },
  ]);
  assert.equal(hit.id, "hdfc-dad");
  assert.equal(hit.confidence, "high");
});

test("a last-four match is medium confidence, not a guess", () => {
  const p = scanPreamble([["Acct 9999009300"]], 0);
  const hit = guessAccount(p, [{ id: "a", number: "99990048219300" }]);
  assert.equal(hit.id, "a");
  assert.equal(hit.confidence, "medium");
});

test("with no number, the bank name is a low-confidence fallback", () => {
  const p = scanPreamble([["ICICI BANK statement"]], 0);
  const hit = guessAccount(p, [{ id: "icici-dad", number: "1234", bank: "ICICI Bank" }]);
  assert.equal(hit.id, "icici-dad");
  assert.equal(hit.confidence, "low");
});

test("nothing matching returns null rather than a wrong account", () => {
  const p = scanPreamble([["some statement"]], 0);
  assert.equal(guessAccount(p, [{ id: "a", number: "999999", bank: "HDFC" }]), null);
});

test("account numbers compare by digits, whatever the spacing", () => {
  assert.equal(sameAccountNumber("9999 0048 2193 00", "9999-0048-219300"), true);
  assert.equal(sameAccountNumber("99990048219300", " 9999 0048 2193 00 "), true);
});

test("different account numbers do not match", () => {
  assert.equal(sameAccountNumber("9999 0048 2193 00", "9999 0048 2193 01"), false);
  assert.equal(sameAccountNumber("9999 0048 2193 00", "9999 1111 2222 33"), false);
});

test("an empty account number never matches", () => {
  assert.equal(sameAccountNumber("", "9999 0048 2193 00"), false);
  assert.equal(sameAccountNumber("9999 0048 2193 00", "no number"), false);
  assert.equal(sameAccountNumber(null, undefined), false);
});

test("impossible years fail closed, and prose dates are read", () => {
  assert.equal(parseDate("4020-12-15"), "");
  assert.equal(parseDate("221-07-20"), "");
  assert.equal(parseDate("200-06-10"), "");
  assert.equal(parseDate("3014-02-28"), "");
  assert.equal(parseDate("01.04.99"), "1999-04-01");
  assert.equal(parseDateInText("Issue 22/11/2025"), "2025-11-22");
  assert.equal(parseDateInText("Maturity:27/11/2026"), "2026-11-27");
  assert.equal(parseDateInText("Policy upto July 2042"), "2042-07-01");
  assert.equal(parseDateInText("17.12.20226 mat"), "");
});

test("dates written with a month name are parsed", () => {
  assert.equal(parseDate("15-Apr-2024"), "2024-04-15");
  assert.equal(parseDate("15 Apr 24"), "2024-04-15");
  assert.equal(parseDate("1 September 2026"), "2026-09-01");
  assert.equal(parseDate("15-Foo-2024"), "");
});

test("Excel serials and trailing punctuation are dates", () => {
  assert.equal(parseDate("45123"), "2023-07-16");
  assert.equal(parseDate("01.04.2024."), "2024-04-01");
  assert.equal(parseDate("15-Apr-2024."), "2024-04-15");
  assert.equal(parseDate("999"), "");
});

test("comma dates and month-year dates are parsed", () => {
  assert.equal(parseDate("01.04,2024"), "2024-04-01");
  assert.equal(parseDate("01.04,24"), "2024-04-01");
  assert.equal(parseDate("12.2024"), "2024-12-01");
  assert.equal(parseDate("2024/2025"), "");
});

test("newest-first statements are reported and can be put back in date order", () => {
  const rows = rowsFromCsv([
    "Date,Description,Deposit,Withdrawal,Balance",
    "03/04/2024,LATER,\"\",\"1,000.00\",\"9,000.00\"",
    "01/04/2024,EARLIER,\"10,000.00\",\"\",\"10,000.00\"",
  ].join("\n"));
  const p = parseStatement(rows);
  assert.equal(p.order, "desc");
  assert.equal(p.rows[0].date, "2024-04-03");
  const asc = chronological(p);
  assert.equal(asc[0].date, "2024-04-01");
  assert.equal(asc[1].date, "2024-04-03");
  assert.equal(asc[1].balance, 900000);
});

test("dirty date cells are normalised without guessing", () => {
  assert.equal(parseDate("20240401"), "2024-04-01");
  assert.equal(parseDate(".01.04.2024"), "2024-04-01");
  assert.equal(parseDate("01.04.2024-5"), "2024-04-01");
  assert.equal(parseDate("01..04.2024"), "2024-04-01");
  assert.equal(parseDate("01.04.]2024"), "2024-04-01");
  assert.equal(parseDate("01.04.20245"), "");
  assert.equal(parseDate("2024/2025"), "");
});

test("the labelled account number wins over an earlier long number", () => {
  const rows = [
    ["Statement 20240101"],
    ["Account Number : 999900482193"],
    ["IFSC: ICIC0000009"],
  ];
  const pre = scanPreamble(rows, 3);
  assert.equal(pre.accountNumber, "999900482193");
  assert.equal(pre.ifsc, "ICIC0000009");
});

test("same-day rows are read newest-first when the balance says so", () => {
  const csv = [
    "Supervalue Savings a/c",
    "Date,Transaction,Deposit,Withdrawal,Running Balance",
    '27/10/2026,"ONLINE FUND TRANSFER SELF",,"450,000.00","112,466.11"',
    '27/10/2026,"TRANSFER ONE",,"450,000.00","562,466.11"',
    '27/10/2026,"TRANSFER TWO",,"201,000.00","1,012,466.11"',
  ].join("\n");
  const parsed = parseStatement(rowsFromCsv(csv));
  assert.equal(parsed.order, "desc");
  const rows = chronological(parsed).filter((r) => r.date && r.amount !== null);
  // Oldest first: the 201,000 debit is the last one in the file, so it comes first.
  assert.deepEqual(rows.map((r) => r.amount), [-20100000, -45000000, -45000000]);
  assert.deepEqual(rows.map((r) => r.balance), [101246611, 56246611, 11246611]);
});

test("a single-date file in oldest-first order is left alone", () => {
  const csv = [
    "Date,Transaction,Deposit,Withdrawal,Running Balance",
    '27/10/2026,"FIRST",,"201,000.00","1,912,466.11"',
    '27/10/2026,"SECOND",,"450,000.00","1,462,466.11"',
  ].join("\n");
  const parsed = parseStatement(rowsFromCsv(csv));
  assert.equal(parsed.order, "");
  assert.deepEqual(chronological(parsed).map((r) => r.amount), [-20100000, -45000000]);
});

test("a passbook sheet that labels only Debits and Credits is read", () => {
  const matrix = [
    ["Punjab national bank", "", "", "", ""],
    ["B/F", "", "Debits", "Credits", 16046.24],
    ["16.09.06", "chq:28886 cmwsse", 6912, "", 9134.24],
    ["18.09.06", "cash deposit", "", 31000, 40134.24],
  ];
  const parsed = parseStatement(matrix);
  assert.equal(parsed.header, 2);
  assert.deepEqual(parsed.mapping, ["date", "description", "debit", "credit", "balance"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].date, "2006-09-16");
  assert.equal(parsed.rows[0].amount, -691200);
  assert.equal(parsed.rows[0].balance, 913424);
  assert.equal(parsed.rows[1].amount, 3100000);
  assert.equal(parsed.rows[1].balance, 4013424);
});

test("a helpline number is not read as the account number", () => {
  const matrix = [
    ["Punjab national bank: helpline 18001802222/18001032222 26454620 Phone No Branch", "", "", "", ""],
    ["B/F", "", "Debits", "Credits", 16046.24],
    ["16.09.06", "chq:28886", 6912, "", 9134.24],
  ];
  const pre = scanPreamble(matrix, 1);
  assert.equal(pre.accountNumber, "");
  assert.deepEqual(pre.numbers, []);
});

test("a labelled account number is still read", () => {
  const pre = scanPreamble([["Account No: 1234 5678 9012", ""]], 0);
  assert.equal(pre.accountNumber, "123456789012");
});
