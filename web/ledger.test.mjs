import test from "node:test";
import assert from "node:assert/strict";

import { dedupePlan, duplicateIds, reconcileChain, orderForChain, statementChain,
  planImport } from "./ledger.js";

const row = (date, amount, balance, extra = {}) => ({ date, amount, balance, ...extra });

test("re-importing the same rows inserts nothing", () => {
  const statement = [
    row("2024-01-01", 100_000, 100_000),
    row("2024-01-02", -2_500, 97_500),
    row("2024-01-03", -1_200, 96_300),
  ];
  const plan = dedupePlan(statement, statement);
  assert.deepEqual(plan.insert, [false, false, false]);
  assert.equal(plan.duplicates, 3);
  assert.deepEqual(plan.updates, [null, null, null]);
});

test("two genuinely identical rows in a fresh file both insert", () => {
  const twins = [row("2024-01-01", 500, 500), row("2024-01-01", 500, 500)];
  const plan = dedupePlan([], twins);
  assert.deepEqual(plan.insert, [true, true]);
  assert.equal(plan.duplicates, 0);
});

test("a batch overlapping an existing statement inserts only the new rows", () => {
  const existing = [row("2024-01-01", 100_000, 100_000), row("2024-01-02", -2_500, 97_500)];
  const incoming = [
    row("2024-01-02", -2_500, 97_500),
    row("2024-01-03", -1_200, 96_300),
    row("2024-01-04", -800, 95_500),
  ];
  const plan = dedupePlan(existing, incoming);
  assert.deepEqual(plan.insert, [false, true, true]);
  assert.equal(plan.duplicates, 1);
});

test("a held row does not swallow a second genuine duplicate in the batch", () => {
  const existing = [row("2024-01-01", 500, 500)];
  const incoming = [row("2024-01-01", 500, 500), row("2024-01-01", 500, 500)];
  const plan = dedupePlan(existing, incoming);
  assert.deepEqual(plan.insert, [false, true]);
  assert.equal(plan.duplicates, 1);
});

test("the same transaction from another source corrects the balance instead of duplicating", () => {
  // The workbook and the bank export can disagree on the running balance for the
  // same payment. The statement wins; no second row is created.
  const existing = [{ id: 7, date: "2026-08-14", amount: -283384,
    balance: 8296611, narration: "IN3OT260731000BK NOSTROACCOUNT|STANDARD CHARTER" }];
  const incoming = [row("2026-08-14", -283384, 31000018,
    { narration: "IN3OT260731000BK NOSTROACCOUNT|STANDARD CHARTER" })];
  const plan = dedupePlan(existing, incoming);
  assert.deepEqual(plan.insert, [false]);
  assert.equal(plan.duplicates, 0);
  assert.deepEqual(plan.updates, [{ id: 7, balance: 31000018,
    narration: "IN3OT260731000BK NOSTROACCOUNT|STANDARD CHARTER" }]);
});

test("a different narration with the same amount is a different transaction", () => {
  const existing = [{ id: 9, date: "2026-08-14", amount: -100000,
    balance: 500000, narration: "PAYMENT GATEWAY BLINKIT" }];
  const plan = dedupePlan(existing, [row("2026-08-14", -100000, 400000,
    { narration: "PAYMENT GATEWAY TATAPOWER" })]);
  assert.deepEqual(plan.insert, [true]);
  assert.deepEqual(plan.updates, [null]);
});

test("repeated same-amount rows with different balances are kept", () => {
  // Three ATM withdrawals of ₹3,500 on one day. Each moves the balance by
  // ₹3,500, so they are three transactions, not one recorded three times.
  const rows = [
    { id: 1, date: "2010-12-10", amount: -350000, balance: 49527722, narration: "ATM" },
    { id: 2, date: "2010-12-10", amount: -350000, balance: 49177722, narration: "ATM" },
    { id: 3, date: "2010-12-10", amount: -350000, balance: 48827722, narration: "ATM" },
  ];
  assert.deepEqual(duplicateIds(rows), []);
  // The same event twice, same balance, is a duplicate.
  const copies = [
    { id: 4, date: "2010-12-10", amount: -350000, balance: 48827722, narration: "ATM" },
    { id: 5, date: "2010-12-10", amount: -350000, balance: 48827722, narration: "ATM" },
  ];
  assert.deepEqual(duplicateIds(copies), [5]);
});

test("duplicate copies of one transaction are identified by date, amount and text", () => {
  const rows = [
    { id: 1, date: "2026-08-14", amount: -283384, narration: "IN3OT NOSTRO" },
    { id: 2, date: "2026-08-14", amount: -283384, narration: "in3ot  nostro" },
    { id: 3, date: "2026-08-14", amount: -29407, narration: "SCW108" },
    { id: 4, date: "2026-08-14", amount: -283384, narration: "SOMETHING ELSE" },
  ];
  assert.deepEqual(duplicateIds(rows), [2]);
});

