import test from "node:test";
import assert from "node:assert/strict";
import { applyCasEvents, applyCasEventsToPortfolio, casEventKey, casLegacyEventKey,
  linkedCostPortfolios, planLinkedSales } from "./cas-apply.js";

const ISIN = "INE000000031";
const sale = (over = {}) => ({ isin: ISIN, date: "2026-08-12", type: "SALE",
  description: "SALE", side: "debit", kind: "sale", quantity: 60,
  openingPaise: 10000, creditPaise: 0, debitPaise: 6000, closingPaise: 4000, ...over });
const lot = (over = {}) => ({ security_id: ISIN, label: "TEST BOND", category: "bond",
  quantity: 50, cost_paise: 50000, purchase_date: "2024-01-01",
  as_of: "2026-07-31", value_paise: 500000, ...over });

const demat = { id: "demat-a", label: "Demat A", category: "demat", number: "IN99990001344321" };
const otherDemat = { id: "demat-b", label: "Demat B", category: "demat",
  number: "IN99990005344322" };
const costA = { id: "cost-a", label: "Cost portfolio A", category: "bonds",
  meta: JSON.stringify({ linked_asset: "demat-a" }) };
const costB = { id: "cost-b", label: "Cost portfolio B", category: "bonds",
  meta: JSON.stringify({ linked_asset: "demat-b" }) };

test("the linked cost portfolio is found through the demat link", () => {
  const accounts = [demat, otherDemat, costA, costB];
  const holdings = new Map([
    ["demat-a", [{ security_id: ISIN, category: "bond", quantity: 100 }]],
    ["demat-b", [{ security_id: "INE000000099", category: "bond", quantity: 10 }]],
    ["cost-a", [lot()]],
    ["cost-b", [lot({ security_id: "INE000000099" })]],
  ]);
  const rowsOf = (id) => holdings.get(id) || [];
  assert.deepEqual(linkedCostPortfolios("demat-a", accounts, rowsOf).map((a) => a.id),
    ["cost-a"]);
  assert.deepEqual(linkedCostPortfolios("demat-b", accounts, rowsOf).map((a) => a.id),
    ["cost-b"]);
  assert.deepEqual(linkedCostPortfolios("demat-a", [demat], rowsOf), []);
});

test("a disposed lot does not decide which demat a portfolio feeds", () => {
  const OTHER = "INE000000032";
  const portfolio = { id: "cost-a", label: "Cost portfolio A", category: "bonds" };
  const accounts = [demat, otherDemat, portfolio];
  const holdings = new Map([
    ["demat-a", [{ security_id: ISIN, category: "bond", quantity: 100 }]],
    ["demat-b", [{ security_id: OTHER, category: "bond", quantity: 10 }]],
    ["cost-a", [
      { security_id: ISIN, category: "bond", quantity: 0, disposed_at: "2026-08-01" },
      { security_id: OTHER, category: "bond", quantity: 10, cost_paise: 10000 },
    ]],
  ]);
  const rowsOf = (id) => holdings.get(id) || [];
  assert.deepEqual(linkedCostPortfolios("demat-b", accounts, rowsOf).map((a) => a.id),
    ["cost-a"]);
});

test("link inference counts distinct ISINs, not lot occurrences", () => {
  const OTHER_A = "INE000000041";
  const OTHER_B = "INE000000042";
  const portfolio = { id: "cost-a", label: "Cost portfolio A", category: "bonds" };
  const accounts = [demat, otherDemat, portfolio];
  const holdings = new Map([
    ["demat-a", [{ security_id: ISIN, category: "bond", quantity: 1 }]],
    ["demat-b", [
      { security_id: OTHER_A, category: "bond", quantity: 1 },
      { security_id: OTHER_B, category: "bond", quantity: 1 },
    ]],
    ["cost-a", [
      { security_id: ISIN, category: "bond", quantity: 1, cost_paise: 1 },
      { security_id: ISIN, category: "bond", quantity: 1, cost_paise: 1 },
      { security_id: ISIN, category: "bond", quantity: 1, cost_paise: 1 },
      { security_id: OTHER_A, category: "bond", quantity: 1, cost_paise: 1 },
      { security_id: OTHER_B, category: "bond", quantity: 1, cost_paise: 1 },
    ]],
  ]);
  const rowsOf = (id) => holdings.get(id) || [];
  // Three lots of one ISIN used to outvote two other ISINs. Distinct ISINs make
  // demat-b (two ISINs) the home, not demat-a (one ISIN, three lots).
  assert.deepEqual(linkedCostPortfolios("demat-b", accounts, rowsOf).map((a) => a.id),
    ["cost-a"]);
});

