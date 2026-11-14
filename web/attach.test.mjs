import test from "node:test";
import assert from "node:assert/strict";
import { attachCost, applyCost, absorbableSources, coverageBySource, planConsolidation, planCostFile, planFreshLots, planSnapshot } from "./attach.js";

const pos = (isin, quantity, cost = null) =>
  ({ security_id: isin, quantity, cost_paise: cost });
const lot = (isin, quantity, cost, date = "2026-01-30") =>
  ({ security_id: isin, quantity, cost_paise: cost, purchase_date: date });

test("a position whose quantity matches its lots takes their total cost", () => {
  const { updates, matched } = attachCost({
    positions: [pos("INE999900272", 30)],
    lots: [lot("INE999900272", 10, 9960229), lot("INE999900272", 20, 19529612,
      "2025-12-02")],
  });
  assert.deepEqual(matched, ["INE999900272"]);
  assert.equal(updates[0].cost_paise, 29489841);
  assert.equal(updates[0].purchase_date, "2025-12-02");
});

test("a quantity that does not match is skipped, never averaged", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE000000019", 14)],
    lots: [lot("INE000000019", 10, 9823491)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "quantity");
  assert.equal(skipped[0].heldQty, 14);
  assert.equal(skipped[0].lotQty, 10);
});

test("a bond the seller never reported is left without cost", () => {
  const { skipped } = attachCost({
    positions: [pos("INE000000020", 100)],
    lots: [],
  });
  assert.equal(skipped[0].reason, "no-lot");
});

test("a position that already has cost is not overwritten", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE999900272", 30, 12345)],
    lots: [lot("INE999900272", 30, 29489841)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "has-cost");
});

test("a lot with no cost blocks the whole position", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE999900272", 30)],
    lots: [lot("INE999900272", 10, 100), lot("INE999900272", 20, null)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "lot-without-cost");
});

test("applying the updates keeps every field it does not own", () => {
  const positions = [{ security_id: "INE999900272", quantity: 30,
    cost_paise: null, value_paise: 29460000, label: "TESTC", purchase_date: "" }];
  const [row] = applyCost(positions, [{ security_id: "INE999900272",
    cost_paise: 29489841, purchase_date: "2025-12-02" }]);
  assert.equal(row.cost_paise, 29489841);
  assert.equal(row.purchase_date, "2025-12-02");
  assert.equal(row.value_paise, 29460000);
  assert.equal(row.label, "TESTC");
});

test("a position with no update is returned untouched", () => {
  const positions = [pos("INE000000020", 100)];
  const [row] = applyCost(positions, []);
  assert.equal(row.cost_paise, null);
});

// --- retiring a cost portfolio ---------------------------------------------

test("a portfolio is retired only when every one of its lots landed", () => {
  const sources = [
    { id: "p1", lots: [{ security_id: "INE1" }, { security_id: "INE2" }] },
    { id: "p2", lots: [{ security_id: "INE3" }] },
  ];
  const cov = coverageBySource(sources, ["ine1", "INE2"].map((s) => s.toUpperCase()));
  assert.deepEqual(cov, [
    { id: "p1", fully: true },
    { id: "p2", fully: false },
  ]);
});

test("a portfolio with no lots is never retired", () => {
  assert.deepEqual(coverageBySource([{ id: "p1", lots: [] }], []), [{ id: "p1", fully: false }]);
});

// --- merging the portfolio into the demat ------------------------------------

test("a portfolio whose every lot is on a demat is absorbed", () => {
  const ids = absorbableSources({
    sources: [{ id: "p1", lots: [lot("INE1", 10, 1000), lot("INE2", 5, 500)] }],
    demats: [{ positions: [
      { security_id: "INE1", quantity: 10 },
      { security_id: "INE2", quantity: 5 },
    ] }],
    today: "2026-11-09",
  });
  assert.deepEqual(ids, ["p1"]);
});

test("a matured lot does not keep a portfolio alive", () => {
  const ids = absorbableSources({
    sources: [{ id: "p1", lots: [
      { security_id: "INE1", quantity: 10, label: "9% TEST 01 JAN 2027" },
      { security_id: "INE2", quantity: 5, label: "9% TEST 01 JAN 2026" },
    ] }],
    demats: [{ positions: [{ security_id: "INE1", quantity: 10 }] }],
    today: "2026-11-09",
  });
  assert.deepEqual(ids, ["p1"]);
});

test("a live lot in no demat keeps its portfolio visible", () => {
  const ids = absorbableSources({
    sources: [{ id: "p1", lots: [
      { security_id: "INE1", quantity: 10, label: "9% TEST 01 JAN 2027" },
      { security_id: "INE3", quantity: 5, label: "9% TEST 01 JAN 2029" },
    ] }],
    demats: [{ positions: [{ security_id: "INE1", quantity: 10 }] }],
    today: "2026-11-09",
  });
  assert.deepEqual(ids, []);
});

