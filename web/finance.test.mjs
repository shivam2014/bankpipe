import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDay, yearsBetween, fdMaturityValue, fdAccruedInterest, bondTotalInterest,
  assetMetrics,
} from "./finance.js";

test("dates are parsed as UTC days, not local time", () => {
  assert.equal(parseDay("2024-04-01"), Date.UTC(2024, 3, 1));
  assert.equal(parseDay("nope"), null);
  assert.ok(Math.abs(yearsBetween("2024-01-01", "2025-01-01") - 1) < 0.01);
});

test("an FD compounds quarterly and caps at maturity", () => {
  // 1,000 rupees at 12% for one year: 1000 * 1.03^4 = 1125.51
  assert.equal(fdMaturityValue(100000, 1200, "2024-01-01", "2025-01-01"), 112551);
  assert.equal(fdAccruedInterest(100000, 1200, "2024-01-01", "2024-01-01"), 0);
  assert.ok(fdAccruedInterest(100000, 1200, "2024-01-01", "2024-07-01") > 0);
});

test("an FD without a rate or dates has no invented maturity value", () => {
  assert.equal(fdMaturityValue(100000, null, "2024-01-01", "2025-01-01"), null);
  assert.equal(fdMaturityValue(100000, 700, "", "2025-01-01"), null);
});

test("a bond pays simple coupon interest over its term", () => {
  // 1,000 at 8% for three years = 240 interest
  assert.equal(bondTotalInterest(100000, 800, "2024-01-01", "2027-01-01"), 24000);
  assert.equal(bondTotalInterest(100000, 800, "2024-01-01", "2024-01-01"), null);
});

test("an FD reports accrued value now and the full value at maturity", () => {
  const m = assetMetrics({
    category: "fd", principal_paise: 100000, rate_bps: 1200,
    start_date: "2024-01-01", maturity_date: "2025-01-01",
  }, "fd", new Date("2024-07-01T00:00:00Z"));
  assert.equal(m.invested, 100000);
  assert.equal(m.expectedAtMaturity, 112551);
  assert.ok(m.value > 100000 && m.value < 112551);
  assert.ok(m.gain > 0);
});

test("a bond separates recorded interest from expected interest", () => {
  const m = assetMetrics({
    category: "bonds", principal_paise: 100000, rate_bps: 800,
    start_date: "2024-01-01", maturity_date: "2027-01-01",
    interest_paid_paise: 4000,
  }, "bonds");
  assert.equal(m.invested, 100000);
  assert.equal(m.interestSoFar, 4000);
  assert.equal(m.expectedInterest, 24000);
  assert.equal(m.expectedAtMaturity, 124000);
  assert.equal(m.value, 104000);
});

test("gold keeps cost in net worth and reports the unrealised gain separately", () => {
  const m = assetMetrics({
    category: "gold",
    meta: JSON.stringify({ grams: 10, buy_per_gram_paise: 500000,
      current_per_gram_paise: 700000, price_date: "2026-03-31" }),
  }, "gold");
  assert.equal(m.invested, 5000000);
  assert.equal(m.value, 5000000);
  assert.equal(m.marketValue, 7000000);
  assert.equal(m.unrealisedGain, 2000000);
  assert.equal(m.gain, null);
  assert.match(m.note, /10 g/);
  assert.match(m.note, /at cost/);
});

test("gold separates a realised gain from the cost", () => {
  const m = assetMetrics({
    category: "gold",
    meta: { grams: 10, buy_per_gram_paise: 500000,
      current_per_gram_paise: 700000, realised_gain_paise: 150000 },
  }, "gold");
  assert.equal(m.value, 5000000);
  assert.equal(m.realisedGain, 150000);
  assert.equal(m.unrealisedGain, 2000000);
  assert.equal(m.gain, 150000);
  assert.equal(m.gainPct, 3);
});

