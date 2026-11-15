import test from "node:test";
import assert from "node:assert/strict";
import { accountFieldState, mergeRowsFromPlan, planMerge, planHasWork, planNetChange,
  soldCostAttribution, soldReportVerdict } from "./import-flow.js";
import { casEventKey, planLinkedSales } from "./cas-apply.js";

// Synthetic identifiers only. The real files are never committed.
//
// A broker report that names a bond after a recorded sale has two readings: the
// sale happened and the report is a stale pre-sale view, or the bond was bought
// again. An accepted sold-conflict ask used to write the report's row beside the
// disposal, which left the bond both sold and held and left the disposal's cost
// empty. These tests pin the repair: the sale stays, the sold cost basis is
// filled, and only a dated acquisition after the sale becomes a live row.

const ISIN = "INE000000201";
const SOLD_ON = "2026-10-10";
const REPORT_ON = "2026-11-05";
const BOUGHT_ON = "2024-06-06";
const LABEL = "8.00% TEST BOND 31 Dec 2028";
const SOURCE = { family: "motilal", label: "Motilal Oswal holdings report", asOf: REPORT_ON };

const disposal = (over = {}) => ({
  security_id: ISIN, label: LABEL, category: "bond",
  quantity: 0, cost_paise: 0, value_paise: 0, value_source: "CAS",
  as_of: SOLD_ON, txn_key: "cas-sale-1", source: "report",
  disposed_at: SOLD_ON, disposed_quantity: 10, disposed_type: "sale",
  disposed_source: "CAS", disposed_reason: "SALE", disposed_cost_paise: null,
  ...over,
});

const live = (over = {}) => ({
  security_id: ISIN, label: LABEL, category: "bond",
  quantity: 6, cost_paise: null, value_paise: 60000, value_source: "CAS",
  as_of: SOLD_ON, ...over,
});

const reportRow = (over = {}) => ({
  isin: ISIN, label: LABEL, category: "bond", quantity: 10,
  valuePaise: null, costPaise: 200000, purchaseDate: BOUGHT_ON, ...over,
});

const report = (row = reportRow(), over = {}) => ({
  kind: "motilal", label: SOURCE.label, asOf: REPORT_ON,
  identity: { kind: "ucid", value: "TEST0001" }, categories: ["bond"],
  rows: [row], ...over,
});

const account = (meta = {}) => ({
  id: "demat-1", label: "Demat · Test DP · …4321", category: "demat",
  subtype: "equity", number: "IN99990001344321",
  meta: JSON.stringify({ ucid: "TEST0001", identity_source: "cas",
    identity_as_of: SOLD_ON, holdings_source: "cas", holdings_as_of: SOLD_ON, ...meta }),
});

function planFor(holdings, incoming, acct = account()) {
  return planMerge({
    incoming,
    existing: { ...accountFieldState(acct, holdings), holdings },
    today: "2026-11-15",
  });
}

const write = (holdings, plan, accept = true) =>
  mergeRowsFromPlan(holdings, plan, SOURCE, accept);

const only = (rows) => {
  assert.equal(rows.length, 1, `expected one row, got ${rows.length}`);
  return rows[0];
};
const soldRows = (rows) => rows.filter((row) => row.disposed_at);
const liveRows = (rows) => rows.filter((row) => !row.disposed_at);

// --- the rule, on its own ---------------------------------------------------

test("the verdict reads a dated acquisition after the sale as a new position", () => {
  const sold = disposal();
  const before = soldReportVerdict({ quantity: 10, purchaseDate: BOUGHT_ON, disposed: sold });
  assert.equal(before.kind, "recovery");
  const after = soldReportVerdict({ quantity: 10, purchaseDate: "2026-10-20", disposed: sold });
  assert.equal(after.kind, "new-position");
  assert.match(after.reason, /2026-10-20/);
  const more = soldReportVerdict({ quantity: 15, purchaseDate: "", disposed: sold });
  assert.equal(more.kind, "unexplained");
  assert.match(more.reason, /15/);
  // A partial sale: the live row plus the disposal must name every unit.
  const part = soldReportVerdict({ quantity: 10, purchaseDate: "", disposed: sold, live: 6 });
  assert.equal(part.kind, "unexplained", "6 live + 10 sold is not the report's 10");
  assert.equal(soldReportVerdict({ quantity: 10, disposed: { ...sold, disposed_quantity: 4 },
    live: 6 }).kind, "recovery");
});

