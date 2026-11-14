import test from "node:test";
import assert from "node:assert/strict";
import { casSoldLines, splitHoldings, soldHoldingsHtml, soldTypeLabel } from "./sold-view.js";

const live = { id: 1, label: "9.00% LIVE BOND", security_id: "INE000000031",
  category: "bond", quantity: 60, value_paise: 6000000 };
const sold = { id: 2, label: "9.00% SOLD BOND", security_id: "INE000000032",
  category: "bond", quantity: 0, value_paise: 0, disposed_at: "2026-08-12",
  disposed_quantity: 50, disposed_type: "sale", disposed_source: "CAS",
  disposed_reason: "SALE", disposed_cost_paise: 500000 };
const transferred = { ...sold, id: 3, disposed_type: "transfer-out",
  disposed_reason: "TRANSFER OUT" };

const fmt = {
  esc: (value) => String(value ?? ""),
  money: (paise) => `₹${Number(paise) / 100}`,
  dateLabel: (value) => String(value),
  jsArg: (value) => `"${value}"`,
};

test("live and sold rows are separated for the bond page", () => {
  const split = splitHoldings([live, sold, transferred]);
  assert.deepEqual(split.live.map((row) => row.id), [1]);
  assert.deepEqual(split.sold.map((row) => row.id), [2, 3]);
});

test("a sold bond is shown with its type, units, date and cost basis", () => {
  const html = soldHoldingsHtml([sold], "demat-a", fmt);
  assert.match(html, /Sold and transferred out \(1\)/);
  assert.match(html, /not counted/);
  assert.match(html, /9\.00% SOLD BOND/);
  assert.match(html, /INE000000032/);
  assert.match(html, /<b>Sold<\/b>/);
  assert.match(html, /50 units/);
  assert.match(html, /2026-08-12/);
  assert.match(html, /cost ₹5000/);
  assert.equal(html.includes("LIVE BOND"), false);
});

test("a transfer out is labelled as a transfer, not a sale", () => {
  assert.equal(soldTypeLabel(transferred), "Transferred out");
  assert.match(soldHoldingsHtml([transferred], "demat-a", fmt), /Transferred out/);
});

test("no disposals render nothing", () => {
  assert.equal(soldHoldingsHtml([], "demat-a", fmt), "");
  assert.equal(soldHoldingsHtml([live], "demat-a", fmt), "");
});

test("the CAS preview lists the sold row with its date, units and cost", () => {
  const lines = casSoldLines({ sold: [sold] }, fmt);
  assert.deepEqual(lines,
    ["Sold 50 units of INE000000032 on 2026-08-12: cost ₹5000"]);
});

test("a sold row with no cost says so instead of printing zero", () => {
  const lines = casSoldLines({ sold: [{ ...sold, disposed_cost_paise: null }] }, fmt);
  assert.match(lines[0], /cost not known/);
});
