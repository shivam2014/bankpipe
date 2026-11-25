import test from "node:test";
import assert from "node:assert/strict";
import { boId, sameAccount, boIdShort } from "./bo-id.js";

// The two accounts from the real statements in this project's research: a CDSL
// BO ID printed by DigiFinn and an NSDL number printed on a Motilal statement.
const CDSL = "IN99990001344321";
const NSDL = "1200000012345678";

test("a CDSL BO ID splits into its DP ID and client ID", () => {
  const id = boId(CDSL);
  assert.equal(id.kind, "bo");
  assert.equal(id.depository, "CDSL");
  assert.equal(id.dpId, "IN999900");
  assert.equal(id.clientId, "01344321");
  assert.equal(id.boId, CDSL);
});

test("an NSDL account is 16 digits, no prefix", () => {
  const id = boId(NSDL);
  assert.equal(id.kind, "bo");
  assert.equal(id.depository, "NSDL");
  assert.equal(id.dpId, "12000000");
  assert.equal(id.clientId, "12345678");
});

test("spacing and dashes from a report do not change the account", () => {
  assert.equal(boId("  IN99990001344321 ").boId, CDSL);
  assert.equal(boId("IN99990001344321").boId, CDSL);
  assert.equal(boId("1200 0000 1234 5678").boId, NSDL);
});

test("a broker client code is a label, not an identity", () => {
  const motilal = boId("5550000000");
  assert.equal(motilal.kind, "client-code");
  assert.equal(motilal.boId, "");
  assert.equal(boId("9990001").kind, "client-code");
});

test("empty and nonsense are reported, not guessed", () => {
  assert.equal(boId("").kind, "empty");
  assert.equal(boId(null).kind, "empty");
  assert.equal(boId("not an account").kind, "unknown");
});

test("the same account with different punctuation matches", () => {
  assert.equal(sameAccount(CDSL, "IN99990001344321"), "match");
  assert.equal(sameAccount(NSDL, "1200000012345678 "), "match");
});

test("two accounts that share their last six digits are still different", () => {
  // This is the bug the old last-six matcher could not see: both end 344321.
  const other = "IN99990004344321";
  assert.equal(other.slice(-6), CDSL.slice(-6));
  assert.equal(sameAccount(other, CDSL), "mismatch");
});

test("a client code never confirms or denies a demat", () => {
  assert.equal(sameAccount("5550000000", CDSL), "unknown");
  assert.equal(sameAccount(CDSL, "9990001"), "unknown");
  assert.equal(sameAccount("", CDSL), "unknown");
});

test("the short label names the depository", () => {
  assert.equal(boIdShort(CDSL), "CDSL …4321");
  assert.equal(boIdShort(NSDL), "NSDL …5678");
  assert.equal(boIdShort("5550000000"), "");
});