test("the cost share is the report's own unit price, and only over the units it names", () => {
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 10 })
    .disposedPaise, 200000);
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 4 })
    .disposedPaise, 80000);
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 4,
    live: 6 }).livePaise, 120000);
  // The report names fewer units than the sale, so it cannot price them all.
  assert.equal(soldCostAttribution({ totalPaise: 100000, reported: 5, disposed: 10 }), null);
  assert.equal(soldCostAttribution({ totalPaise: null, reported: 10, disposed: 10 }), null);
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 0 }), null);
  // A split is made only when the report names exactly the units on file.
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 4 })
    .livePaise, null);
  assert.equal(soldCostAttribution({ totalPaise: 200000, reported: 10, disposed: 4,
    live: 2 }).livePaise, null);
});

// --- a full sale ------------------------------------------------------------

test("a full sale: accepting the ask prices the disposal and adds no live row", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report());
  assert.equal(plan.summary.ask, 1);
  assert.equal(plan.blocking, true);
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-conflict"), true);
  assert.equal(decision.flags.includes("sold-recovery"), true);
  assert.equal(decision.recovery.costPaise, 200000);

  const before = only(write(holdings, plan, false));
  assert.equal(before.disposed_cost_paise, null, "an unaccepted ask writes nothing");

  const after = write(holdings, plan, true);
  const row = only(after);
  assert.equal(row.disposed_cost_paise, 200000, "the sold cost basis is filled");
  assert.equal(row.quantity, 0, "the sale still holds no live units");
  assert.equal(row.disposed_at, SOLD_ON);
  assert.equal(row.disposed_quantity, 10);
  assert.equal(row.txn_key, "cas-sale-1");
  assert.equal(liveRows(after).length, 0, "the bond is not held after a full sale");
  const net = planNetChange(holdings, after);
  assert.equal(net.soldCost, 1);
  assert.equal(net.added, 0);
  assert.equal(net.updated, 0, "a sold basis is not a live holding update");
});

test("accepting the same full sale twice changes nothing the second time", () => {
  const holdings = [disposal()];
  const first = write(holdings, planFor(holdings, report()), true);
  const again = planFor(first, report());
  assert.equal(again.summary.ask, 0);
  assert.equal(again.decisions[0].action, "keep");
  assert.deepEqual(write(first, again, true), first);
});

// --- a partial sale ---------------------------------------------------------

test("a partial sale: accepting the ask prices the sold units and keeps the live ones", () => {
  const holdings = [live(), disposal({ disposed_quantity: 4 })];
  const plan = planFor(holdings, report());
  assert.equal(plan.summary.ask, 1);
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.recovery.costPaise, 80000);

  const after = write(holdings, plan, true);
  assert.equal(after.length, 2, "one live row and one disposal, not three");
  const sold = only(soldRows(after));
  const held = only(liveRows(after));
  assert.equal(sold.disposed_cost_paise, 80000, "4 of the report's 10 units");
  assert.equal(held.cost_paise, 120000, "the other 6 units keep their share");
  assert.equal(held.quantity, 6, "the report's pre-sale quantity is not taken");
  assert.equal(held.cost_paise + sold.disposed_cost_paise, 200000,
    "the report's cost is split once, never counted twice");
  const net = planNetChange(holdings, after);
  assert.equal(net.added, 0);
  assert.equal(net.soldCost, 1);
  assert.equal(net.updated, 1, "the live row's cost is the plan's only update");
});

// --- a re-purchase ----------------------------------------------------------

test("a re-purchase after the sale becomes a live row, with the sale kept as history", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report(reportRow({ quantity: 10, costPaise: 210000,
    purchaseDate: "2026-10-20" })));
  assert.equal(plan.summary.ask, 0, "a dated acquisition is not a sold conflict");
  const add = plan.decisions.find((item) => item.action === "add");
  assert.equal(add.reason, "new holding");

  const after = write(holdings, plan, true);
  assert.equal(after.length, 2);
  const sold = only(soldRows(after));
  assert.equal(sold.disposed_quantity, 10, "the sale stays exactly as recorded");
  assert.equal(sold.disposed_cost_paise, null);
  const held = only(liveRows(after));
  assert.equal(held.quantity, 10);
  assert.equal(held.cost_paise, 210000);
  assert.equal(held.purchase_date, "2026-10-20", "the new lot's own purchase date");
  const net = planNetChange(holdings, after);
  assert.equal(net.added, 1);
  assert.equal(net.soldCost, 0);
});