test("with a null balance, narration is part of identity", () => {
  const existing = [row("2024-01-01", 500, null, { narration: "Coffee Shop" })];

  const same = dedupePlan(existing, [row("2024-01-01", 500, null, { narration: "coffee   shop" })]);
  assert.deepEqual(same.insert, [false]);
  assert.equal(same.duplicates, 1);

  const other = dedupePlan(existing, [row("2024-01-01", 500, null, { narration: "Bus fare" })]);
  assert.deepEqual(other.insert, [true]);
  assert.equal(other.duplicates, 0);
});

test("with a readable balance, narration is ignored", () => {
  const existing = [row("2024-01-01", 500, 900, { narration: "Coffee Shop" })];
  const plan = dedupePlan(existing, [row("2024-01-01", 500, 900, { narration: "Something else" })]);
  assert.deepEqual(plan.insert, [false]);
  assert.equal(plan.duplicates, 1);
});

test("one broken balance yields one issue and one suppressed neighbour", () => {
  const chain = [
    { id: 1, amount: 100_000, balance: 100_000 },
    { id: 2, amount: -20_000, balance: 80_000 },
    { id: 3, amount: -10_000, balance: 60_000 }, // expected 70_000
    { id: 4, amount: -10_000, balance: 60_000 }, // expected 50_000, opposite error
    { id: 5, amount: -10_000, balance: 50_000 },
  ];
  assert.deepEqual(reconcileChain(chain), {
    issues: [{ id: 3, expected: 70_000, actual: 60_000, delta: -10_000 }],
    suppressed: [4],
  });
});

test("a clean chain yields no issues", () => {
  const chain = [
    { id: 1, amount: 1_000, balance: 1_000 },
    { id: 2, amount: -400, balance: 600 },
    { id: 3, amount: 50, balance: 650 },
  ];
  assert.deepEqual(reconcileChain(chain), { issues: [], suppressed: [] });
});

test("excluded rows are invisible to the balance chain", () => {
  const chain = [
    { id: 1, amount: 1_000, balance: 1_000 },
    { id: 2, amount: 9_999, balance: 10_999, excluded: true },
    { id: 3, amount: -400, balance: 600 },
  ];
  assert.deepEqual(reconcileChain(chain), { issues: [], suppressed: [] });
});

test("printed order is kept when every day chains forward", () => {
  const rows = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -100, balance: 900 },
    { id: 3, date: "2024-04-02", amount: -50, balance: 850 },
    { id: 4, date: "2024-04-03", amount: 25, balance: 875 },
  ];
  const res = orderForChain(rows, { previousBalance: 0 });
  assert.deepEqual(res.rows.map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(res.reversed, []);
  assert.deepEqual(res.unresolved, []);
});

test("a day printed in reverse is flipped and reported", () => {
  const rows = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -50, balance: 850 },
    { id: 3, date: "2024-04-02", amount: -100, balance: 900 },
    { id: 4, date: "2024-04-03", amount: 25, balance: 875 },
  ];
  const res = orderForChain(rows, { previousBalance: 0 });
  assert.deepEqual(res.rows.map((r) => r.id), [1, 3, 2, 4]);
  assert.deepEqual(res.reversed, [{ date: "2024-04-02", ids: [3, 2] }]);
  assert.deepEqual(res.unresolved, []);
});

test("a day that chains neither way is left alone and reported", () => {
  const rows = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -50, balance: 700 },
    { id: 3, date: "2024-04-02", amount: -100, balance: 900 },
  ];
  const res = orderForChain(rows, { previousBalance: 0 });
  assert.deepEqual(res.rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(res.reversed, []);
  assert.deepEqual(res.unresolved, [{ date: "2024-04-02", ids: [2, 3] }]);
});

test("a single-row day is never reordered", () => {
  const rows = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -50, balance: 1 },
  ];
  const res = orderForChain(rows, { previousBalance: 0 });
  assert.deepEqual(res.rows.map((r) => r.id), [1, 2]);
  assert.deepEqual(res.reversed, []);
  assert.deepEqual(res.unresolved, []);
});

test("a repeated end-of-day balance is not treated as reversed", () => {
  const rows = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -100, balance: 1_200 },
    { id: 3, date: "2024-04-02", amount: 300, balance: 1_200 },
  ];
  const res = orderForChain(rows, { previousBalance: 0 });
  assert.deepEqual(res.rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(res.reversed, []);
  assert.deepEqual(res.unresolved, []);
});

test("a 5-day overlap is reported and a 1-day boundary overlap is not", () => {
  const contiguous = [
    { id: "jan", start: "2024-01-01", end: "2024-01-31", opening: 0, closing: 1_000 },
    { id: "feb", start: "2024-02-01", end: "2024-02-29", opening: 1_000, closing: 2_000 },
    { id: "mar", start: "2024-02-29", end: "2024-03-31", opening: 2_000, closing: 3_000 },
  ];
  assert.deepEqual(statementChain(contiguous), { gaps: [], overlaps: [] });

  const oneDay = [
    { id: "jan", start: "2024-01-01", end: "2024-01-31", opening: 0, closing: 1_000 },
    { id: "feb", start: "2024-01-30", end: "2024-02-29", opening: 1_000, closing: 2_000 },
  ];
  assert.deepEqual(statementChain(oneDay), { gaps: [], overlaps: [] });

  const fiveDays = [
    { id: "jan", start: "2024-01-01", end: "2024-01-31", opening: 0, closing: 1_000 },
    { id: "feb", start: "2024-01-26", end: "2024-02-29", opening: 1_000, closing: 2_000 },
  ];
  assert.deepEqual(statementChain(fiveDays), { gaps: [], overlaps: [{ id: "feb", overlapDays: 5 }] });
});

