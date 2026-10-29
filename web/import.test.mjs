// Import matrix for bank statements and workbooks. Everything here goes
// through the same parse -> plan -> store path the browser uses; fixtures are
// the redacted ones in fixtures/, plus synthetic rows built in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStatement, chronological, auditStatement, rowsFromCsv, parseDate,
  parseMoney, scanPreamble, guessAccount,
} from "./parse.js";
import { makeStore } from "./db.js";
import { isEncryptedOffice, decryptOffice } from "./office-crypto.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const XLSX = require("./vendor/xlsx.full.min.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const BANKS = new URL("./fixtures/banks/", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const ENCRYPTED = new URL("./fixtures/encrypted/example_password.xlsx",
  import.meta.url).pathname;

const parseCsv = (text) => parseStatement(rowsFromCsv(text));

function fixtureRows(name) {
  const base = /hdfc\.xlsx$/i.test(name) ? FIXTURES : BANKS;
  const bytes = readFileSync(join(base, name));
  if (/\.csv$/i.test(name)) return rowsFromCsv(new TextDecoder().decode(bytes));
  const wb = XLSX.read(bytes, { type: "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
    { header: 1, raw: false, defval: "" });
}

// Round-trip a synthetic matrix through a real .xlsx buffer, so the test
// exercises the same sheet_to_json path as a browser upload.
function xlsxRows(matrix) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), "Statement");
  const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const read = XLSX.read(bytes, { type: "buffer" });
  return XLSX.utils.sheet_to_json(read.Sheets[read.SheetNames[0]],
    { header: 1, raw: false, defval: "" });
}

async function newStore() {
  const store = makeStore(SQL, null);
  await store.open();
  return store;
}

// ---------------------------------------------------------------------------
// Header detection: CSV, XLSX, passbook layouts, junk rows
// ---------------------------------------------------------------------------

test("an XLSX statement finds the header below the preamble", () => {
  const p = parseStatement(fixtureRows("hdfc.xlsx"));
  assert.ok(!p.error, p.error);
  assert.equal(p.header, 4);
  assert.deepEqual(p.mapping,
    ["date", "description", "ref", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 12);
  assert.equal(p.order, "asc");
  assert.equal(p.rows[0].date, "2024-04-02");
  assert.equal(p.rows[0].description, "SALARY CR 0");
  assert.equal(p.rows[0].amount, 149525);
  assert.equal(p.rows[0].balance, 12149525);
  assert.equal(p.rows[1].amount, -451748);
});

test("an ICICI XLSX export maps value date, reference and both money columns", () => {
  const p = parseStatement(fixtureRows("icici-savings-2026-08.xlsx"));
  assert.ok(!p.error, p.error);
  assert.equal(p.header, 13);
  assert.deepEqual(p.mapping,
    ["value_date", "date", "ref", "description", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 52);
  assert.equal(p.order, "asc");
  for (const row of p.rows) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(row.amount));
  }
});

test("an XLSX passbook that labels only Debits and Credits is read", () => {
  const rows = xlsxRows([
    ["Punjab National Bank", "", "", "", ""],
    ["B/F", "", "Debits", "Credits", 16046.24],
    ["16.09.06", "chq:28886", "6,912.00", "", "9,134.24"],
    ["18.09.06", "cash deposit", "", "31,000.00", "40,134.24"],
  ]);
  const p = parseStatement(rows);
  assert.equal(p.header, 2);
  assert.deepEqual(p.mapping,
    ["date", "description", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].date, "2006-09-16");
  assert.equal(p.rows[0].amount, -691200);
  assert.equal(p.rows[0].balance, 913424);
  assert.equal(p.rows[1].date, "2006-09-18");
  assert.equal(p.rows[1].amount, 3100000);
  assert.equal(p.rows[1].balance, 4013424);
});

