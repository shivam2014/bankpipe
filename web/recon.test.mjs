import test from "node:test";
import assert from "node:assert/strict";
import { reconPositions, reconSummary } from "./recon.js";

const TODAY = "2026-11-06";
const AS_OF = "2026-10-26";

const lot = (isin, quantity, extra = {}) =>
  ({ security_id: isin, label: "", quantity, cost_paise: 100000, ...extra });
const held = (isin, quantity, extra = {}) =>
  ({ security_id: isin, label: "", quantity, ...extra });

test("equal quantities on both sides are matched", () => {
  const [line] = reconPositions({
    lots: [lot("INE00XL07015", 30)],
    positions: [held("INE00XL07015", 30)],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "matched");
  assert.equal(line.lotQty, 30);
  assert.equal(line.custodianQty, 30);
});

test("two purchase lots of one ISIN sum before the comparison", () => {
  const [line] = reconPositions({
    lots: [lot("INE00XL07015", 10), lot("INE00XL07015", 20)],
    positions: [held("INE00XL07015", 30)],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "matched");
  assert.equal(line.lotCount, 2);
  assert.equal(line.costPaise, 200000);
});

test("the depository holding less than the purchase is a real break", () => {
  const [line] = reconPositions({
    lots: [lot("INE00XL07015", 30)],
    positions: [held("INE00XL07015", 10)],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "quantity_differs");
});

test("bought before the statement date and absent from it is not settled", () => {
  const [line] = reconPositions({
    lots: [lot("INE0B2O07011", 30, { purchase_date: "2026-08-21" })],
    positions: [],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "not_settled");
});

test("bought after the statement date is still in transit, not a break", () => {
  const [line] = reconPositions({
    lots: [lot("INE0B2O07011", 30, { purchase_date: "2026-11-01" })],
    positions: [],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "in_transit");
});

test("a holding with no purchase record has no cost", () => {
  const [line] = reconPositions({
    lots: [],
    positions: [held("INE01E708032", 1)],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "cost_missing");
  assert.equal(line.costPaise, 0);
});

test("maturity closes a position before quantity is compared", () => {
  const [line] = reconPositions({
    lots: [lot("INE01E708032", 1)],
    positions: [held("INE01E708032", 1, { maturity: "2026-08-16" })],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.state, "closed");
});

test("maturity is read from the bond label when the file omits it", () => {
  const [line] = reconPositions({
    lots: [{ security_id: "INE00XL07015", quantity: 30, cost_paise: 100000,
      label: "9.75% BNAL 27 NOV 2028" }],
    positions: [],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(line.maturity, "2028-11-27");
  assert.equal(line.state, "not_settled");
});

test("rows with no ISIN are skipped rather than matched by name", () => {
  const lines = reconPositions({
    lots: [{ security_id: "", label: "Some bond", quantity: 5, cost_paise: 1 }],
    positions: [{ security_id: "", label: "Some bond", quantity: 5 }],
    today: TODAY, asOf: AS_OF,
  });
  assert.equal(lines.length, 0);
});

test("breaks sort above matched lines, closed lines last", () => {
  const lines = reconPositions({
    lots: [lot("A0000000001", 10), lot("B0000000002", 5), lot("C0000000003", 1)],
    positions: [held("A0000000001", 10), held("B0000000002", 2),
      held("C0000000003", 1, { maturity: "2025-01-01" })],
    today: TODAY, asOf: AS_OF,
  });
  assert.deepEqual(lines.map((l) => l.state), ["quantity_differs", "matched", "closed"]);
});

test("the summary counts breaks without counting closed history", () => {
  const lines = reconPositions({
    lots: [lot("A0000000001", 10), lot("B0000000002", 5), lot("C0000000003", 1)],
    positions: [held("A0000000001", 10), held("B0000000002", 2),
      held("C0000000003", 1, { maturity: "2025-01-01" })],
    today: TODAY, asOf: AS_OF,
  });
  const sum = reconSummary(lines);
  assert.equal(sum.total, 3);
  assert.equal(sum.breaks, 1);
  assert.equal(sum.counts.matched, 1);
  assert.equal(sum.counts.closed, 1);
  assert.equal(sum.counts.quantity_differs, 1);
});