test("a portfolio of only matured lots is left alone", () => {
  const ids = absorbableSources({
    sources: [{ id: "p1", lots: [
      { security_id: "INE2", quantity: 5, label: "9% TEST 01 JAN 2026" },
    ] }],
    demats: [{ positions: [] }],
    today: "2026-11-09",
  });
  assert.deepEqual(ids, []);
});

test("attaching cost carries the fields the depository does not know", () => {
  const plan = planConsolidation({
    demats: [{ id: "cdsl", positions: [{ security_id: "INE1", quantity: 10, cost_paise: null }] }],
    sources: [{ id: "p1", lots: [{ security_id: "INE1", quantity: 10, cost_paise: 1000,
      rating: "AAA", frequency: "Annual", yield_bps: 900 }] }],
  });
  assert.deepEqual(plan.updates[0].carry,
    { rating: "AAA", frequency: "Annual", yield_bps: 900 });
  const [row] = applyCost([{ security_id: "INE1", quantity: 10 }], plan.updates);
  assert.equal(row.rating, "AAA");
  assert.equal(row.frequency, "Annual");
});

// --- consolidating several demats --------------------------------------------

test("a bond held in two demats shares its cost by quantity", () => {
  const plan = planConsolidation({
    demats: [
      { id: "cdsl", positions: [{ security_id: "INE1", quantity: 6, cost_paise: null }] },
      { id: "nsdl", positions: [{ security_id: "INE1", quantity: 4, cost_paise: null }] },
    ],
    sources: [{ id: "p1", lots: [{ security_id: "INE1", quantity: 10, cost_paise: 100000 }] }],
  });
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.updates.find((u) => u.assetId === "cdsl").cost_paise, 60000);
  assert.equal(plan.updates.find((u) => u.assetId === "nsdl").cost_paise, 40000);
  assert.equal(plan.stats.exact, 2);
  assert.deepEqual(plan.retire, ["p1"]);
});

test("a lot larger than the holding gives up only the part still held", () => {
  const plan = planConsolidation({
    demats: [{ id: "cdsl", positions: [{ security_id: "INE2", quantity: 20, cost_paise: null }] }],
    sources: [{ id: "p1", lots: [{ security_id: "INE2", quantity: 30, cost_paise: 300000 }] }],
  });
  assert.equal(plan.updates[0].cost_paise, 200000);
  assert.equal(plan.stats.prorata, 1);
});

test("a portfolio bond held in no demat is counted as gone, not as an asset", () => {
  const plan = planConsolidation({
    demats: [{ id: "cdsl", positions: [{ security_id: "INE2", quantity: 5, cost_paise: null }] }],
    sources: [{ id: "p1", lots: [
      { security_id: "INE2", quantity: 5, cost_paise: 5000 },
      { security_id: "INE9", quantity: 5, cost_paise: 9000 },
    ] }],
  });
  assert.equal(plan.stats.orphan, 1);
  assert.deepEqual(plan.retire, ["p1"]);
  assert.equal(plan.updates.length, 1);
});

test("a bond that already has a cost is left alone", () => {
  const plan = planConsolidation({
    demats: [{ id: "cdsl", positions: [{ security_id: "INE2", quantity: 5, cost_paise: 123 }] }],
    sources: [{ id: "p1", lots: [{ security_id: "INE2", quantity: 5, cost_paise: 5000 }] }],
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.stats.alreadyPriced, 1);
});

// --- a statement and a later file --------------------------------------------

const held = (id, qty, extra = {}) => ({ security_id: id, quantity: qty,
  cost_paise: null, purchase_date: "", ...extra });

test("a unit the statement no longer lists counts as sold", () => {
  const out = planCostFile({
    positions: [held("INE1", 8)],
    rows: [{ security_id: "INE1", quantity: 10, cost_paise: 100000,
      purchase_date: "2026-05-01" }],
    asOf: "2026-10-31",
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.added, 0);
  assert.equal(out.rows[0].cost_paise, 80000);
});

test("a purchase after the statement date is added, not dropped", () => {
  const out = planCostFile({
    positions: [held("INE1", 8)],
    rows: [
      { security_id: "INE1", quantity: 8, cost_paise: 80000, purchase_date: "2026-05-01" },
      { security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-11-05" },
    ],
    asOf: "2026-10-31",
  });
  assert.equal(out.added, 1);
  const row = out.rows.find((r) => r.security_id === "INE2");
  assert.equal(row.quantity, 5);
  assert.equal(row.cost_paise, 50000);
  assert.equal(row.value_paise, 50000);
});

test("an undated holding the statement does not list is left alone", () => {
  const out = planCostFile({
    positions: [held("INE1", 8)],
    rows: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "" }],
    asOf: "2026-10-31",
  });
  assert.equal(out.added, 0);
  assert.equal(out.stale, 1);
});

test("a file older than the statement never overrides it", () => {
  const out = planCostFile({
    positions: [held("INE1", 8)],
    rows: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-09-01" }],
    asOf: "2026-10-31",
  });
  assert.equal(out.added, 0);
  assert.equal(out.rows.length, 1);
});

// --- lots bought after the statement ----------------------------------------

test("a lot bought after the statement is kept as held", () => {
  const add = planFreshLots({
    positions: [held("INE1", 8)],
    lots: [
      { security_id: "INE1", quantity: 8, cost_paise: 80000, purchase_date: "2026-05-01" },
      { security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-11-05" },
    ],
    asOf: "2026-10-31",
  });
  assert.equal(add.length, 1);
  assert.equal(add[0].security_id, "INE2");
});

test("a lot already on the demat is never added twice", () => {
  const add = planFreshLots({
    positions: [held("INE2", 5)],
    lots: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-11-05" }],
    asOf: "2026-10-31",
  });
  assert.equal(add.length, 0);
});

test("an undated lot is never assumed to be new", () => {
  const add = planFreshLots({
    positions: [],
    lots: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "" }],
    asOf: "2026-10-31",
  });
  assert.equal(add.length, 0);
});