test("a CSV passbook with Debits/Credits, BOM, CRLF and quoted commas is read", () => {
  const text = "\uFEFFAccount: 1234, a passbook\r\n"
    + "\r\n"
    + "B/F,,Debits,Credits,16,046.24\r\n"
    + "16.09.06,\"chq, 28886\",\"6,912.00\",,\"9,134.24\"\r\n"
    + "\r\n"
    + "18.09.06,cash deposit,,\"31,000.00\",\"40,134.24\"\r\n";
  const p = parseCsv(text);
  assert.ok(!p.error, p.error);
  assert.equal(p.header, 2);
  assert.deepEqual(p.mapping,
    ["date", "description", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].description, "chq, 28886");
  assert.equal(p.rows[0].amount, -691200);
  assert.equal(p.rows[1].amount, 3100000);
});

test("BOM, CRLF, quoted commas, Indian amounts, CR/DR suffixes and blank rows", () => {
  const text = "\uFEFFDate,Description,Debit,Credit,Balance\r\n"
    + "01/08/06,\"PAY, SHOP\",\"1,23,456.78 DR\",,\"2,00,000.00\"\r\n"
    + "\r\n"
    + "02/08/06,SALARY,,\"1,23,456.78 CR\",\"3,23,456.78 Cr.\"\r\n";
  const rows = rowsFromCsv(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0].replace(/^\uFEFF/, ""), "Date");
  const p = parseStatement(rows);
  assert.ok(!p.error, p.error);
  assert.equal(p.header, 1);
  assert.deepEqual(p.mapping,
    ["date", "description", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].date, "2006-08-01");
  assert.equal(p.rows[0].description, "PAY, SHOP");
  assert.equal(p.rows[0].amount, -12345678);
  assert.equal(p.rows[0].balance, 20000000);
  assert.equal(p.rows[1].date, "2006-08-02");
  assert.equal(p.rows[1].amount, 12345678);
  assert.equal(p.rows[1].balance, 32345678);
});

test("money suffixes and Indian digit grouping parse to integer paise", () => {
  assert.equal(parseMoney("1,23,456.78 DR"), -12345678);
  assert.equal(parseMoney("1,23,456.78DR"), -12345678);
  assert.equal(parseMoney("1,23,456.78 Dr."), -12345678);
  assert.equal(parseMoney("1,23,456.78 CR"), 12345678);
  assert.equal(parseMoney("1,23,456.78Cr"), 12345678);
  assert.equal(parseMoney("₹1,23,456.78"), 12345678);
  assert.equal(parseMoney("INR 1,23,456.78"), 12345678);
  assert.equal(parseMoney("(1,23,456.78)"), -12345678);
  assert.equal(parseMoney("2,00,000.00 Cr."), 20000000);
  assert.equal(parseMoney("not money"), null);
});

test("unknown columns are ignored, not mistaken for money or dates", () => {
  const p = parseCsv([
    "Date,Narration,Withdrawal Amt,Deposit Amt,Closing Balance,Beneficiary Name,Unnamed: 7",
    '01/08/2026,"UPI, MERCHANT","1,000.00","","9,000.00",ARJUN,EXTRA',
  ].join("\n"));
  assert.ok(!p.error, p.error);
  assert.deepEqual(p.mapping,
    ["date", "description", "debit", "credit", "balance"]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].amount, -100000);
  assert.equal(p.rows[0].balance, 900000);
});

test("empty, headerless and unknown-only files are refused or empty, never guessed", () => {
  const empty = parseStatement(rowsFromCsv(""));
  assert.deepEqual(empty.rows, []);
  assert.match(empty.error, /header row/);

  const headerless = parseCsv("01/08/06,SWIGGY,-100.00,900.00\n"
    + "02/08/06,SALARY,5000.00,5900.00");
  assert.deepEqual(headerless.rows, []);
  assert.match(headerless.error, /header row/);

  const headersOnly = parseCsv("Date,Description,Amount,Balance\r\n");
  assert.ok(!headersOnly.error);
  assert.deepEqual(headersOnly.rows, []);

  const unknown = parseCsv("Ref,Notes,Value\nREF1,hello,10\n");
  assert.deepEqual(unknown.rows, []);
  assert.match(unknown.error, /header row/);
});

