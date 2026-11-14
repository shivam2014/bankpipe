import test from "node:test";
import assert from "node:assert/strict";
import { parseZerodhaHoldings, parseZerodhaHoldingsSheets } from "./zerodha.js";

const matrix = [
  ["Client ID", "TEST500"],
  ["Equity Holdings Statement as on 2026-11-12"],
  [],
  ["Symbol", "ISIN", "Sector", "Quantity Available", "Quantity Discrepant",
    "Quantity Long Term", "Quantity Pledged (Margin)", "Quantity Pledged (Loan)",
    "Average Price", "Previous Closing Price", "Unrealized P&L", "Unrealized P&L Pct."],
  ["TESTPOWER", "INE000000028", "ENERGY", 70, 0, 0, 0, 0, 191.2386, 208, 1173.3, 8.7647],
  ["TESTGAS", "INE000000026", "ENERGY", 80, 0, 0, 0, 0, 590.9125, 582.7, -657, -1.3898],
  ["", "", "", "", "", "", "", "", "", "", "", ""],
];

test("reads the Zerodha equity holdings columns", () => {
  const p = parseZerodhaHoldings(matrix);
  assert.equal(p.error, null);
  assert.equal(p.asOf, "2026-11-12");
  assert.equal(p.clientId, "TEST500");
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], {
    symbol: "TESTPOWER", isin: "INE000000028", sector: "ENERGY",
    quantity: 70, pledged: 0, averagePrice: 191.2386,
    previousClose: 208, pnl: 1173.3,
  });
  assert.equal(p.rows[1].pnl, -657);
});

test("finds the holdings header after summary rows and a blank line", () => {
  const p = parseZerodhaHoldings([
    ["Something else"],
    ["Symbol", "ISIN", "Quantity Available", "Average Price"],
    ["TESTSOFT", "INE000000025", "10", "1,500.50"],
  ]);
  assert.equal(p.error, null);
  assert.equal(p.rows[0].averagePrice, 1500.5);
  assert.equal(p.rows[0].quantity, 10);
});

test("skips a sheet with no holdings header and uses the next sheet", () => {
  const p = parseZerodhaHoldingsSheets([
    [["Mutual Funds"], ["Scheme", "Units"]],
    matrix,
  ]);
  assert.equal(p.rows.length, 2);
});

test("rejects a file with no holdings table", () => {
  const p = parseZerodhaHoldings([["hello"], ["world"]]);
  assert.match(p.error, /No holdings header/);
  assert.equal(p.rows.length, 0);
});

test("reads the 28-equity statement with its Client ID and date", () => {
  const rows = [
    ["Client ID", "TEST500"],
    ["Equity Holdings Statement as on 2026-11-12"],
    [],
    ["Symbol", "ISIN", "Sector", "Quantity Available", "Quantity Discrepant",
      "Quantity Long Term", "Quantity Pledged (Margin)", "Quantity Pledged (Loan)",
      "Average Price", "Previous Closing Price", "Unrealized P&L", "Unrealized P&L Pct."],
  ];
  for (let i = 0; i < 28; i++) {
    rows.push([`STOCK${i}`, `INE${String(100000000 + i)}`, "ENERGY",
      10 + i, 0, 0, 0, 0, 100 + i, 110 + i, 10, 1]);
  }
  const p = parseZerodhaHoldings(rows);
  assert.equal(p.error, null);
  assert.equal(p.clientId, "TEST500");
  assert.equal(p.asOf, "2026-11-12");
  assert.equal(p.rows.length, 28);
  assert.equal(p.rows[27].quantity, 37);
});
