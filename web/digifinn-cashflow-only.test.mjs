import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bondBroker } from "./brokers.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the payouts slot names one file, and it is optional", () => {
  const reports = bondBroker("digifinn").reports;
  const payouts = reports.find((r) => r.slot === "payouts");
  assert.ok(payouts);
  assert.equal(payouts.optional, true);
  assert.deepEqual(payouts.files, ["upcoming-payouts.csv"]);
  assert.equal(reports.filter((r) => r.slot === "payouts").length, 1);
});

test("the page offers no choice between payout exports", () => {
  assert.doesNotMatch(html, /upcoming-payouts\.csv or portfolio-cashflow-future\.csv/);
  assert.doesNotMatch(html, /A Cashflow Future export is also accepted/);
  assert.doesNotMatch(html, /Cashflow Future, if offered, adds the full schedule/);
});

test("the field map credits Upcoming Payouts with frequency and next interest", () => {
  assert.match(html, /Upcoming Payouts", "payment frequency · next interest · next interest date/);
});
