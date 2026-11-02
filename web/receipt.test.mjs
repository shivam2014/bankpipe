import test from "node:test";
import assert from "node:assert/strict";
import { countRows, receiptFrom, receiptTotals } from "./receipt.js";

test("an empty receipt list totals zero", () => {
  assert.deepEqual(receiptTotals([]),
    { read: 0, parsed: 0, rejected: 0, noDate: 0 });
});

test("one sheet totals its own counts", () => {
  assert.deepEqual(receiptTotals([
    { read: 10, parsed: 8, rejected: 2, noDate: 1 },
  ]), { read: 10, parsed: 8, rejected: 2, noDate: 1 });
});

test("several sheets sum read, parsed, rejected and no-date rows", () => {
  assert.deepEqual(receiptTotals([
    { read: 100, parsed: 98, rejected: 2, noDate: 1 },
    { read: 20, parsed: 20, rejected: 0, noDate: 0 },
    { read: 5, parsed: 4, rejected: 1, noDate: 3 },
  ]), { read: 125, parsed: 122, rejected: 3, noDate: 4 });
});

test("a receipt counts totals, dates and undated amounts without identity", () => {
  const receipt = receiptFrom([
    { date: "2024-04-03", amount: -120000 },
    { date: "2024-04-01", amount: 149525 },
    { date: "", amount: -5000 },
    { date: "2024-04-04", amount: null },
  ], { sheet: 4, read: 7 });
  assert.deepEqual(receipt, {
    sheet: 4, read: 7, parsed: 4, rejected: 3, noDate: 1,
    debit: 125000, credit: 149525, first: "2024-04-01", last: "2024-04-04",
  });
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
