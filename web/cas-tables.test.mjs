import test from "node:test";
import assert from "node:assert/strict";
import { parseCas } from "./cas.js";

// A real CAS prints a transactions table above the holdings table, and both
// carry ISINs. Numbers are right-aligned, so the fixture gives every numeric
// cell a width and places it by its right edge.
const text = (str, x, y) => ({ str, x, y, width: 0 });
const money = (str, right, y) => ({ str, x: right - str.length * 6, width: str.length * 6, y });
const page = (items) => ({ items });

const TXN_HEADER = [
  text("ISIN", 50, 700), text("Security", 142, 700), text("Transaction", 234, 700),
  text("Date", 327, 700), text("Op. Bal", 368, 700), text("Credit", 415, 700),
  text("Debit", 458, 700), text("Cl. Bal", 500, 700), text("Stamp", 546, 700),
];
const HOLD_HEADER = [
  text("ISIN", 51, 560), text("Security", 152, 560), text("Current", 245, 560),
  text("Frozen", 300, 560), text("Pledge", 337, 560), text("Market Price", 486, 560),
  text("Value", 533, 560),
];

const txnRow = (isin, y) => [
  text(isin, 50, y), text("SOME SECURITY", 142, y), text("BUY", 234, y),
  text("01-09-2026", 327, y), money("10", 390, y), money("5", 420, y),
  money("9", 470, y), money("15", 520, y), money("9", 578, y),
];
const holdRow = (isin, qty, value, y) => [
  text(isin, 51, y), text("SOME SECURITY", 152, y), money(String(qty), 293, y),
  money("1,20,000.00", 530, y), money(value, 578, y),
];

test("transaction rows are not holdings, even though they carry ISINs", () => {
  const out = parseCas({ pages: [page([
    ...TXN_HEADER, ...txnRow("INE000000001", 660), ...txnRow("INE000000002", 620),
    ...HOLD_HEADER, ...holdRow("INE000000003", 5, "58,360.00", 520),
    ...holdRow("INE000000004", 10, "1,00,752.60", 480),
  ])] });
  assert.equal(out.holdings.length, 2);
  assert.deepEqual(out.holdings.map((h) => h.isin).sort(),
    ["INE000000003", "INE000000004"]);
  assert.equal(out.holdings.find((h) => h.isin === "INE000000004").valuePaise, 10075260);
});

test("a value is read from the value column, not the price beside it", () => {
  const out = parseCas({ pages: [page([
    ...HOLD_HEADER, ...holdRow("INE000000003", 5, "58,360.00", 520),
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].valuePaise, 5836000);
  assert.equal(out.holdings[0].quantity, 5);
  assert.equal(out.holdings[0].kind, "equity");
});

test("a header printed on two lines still places its columns", () => {
  const out = parseCas({ pages: [page([
    text("ISIN", 51, 562), text("Quantity", 245, 562), text("Value in", 533, 562),
    text("(Units)", 245, 548), text("Current", 533, 548),
    ...holdRow("INE000000003", 5, "58,360.00", 520),
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].valuePaise, 5836000);
});

test("the same ISIN in the trade table and the holdings table counts once", () => {
  const out = parseCas({ pages: [page([
    ...TXN_HEADER, ...txnRow("INE000000003", 660),
    ...HOLD_HEADER, ...holdRow("INE000000003", 5, "58,360.00", 520),
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].valuePaise, 5836000);
});

test("a folio table is read as mutual funds, not as equities", () => {
  const out = parseCas({ pages: [page([
    text("ISIN UCC", 15, 380), text("Scheme Name", 107, 380),
    text("Folio No.", 219, 380), text("No. of Units", 269, 380),
    text("NAV per", 441, 380), text("Value in", 492, 380),
    text("Profit/(Loss)", 543, 380),
    text("INF000000001", 15, 340), text("SOME FUND", 107, 340),
    money("12345", 257, 340), money("210.1234", 482, 340),
    money("3,24,536.01", 537, 340), money("12.5", 592, 340),
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].kind, "mf");
  assert.equal(out.holdings[0].valuePaise, 32453601);
});

test("a bond table names its maturity and coupon", () => {
  const out = parseCas({ pages: [page([
    text("ISIN", 50, 400), text("ISIN Name", 127, 400), text("Coupon / Rate", 217, 400),
    text("Maturity", 310, 400), text("Quantity", 363, 400),
    text("Face Value per Bond", 415, 400), text("Value in", 526, 400),
    text("INE999900298", 50, 360), text("SOME BOND", 127, 360),
    money("9.75", 305, 360), text("27-11-2028", 310, 360),
    money("10", 410, 360), money("1,000.00", 470, 360),
    money("1,00,752.60", 578, 360),
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].kind, "bond");
  assert.equal(out.holdings[0].quantity, 10);
  assert.equal(out.holdings[0].maturity, "2028-11-27");
  assert.equal(out.holdings[0].couponPct, 9.75);
  assert.equal(out.holdings[0].valuePaise, 10075260);
});