test("day-first 01/08/06 and ISO 2026-08-01 are different writings of the same day", () => {
  assert.equal(parseDate("01/08/06"), "2006-08-01");
  assert.equal(parseDate("01/08/2026"), "2026-08-01");
  assert.equal(parseDate("2026-08-01"), "2026-08-01");
  assert.equal(parseDate("13/08/06"), "2006-08-13");
  // When both numbers can be a month, the Indian day-first reading wins.
  assert.equal(parseDate("08/01/2026"), "2026-01-08");
  assert.equal(parseDate("2026-08-01T00:00:00"), "2026-08-01");
  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "01/08/06,BOTH SAME DAY,-100.00,900.00\n"
    + "2026-08-01,LATER,100.00,1000.00\n");
  assert.deepEqual(p.rows.map((r) => r.date), ["2006-08-01", "2026-08-01"]);
  assert.equal(p.order, "asc");
});

// ---------------------------------------------------------------------------
// Ordering: newest-first, oldest-first, one date, same-day direction
// ---------------------------------------------------------------------------

test("a newest-first file is reported desc and restored to date order", () => {
  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "03/04/2024,LATER,100.00,1100.00\n"
    + "01/04/2024,EARLIER,-100.00,1000.00\n");
  assert.equal(p.order, "desc");
  const asc = chronological(p);
  assert.deepEqual(asc.map((r) => r.date), ["2024-04-01", "2024-04-03"]);
  assert.deepEqual(asc.map((r) => r.balance), [100000, 110000]);
});

test("an oldest-first file is left in date order", () => {
  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "01/04/2024,EARLIER,-100.00,1000.00\n"
    + "03/04/2024,LATER,100.00,1100.00\n");
  assert.equal(p.order, "asc");
  const asc = chronological(p);
  assert.deepEqual(asc.map((r) => r.date), ["2024-04-01", "2024-04-03"]);
});

test("a single-date file is ordered by its running balance", () => {
  const p = parseCsv("Date,Description,Deposit,Withdrawal,Balance\n"
    + '27/10/2026,THIRD,,"450,000.00","112,466.11"\n'
    + '27/10/2026,SECOND,,"450,000.00","562,466.11"\n'
    + '27/10/2026,FIRST,,"201,000.00","1,012,466.11"\n');
  assert.equal(p.order, "desc");
  const asc = chronological(p);
  assert.deepEqual(asc.map((r) => r.amount), [-20100000, -45000000, -45000000]);
  assert.deepEqual(asc.map((r) => r.balance), [101246611, 56246611, 11246611]);
});

test("a single-date oldest-first file is not reversed", () => {
  const p = parseCsv("Date,Description,Deposit,Withdrawal,Balance\n"
    + '27/10/2026,FIRST,,"201,000.00","1,012,466.11"\n'
    + '27/10/2026,SECOND,,"450,000.00","562,466.11"\n'
    + '27/10/2026,THIRD,,"450,000.00","112,466.11"\n');
  assert.equal(p.order, "");
  assert.deepEqual(chronological(p).map((r) => r.amount),
    [-20100000, -45000000, -45000000]);
});

