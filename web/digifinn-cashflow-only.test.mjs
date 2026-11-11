import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bondBroker } from "./brokers.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the payouts slot is Upcoming Payouts; Cashflow Future is the optional one", () => {
  const broker = bondBroker("digifinn");
  const payouts = broker.reports.find((r) => r.slot === "payouts");
  const cashflow = broker.reports.find((r) => r.slot === "cashflow");
  assert.equal(payouts.title, "Upcoming Payouts");
  assert.deepEqual(payouts.files, ["upcoming-payouts.csv"]);
  assert.equal(cashflow.optional, true);
  assert.deepEqual(cashflow.files, ["portfolio-cashflow-future.csv"]);
});

test("the page accepts both payout exports", () => {
  assert.match(html, /A Cashflow Future export is also accepted/);
});

test("the optional export is described as the full schedule", () => {
  const cashflow = bondBroker("digifinn").reports.find((r) => r.slot === "cashflow");
  assert.match(cashflow.detail, /full schedule and part redemptions/);
});
