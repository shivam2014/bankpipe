import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bondBroker } from "./brokers.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the payouts slot offers only the Cashflow Future export", () => {
  const report = bondBroker("digifinn").reports.find((r) => r.slot === "payouts");
  assert.equal(report.title, "Cashflow Future");
  assert.deepEqual(report.files, ["portfolio-cashflow-future*.csv"]);
  assert.match(report.detail, /month-by-month/);
});

test("the page names the third report Cashflow Future, never Upcoming Payouts", () => {
  assert.match(html, /set\("df-status-payouts", state\?\.payouts, "Cashflow Future"/);
  assert.match(html, /missing\.push\("Cashflow Future"\)/);
  assert.doesNotMatch(html, /missing\.push\("Upcoming Payouts"\)/);
  assert.doesNotMatch(html, /Upcoming Payouts or Cashflow Future/);
  assert.doesNotMatch(html, /Upcoming Payouts \/ Cashflow/);
});

test("the card tells the person to attach Cashflow Future", () => {
  assert.match(html, /Attach the Cashflow Future\s+export: it carries the next payout, the full schedule and any part redemptions\./);
  assert.doesNotMatch(html, /If DigiFInn offers both/);
});

test("an Upcoming Payouts file is still recognised but refused with the switch", () => {
  assert.match(html, /parsed\.kind === "payouts" && parsed\.source !== "cashflow"/);
  assert.ok(html.includes("That is the Upcoming Payouts report. In DigiFInn, switch "
    + "Reports & Documents to Cashflow Future and download that; it carries the whole "
    + "schedule and any part redemptions."));
});
