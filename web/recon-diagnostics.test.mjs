import test from "node:test";
import assert from "node:assert/strict";
import { reconShape, reconShapeText, reconInputs } from "./recon-diagnostics.js";

const lots = [
  { security_id: "INE999900272", label: "9.75% TESTC 27 NOV 2028", quantity: 30,
    cost_paise: 29426571, purchase_date: "2026-01-30" },
  { security_id: "INE000000012", label: "10.00% TESTA 18 AUG 2028", quantity: 30,
    cost_paise: 29949658, purchase_date: "2026-08-21" },
  { security_id: "", label: "no isin row", quantity: 1, cost_paise: null },
];

test("the report carries counts and shapes, never an identifier", () => {
  const text = reconShapeText(reconShape({
    reason: "ok",
    asset: { number: "IN99990001344321" },
    custodian: { number: "1200000012345678" },
    total: 2, breaks: 1, counts: { matched: 1, not_settled: 1 },
    inputs: reconInputs(lots, []),
  }));
  assert.equal(text.includes("IN99990001344321"), false);
  assert.equal(text.includes("1200000012345678"), false);
  assert.equal(text.includes("INE999900272"), false);
  assert.equal(text.includes("29426571"), false);
  assert.match(text, /bo:cdsl:8\+8/);
  assert.match(text, /not_settled/);
});

test("an unreadable BO ID is reported by kind, not by value", () => {
  const shape = reconShape({
    reason: "client-code", asset: { number: "5550000000" }, total: 0, breaks: 0,
  });
  assert.equal(shape.assetBoId, "client-code");
  assert.equal(JSON.stringify(shape).includes("5550000000"), false);
});

test("a skipped row is counted, so a clean report cannot hide it", () => {
  const inputs = reconInputs(lots, []);
  assert.equal(inputs.lots, 3);
  assert.equal(inputs.withoutIsin, 1);
  assert.equal(inputs.lotsWithoutCost, 0);
  assert.equal(inputs.quantityShape, "99");
  assert.equal(inputs.dateShape, "9{4}-99-99");
});

test("the text report is stable enough to paste", () => {
  const text = reconShapeText(reconShape({
    reason: "ok", asset: { number: "IN99990001344321" },
    total: 7, breaks: 2, counts: { matched: 5, quantity_differs: 2 },
    inputs: reconInputs(lots, []),
  }));
  assert.match(text, /^BankPipe recon shape · v1/);
  assert.match(text, /result {11}7 positions · 2 breaks/);
});

test("a missing result is reported, not thrown", () => {
  assert.equal(reconShape(null).reason, "missing");
  assert.equal(reconShapeText(null), "");
});
