import test from "node:test";
import assert from "node:assert/strict";
import { boId, sameAccount, boIdShort } from "./bo-id.js";

// The two accounts from the real statements in this project's research: a CDSL
// BO ID printed by DigiFInn and an NSDL number printed on a Motilal statement.
const CDSL = "IN30302873183122";
const NSDL = "1201090009140907";

test("a CDSL BO ID splits into its DP ID and client ID", () => {
  const id = boId(CDSL);
  assert.equal(id.kind, "bo");
  assert.equal(id.depository, "CDSL");
  assert.equal(id.dpId, "IN303028");
  assert.equal(id.clientId, "73183122");
  assert.equal(id.boId, CDSL);
});

test("an NSDL account is 16 digits, no prefix", () => {
  const id = boId(NSDL);
  assert.equal(id.kind, "bo");
  assert.equal(id.depository, "NSDL");
  assert.equal(id.dpId, "12010900");
  assert.equal(id.clientId, "09140907");
});

test("spacing and dashes from a report do not change the account", () => {
  assert.equal(boId("  in 303028 73183122 ").boId, CDSL);
  assert.equal(boId("IN-303028-73183122").boId, CDSL);
  assert.equal(boId("1201 0900 0914 0907").boId, NSDL);
});

test("a broker client code is a label, not an identity", () => {
  const motilal = boId("8504986299");
  assert.equal(motilal.kind, "client-code");
  assert.equal(motilal.boId, "");
  assert.equal(boId("6638002").kind, "client-code");
});

test("empty and nonsense are reported, not guessed", () => {
  assert.equal(boId("").kind, "empty");
  assert.equal(boId(null).kind, "empty");
  assert.equal(boId("not an account").kind, "unknown");
});

test("the same account with different punctuation matches", () => {
  assert.equal(sameAccount(CDSL, "IN-303028-73183122"), "match");
  assert.equal(sameAccount(NSDL, "1201090009140907 "), "match");
});

test("two accounts that share their last six digits are still different", () => {
  // This is the bug the old last-six matcher could not see: both end 183122.
  const other = "IN30302811183122";
  assert.equal(other.slice(-6), CDSL.slice(-6));
  assert.equal(sameAccount(other, CDSL), "mismatch");
});

test("a client code never confirms or denies a demat", () => {
  assert.equal(sameAccount("8504986299", CDSL), "unknown");
  assert.equal(sameAccount(CDSL, "6638002"), "unknown");
  assert.equal(sameAccount("", CDSL), "unknown");
});

test("the short label names the depository", () => {
  assert.equal(boIdShort(CDSL), "CDSL …3122");
  assert.equal(boIdShort(NSDL), "NSDL …0907");
  assert.equal(boIdShort("8504986299"), "");
});