test("the linked portfolio consumes lots FIFO and records the sum of their costs", () => {
  const rows = [
    lot({ quantity: 50, cost_paise: 50000, purchase_date: "2024-01-01" }),
    lot({ quantity: 50, cost_paise: 60000, purchase_date: "2024-06-01" }),
    lot({ quantity: 20, cost_paise: 24000, purchase_date: "2024-03-01" }),
  ];
  const plan = applyCasEventsToPortfolio(rows, [sale()], { assetId: "cost-a",
    asOf: "2026-08-31" });
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.sold[0].disposed_quantity, 60);
  assert.equal(plan.sold[0].disposed_cost_paise, 62000);
  assert.equal(plan.sold[0].disposed_type, "sale");
  assert.equal(plan.sold[0].txn_key, casEventKey(sale(), "cost-a"));
  const live = plan.rows.filter((row) => !row.disposed_at);
  const jan = live.find((row) => row.purchase_date === "2024-01-01");
  const mar = live.find((row) => row.purchase_date === "2024-03-01");
  const jun = live.find((row) => row.purchase_date === "2024-06-01");
  assert.equal(jan, undefined);
  assert.equal(mar.quantity, 10);
  assert.equal(mar.cost_paise, 12000);
  assert.equal(jun.quantity, 50);
  assert.equal(jun.cost_paise, 60000);
});

test("a re-import does not consume the linked lots twice", () => {
  const rows = [lot({ quantity: 100, cost_paise: 100000 })];
  const first = applyCasEventsToPortfolio(rows, [sale()], { assetId: "cost-a",
    asOf: "2026-08-31" });
  const again = applyCasEventsToPortfolio(first.rows, [sale()], { assetId: "cost-a",
    asOf: "2026-08-31" });
  assert.equal(again.sold.length, 0);
  assert.equal(again.applied[0].status, "already");
  assert.deepEqual(again.rows, first.rows);
});

test("a lot without a purchase date is left in place with a warning", () => {
  const rows = [
    lot({ quantity: 40, cost_paise: 40000, purchase_date: "2024-01-01" }),
    lot({ quantity: 20, cost_paise: 20000, purchase_date: "" }),
  ];
  const plan = applyCasEventsToPortfolio(rows, [sale({ quantity: 10 })],
    { assetId: "cost-a" });
  assert.equal(plan.sold[0].disposed_cost_paise, 10000);
  assert.equal(plan.rows.find((row) => row.purchase_date === "").quantity, 20);
  assert.match(plan.warnings.join(" "), /no purchase date/i);
});

test("the demat sold cost reconciles to the FIFO cost and the live cost stays whole", () => {
  const soldRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 120000,
    txn_key: casEventKey(sale(), "demat-a") };
  const liveRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: 80000, value_paise: 400000, as_of: "2026-08-31" };
  const dematPlan = { events: [sale()], sold: [soldRow], rows: [liveRow, soldRow] };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: costA, rows }] });
  assert.equal(linked.reconciliations.length, 1);
  assert.equal(soldRow.disposed_cost_paise, 66000);
  assert.equal(liveRow.cost_paise, 134000);
  assert.equal(linked.portfolios[0].plan.sold.length, 1);
});

test("no linked cost portfolio is not an error", () => {
  const sell = sale();
  const dematPlan = { events: [sell], sold: [], rows: [] };
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    portfolios: [] });
  assert.deepEqual(linked.portfolios, []);
  assert.deepEqual(linked.warnings, []);
  assert.deepEqual(linked.reconciliations, []);
});

