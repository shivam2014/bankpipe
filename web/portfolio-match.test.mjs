import test from "node:test";
import assert from "node:assert/strict";
import { matchDemat } from "./portfolio-match.js";

test("identical Demat numbers match", () => {
  assert.equal(matchDemat("1201000000001234", "1201000000001234"), "match");
});

test("the same last six digits are not the same account", () => {
  // Both end 1234, but the DP ID differs, so these are two accounts. The old
  // last-six matcher called this a match and would silently move a portfolio.
  assert.equal(matchDemat("0000123400001234", "1201000000001234"), "mismatch");
});

test("two clients of one DP are told apart", () => {
  assert.equal(matchDemat("IN99990001344321", "IN99990004344321"), "mismatch");
  assert.equal(matchDemat("IN99990001344321", "IN99990001344321"), "match");
});

test("a number that lost a digit is unknown, never repaired", () => {
  assert.equal(matchDemat("201000000001234", "1201000000001234"), "unknown");
});

test("a broker client code is never a match", () => {
  assert.equal(matchDemat("5550000000", "1201000000001234"), "unknown");
});

test("a different last six is a mismatch", () => {
  assert.equal(matchDemat("1201000000001234", "1201000000005678"), "mismatch");
});

test("a missing Demat on either side is unknown, not a mismatch", () => {
  assert.equal(matchDemat("", "1201000000001234"), "unknown");
  assert.equal(matchDemat("1201000000001234", ""), "unknown");
  assert.equal(matchDemat("", ""), "unknown");
  assert.equal(matchDemat(null, undefined), "unknown");
});

test("fewer than six digits on either side is unknown", () => {
  assert.equal(matchDemat("12345", "1201000000001234"), "unknown");
  assert.equal(matchDemat("1201000000001234", "12345"), "unknown");
  assert.equal(matchDemat("12345", "12345"), "unknown");
});

test("spaces and dashes in one number do not break the match", () => {
  assert.equal(matchDemat("1201 0000 0000 1234", "1201000000001234"), "match");
  assert.equal(matchDemat("1201-0000-0000-1234", "1201000000001234"), "match");
});

