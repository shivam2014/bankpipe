import test from "node:test";
import assert from "node:assert/strict";
import { reconHeadline, reconRows, reconCardHtml } from "./recon-card.js";

const line = (state, extra = {}) =>
  ({ isin: "INE00XL07015", label: "9.75% BNAL 27 NOV 2028", state, ...extra });

test("an asset with no BO ID says so instead of showing an empty report", () => {
  assert.match(reconHeadline({ reason: "empty" }), /No demat number/);
});

test("a client code is named as the blocker", () => {
  assert.match(reconHeadline({ reason: "client-code" }), /not a BO ID/);
});

test("a single statement means nothing to compare", () => {
  assert.match(reconHeadline({ reason: "no-second-statement" }), /No second statement/);
});

test("two assets on one demat are refused, not guessed", () => {
  assert.match(reconHeadline({ reason: "ambiguous-pair" }), /Two assets share this demat/);
});

test("the receipt counts positions, matches and breaks", () => {
  const head = reconHeadline({
    reason: "ok", total: 3, breaks: 1, counts: { matched: 2 },
  });
  assert.equal(head, "3 positions · 2 matched · 1 break");
});

test("one position and no breaks reads in the singular", () => {
  assert.equal(reconHeadline({ reason: "ok", total: 1, breaks: 0, counts: { matched: 1 } }),
    "1 position · 1 matched · 0 breaks");
});

test("rows list breaks only, never the matches", () => {
  const rows = reconRows({
    lines: [line("quantity_differs", { lotQty: 30, custodianQty: 10 }),
      line("matched", { lotQty: 30 }), line("closed", { maturity: "2026-08-16" })],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stateLabel, "Quantity differs");
  assert.equal(rows[0].detail, "seller 30 units · depository 10 units");
  assert.equal(rows[1].stateLabel, "Closed");
});

test("a holding with no purchase record says that, not a fake gain", () => {
  const [row] = reconRows({ lines: [line("cost_missing", { custodianQty: 7 })] });
  assert.equal(row.detail, "7 units held · no purchase record");
});

test("a bond label cannot inject markup", () => {
  const html = reconCardHtml({
    reason: "ok", total: 1, breaks: 1, counts: { matched: 0 },
    lines: [line("quantity_differs", { label: "<script>x</script>", lotQty: 1, custodianQty: 2 })],
  });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("no result renders no card", () => {
  assert.equal(reconCardHtml(null), "");
});