test("newest-first and oldest-first same-day files import to the same ledger", async () => {
  const desc = parseCsv("Date,Description,Deposit,Withdrawal,Balance\n"
    + '27/10/2026,THIRD,,"450,000.00","112,466.11"\n'
    + '27/10/2026,SECOND,,"450,000.00","562,466.11"\n'
    + '27/10/2026,FIRST,,"201,000.00","1,012,466.11"\n');
  const asc = parseCsv("Date,Description,Deposit,Withdrawal,Balance\n"
    + '27/10/2026,FIRST,,"201,000.00","1,012,466.11"\n'
    + '27/10/2026,SECOND,,"450,000.00","562,466.11"\n'
    + '27/10/2026,THIRD,,"450,000.00","112,466.11"\n');
  assert.equal(desc.order, "desc");
  assert.equal(asc.order, "");
  const a = await newStore();
  const b = await newStore();
  a.importRows("desc", chronological(desc));
  b.importRows("asc", chronological(asc));
  const rowsA = a.heldRows("desc").map((r) => [r.amount, r.balance]);
  const rowsB = b.heldRows("asc").map((r) => [r.amount, r.balance]);
  assert.deepEqual(rowsA, rowsB);
  assert.deepEqual(rowsA.map((r) => r[0]), [-20100000, -45000000, -45000000]);
  assert.equal(a.balanceBreaks("desc").length, 0);
  assert.equal(b.balanceBreaks("asc").length, 0);
});

// ---------------------------------------------------------------------------
// Duplicates, overlaps, corrections, planning
// ---------------------------------------------------------------------------

test("re-importing a real statement changes no rows and the plan says so", async () => {
  const store = await newStore();
  const p = parseStatement(fixtureRows("scb-savings-2026-10.csv"));
  const before = store.planImport("scb", p.rows);
  assert.equal(before.rows, 13);
  assert.equal(before.missing, 13);
  assert.equal(before.held, 0);
  assert.equal(before.correct, 0);

  const first = store.importRows("scb", chronological(p));
  assert.equal(first.inserted, 13);

  const after = store.planImport("scb", p.rows);
  assert.equal(after.rows, 13);
  assert.equal(after.missing, 0);
  assert.equal(after.held, 13);
  assert.equal(after.correct, 0);

  const again = store.importRows("scb", chronological(p));
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 13);
  assert.equal(store.summary().facts, 13);
});

test("an overlapping file adds only the days it does not already hold", async () => {
  const store = await newStore();
  const fileA = [
    { date: "2024-04-01", amount: 100000, balance: 100000, description: "OPEN" },
    { date: "2024-04-02", amount: -10000, balance: 90000, description: "A2" },
    { date: "2024-04-03", amount: 5000, balance: 95000, description: "A3" },
  ];
  const fileB = [
    { date: "2024-04-02", amount: -10000, balance: 90000, description: "A2" },
    { date: "2024-04-03", amount: 5000, balance: 95000, description: "A3" },
    { date: "2024-04-04", amount: -2500, balance: 92500, description: "B4" },
    { date: "2024-04-05", amount: 1000, balance: 93500, description: "B5" },
  ];
  store.importRows("overlap", fileA);
  const plan = store.planImport("overlap", fileB);
  assert.equal(plan.rows, 4);
  assert.equal(plan.held, 2);
  assert.equal(plan.missing, 2);
  assert.equal(plan.correct, 0);
  const res = store.importRows("overlap", fileB);
  assert.equal(res.inserted, 2);
  assert.equal(res.duplicates, 2);
  assert.equal(store.summary().facts, 5);
});

test("same amount, same day, same text, different balances are distinct rows", async () => {
  const store = await newStore();
  const rows = [
    { date: "2010-12-10", amount: -350000, balance: 5000000, description: "ATM" },
    { date: "2010-12-10", amount: -350000, balance: 4650000, description: "ATM" },
    { date: "2010-12-10", amount: -350000, balance: 4300000, description: "ATM" },
  ];
  const first = store.importRows("atm", rows);
  assert.equal(first.inserted, 3);
  assert.equal(store.duplicateFacts("atm").length, 0);
  const again = store.importRows("atm", rows);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 3);
  assert.equal(store.summary().facts, 3);

  // The same row stored twice, same balance, is still a duplicate the dedupe
  // screen can find.
  store.importRows("atm-copy", [rows[0], rows[0]]);
  assert.equal(store.duplicateFacts("atm-copy").length, 1);
});

