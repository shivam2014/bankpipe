import test from "node:test";
import assert from "node:assert/strict";
import { sniffKind, guessKind, IMPORT_KINDS, IMPORT_KIND_LABEL } from "./import-kind.js";

test("a CAS is recognised by what its first page says", () => {
  const page = "National Securities Depository Limited\nConsolidated Account Statement"
    + "\nDemat Account No. 1200 0000 1234 5678";
  assert.equal(sniffKind({ name: "download.pdf", text: page }), "cas");
});

test("a CDSL transaction file is a CAS from its first page", () => {
  assert.equal(sniffKind({ name: "SEP2026_AA06635090_TXN.pdf",
    text: "Central Depository Services (India) Limited e-CAS" }), "cas");
  // With no readable content the name still decides, through guessKind.
  assert.equal(guessKind("SEP2026_AA06635090_TXN.pdf"), "cas");
});

test("a broker holdings export is read from its header row", () => {
  const csv = "ISIN,Stock Name,Quantity,Buy Value,Current Value\nINE000000030,BAJAJ,34,300000,326196";
  assert.equal(sniffKind({ name: "any.csv", text: csv }), "broker");
});

test("a DigiFInn holdings report is broker even though it names a Demat Account No.", () => {
  const csv = "DIGIFINN - HOLDINGS REPORT\nDemat Account No.,1200000012345678"
    + "\nISIN,Bond Name,Purchase date,Qty,Investment Value (₹)"
    + "\nINE000000011,9.25% TESTF 07 OCT 2029,23-Oct-26,20,196406.16";
  assert.equal(sniffKind({ name: "holdings-report-2026-10-26.csv", text: csv }), "broker");
});

test("a bank statement is read from its columns", () => {
  const csv = "Date,Narration,Withdrawal,Deposit,Balance\n01/10/2026,Rent,25000,,100000";
  assert.equal(sniffKind({ name: "any.csv", text: csv }), "bank");
});

test("content beats the name when they disagree", () => {
  // A bank export saved as "holdings.csv" is still a bank statement.
  const bank = "Date,Particulars,Debit,Credit,Balance\n01/10/2026,Rent,25000,,100000";
  assert.equal(sniffKind({ name: "holdings.csv", text: bank }), "bank");
});

test("a bank statement that mentions NSDL stays a bank statement", () => {
  const bank = "Date,Narration,Debit,Credit,Balance\n01/10/2026,NSDL CHARGES,250,,100000";
  assert.equal(sniffKind({ name: "statement.csv", text: bank }), "bank");
});

test("nothing readable reports no opinion instead of guessing", () => {
  assert.equal(sniffKind({ name: "NSDLe-CAS_SEP.pdf", text: "" }), "");
  assert.equal(sniffKind({ name: "whatever.csv", text: "hello,world\n1,2" }), "");
});

test("the name rules still mean what they meant", () => {
  assert.equal(guessKind("SEP2026_AA06635090_TXN_unlocked.pdf"), "cas");
  assert.equal(guessKind("CDSL_CAS_2026.pdf"), "cas");
  assert.equal(guessKind("holdings-report-2026-10-26.csv"), "broker");
  assert.equal(guessKind("HDFC_stmt.xlsx"), "bank");
  assert.equal(guessKind(""), "broker");
});

test("every kind has a label a person can read", () => {
  for (const kind of IMPORT_KINDS) {
    assert.ok(IMPORT_KIND_LABEL[kind], `${kind} has no label`);
    assert.ok(IMPORT_KIND_LABEL[kind].length > 3);
  }
});
