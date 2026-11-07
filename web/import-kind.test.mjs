import test from "node:test";
import assert from "node:assert/strict";
import { sniffKind, guessKind, IMPORT_KINDS, IMPORT_KIND_LABEL } from "./import-kind.js";

test("a CAS is recognised by what its first page says", () => {
  const page = "National Securities Depository Limited\nConsolidated Account Statement"
    + "\nDemat Account No. 9999000001140907";
  assert.equal(sniffKind({ name: "download.pdf", text: page }), "cas");
});

test("a CDSL transaction file is a CAS even named TXN", () => {
  assert.equal(sniffKind({ name: "SEP2026_AA06635090_TXN.pdf", text: "" }), "cas");
  assert.equal(sniffKind({ name: "x.pdf",
    text: "Central Depository Services (India) Limited e-CAS" }), "cas");
});

test("a broker holdings export is read from its header row", () => {
  const csv = "ISIN,Stock Name,Quantity,Buy Value,Current Value\nINE999900140,BAJAJ,34,300000,326196";
  assert.equal(sniffKind({ name: "any.csv", text: csv }), "broker");
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

test("nothing readable falls back to the name", () => {
  assert.equal(sniffKind({ name: "NSDLe-CAS_SEP.pdf", text: "" }), "cas");
  assert.equal(sniffKind({ name: "pnb-statement.csv", text: "" }), "bank");
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
