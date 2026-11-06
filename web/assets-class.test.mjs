import test from "node:test";
import assert from "node:assert/strict";
import { allocationByClass } from "./assets.js";

const demat = (over) => ({
  id: "d1", label: "Demat", category: "demat", subtype: "equity",
  holdings_count: 2, holdings_cost: 100000, holdings_value: 100000, ...over,
});

const bondAccount = (over) => ({
  id: "b1", label: "Bonds", category: "bonds",
  holdings_count: 1, holdings_cost: 200000, holdings_value: 200000, ...over,
});

test("a demat is split into shares and fund units", () => {
  const assets = [
    demat({ class_equity_value: 60000, class_mf_value: 40000 }),
  ];
  const groups = allocationByClass(assets);
  const equity = groups.find((g) => g.id === "equity");
  const mf = groups.find((g) => g.id === "mf");
  assert.equal(equity.total, 60000);
  assert.equal(mf.total, 40000);
  assert.equal(equity.label, "Equities");
  assert.equal(mf.label, "Mutual funds");
});

test("a bond portfolio is still a bond slice", () => {
  const groups = allocationByClass([bondAccount({ class_bond_value: 200000 })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "bond");
  assert.equal(groups[0].total, 200000);
});

test("the slices add up to the value the account already shows", () => {
  const assets = [
    demat({ class_equity_value: 30000, class_mf_value: 10000,
      holdings_value: 60000, holdings_cost: 60000 }),
  ];
  const groups = allocationByClass(assets);
  const sum = groups.reduce((t, g) => t + g.total, 0);
  assert.equal(sum, 60000);
});

test("a demat with no class totals falls back to its subtype", () => {
  const fund = demat({ id: "m1", label: "Axis", subtype: "mutual fund",
    class_equity_value: null, class_mf_value: null, holdings_value: 50000 });
  const groups = allocationByClass([fund]);
  assert.equal(groups[0].id, "mf");
  assert.equal(groups[0].total, 50000);
});

test("bank accounts and deposits keep their own group", () => {
  const assets = [{ id: "s1", label: "PNB", category: "bank", type: "savings",
    value_paise: 100000 }];
  const groups = allocationByClass(assets);
  assert.equal(groups[0].id, "bank");
  assert.equal(groups[0].label, "Bank accounts & FDs");
});