test("the same event from another file corrects the balance instead of duplicating", async () => {
  const store = await newStore();
  const first = { date: "2026-08-14", amount: -283384, balance: 8296611,
    description: "IN3OT NOSTRO" };
  store.importRows("correct", [first]);
  const plan = store.planImport("correct", [{ ...first, balance: 31000018 }]);
  assert.equal(plan.rows, 1);
  assert.equal(plan.missing, 0);
  assert.equal(plan.held, 0);
  assert.equal(plan.correct, 1);

  const res = store.importRows("correct", [{ ...first, balance: 31000018 }]);
  assert.equal(res.inserted, 0);
  assert.equal(res.corrected, 1);
  assert.equal(res.duplicates, 0);
  const held = store.heldRows("correct");
  assert.equal(held.length, 1);
  assert.equal(held[0].balance, 31000018);
});

test("two genuinely identical rows in one file both import once", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: -500, balance: 500, description: "FEE" },
    { date: "2024-04-01", amount: -500, balance: 500, description: "FEE" },
  ];
  assert.equal(store.planImport("twins", rows).missing, 2);
  assert.equal(store.importRows("twins", rows).inserted, 2);
  assert.equal(store.importRows("twins", rows).inserted, 0);
  assert.equal(store.summary().facts, 2);
});

test("the plan counts readable rows and exposes unreadable ones instead of dropping them", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const rows = [
    { date: "2024-04-01", amount: -100, balance: 900, description: "OK", source_row: 2 },
    { date: "", amount: -200, balance: 700, description: "NO DATE", source_row: 3 },
    { date: "", amount: null, balance: null, description: "TOTALS", source_row: 4 },
  ];
  const plan = store.planImport("suspect", rows);
  assert.equal(plan.rows, 2);
  assert.equal(plan.missing, 2);
  assert.equal(plan.held, 0);
  assert.deepEqual(plan.suspectRows, [3]);
  assert.deepEqual(plan.missingRows, [2, 3]);
});

// ---------------------------------------------------------------------------
// Opening + credits - debits = closing, and the audit trail
// ---------------------------------------------------------------------------

test("a matching statement reconciles: opening + credits - debits = closing", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: -100000, balance: 900000, description: "A" },
    { date: "2024-04-02", amount: 50000, balance: 950000, description: "B" },
  ];
  const res = store.importRows("audit-ok", rows);
  assert.equal(res.breaks, 0);
  const v = store.validation();
  const acct = v.accounts.find((a) => a.account_id === "audit-ok");
  assert.equal(acct.opening, 1000000);
  assert.equal(acct.closing, 950000);
  assert.equal(acct.credits, 50000);
  assert.equal(acct.debits, 100000);
  assert.equal(acct.closing - acct.opening - (acct.credits - acct.debits), 0);
  assert.equal(store.balanceBreaks("audit-ok").length, 0);

  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "01/04/2024,A,-1000.00,9000.00\n"
    + "02/04/2024,B,500.00,9500.00\n");
  const audit = auditStatement([["Closing Balance 9,500.00 CR"]], p);
  assert.equal(audit.breaks.length, 0);
  assert.equal(audit.closingMatches, true);
  assert.equal(audit.closing, 950000);
});

test("a printed closing balance that disagrees is flagged, not hidden", () => {
  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "01/04/2024,A,-1000.00,9000.00\n"
    + "02/04/2024,B,500.00,9500.00\n");
  const audit = auditStatement([["Closing Balance 9,600.00 CR"]], p);
  assert.equal(audit.breaks.length, 0);
  assert.equal(audit.closing, 960000);
  assert.equal(audit.closingMatches, false);
});