test("gold derives grams from the buy value and price per gram", () => {
  const m = assetMetrics({ category: "gold", value_paise: 600000,
    start_date: "2019-06-01",
    meta: { buy_per_gram_paise: 600000, current_per_gram_paise: 720000 } }, "gold");
  assert.equal(m.grams, 1);
  assert.equal(m.gramsDerived, true);
  assert.equal(m.value, 600000);
  assert.equal(m.marketValue, 720000);
  assert.equal(m.unrealisedGain, 120000);
  assert.equal(m.sinceYear, 2019);
  assert.match(m.note, /estimated/);
});

test("gold without a current price still carries its cost", () => {
  const m = assetMetrics({ category: "gold", value_paise: 999,
    meta: { grams: 10, buy_per_gram_paise: 500000 } }, "gold");
  assert.equal(m.value, 5000000);
  assert.equal(m.invested, 5000000);
  assert.equal(m.marketValue, null);
  assert.equal(m.unrealisedGain, null);
});

test("equity PnL comes from the last import when present", () => {
  const m = assetMetrics({
    category: "demat",
    meta: { buy_value_paise: 100000, current_value_paise: 125000,
      source: "import", as_of: "2026-03-31" },
  }, "demat");
  assert.equal(m.invested, 100000);
  assert.equal(m.value, 125000);
  assert.equal(m.gain, 25000);
  assert.equal(m.gainPct, 25);
  assert.match(m.note, /last import/);
});

test("insurance counts premiums paid, not the cover", () => {
  const m = assetMetrics({
    category: "insurance", maturity_date: "2035-01-01",
    meta: { sum_assured_paise: 500000000, premium_paise: 2500000, frequency: "yearly" },
  }, "insurance");
  assert.equal(m.excluded, false);
  assert.equal(m.value, 2500000);
  assert.equal(m.invested, 2500000);
  assert.equal(m.cover, 500000000);
  assert.equal(m.premium, 2500000);
  assert.match(m.note, /premiums paid/);
});

test("a bank statement balance still wins over a manual value", () => {
  const m = assetMetrics({ category: "bank", facts: 3, balance: 12345, value_paise: 1 }, "bank");
  assert.equal(m.value, 12345);
  assert.equal(m.note, "latest statement");
});

test("a bond portfolio is valued from its holdings, not a missing principal", () => {
  const asset = { category: "bonds", holdings_count: 3, holdings_cost: 10000000,
    holdings_value: 10500000 };
  const m = assetMetrics(asset, "bonds");
  assert.equal(m.value, 10500000);
  assert.equal(m.invested, 10000000);
  assert.equal(m.gain, 500000);
  assert.equal(m.note, "3 holdings");
});

test("a partially priced bond portfolio carries unpriced lots at cost", () => {
  const asset = { category: "bonds", holdings_count: 9,
    holdings_cost: 132736750, holdings_value: 9859363,
    holdings_priced_value: 9859363, holdings_priced_cost: 9859863,
    holdings_priced_count: 1 };
  const m = assetMetrics(asset, "bonds");
  assert.equal(m.value, 132736250);
  assert.equal(m.gain, -500);
  assert.equal(m.pricedCount, 1);
  assert.equal(m.note, "9 holdings · 1 priced");
});

test("a bond portfolio with no market prices is valued at cost", () => {
  const asset = { category: "bonds", holdings_count: 9,
    holdings_cost: 132736750, holdings_value: null,
    holdings_priced_value: null, holdings_priced_cost: null,
    holdings_priced_count: 0 };
  const m = assetMetrics(asset, "bonds");
  assert.equal(m.value, 132736750);
  assert.equal(m.gain, null);
  assert.equal(m.note, "9 holdings · at cost");
});

test("an FD with a principal but no rate or start still has a value", () => {
  const m = assetMetrics({ category: "fd", principal_paise: 80677100,
    maturity_date: "2026-12-05" }, "fd");
  assert.equal(m.value, 80677100);
  assert.equal(m.invested, 80677100);
  assert.match(m.note, /principal only/);
});

test("a foreign-currency balance does not overwrite its INR valuation", () => {
  const m = assetMetrics({ category: "bank", currency: "OMR", facts: 10,
    balance: 211346611, value_paise: 211346611 }, "bank");
  assert.equal(m.value, 211346611);
  assert.match(m.note, /manual|INR/);
});
