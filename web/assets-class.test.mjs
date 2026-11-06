import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { allocationByClass, assetSections } from "./assets.js";

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

test("a demat account is listed as equities and mutual funds, not demat", () => {
  const assets = [
    { id: "m1", label: "Axis mutual fund", category: "demat", subtype: "mutual fund",
      holdings_count: 1, holdings_cost: 300000, holdings_value: 300000 },
    { id: "m2", label: "Mirae mutual fund", category: "demat", subtype: "mutual fund",
      holdings_count: 1, holdings_cost: 200000, holdings_value: 200000 },
    { id: "e1", label: "ICICI demat", category: "demat", subtype: "equity",
      holdings_count: 4, holdings_cost: 100000, holdings_value: 150000 },
  ];
  const sections = assetSections(assets);
  const eq = sections.find((s) => s.id === "equity");
  const mf = sections.find((s) => s.id === "mf");
  assert.equal(eq.label, "Equities");
  assert.equal(eq.rows.length, 1);
  assert.equal(eq.total, 150000);
  assert.equal(mf.label, "Mutual funds");
  assert.equal(mf.rows.length, 2);
  assert.equal(mf.total, 500000);
  assert.equal(sections.some((s) => s.id === "demat"), false);
});

test("bank accounts and deposits keep their own group", () => {
  const assets = [{ id: "s1", label: "PNB", category: "bank", type: "savings",
    value_paise: 100000 }];
  const groups = allocationByClass(assets);
  assert.equal(groups[0].id, "bank");
  assert.equal(groups[0].label, "Bank accounts & FDs");
});

// A colour variable that is referenced but never defined makes the whole
// conic-gradient declaration invalid, and the ring disappears rather than
// falling back. That is exactly how the fund slice blanked the donut.
test("every allocation colour is defined in the stylesheet", () => {
  const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const map = src.match(/const classColor = \{([\s\S]*?)\};/);
  assert.ok(map, "classColor map not found");
  const used = new Set([...map[1].matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(src.includes(`${name}:`), `${name} is referenced but never defined`);
  }
});
