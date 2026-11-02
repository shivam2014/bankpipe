import test from "node:test";
import assert from "node:assert/strict";
import { countRows, receiptFrom, receiptTotals } from "./receipt.js";

test("an empty receipt list totals zero", () => {
  assert.deepEqual(receiptTotals([]), {
    read: 0, parsed: 0, rejected: 0, noDate: 0,
    reasons: { total: 0, blank: 0, stray: 0, orphan: 0 },
    head: { match: 0, mismatch: 0, unknown: 0 },
  });
});

test("one sheet totals its own counts", () => {
  assert.deepEqual(receiptTotals([
    { read: 10, parsed: 8, rejected: 2, noDate: 1 },
  ]), {
    read: 10, parsed: 8, rejected: 2, noDate: 1,
    reasons: { total: 0, blank: 0, stray: 0, orphan: 0 },
    head: { match: 0, mismatch: 0, unknown: 1 },
  });
});

test("several sheets sum read, parsed, rejected and no-date rows", () => {
  assert.deepEqual(receiptTotals([
    { read: 100, parsed: 98, rejected: 2, noDate: 1 },
    { read: 20, parsed: 20, rejected: 0, noDate: 0 },
    { read: 5, parsed: 4, rejected: 1, noDate: 3 },
  ]), {
    read: 125, parsed: 122, rejected: 3, noDate: 4,
    reasons: { total: 0, blank: 0, stray: 0, orphan: 0 },
    head: { match: 0, mismatch: 0, unknown: 3 },
  });
});

test("a receipt counts totals, dates and undated amounts without identity", () => {
  const receipt = receiptFrom([
    { date: "2024-04-03", amount: -120000 },
    { date: "2024-04-01", amount: 149525 },
    { date: "", amount: -5000 },
    { date: "2024-04-04", amount: null },
  ], { sheet: 4, read: 7 });
  assert.deepEqual(receipt, {
    sheet: 4, read: 7, parsed: 4, rejected: 3,
    reasons: null, stray: [], orphan: [],
    noDate: 1, debit: 125000, credit: 149525,
    first: "2024-04-01", last: "2024-04-04",
    opening: null, openingFromRows: null,
  });
});

test("reasons sum to rejected and keep the stray and orphan rows", () => {
  const receipt = receiptFrom([
    { date: "2024-04-01", amount: -1000, balance: 99000 },
    { date: "2024-04-02", amount: 500, balance: 99500 },
  ], {
    sheet: 6, read: 6, opening: 100000,
    reasons: { total: 1, blank: 2, stray: 2, orphan: 1 },
    strayRows: [7, 8], orphanRows: [9],
  });
  assert.equal(receipt.rejected, 6);
  assert.deepEqual(receipt.reasons, { total: 1, blank: 2, stray: 2, orphan: 1 });
  assert.deepEqual(receipt.stray, [7, 8]);
  assert.deepEqual(receipt.orphan, [9]);
  assert.equal(receipt.opening, 100000);
  assert.equal(receipt.openingFromRows, 100000);
});

test("the head check compares the printed opening with the first dated row", () => {
  const match = receiptTotals([
    { opening: 100000, openingFromRows: 100000 },
    { opening: 100000, openingFromRows: 100001 },
  ]);
  assert.equal(match.head.match, 2);
  assert.equal(match.head.mismatch, 0);
  const mismatch = receiptTotals([
    { opening: 100000, openingFromRows: 101000 },
    { opening: null, openingFromRows: 10 },
  ]);
  assert.equal(mismatch.head.mismatch, 1);
  assert.equal(mismatch.head.unknown, 1);
});

test("countRows ignores rows that are entirely blank", () => {
  const matrix = [
    ["Date", "Description", "Amount"],
    ["01/04/2024", "A", "10"],
    ["", "   ", null],
    [],
    ["02/04/2024", "TOTAL", ""],
  ];
  assert.equal(countRows(matrix, 1), 2);
});
