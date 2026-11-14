import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  BOND_BROKERS, bondBroker, brokerLogo, brokerReport, parseBrokerReport,
  EQUITY_BROKERS, equityBroker,
} from "./brokers.js";

test("digifinn is the first broker, with one cost file and one optional payouts file", () => {
  assert.ok(BOND_BROKERS.length >= 1);
  const b = bondBroker("digifinn");
  assert.equal(b.label, "DigiFInn");
  assert.deepEqual(b.reports.map((r) => r.slot), ["portfolio", "payouts"]);
  assert.ok(b.reports.every((r) => r.title && Array.isArray(r.files) && r.files.length));
  const payouts = b.reports.find((r) => r.slot === "payouts");
  assert.equal(payouts.optional, true);
  assert.deepEqual(payouts.files, ["upcoming-payouts.csv"]);
  // Slots must be unique: the file picker keys its state by slot.
  assert.equal(new Set(b.reports.map((r) => r.slot)).size, b.reports.length);
});

test("a broker logo, when set, ships with the app", () => {
  for (const b of BOND_BROKERS) {
    assert.ok(b.id && b.label && b.parser);
    assert.equal(brokerLogo(b.id), b.logo || "");
    if (b.logo) {
      assert.ok(existsSync(new URL(b.logo, import.meta.url)), `${b.id} logo missing`);
    }
    assert.ok(b.page?.url && b.page?.where);
  }
});

test("an unknown broker id falls back for display", () => {
  assert.equal(bondBroker("not-a-broker").id, BOND_BROKERS[0].id);
});

test("the planner reports are the ones this app reads", () => {
  assert.ok(brokerReport("digifinn", "portfolio"));
  assert.ok(brokerReport("digifinn", "payouts"));
  assert.equal(brokerReport("digifinn", "nope"), null);
});

test("Motilal's holding summary is a PDF with no payouts report", () => {
  const broker = bondBroker("motilal");
  assert.equal(broker.parser, "motilal");
  assert.equal(broker.format, "pdf");
  assert.equal(brokerReport("motilal", "portfolio").accept, ".pdf");
  assert.equal(brokerReport("motilal", "payouts"), null);
});

test("equity brokers start with Motilal Oswal and Zerodha", () => {
  assert.deepEqual(EQUITY_BROKERS.map((b) => b.id), ["motilal", "zerodha"]);
  assert.equal(equityBroker("zerodha").label, "Zerodha");
  assert.equal(equityBroker("motilal").page.url.length > 0, true);
  assert.equal(equityBroker("not-a-broker"), null);
});

test("a broker's file is read by that broker's parser", () => {
  const csv = [
    "Name,Test Holder",
    "Demat Account No,1200000012345678",
    "ISIN,Bond Name,Purchase date,Qty,Investment Value",
    "INE000000024,TESTE 11.40 13062027,19 Jun 2024,2,193540.19",
  ].join("\n");
  const parsed = parseBrokerReport("digifinn", csv, "holdings-report.csv");
  assert.equal(parsed.kind, "portfolio");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].isin, "INE000000024");
  // An unregistered source must not be read as DigiFInn's format.
  assert.equal(parseBrokerReport("not-a-broker", csv, "x.csv").kind, "unknown");
});