test("a report that shows more units than the sale explains keeps today's question", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report(reportRow({ quantity: 15, costPaise: 300000,
    purchaseDate: "" })));
  assert.equal(plan.summary.ask, 1, "units the sale does not explain are a decision");
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-recovery"), false);
  assert.equal(decision.changes.some((change) => change.group === "snapshot"
    && change.field === "quantity"), true);
  const after = write(holdings, plan, true);
  assert.equal(only(liveRows(after)).quantity, 15);
});

// --- a disposal that already carries a cost ---------------------------------

test("a disposal that already carries a cost keeps it and the difference is named", () => {
  const holdings = [disposal({ disposed_cost_paise: 190000 })];
  const plan = planFor(holdings, report());
  assert.equal(plan.summary.ask, 0, "two claims are not a reason to rewrite one");
  assert.equal(plan.decisions[0].action, "keep");
  assert.equal(plan.decisions[0].flags.includes("sold-cost-differs"), true);
  assert.match(plan.warnings.join(" "), /1,900\.00/);
  assert.match(plan.warnings.join(" "), /2,000\.00/);
  assert.match(plan.warnings.join(" "), /kept/i);
  const after = only(write(holdings, plan, true));
  assert.equal(after.disposed_cost_paise, 190000, "the recorded basis wins");
});

test("a report with no cost cannot price the sale and writes nothing", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report(reportRow({ costPaise: null })));
  assert.equal(plan.summary.ask, 0, "there is no number to accept");
  assert.equal(plan.decisions[0].action, "skip");
  assert.equal(plan.decisions[0].flags.includes("sold-conflict"), true);
  assert.match(plan.warnings.join(" "), /cost basis is still unknown/i);
  const after = write(holdings, plan, true);
  assert.equal(only(after).disposed_cost_paise, null);
  assert.equal(liveRows(after).length, 0);
});

test("a report that names fewer units than the sale does not price it", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report(reportRow({ quantity: 5, costPaise: 100000 })));
  // Five units cannot be the ten that were sold, and one number cannot price the
  // other. The units are a question, and the disposal stays unpriced.
  assert.equal(plan.summary.ask, 1);
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-recovery"), false);
  assert.match(decision.reason, /5 units.*10|10.*5 units/i);
  const after = write(holdings, plan, true);
  assert.equal(after.find((row) => row.disposed_at).disposed_cost_paise, null);
});

test("several live lots of one bond are left alone rather than priced twice", () => {
  const holdings = [
    live({ quantity: 6, purchase_date: "2024-01-01" }),
    live({ quantity: 6, purchase_date: "2024-06-01" }),
    disposal({ disposed_quantity: 4 }),
  ];
  const plan = planFor(holdings, report(reportRow({ quantity: 16, costPaise: 320000 })));
  assert.equal(plan.summary.ask, 0, "a writer that decides per ISIN cannot price one lot");
  assert.equal(plan.decisions[0].flags.includes("sold-multi-lot"), true);
  assert.match(plan.warnings.join(" "), /2 lots.*cannot price/i);
  const after = write(holdings, plan, true);
  assert.equal(after.length, 3, "no lot is collapsed or dropped");
  assert.equal(after.find((row) => row.disposed_at).disposed_cost_paise, null);
  assert.deepEqual(after.filter((row) => !row.disposed_at).map((row) => row.cost_paise),
    [null, null]);
});

// --- a linked cost portfolio ------------------------------------------------

