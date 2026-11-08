import test from "node:test";
import assert from "node:assert/strict";
import { attachCost, applyCost, coverageBySource, planConsolidation } from "./attach.js";

const pos = (isin, quantity, cost = null) =>
  ({ security_id: isin, quantity, cost_paise: cost });
const lot = (isin, quantity, cost, date = "2026-01-30") =>
  ({ security_id: isin, quantity, cost_paise: cost, purchase_date: date });

test("a position whose quantity matches its lots takes their total cost", () => {
  const { updates, matched } = attachCost({
    positions: [pos("INE999900033", 30)],
    lots: [lot("INE999900033", 10, 9960229), lot("INE999900033", 20, 19529612,
      "2025-12-02")],
  });
  assert.deepEqual(matched, ["INE999900033"]);
  assert.equal(updates[0].cost_paise, 29489841);
  assert.equal(updates[0].purchase_date, "2025-12-02");
});

test("a quantity that does not match is skipped, never averaged", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE999900090", 14)],
    lots: [lot("INE999900090", 10, 9823491)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "quantity");
  assert.equal(skipped[0].heldQty, 14);
  assert.equal(skipped[0].lotQty, 10);
});

test("a bond the seller never reported is left without cost", () => {
  const { skipped } = attachCost({
    positions: [pos("INE999900108", 100)],
    lots: [],
  });
  assert.equal(skipped[0].reason, "no-lot");
});

test("a position that already has cost is not overwritten", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE999900033", 30, 12345)],
    lots: [lot("INE999900033", 30, 29489841)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "has-cost");
});

test("a lot with no cost blocks the whole position", () => {
  const { updates, skipped } = attachCost({
    positions: [pos("INE999900033", 30)],
    lots: [lot("INE999900033", 10, 100), lot("INE999900033", 20, null)],
  });
  assert.equal(updates.length, 0);
  assert.equal(skipped[0].reason, "lot-without-cost");
});

test("applying the updates keeps every field it does not own", () => {
  const positions = [{ security_id: "INE999900033", quantity: 30,
    cost_paise: null, value_paise: 29460000, label: "BNAL", purchase_date: "" }];
  const [row] = applyCost(positions, [{ security_id: "INE999900033",
    cost_paise: 29489841, purchase_date: "2025-12-02" }]);
  assert.equal(row.cost_paise, 29489841);
  assert.equal(row.purchase_date, "2025-12-02");
  assert.equal(row.value_paise, 29460000);
  assert.equal(row.label, "BNAL");
});

test("a position with no update is returned untouched", () => {
  const positions = [pos("INE999900108", 100)];
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
