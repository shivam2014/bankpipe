import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bondBroker } from "./brokers.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("one payouts slot accepts either export, and both are optional", () => {
  const reports = bondBroker("digifinn").reports;
  const payouts = reports.find((r) => r.slot === "payouts");
  assert.ok(payouts);
  assert.equal(payouts.optional, true);
  assert.deepEqual(payouts.files,
    ["upcoming-payouts.csv", "portfolio-cashflow-future.csv"]);
  assert.equal(reports.filter((r) => r.slot === "payouts").length, 1);
});

test("the page accepts both payout exports", () => {
  assert.match(html, /A Cashflow Future export is also accepted/);
});

test("the optional export is described as the full schedule", () => {
  const payouts = bondBroker("digifinn").reports.find((r) => r.slot === "payouts");
  assert.match(payouts.detail, /Cashflow Future adds the full schedule/);
});
