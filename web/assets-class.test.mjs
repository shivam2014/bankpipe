import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { allocationByClass, assetAtCost, assetSections, assetValue, classPage,
  holdingClass, holdingValue, isFundAccount } from "./assets.js";

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

test("a demat's bond class total keeps the matured lot and the live one", () => {
  const account = demat({ id: "d-mixed", class_bond_value: 60000000,
    class_equity_value: 0, class_mf_value: 0, holdings_count: 2,
    holdings_cost: 60000000, holdings_value: 60000000 });
  const holdings = { "d-mixed": [
    { id: 1, category: "bond", label: "9.50% TEST 15 MAY 2020",
      quantity: 1, cost_paise: 50000000, value_paise: 50000000 },
    { id: 2, category: "bond", label: "9.50% TEST 15 MAY 2030",
      quantity: 1, cost_paise: 10000000, value_paise: 10000000 },
  ] };
  const page = classPage([account], holdings, "bond");
  assert.equal(page.total, 60000000);
  assert.equal(page.holdingsCount, 2);
  const sections = assetSections([account]);
  assert.equal(sections.find((s) => s.id === "bond").total, 60000000);
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
  const fund = demat({ id: "m1", label: "TestTwo", subtype: "mutual fund",
    class_equity_value: null, class_mf_value: null, holdings_value: 50000 });
  const groups = allocationByClass([fund]);
  assert.equal(groups[0].id, "mf");
  assert.equal(groups[0].total, 50000);
});

test("one demat account appears under each class it holds", () => {
  const mixed = demat({ class_bond_value: 40000, class_equity_value: 60000,
    holdings_value: 100000, holdings_cost: 100000 });
  const sections = assetSections([mixed]);
  const bonds = sections.find((s) => s.id === "bond");
  const equities = sections.find((s) => s.id === "equity");
  assert.equal(bonds.label, "Bonds");
  assert.equal(bonds.total, 40000);
  assert.equal(bonds.rows[0].id, "d1");
  assert.equal(equities.total, 60000);
  assert.equal(equities.rows[0].id, "d1");
  assert.equal(sections.some((s) => s.id === "demat"), false);
});

test("a class row values only its own part of the account", () => {
  const mixed = demat({ class_bond_value: 40000, class_equity_value: 60000 });
  const row = assetSections([mixed]).find((s) => s.id === "bond").rows[0];
  assert.equal(assetValue(row).paise, 40000);
});

test("a demat account holding only funds is listed as mutual funds", () => {
  const fund = demat({ id: "m1", label: "TestTwo", subtype: "mutual fund",
    class_mf_value: 50000, class_equity_value: null, holdings_value: 50000 });
  const sections = assetSections([fund]);
  assert.equal(sections[0].label, "Mutual funds");
  assert.equal(sections[0].total, 50000);
});

test("a bond portfolio joins the demat bonds in one Bonds section", () => {
  const sections = assetSections([
    demat({ class_bond_value: 40000 }),
    { id: "b1", label: "Bonds · portfolio 1", category: "bonds",
      holdings_count: 2, holdings_cost: 100000, holdings_value: 100000 },
    { id: "g1", label: "Gold", category: "gold", value_paise: 4 },
  ]);
  const bonds = sections.find((s) => s.id === "bond");
  assert.ok(bonds, "one Bonds section");
  assert.equal(bonds.label, "Bonds");
  assert.equal(bonds.rows.length, 2);
  assert.equal(bonds.total, 140000);
  assert.deepEqual(sections.map((s) => s.id), ["bond", "gold"]);
});