test("a position closed at zero units is not a position", () => {
  const add = planFreshLots({
    positions: [held("INE1", 8), held("INE2", 0)],
    lots: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-11-05" }],
    asOf: "2026-10-31",
  });
  assert.equal(add.length, 1);
  assert.equal(add[0].security_id, "INE2");
});

test("a closed position cannot absorb a portfolio's cost", () => {
  const plan = planConsolidation({
    demats: [{ id: "cdsl", positions: [{ security_id: "INE2", quantity: 0, cost_paise: null }] }],
    sources: [{ id: "p1", lots: [{ security_id: "INE2", quantity: 20, cost_paise: 200000 }] }],
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.stats.orphan, 1);
  assert.deepEqual(plan.retire, []);
});

test("a cost file adds the lot a closed position could not take", () => {
  const out = planCostFile({
    positions: [held("INE1", 8), held("INE2", 0)],
    rows: [{ security_id: "INE2", quantity: 5, cost_paise: 50000, purchase_date: "2026-11-05" }],
    asOf: "2026-10-31",
  });
  assert.equal(out.added, 1);
  assert.equal(out.rows.find((r) => r.security_id === "INE2").cost_paise, 50000);
});

// --- an undated snapshot -----------------------------------------------------

const snap = (id, qty, extra = {}) => ({ security_id: id, quantity: qty,
  cost_paise: null, value_paise: null, purchase_date: "", ...extra });

test("a newer snapshot wins on quantity, even with no dates", () => {
  const out = planSnapshot({
    positions: [held("INE1", 100, { cost_paise: 18000000 })],
    rows: [snap("INE1", 150, { value_paise: 30000000 })],
    fileAsOf: "2026-11-09",
    statementAsOf: "2026-09-30",
  });
  assert.equal(out.mode, "reconcile");
  assert.equal(out.rows[0].quantity, 150);
  assert.equal(out.rows[0].value_paise, 30000000);
  // the 50 new units have no known cost, so the known cost is kept
  assert.equal(out.rows[0].cost_paise, 18000000);
});

test("a smaller snapshot drops the sold part and its cost", () => {
  const out = planSnapshot({
    positions: [held("INE1", 100, { cost_paise: 18000000 })],
    rows: [snap("INE1", 80)],
    fileAsOf: "2026-11-09",
    statementAsOf: "2026-09-30",
  });
  assert.equal(out.rows[0].quantity, 80);
  assert.equal(out.rows[0].cost_paise, 14400000);
});

test("a snapshot adds what the statement could not see, and drops what it lost", () => {
  const out = planSnapshot({
    positions: [held("INE1", 100), held("INE2", 5)],
    rows: [snap("INE1", 100), snap("INE3", 10, { value_paise: 250000 })],
    fileAsOf: "2026-11-09",
    statementAsOf: "2026-09-30",
  });
  assert.equal(out.added, 1);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.rows.map((r) => r.security_id).sort(), ["INE1", "INE3"]);
});

test("a snapshot older than the statement only supplies cost", () => {
  const out = planSnapshot({
    positions: [held("INE1", 100)],
    rows: [snap("INE1", 150, { cost_paise: 27000000 })],
    fileAsOf: "2026-09-01",
    statementAsOf: "2026-09-30",
  });
  assert.equal(out.mode, "cost");
  assert.equal(out.rows[0].quantity, 100);
  assert.equal(out.rows[0].cost_paise, 18000000);
});