test("a wrong running balance is one review item and a non-zero audit delta", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: -100000, balance: 900000, description: "A" },
    { date: "2024-04-02", amount: 50000, balance: 960000, description: "B" },
  ];
  const res = store.importRows("audit-bad", rows);
  assert.equal(res.breaks, 1);
  assert.equal(store.listIssues().length, 1);
  const issue = store.listIssues()[0];
  assert.equal(issue.kind, "balance_break");
  assert.match(issue.detail, /960000/);
  const v = store.validation();
  const acct = v.accounts.find((a) => a.account_id === "audit-bad");
  assert.equal(acct.closing - acct.opening - (acct.credits - acct.debits), 10000);
  assert.equal(store.balanceBreaks("audit-bad").length, 1);

  const again = store.importRows("audit-bad", rows);
  assert.equal(again.inserted, 0);
  assert.equal(store.summary().issues, 1);
});

test("a one-day statement is audited from its implied opening balance", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: -100000, balance: 900000, description: "A" },
    { date: "2024-04-01", amount: 50000, balance: 960000, description: "B" },
  ];
  const res = store.importRows("one-day-bad", rows);
  assert.equal(res.breaks, 1);
  assert.equal(store.summary().issues, 1);
  const v = store.validation();
  const acct = v.accounts.find((a) => a.account_id === "one-day-bad");
  assert.equal(acct.closing - acct.opening - (acct.credits - acct.debits), 10000);

  const p = parseCsv("Date,Description,Amount,Balance\n"
    + "01/04/2024,A,-1000.00,9000.00\n"
    + "01/04/2024,B,500.00,9600.00\n");
  assert.equal(auditStatement([], p).breaks.length, 1);

  const good = await newStore();
  const clean = [
    { date: "2024-04-01", amount: -100000, balance: 900000, description: "A" },
    { date: "2024-04-01", amount: 50000, balance: 950000, description: "B" },
  ];
  assert.equal(good.importRows("one-day-ok", clean).breaks, 0);
});

test("an end-of-day balance repeated on the first day is not a break", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: 100000, balance: 1200000, description: "A" },
    { date: "2024-04-01", amount: 300000, balance: 1200000, description: "B" },
  ];
  const res = store.importRows("repeated-eod", rows);
  assert.equal(res.breaks, 0);
  assert.equal(store.listIssues().length, 0);
});

test("a negative (DR) closing balance is read with its sign", () => {
  const p = { order: "", rows: [
    { date: "2024-04-01", amount: -5000000, balance: -10000000 },
  ] };
  const audit = auditStatement([["Closing Balance 1,00,000.00 DR"]], p);
  assert.equal(audit.closing, -10000000);
  assert.equal(audit.closingMatches, true);
});

// ---------------------------------------------------------------------------
// Account identity
// ---------------------------------------------------------------------------

test("a labelled account number matches the right asset at high confidence", () => {
  const pre = scanPreamble([
    ["HDFC Bank Ltd", "", ""],
    ["Account No: 9999 0048 2193 00", "", ""],
    ["IFSC: HDFC0001234", "", ""],
  ], 2);
  assert.equal(pre.accountNumber, "99990048219300");
  const hit = guessAccount(pre, [
    { id: "icici", number: "999911112222", bank: "ICICI" },
    { id: "hdfc", number: "9999 0048 2193 00", bank: "HDFC" },
  ]);
  assert.equal(hit.id, "hdfc");
  assert.equal(hit.confidence, "high");
});

test("an account-number mismatch returns no guess rather than the wrong account", () => {
  const pre = scanPreamble([["Account No: 9999 8888 7777"]], 0);
  assert.equal(guessAccount(pre, [
    { id: "hdfc", number: "99990048219300" },
  ]), null);
});

test("helpline, phone and toll-free numbers are not account numbers", () => {
  const pre = scanPreamble([[
    "Punjab National Bank",
    "Phone No: 26454620",
    "Toll Free 18001802222",
    "Mobile: 9876543210",
  ]], 0);
  assert.deepEqual(pre.numbers, []);
  assert.equal(pre.accountNumber, "");

  const withAccount = scanPreamble([[
    "Phone No: 26454620",
    "Account No: 1234 5678 9012",
    "Contact: 04000000000",
  ]], 0);
  assert.equal(withAccount.accountNumber, "123456789012");
  assert.deepEqual(withAccount.numbers, ["123456789012"]);

  const phoneOnly = scanPreamble([["helpline 18001802222"]], 0);
  assert.equal(guessAccount(phoneOnly, [
    { id: "wrong", number: "18001802222" },
  ]), null);
});