test("sections read cash, then the demat classes, then gold and insurance", () => {
  const sections = assetSections([
    demat({ class_bond_value: 1, class_equity_value: 2, class_mf_value: 3 }),
    { id: "s1", label: "PNB", category: "bank", type: "savings", value_paise: 9 },
    { id: "g1", label: "Gold", category: "gold", value_paise: 4 },
    { id: "i1", label: "LIC", category: "insurance", value_paise: 5 },
  ]);
  assert.deepEqual(sections.map((s) => s.id),
    ["bank", "bond", "mf", "equity", "gold", "insurance"]);
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

test("a fund category is a fund whether it says mf, fund or only carries an INF ISIN", () => {
  assert.equal(holdingClass({ category: "mf" }), "mf");
  assert.equal(holdingClass({ category: "MF" }), "mf");
  assert.equal(holdingClass({ category: "mutual fund" }), "mf");
  assert.equal(holdingClass({ category: "fund" }), "mf");
  assert.equal(holdingClass({ security_id: "INF000000011" }), "mf");
  assert.equal(holdingClass({ category: "equity", security_id: "INF000000011" }), "mf");
  assert.equal(holdingClass({ category: "bond", security_id: "INF000000011" }), "bond");
  assert.equal(holdingClass({ category: "equity", security_id: "INE999900264" }), "equity");
});

test("a folio is a fund account, not a bond demat", () => {
  assert.equal(isFundAccount({ category: "demat", subtype: "mutual fund" }), true);
  assert.equal(isFundAccount({ category: "demat", subtype: "mf" }), true);
  assert.equal(isFundAccount({ category: "demat", subtype: "equity" }), false);
  assert.equal(isFundAccount({ category: "bank", subtype: "mutual fund" }), false);
});

test("cost is the measure only when a demat has no price and no manual value", () => {
  assert.equal(assetAtCost({ holdings_value: null, holdings_cost: 100 }), true);
  assert.equal(assetAtCost({ holdings_value: 0, holdings_cost: 100 }), false,
    "a zero market value is still a recorded value");
  assert.equal(assetAtCost({ holdings_value: null, holdings_cost: 100,
    meta: JSON.stringify({ current_value_paise: 90 }) }), false,
    "a manual current value is the account's figure, not cost");
  assert.equal(assetAtCost({ holdings_value: null, holdings_cost: null }), false,
    "nothing was paid, so there is no cost to carry");
  assert.equal(holdingValue({ value_paise: null, cost_paise: 100 }, true), 100);
  assert.equal(holdingValue({ value_paise: null, cost_paise: 100 }, false), 0);
  assert.equal(holdingValue({ value_paise: 120, cost_paise: 100 }, true), 120,
    "a priced row keeps its market value even when the account is at cost");
});

test("the funds class page adds a folio value that has no holding row", () => {
  const assets = [
    demat({ id: "d1", class_mf_value: 40000, holdings_value: 40000, holdings_cost: 35000 }),
    demat({ id: "m1", label: "TestOne mutual fund", subtype: "mutual fund",
      holdings_count: 0, holdings_cost: null, holdings_value: null, value_paise: 50000 }),
  ];
  const holdings = { d1: [{ id: 1, category: "mf", security_id: "INF1", label: "Fund A",
    cost_paise: 35000, value_paise: 40000 }] };
  const page = classPage(assets, holdings, "mf");
  const alloc = allocationByClass(assets).find((g) => g.id === "mf");
  assert.equal(page.total, alloc.total);
  assert.equal(page.total, 90000);
  assert.equal(page.holdingsCount, 1);
  assert.equal(page.accountValues, 1);
  assert.equal(page.groups.length, 2);
  assert.equal(page.rows.find((r) => r.accountValue).value_paise, 50000);
});

test("an account-level value does not double count a valued holding row", () => {
  const fund = demat({ id: "m2", subtype: "mutual fund", value_paise: 999999,
    holdings_count: 1, holdings_value: 30000, holdings_cost: 25000,
    class_mf_value: 30000 });
  const holdings = { m2: [{ id: 2, category: "mf", security_id: "INF2",
    label: "Fund B", cost_paise: 25000, value_paise: 30000 }] };
  const page = classPage([fund], holdings, "mf");
  assert.equal(page.total, 30000);
  assert.equal(page.rows.length, 1);
  assert.equal(page.accountValues, 0);
  assert.equal(allocationByClass([fund]).find((g) => g.id === "mf").total, 30000);
});

test("the equity class page adds an account-level value too", () => {
  const account = demat({ id: "e1", subtype: "equity", holdings_count: 0,
    holdings_cost: null, holdings_value: null, value_paise: 40000 });
  const page = classPage([account], {}, "equity");
  assert.equal(page.total, 40000);
  assert.equal(page.accountValues, 1);
  assert.equal(allocationByClass([account]).find((g) => g.id === "equity").total, 40000);
});

test("a folio with a stray bond row is still all funds", () => {
  const folio = demat({ id: "m3", subtype: "mutual fund", holdings_count: 1,
    holdings_cost: 100, holdings_value: 100, class_bond_value: 100,
    class_mf_value: null });
  const groups = allocationByClass([folio]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "mf");
  assert.equal(groups[0].total, 100);
  const page = classPage([folio],
    { m3: [{ id: 3, category: "bond", security_id: "INE000000001", value_paise: 100 }] },
    "mf");
  assert.equal(page.total, 100);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].accountValue, true);
  assert.equal(page.rows[0].security_id, "");
});

test("a folio with a stray bond row is listed only under funds", () => {
  const folio = demat({ id: "m3", subtype: "mutual fund", holdings_count: 1,
    holdings_cost: 100, holdings_value: 100, class_bond_value: 100,
    class_mf_value: null });
  const sections = assetSections([folio]);
  assert.deepEqual(sections.map((s) => s.id), ["mf"]);
  assert.equal(sections[0].total, 100);
});

// The owner asked why the class page had no edit or delete. Those live on the
// account page, so the group header must read as the way there. One control,
// naming the account: a second destructive control on this page would be a
// delete for a security, not for the account.
test("a class group header is one control that opens its account", () => {
  const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const start = src.indexOf("const groupHtml = groups.map");
  const end = src.indexOf("const countBits", start);
  assert.ok(start > 0 && end > start, "the class group renderer is in index.html");
  const block = src.slice(start, end);
  assert.equal((block.match(/<a\b/g) || []).length, 1,
    "the group header has exactly one focusable control");
  assert.equal((block.match(/<button\b/g) || []).length, 0,
    "the header adds no button beside the name");
  assert.equal((block.match(/tabindex=/g) || []).length, 0,
    "the header adds no second focus stop");
  assert.equal((block.match(/onclick="bpAsset\(/g) || []).length, 1,
    "only the one control opens the account");
  assert.match(block,
    /bpAsset\(\$\{jsArg\(g\.asset\.id\)\},\$\{jsArg\(classKind\)\}\)/);
  assert.match(block, /class-group-open">Open account/);
  assert.match(block, /Rename, edit or delete this account on its page\./);
  assert.doesNotMatch(block, /bpAssetDelete/);
});

test("the class page sends account delete to the account page and never renders it", () => {
  const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const start = src.indexOf("async function renderCategory()");
  const end = src.indexOf("function staleImport(", start);
  assert.ok(start > 0 && end > start);
  const page = src.slice(start, end);
  assert.doesNotMatch(page, /bpAssetDelete/,
    "the class page has no account-delete handler");
  assert.match(page, /class-group-note/,
    "one line says where rename, edit and delete live");
  const cardStart = src.indexOf("function holdingCardHtml");
  const cardEnd = src.indexOf("function holdingCards", cardStart);
  assert.ok(cardStart > 0 && cardEnd > cardStart);
  assert.doesNotMatch(src.slice(cardStart, cardEnd), /bpAssetDelete/,
    "a holding card removes the holding, never the account");
});
