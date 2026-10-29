import test from "node:test";
import assert from "node:assert/strict";
import { BOND_BROKERS, bondBroker } from "./brokers.js";

test("digifinn is the first registered bond broker, with the three report slots", () => {
  assert.ok(BOND_BROKERS.length >= 1);
  const b = bondBroker("digifinn");
  assert.equal(b.label, "DigiFInn");
  assert.deepEqual(b.reports.map((r) => r.slot), ["portfolio", "investment", "payouts"]);
  assert.ok(b.reports.every((r) => r.title && Array.isArray(r.files) && r.files.length));
  // Slots must be unique: the file picker keys its state by slot.
  assert.equal(new Set(b.reports.map((r) => r.slot)).size, b.reports.length);
});

test("an unknown broker falls back to the first entry", () => {
  assert.equal(bondBroker("not-a-broker").id, BOND_BROKERS[0].id);
});

test("slots match the parser kinds the importer expects", () => {
  // digifinn-reports.js returns kind "portfolio", "investment" and "payouts".
  const slots = bondBroker("digifinn").reports.map((r) => r.slot);
  assert.deepEqual(slots, ["portfolio", "investment", "payouts"]);
});
