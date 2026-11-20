import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountMatches } from "./import-flow.js";
import { planZerodhaCosts } from "./zerodha.js";

// The Zerodha holdings card sets cost on rows that already exist. This file
// holds the two rules that used to be wrong: whose holdings count as a match,
// and which invested number the card prints.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

const ISIN_A = "INE000A01001";
const ISIN_B = "INE000A01002";
const row = (isin, quantity, averagePrice) => ({ isin, quantity, averagePrice, symbol: "TEST" });
const holding = (isin, quantity) => ({ security_id: isin, quantity });
const account = (extra) => ({ id: "account-1", label: "Account", holdings: [], ...extra });

test("a holding on a bond-kind account matches like any demat", () => {
  const accounts = [
    account({ id: "bonds", category: "bonds", subtype: "bond",
      holdings: [holding(ISIN_A, 8)] }),
    account({ id: "legacy", type: "bond", holdings: [holding(ISIN_B, 5)] }),
  ];
  const result = planZerodhaCosts([row(ISIN_A, 10, 100.5), row(ISIN_B, 5, 200)], accounts);
  assert.equal(result.matched.length, 2);
  assert.equal(result.plan[0].matches[0]._asset.id, "bonds");
  assert.equal(result.plan[1].matches[0]._asset.id, "legacy");
  assert.equal(result.filePaise, Math.round((10 * 100.5 + 5 * 200) * 100));
  assert.equal(result.matchedPaise, Math.round((8 * 100.5 + 5 * 200) * 100));
});

test("a bank account never becomes a cost target", () => {
  const bank = account({ id: "bank", category: "bank", subtype: "savings",
    holdings: [holding(ISIN_A, 10)] });
  const result = planZerodhaCosts([row(ISIN_A, 10, 100)], [bank]);
  assert.deepEqual(result.matched, []);
});

test("the file total survives a file with no match", () => {
  const result = planZerodhaCosts([row(ISIN_A, 10, 100.5)], []);
  assert.deepEqual(result.matched, []);
  assert.equal(result.matchedPaise, 0);
  assert.equal(result.filePaise, 100500);
  assert.equal(result.unmatched.length, 1);
});

test("the card prints the file total, never a bare matched total", () => {
  const card = between("window.bpZerodhaHoldings = async", "window.bpZerodhaCancel");
  assert.match(card, /planZerodhaCosts\(/);
  assert.match(card, /cost\.filePaise/);
  assert.doesNotMatch(card, /Invested \$\{money\(total\)\}\./);
});

test("a file that matches nothing offers the inbox instead of a dead end", () => {
  const card = between("window.bpZerodhaHoldings = async", "window.bpZerodhaCancel");
  assert.match(card, /bpZerodhaUseInbox/);
  assert.match(card, /an account on file/);
});

test("the target note counts custody demats, not fund folios", () => {
  const note = between("window.bpZerodhaTargetNote = async", "window.bpZerodhaHoldings = async");
  assert.match(note, /isFundAccount/);
});

test("the import inbox already matches a bond-kind account", () => {
  const bonds = account({ id: "bonds", category: "bonds", subtype: "bond",
    holdings: [holding(ISIN_A, 1)] });
  const match = accountMatches({ accountKey: "TEST500", accountKind: "client",
    rows: [row(ISIN_A, 1, 100)] }, [bonds]);
  assert.equal(match.matches.length, 1);
  assert.equal(match.matches[0].hits, 1);
});