test("a linked cost portfolio is reduced once and the recovered cost does not double count it", () => {
  // The CAS sale consumes the cost portfolio's FIFO lots, exactly as today.
  const portfolioRows = [
    { security_id: ISIN, label: LABEL, category: "bond", quantity: 60,
      cost_paise: 60000, purchase_date: "2024-01-01", as_of: "2026-09-30" },
    { security_id: ISIN, label: LABEL, category: "bond", quantity: 40,
      cost_paise: 50000, purchase_date: "2024-06-01", as_of: "2026-09-30" },
  ];
  const liveRow = { security_id: ISIN, label: LABEL, category: "bond", quantity: 40,
    cost_paise: null, value_paise: 400000, as_of: SOLD_ON };
  const event = { isin: ISIN, date: SOLD_ON, type: "SALE", description: "SALE",
    side: "debit", kind: "sale", quantity: 60, openingPaise: 1000000,
    creditPaise: 0, debitPaise: 600000, closingPaise: 400000 };
  const soldRow = { security_id: ISIN, label: LABEL, category: "bond", quantity: 0,
    cost_paise: 0, value_paise: 0, as_of: SOLD_ON, disposed_at: SOLD_ON,
    disposed_quantity: 60, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 60000,
    txn_key: casEventKey(event, "demat-1") };
  const dematPlan = { events: [event], sold: [soldRow], rows: [liveRow, soldRow] };
  const linked = planLinkedSales({ dematPlan, dematAssetId: "demat-1", asOf: SOLD_ON,
    portfolios: [{ account: { id: "cost-a" },
      rows: portfolioRows.map((row) => ({ ...row })) }] });
  assert.equal(soldRow.disposed_cost_paise, 60000, "the portfolio priced the sale");
  assert.equal(liveRow.cost_paise, 50000, "the live row takes the portfolio's remainder");
  const lotsLeft = linked.portfolios[0].plan.rows.filter((row) => !row.disposed_at);
  assert.equal(lotsLeft.length, 1, "the January lot was consumed whole");
  assert.equal(lotsLeft[0].quantity, 40);
  assert.equal(lotsLeft[0].cost_paise, 50000, "the portfolio holds the cost once");
  const portfolioAfterCas = linked.portfolios[0].plan.rows.map((row) => ({ ...row }));

  // A later broker report disagrees. The recorded basis and the portfolio stay.
  const holdings = dematPlan.rows.map((row) => ({ ...row }));
  const plan = planFor(holdings, report(reportRow({ quantity: 100, costPaise: 200000 })));
  assert.equal(plan.summary.ask, 0);
  assert.equal(plan.decisions[0].flags.includes("sold-cost-differs"), true);
  const after = write(holdings, plan, true);
  assert.equal(after.find((row) => row.disposed_at).disposed_cost_paise, 60000);
  assert.equal(after.find((row) => !row.disposed_at).cost_paise, 50000,
    "the live demat basis is not moved by the report");
  assert.deepEqual(linked.portfolios[0].plan.rows, portfolioAfterCas,
    "the recovery never runs the sale against the portfolio a second time");
});

// --- a depository statement is not an enrichment ---------------------------

test("a depository statement that still names a sold bond stays a question", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, {
    kind: "cas", label: "CDSL CAS", asOf: REPORT_ON,
    identity: { kind: "bo", value: "IN99990001344321" }, categories: ["bond"],
    rows: [reportRow()],
  });
  assert.equal(plan.summary.ask, 1, "the custody record contradicting a sale is a decision");
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-recovery"), false);
  assert.equal(decision.recovery, undefined);
  const after = write(holdings, plan, true);
  assert.equal(after.find((row) => row.disposed_at).disposed_cost_paise, null,
    "a statement never puts a cost on a disposal it disagrees with");
});

// --- the plan the page writes ----------------------------------------------

test("an ask counts as work, so an accepted one reaches the writer", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report());
  assert.equal(planHasWork(plan), true, "a pending ask is work");
  assert.equal(planHasWork({ plan }), true, "a receipt's plan reads the same");
  assert.equal(planHasWork({ plan: { summary: { ask: 0 } } }), false);
  assert.equal(planHasWork(null), false);
});

test("the composed plan writes the recovered basis through mergeRowsFromPlan", () => {
  const holdings = [disposal()];
  const plan = planFor(holdings, report());
  const rows = write(holdings, plan, false);
  assert.equal(rows.find((row) => row.disposed_at).disposed_cost_paise, null);
  const accepted = write(holdings, plan, true);
  assert.equal(accepted.find((row) => row.disposed_at).disposed_cost_paise, 200000);
  assert.equal(accepted.filter((row) => row.security_id === ISIN).length, 1,
    "one row for one security: the sale, priced");
});