test("a partial sale scales the live lot's value but not its per-unit face", () => {
  const rows = [lot({ quantity: 100, cost_paise: 110000, value_paise: 1000000,
    face_paise: 10000000 })];
  const plan = applyCasEventsToPortfolio(rows, [sale({ quantity: 60 })],
    { assetId: "cost-a", asOf: "2026-08-31" });
  const live = plan.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 40);
  assert.equal(live.cost_paise, 44000);
  assert.equal(live.value_paise, 400000);
  assert.equal(live.face_paise, 10000000);
});

test("a cost basis that differs from the demat row is surfaced, not overwritten", () => {
  const soldRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 120000,
    txn_key: casEventKey(sale(), "demat-a") };
  const liveRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: 80000, value_paise: 400000, as_of: "2026-08-31" };
  const dematPlan = { events: [sale()], sold: [soldRow], rows: [liveRow, soldRow] };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: costA, rows }] });
  assert.equal(soldRow.disposed_cost_paise, 66000);
  assert.equal(liveRow.cost_paise, 134000);
  assert.match(linked.warnings.join(" "),
    /linked cost portfolio holds 440\.00 in cost after the sale/);
});

test("a demat cost that matches the remaining portfolio cost raises no warning", () => {
  const soldRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 66000,
    txn_key: casEventKey(sale(), "demat-a") };
  const liveRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: 44000, value_paise: 400000, as_of: "2026-08-31" };
  const dematPlan = { events: [sale()], sold: [soldRow], rows: [liveRow, soldRow] };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: costA, rows }] });
  assert.equal(liveRow.cost_paise, 44000);
  assert.deepEqual(linked.warnings, []);
});

test("a null live demat cost takes the linked portfolio's remaining cost", () => {
  const soldRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: null,
    txn_key: casEventKey(sale(), "demat-a") };
  const liveRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: null, value_paise: 400000, as_of: "2026-08-31" };
  const dematPlan = { events: [sale()], sold: [soldRow], rows: [liveRow, soldRow] };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: costA, rows }] });
  assert.equal(soldRow.disposed_cost_paise, 66000);
  assert.equal(liveRow.cost_paise, 44000);
  assert.deepEqual(linked.warnings, []);
});

test("a balance-bearing sale reconciles to the linked sold row and only once", () => {
  const event = sale({ quantity: 60, openingPaise: 10000, debitPaise: 6000,
    closingPaise: 4000 });
  const demat = applyCasEvents([{ security_id: ISIN, label: "TEST BOND",
    category: "bond", quantity: 100, cost_paise: 120000, value_paise: 100000,
    as_of: "2026-07-31" }], [event], { asOf: "2026-08-31", assetId: "demat-a" });
  const dematPlan = { ...demat, events: demat.applied };
  assert.equal(casEventKey(demat.applied[0], "demat-a"), demat.sold[0].txn_key);
  const portfolio = { id: "cost-a", label: "Cost portfolio A", category: "bonds" };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: portfolio, rows }] });
  assert.equal(demat.sold[0].disposed_cost_paise, 66000);
  assert.equal(linked.portfolios[0].plan.sold.length, 1);
  assert.equal(linked.reconciliations.length, 1);
  const again = planLinkedSales({ dematPlan: { ...dematPlan, events: dematPlan.events },
    dematAssetId: "demat-a", asOf: "2026-08-31",
    portfolios: [{ account: portfolio, rows: linked.portfolios[0].plan.rows }] });
  assert.equal(again.portfolios[0].plan.sold.length, 0);
  assert.equal(again.portfolios[0].plan.applied[0].status, "already");
});

test("a legacy-keyed sold row still reconciles to the linked FIFO cost", () => {
  const event = sale();
  const soldRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 72000,
    txn_key: casLegacyEventKey(event, "demat-a") };
  const liveRow = { security_id: ISIN, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: 48000, value_paise: 400000, as_of: "2026-08-31" };
  const dematPlan = { events: [{ ...event, txn_key: casEventKey(event, "demat-a") }],
    sold: [soldRow], rows: [liveRow, soldRow] };
  const rows = [lot({ quantity: 100, cost_paise: 110000 })];
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-a",
    asOf: "2026-08-31", portfolios: [{ account: costA, rows }] });
  assert.equal(soldRow.disposed_cost_paise, 66000);
  assert.equal(liveRow.cost_paise, 54000);
  assert.equal(linked.reconciliations.length, 1);
});