test("a discontinuous statement yields exactly one gap", () => {
  const statements = [
    { id: "jan", start: "2024-01-01", end: "2024-01-31", opening: 0, closing: 1_000 },
    { id: "mar", start: "2024-03-01", end: "2024-03-31", opening: 1_200, closing: 2_000 },
  ];
  assert.deepEqual(statementChain(statements), {
    gaps: [{ id: "mar", previousClosing: 1_000, opening: 1_200 }],
    overlaps: [],
  });
});

test("a repeated end-of-day balance is not a break", () => {
  const chain = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -100, balance: 1_200 },
    { id: 3, date: "2024-04-02", amount: 300, balance: 1_200 },
    { id: 4, date: "2024-04-03", amount: -200, balance: 1_000 },
  ];
  assert.deepEqual(reconcileChain(chain), { issues: [], suppressed: [] });
});

test("a wrong day-end balance is one issue, not one per row", () => {
  const chain = [
    { id: 1, date: "2024-04-01", amount: 1_000, balance: 1_000 },
    { id: 2, date: "2024-04-02", amount: -100, balance: 900 },
    { id: 3, date: "2024-04-02", amount: -100, balance: 700 },
  ];
  const issue = reconcileChain(chain).issues[0];
  assert.equal(reconcileChain(chain).issues.length, 1);
  assert.equal(issue.actual, 700);
  // The ledger explains the figure: where the day started, what its rows add
  // up to, and the difference.
  assert.equal(issue.previous, 1000);
  assert.equal(issue.dayNet, -200);
  assert.equal(issue.expected, 800);
  assert.equal(issue.delta, -100);
});

test("a blank date is the same held row, not a new one on re-import", () => {
  const existing = [{ date: null, amount: 500, balance: 500, narration: "A" }];
  const incoming = [{ date: "", amount: 500, balance: 500, description: "A" }];
  const plan = dedupePlan(existing, incoming);
  assert.deepEqual(plan.insert, [false]);
  assert.equal(plan.duplicates, 1);
});

test("a row without a balance matches by description on re-import", () => {
  const existing = [{ date: "2024-04-01", amount: -500, balance: null, narration: "ATM" }];
  const incoming = [{ date: "2024-04-01", amount: -500, balance: null, description: "atm" }];
  const plan = dedupePlan(existing, incoming);
  assert.deepEqual(plan.insert, [false]);
  assert.equal(plan.duplicates, 1);
});

test("planImport checks the held rows and the file as one chain", () => {
  const held = [
    { id: 1, date: "2024-04-02", amount: 100000, balance: 1100000,
      run_id: 1, run_first_date: "2024-04-02" },
    { id: 2, date: "2024-04-03", amount: -20000, balance: 1080000,
      run_id: 1, run_first_date: "2024-04-02" },
  ];
  const incoming = [{ date: "2024-04-04", amount: -10000, balance: 1060000 }];
  const plan = planImport({ held, incoming });
  assert.deepEqual(plan.insert, [true]);
  assert.equal(plan.duplicates, 0);
  assert.equal(plan.corrected, 0);
  assert.equal(plan.breaks.length, 1, "the file alone chains from its own first row");
  assert.deepEqual(plan.merged.map((r) => r.date),
    ["2024-04-02", "2024-04-03", "2024-04-04"]);
});

test("planImport puts a back-dated run before the held run", () => {
  const held = [{ id: 7, date: "2024-04-02", amount: 100000, balance: 1200000,
    run_id: 3, run_first_date: "2024-04-02" }];
  const incoming = [
    { date: "2024-03-01", amount: 400000, balance: 400000 },
    { date: "2024-03-02", amount: 700000, balance: 1100000 },
  ];
  const plan = planImport({ held, incoming });
  assert.deepEqual(plan.merged.map((r) => r.date),
    ["2024-03-01", "2024-03-02", "2024-04-02"]);
  assert.equal(plan.breaks.length, 0);
});

test("planImport counts undated and out-of-order rows and the closing match", () => {
  const incoming = [
    { date: "2024-04-02", amount: 100000, balance: 1100000 },
    { date: "", amount: -20000, balance: 1080000 },
    { date: "2024-04-04", amount: -20000, balance: 1060000 },
    { date: "2024-04-03", amount: -10000, balance: 1070000 },
  ];
  const plan = planImport({ incoming, closing: 1070000 });
  assert.equal(plan.noDate, 1);
  assert.equal(plan.outOfOrder, 1);
  assert.deepEqual(plan.closing,
    { printed: 1070000, actual: 1070000, matches: true });
});
