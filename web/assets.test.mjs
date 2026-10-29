import test from "node:test";
import assert from "node:assert/strict";
import { importFillPlan, CATEGORIES, categoryOf, typesFor, assetValue, totalAssets, groupAssets, allocationGroups } from "./assets.js";

test("legacy account types map to an asset category", () => {
  assert.equal(categoryOf({ type: "savings" }), "bank");
  assert.equal(categoryOf({ type: "current" }), "bank");
  assert.equal(categoryOf({ type: "demat" }), "demat");
  assert.equal(categoryOf({ type: "fd" }), "fd");
  assert.equal(categoryOf({ acct_type: "gold" }), "gold");
  assert.equal(categoryOf({ type: "something-else" }), "other");
});

test("an explicit category wins over the legacy type", () => {
  assert.equal(categoryOf({ category: "bonds", type: "savings" }), "bonds");
});

test("a bank asset is valued from its latest statement", () => {
  const v = assetValue({ category: "bank", facts: 12, balance: 13477950, value_paise: 999 });
  assert.equal(v.paise, 13477950);
  assert.equal(v.source, "latest statement");
});

test("a manual asset is valued from the entered amount and date", () => {
  const v = assetValue({ facts: 0, balance: null, value_paise: 50000000, value_date: "2026-03-31" });
  assert.equal(v.paise, 50000000);
  assert.equal(v.source, "manual · 2026-03-31");
});

test("a bank with no statement falls back to the manual value", () => {
  const v = assetValue({ facts: 0, balance: null, value_paise: 250000 });
  assert.equal(v.paise, 250000);
  assert.equal(v.source, "manual");
});

test("no statement and no manual value is not zero", () => {
  assert.equal(assetValue({ facts: 0, balance: null }).paise, null);
  assert.equal(assetValue({}).source, "no value yet");
});

test("totals skip assets with no value", () => {
  assert.equal(totalAssets([
    { category: "bank", facts: 2, balance: 1000 }, { value_paise: 2500 }, { facts: 0 },
  ]), 3500);
});

test("grouping keeps category order and drops empty groups", () => {
  const groups = groupAssets([
    { id: "a", category: "gold", value_paise: 100 },
    { id: "b", category: "bank", facts: 1, balance: 500 },
    { id: "c", category: "gold", value_paise: 200 },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["bank", "gold"]);
  assert.equal(groups[1].total, 300);
  assert.equal(groups[1].rows.length, 2);
});

test("every category offers at least one kind", () => {
  for (const c of CATEGORIES) {
    assert.ok(c.types.length > 0, c.id);
    assert.equal(typesFor(c.id).length, c.types.length);
  }
});

test("a non-bank asset is never valued by a bank balance", () => {
  const v = assetValue({ category: "gold", facts: 3, balance: 100, value_paise: 999 });
  assert.equal(v.paise, 999);
});

test("insurance premiums are added to net worth, cover is not", () => {
  assert.equal(categoryOf({ type: "insurance" }), "insurance");
  assert.equal(totalAssets([
    { category: "bank", facts: 1, balance: 5000 },
    { category: "insurance", value_paise: 999999,
      meta: { premium_paise: 250000, sum_assured_paise: 999999 } },
  ]), 255000);
});

test("allocation groups fixed deposits under bank accounts", () => {
  const groups = allocationGroups([
    { category: "bank", facts: 1, balance: 500 },
    { category: "fd", value_paise: 1000 },
    { category: "gold", value_paise: 200 },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["bank", "gold"]);
  assert.equal(groups[0].total, 1500);
  assert.deepEqual(groups[0].children.map((c) => c.id), ["bank", "fd"]);
  assert.equal(groups[0].children[1].total, 1000);
});

test("an import fills an empty account and leaves typed values alone", () => {
  const filled = importFillPlan({ number: "", holder: "", bank: "" },
    { demat: "1234567890123456", holder: "A Holder", broker: "DigiFInn" });
  assert.deepEqual(filled, { number: "1234567890123456", holder: "A Holder", bank: "DigiFInn" });

  const kept = importFillPlan({ number: "9999", holder: "Typed", bank: "" },
    { demat: "1234567890123456", holder: "A Holder", broker: "DigiFInn" });
  assert.deepEqual(kept, { bank: "DigiFInn" });

  assert.deepEqual(importFillPlan({}), {});
});
