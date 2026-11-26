import test from "node:test";
import assert from "node:assert/strict";
import { typeLabel, tail, sourceName, consequence, netConsequence, matchLine,
  createProposal, importButtonLabel, waitingText, lockedAccountLine,
  passwordHint } from "./import-queue.js";

test("a file is named by what it is, not by its extension", () => {
  assert.equal(typeLabel("cas"), "NSDL/CDSL (CAS)");
  assert.equal(typeLabel("zerodha-holdings"), "Zerodha holdings");
  assert.equal(typeLabel("bank"), "Bank statement");
  assert.equal(typeLabel("nonsense"), "File");
});

test("a number is read back by its last four digits", () => {
  assert.equal(tail("9999000012343122"), "…3122");
  assert.equal(tail("AB1234567"), "…4567");
  assert.equal(tail("9/1234"), "…1234");
  assert.equal(tail(""), "");
});

test("a short client id is read whole, not cut to four characters", () => {
  assert.equal(tail("SYN500"), "SYN500");
  assert.equal(tail("TEST500"), "TEST500");
});

test("a known source reads as the name a person uses", () => {
  assert.equal(sourceName("ICICI BANK LIMITED"), "ICICI Direct");
  assert.equal(sourceName("Zerodha Broking Ltd"), "Zerodha");
  assert.equal(sourceName("Motilal Oswal Financial Services Limited"), "Motilal Oswal");
  assert.equal(sourceName("", "digifinn"), "DigiFinn");
});

test("the consequence is the account's own unit", () => {
  assert.equal(consequence({ kind: "bank", parsed: { rows: Array(42).fill({}) } }),
    "42 transactions");
  assert.equal(consequence({ kind: "zerodha-holdings", rows: Array(17).fill({}) }),
    "17 holdings");
  assert.equal(consequence({ kind: "cas", rows: Array(42).fill({}), accountCount: 3 }),
    "3 accounts · 42 holdings");
  assert.equal(consequence({ kind: "zerodha-tradebook", parsed: { rows: Array(19).fill({}) } }),
    "19 trades");
});

test("the consequence follows the chosen account, not the file alone", () => {
  assert.equal(netConsequence({ added: 17 }), "17 holdings");
  assert.equal(netConsequence({ added: 7, updated: 10 }), "7 new · 10 updated");
  assert.equal(netConsequence({ added: 0, updated: 0, history: 2 }), "2 to history");
  assert.equal(netConsequence({ added: 0, updated: 0 }), "Nothing new");
});

test("a match says how it was found, and a partial match says the score", () => {
  assert.equal(matchLine({ identityKind: "BO ID" }), "BO ID match");
  assert.equal(matchLine({ hits: 17, of: 17 }), "17 of 17 ISINs match");
  assert.equal(matchLine({ hits: 1, of: 500 }), "1 of 500 ISINs match");
  assert.equal(matchLine(null), "");
});

test("a proposed account is named by its source and its number", () => {
  assert.equal(createProposal({ family: "zerodha", key: "AB1234567" }),
    "Create Zerodha demat …4567");
  assert.equal(createProposal({ family: "zerodha", key: "SYN500" }),
    "Create Zerodha demat SYN500");
  assert.equal(createProposal({ family: "cas", source: "ICICI BANK LIMITED",
    key: "1200000012348054" }), "Create ICICI Direct demat …8054");
  assert.equal(createProposal({ folio: true, amc: "HDFC Mutual Fund",
    key: "999900001234" }), "Create HDFC Mutual Fund folio …1234");
});

test("the bar counts ready files and names what still waits", () => {
  assert.equal(importButtonLabel(0), "Import 0 ready files");
  assert.equal(importButtonLabel(1), "Import 1 ready file");
  assert.equal(importButtonLabel(3), "Import 3 ready files");
  assert.equal(waitingText({ password: 1, account: 2 }),
    "1 needs a password and 2 need an account.");
  assert.equal(waitingText({ review: 1 }), "1 needs a review.");
  assert.equal(waitingText({ unread: 1 }), "1 couldn't be read.");
  assert.equal(waitingText({}), "");
});

test("a locked file does not name an account it has not read", () => {
  assert.equal(lockedAccountLine(), "Account shown after it opens.");
});

test("the password hint follows the source", () => {
  assert.equal(passwordHint({ kind: "cas" }), "Usually your PAN in capitals");
  assert.equal(passwordHint({ name: "Portfolio_Holding_Summary.pdf" }),
    "Password is your PAN in capitals");
  assert.equal(passwordHint({ kind: "bank" }),
    "Usually your PAN, date of birth or customer ID");
  assert.equal(passwordHint({ name: "statement.pdf" }),
    "Usually your PAN, date of birth or customer ID");
});
