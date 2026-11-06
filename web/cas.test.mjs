import test from "node:test";
import assert from "node:assert/strict";
import { parseCas, casTotals } from "./cas.js";

// A synthetic page laid out like a depository statement: one heading line, then
// a block of lines per holding. Fields sit at fixed x; the ISIN is printed on a
// different line of the block each time, which is what breaks a parser that
// reads rows line by line.
const line = (...cells) => cells;
const heading = (str) => [line([200, str])];
const page = (rows) => {
  const items = [];
  let y = 800;
  for (const row of rows) {
    for (let n = 0; n < row.length; n++) {
      for (const [x, str] of row[n]) items.push({ str, x, y: y - n * 15 });
    }
    y -= 60;
  }
  return { items };
};

const bondA = [
  line([60, "INE00XL07015"], [430, "27-Nov-2028"], [600, "10.00"], [660, "10,000.00"],
    [730, "10,075.26"], [800, "1,00,752.60"]),
  line([200, "B.N. AGRITECH LIMITED"], [380, "9.75"]),
  line([200, "Fixed Interest Bonds"]),
];
const bondB = [
  line([200, "OPG POWER GENERATION PRIVATE LIMITED"], [380, "9.25"]),
  line([60, "INE0D8F07055"], [430, "07-Oct-2029"], [600, "20.00"], [660, "10,000.00"],
    [730, "9,899.00"], [800, "1,97,980.00"]),
  line([200, "Fixed Interest Bonds"]),
];

test("a bond row is read even when its ISIN sits on the third line", () => {
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), bondA, bondB,
  ])] });
  assert.equal(out.holdings.length, 2);
  const [a, b] = out.holdings;
  assert.equal(a.isin, "INE00XL07015");
  assert.equal(a.quantity, 10);
  assert.equal(a.faceValuePaise, 1000000);
  assert.equal(a.valuePaise, 10075260);
  assert.equal(a.maturity, "2028-11-27");
  assert.equal(b.isin, "INE0D8F07055");
  assert.equal(b.quantity, 20);
  assert.equal(b.kind, "bond");
  assert.equal(a.couponPct, 9.75);
  assert.equal(b.couponPct, 9.25);
});

test("the Depository is named from the statement, not guessed", () => {
  const cdsl = page([heading("Central Depository Services (India) Limited"),
    heading("Corporate Bonds"), bondA]);
  assert.equal(parseCas({ pages: [cdsl] }).depository, "CDSL");
  const nsdl = page([heading("National Securities Depository Limited"),
    heading("Corporate Bonds"), bondA]);
  assert.equal(parseCas({ pages: [nsdl] }).depository, "NSDL");
});

test("an equity row with no maturity date is still read", () => {
  const equity = [line([60, "INE585B01010"], [200, "MARUTI SUZUKI INDIA LTD"],
    [600, "5.00"], [660, "5"], [730, "11,672.00"], [800, "58,360.00"])];
  const out = parseCas({ pages: [page([
    heading("Equity Shares"), equity,
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].kind, "equity");
  assert.equal(out.holdings[0].quantity, 5);
  assert.equal(out.holdings[0].valuePaise, 5836000);
});

test("a row with one number is quarantined, never guessed", () => {
  const broken = [line([60, "INE01E708032"], [200, "ANDHRA PRADESH CAPITAL"],
    [800, "50,150.50"])];
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), broken,
  ])] });
  assert.equal(out.holdings.length, 0);
  assert.equal(out.counts.quarantined, 1);
});

test("a page with no ISIN reports nothing instead of inventing rows", () => {
  const out = parseCas({ pages: [page([heading("Corporate Bonds")])] });
  assert.equal(out.holdings.length, 0);
  assert.equal(out.counts.rows, 0);
});

test("the rows must add up to the total the statement prints", () => {
  const parsed = { holdings: [{ valuePaise: 100 }, { valuePaise: 250 }] };
  assert.equal(casTotals(parsed, 350).ok, true);
  const bad = casTotals(parsed, 400);
  assert.equal(bad.ok, false);
  assert.equal(bad.diffPaise, -50);
});

test("an unstated total is not a failure", () => {
  const res = casTotals({ holdings: [{ valuePaise: 100 }] }, null);
  assert.equal(res.ok, true);
  assert.equal(res.diffPaise, null);
});