// ---------------------------------------------------------------------------
// Encrypted workbooks
// ---------------------------------------------------------------------------

test("the encrypted XLSX fixture opens with its password and reads as a workbook", async () => {
  const bytes = new Uint8Array(readFileSync(ENCRYPTED));
  assert.equal(isEncryptedOffice(bytes), true);
  const zip = await decryptOffice(bytes, "Password1234_");
  assert.deepEqual([zip[0], zip[1]], [0x50, 0x4b]);

  const wb = XLSX.read(Buffer.from(zip), { type: "buffer" });
  assert.equal(wb.SheetNames.length, 1);
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
    { header: 1, raw: false, defval: "" });
  assert.deepEqual(matrix, [["lorem", "ipsum"]]);

  await assert.rejects(() => decryptOffice(bytes, "wrong"), /wrong password/);
  await assert.rejects(() => decryptOffice(bytes, "Password1234"), /wrong password/);
});

// ---------------------------------------------------------------------------
// Wrong account, delete and re-import
// ---------------------------------------------------------------------------

test("importing into the wrong account does not dedupe against another account", async () => {
  const store = await newStore();
  const rows = [
    { date: "2024-04-01", amount: -100000, balance: 900000, description: "A" },
    { date: "2024-04-02", amount: 50000, balance: 950000, description: "B" },
    { date: "2024-04-03", amount: -25000, balance: 925000, description: "C" },
  ];
  store.importRows("right", rows);
  const plan = store.planImport("wrong", rows);
  assert.equal(plan.held, 0);
  assert.equal(plan.missing, 3);
  const res = store.importRows("wrong", rows);
  assert.equal(res.inserted, 3);
  assert.equal(store.heldRows("right").length, 3);
  assert.equal(store.heldRows("wrong").length, 3);
});

test("delete-all clears rows and their review items, and a re-import restores one of each", async () => {
  const store = await newStore();
  const broken = [
    { date: "2024-04-01", amount: 100000, balance: 1100000, description: "A" },
    { date: "2024-04-02", amount: -20000, balance: 1079000, description: "B" },
  ];
  store.importRows("delete-me", broken);
  assert.equal(store.summary().facts, 2);
  assert.equal(store.summary().issues, 1);

  assert.equal(store.deleteAllFacts("delete-me"), 2);
  assert.equal(store.summary().facts, 0);
  assert.equal(store.summary().issues, 0);
  const plan = store.planImport("delete-me", broken);
  assert.equal(plan.missing, 2);
  assert.equal(plan.held, 0);

  const res = store.importRows("delete-me", broken);
  assert.equal(res.inserted, 2);
  assert.equal(store.summary().facts, 2);
  assert.equal(store.summary().issues, 1);
});

test("the advanced workbook re-import renders into a host that exists", () => {
  // The report is written with innerHTML at the end of importWorkbook. The host
  // lived only in the old upload card, so a successful re-import ended in
  // "Cannot set properties of null" after the data was already written.
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const start = html.indexOf('<details class="adv">');
  assert.ok(start > -1, "the advanced card exists");
  const card = html.slice(start, html.indexOf("</details>", start));
  assert.match(card, /<div id="wres"><\/div>/, "the card carries the report host");
  assert.match(html, /if \(out\) \{\s*out\.innerHTML/, "the write is null-safe");
  assert.match(html, /getElementById\("wres"\)\s*\|\|\s*document\.getElementById\("reimport-status"\)/,
    "a missing host falls back to the status line");
});
