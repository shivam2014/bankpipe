import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { makeStore, useDemoStore, listAccounts, reconFor } from "./db.js";
import { assetClassParts, assetSections, assetValue, classPage,
  holdingClass } from "./assets.js";
import { reconCardHtml, reconDismissKey, reconEligible, reconHasCard,
  reconHiddenHtml } from "./recon-card.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const BOND_A = "INE999900272";
const BOND_B = "INE000000012";
const AS_OF = "2026-10-31";

const bond = (isin, quantity) => ({
  security_id: isin, label: `Bond ${isin}`, category: "bond",
  quantity, cost_paise: 100000, value_paise: 100000,
  purchase_date: "2026-01-05",
});

async function seed(accounts, holdings = {}) {
  const store = makeStore(SQL, null);
  await store.open();
  for (const account of accounts) store.createAccount(account);
  for (const [id, rows] of Object.entries(holdings)) {
    store.replaceHoldings(id, rows, AS_OF);
  }
  await useDemoStore(store);
  return store;
}

const baseAccounts = () => [
  { id: "d1", label: "Demat one", category: "demat", subtype: "equity",
    number: "1200000012345678", meta: JSON.stringify({ holdings_as_of: AS_OF }) },
  { id: "d2", label: "Demat two", category: "demat", subtype: "equity",
    number: "IN99990001344321", meta: JSON.stringify({ holdings_as_of: AS_OF }) },
  { id: "p1", label: "Portfolio one", category: "bonds",
    meta: JSON.stringify({ linked_asset: "d1" }) },
  { id: "p2", label: "Portfolio two", category: "bonds",
    meta: JSON.stringify({ linked_asset: "d2" }) },
  { id: "f1", label: "TestOne mutual fund", category: "demat", subtype: "mutual fund",
    number: "99990000003" },
  { id: "e1", label: "Equity only", category: "demat", subtype: "equity" },
];

const baseHoldings = () => ({
  d1: [bond(BOND_A, 30),
    { security_id: "INF000000011", label: "Fund one", category: "mf",
      quantity: 10, cost_paise: 200000, value_paise: 250000 }],
  d2: [bond(BOND_B, 5)],
  p1: [bond(BOND_A, 30)],
  p2: [bond(BOND_B, 5)],
});

test("a fund folio gets no bond reconcile even when a stray bond row exists", async () => {
  await seed(baseAccounts(), { ...baseHoldings(),
    f1: [bond(BOND_A, 30)] });
  const result = await reconFor("f1");
  assert.equal(result.reason, "not-applicable");
  assert.equal(reconHasCard(result), false);
  assert.equal(reconEligible({ id: "f1", category: "demat", subtype: "mutual fund" },
    [bond(BOND_A, 30)]), false);
});

test("an MF-only demat has nothing to reconcile", async () => {
  await seed(baseAccounts(), baseHoldings());
  const result = await reconFor("e1");
  assert.equal(result.reason, "no-bond-holdings");
  assert.equal(reconHasCard(result), false);
});

test("a demat audits only the cost portfolio linked to it", async () => {
  await seed(baseAccounts(), baseHoldings());
  const result = await reconFor("d1", "2026-11-14");
  assert.equal(result.reason, "ok");
  assert.equal(result.custodian.id, "d1");
  assert.equal(result.total, 1);
  assert.equal(result.lines[0].isin, BOND_A);
  assert.equal(result.lines.some((line) => line.isin === BOND_B), false);
});

test("a bond portfolio audits against its linked demat, not every demat", async () => {
  await seed(baseAccounts(), baseHoldings());
  const result = await reconFor("p1", "2026-11-14");
  assert.equal(result.reason, "ok");
  assert.equal(result.custodian.id, "d1");
  assert.deepEqual(result.lines.map((line) => line.isin), [BOND_A]);
});

test("a bond portfolio cannot use a fund folio as its demat", async () => {
  const accounts = [...baseAccounts().filter((a) => !["p1", "p2"].includes(a.id)),
    { id: "p3", label: "Unlinked", category: "bonds" }];
  await seed(accounts, { f1: [bond(BOND_A, 30)], p3: [bond(BOND_A, 30)] });
  const result = await reconFor("p3", "2026-11-14");
  assert.equal(result.reason, "no-linked-demat");
  assert.equal(reconHasCard(result), false);
});

test("the reconcile card carries a per-account dismiss and a restore", () => {
  const html = reconCardHtml({ reason: "ok", total: 1, breaks: 0,
    counts: { matched: 1 }, lines: [] }, { dismissId: "d1" });
  assert.match(html, /bpReconDismiss\(&quot;d1&quot;\)/);
  assert.equal(reconDismissKey("d1"), "bp.recon.dismissed.d1");
  const hidden = reconHiddenHtml();
  assert.match(hidden, /Show again/);
  assert.match(hidden, /bpReconShow\(\)/);
});

test("reconcile eligibility follows the account's bond positions", () => {
  assert.equal(reconEligible({ category: "bonds" }, []), true);
  assert.equal(reconEligible({ category: "demat", subtype: "equity" }, [bond(BOND_A, 1)]), true);
  assert.equal(reconEligible({ category: "demat", subtype: "equity" },
    [{ category: "mf", security_id: "INF1" }]), false);
  assert.equal(reconEligible({ category: "bank" }, []), false);
});

test("the SQL class totals use the same rule as holdingClass", async () => {
  const rows = [
    { security_id: "INE000000001", label: "Bond", category: "bond",
      quantity: 1, cost_paise: 100, value_paise: 200 },
    { security_id: "INE000000002", label: "Share", category: "equity",
      quantity: 1, cost_paise: 100, value_paise: 50 },
    { security_id: "INF000000003", label: "Fund by category", category: "fund",
      quantity: 1, cost_paise: 100, value_paise: 70 },
    { security_id: "INF000000004", label: "Fund by ISIN", category: "equity",
      quantity: 1, cost_paise: 100, value_paise: 25 },
  ];
  await seed([{ id: "d1", label: "Demat", category: "demat", subtype: "equity" }],
    { d1: rows });
  const [account] = await listAccounts();
  const sums = { bond: 0, equity: 0, mf: 0 };
  for (const row of rows) sums[holdingClass(row)] += row.value_paise;
  assert.equal(account.class_bond_value, sums.bond);
  assert.equal(account.class_equity_value, sums.equity);
  assert.equal(account.class_mf_value, sums.mf);
  assert.equal(account.class_bond_value + account.class_equity_value
    + account.class_mf_value, account.holdings_value);
});

test("a manual fund row replaces the folio value instead of adding to it", async () => {
  const store = await seed([{ id: "f1", label: "TestTwo mutual fund",
    category: "demat", subtype: "mutual fund", value_paise: 90000 }]);
  store.upsertHolding("f1", { label: "TestTwo Bluechip Fund",
    security_id: "INF000000011", category: "mf", quantity: 10,
    cost_paise: 100000, value_paise: 120000 });
  const [account] = await listAccounts();
  const rows = store.listHoldings("f1");
  assert.equal(rows[0].category, "mf");
  assert.equal(account.class_mf_value, 120000);
  const page = classPage([account], { f1: rows }, "mf");
  assert.equal(page.total, 120000);
  assert.equal(page.holdingsCount, 1);
  assert.equal(page.accountValues, 0);
});

test("a demat that carries cost but no price lands in its class at cost", async () => {
  const rows = [
    { security_id: "INE000000101", label: "Bond one", category: "bond",
      quantity: 10, cost_paise: 5000000, value_paise: null },
    { security_id: "INE000000102", label: "Bond two", category: "bond",
      quantity: 5, cost_paise: 2500000, value_paise: null },
  ];
  await seed([{ id: "d1", label: "Motilal demat", category: "demat", subtype: "equity" }],
    { d1: rows });
  const [account] = await listAccounts();
  assert.equal(account.class_bond_value, 7500000,
    "the bond class carries the cost the report printed");
  assert.equal(account.class_equity_value, 0);
  assert.equal(account.class_mf_value, 0);
  const sections = assetSections([account]);
  const bonds = sections.find((s) => s.id === "bond");
  assert.ok(bonds, "one Bonds section");
  assert.equal(bonds.total, 7500000);
  assert.equal(assetValue(bonds.rows[0]).paise, bonds.total,
    "the row is worth the section it sits in");
  assert.match(assetValue(bonds.rows[0]).source, /cost/,
    "the class row says the cost came from the report");
  assert.equal(sections.some((s) => s.id === "equity"), false,
    "the cost is not filed under Equities");
  const page = classPage([account], { d1: rows }, "bond");
  assert.equal(page.total, 7500000);
  assert.equal(page.rows.length, 2);
  assert.equal(page.accountValues, 0, "no invented value-not-in-a-row");
  assert.equal(page.rows[0].value_paise, 5000000);
  assert.equal(page.rows[0].atCost, true);
});

test("an unpriced row keeps its cost inside the account value and its class", async () => {
  const rows = [
    { security_id: "INE000000201", label: "Priced share", category: "equity",
      quantity: 10, cost_paise: 40000, value_paise: 50000 },
    { security_id: "INE000000202", label: "Unpriced bond", category: "bond",
      quantity: 10, cost_paise: 30000, value_paise: null },
  ];
  await seed([{ id: "d1", label: "Mixed demat", category: "demat", subtype: "equity" }],
    { d1: rows });
  const [account] = await listAccounts();
  // The demat's value is the sum of one measure over every live row: the
  // market value where the row has one, cost where it does not. The unpriced
  // bond is therefore in both the account value and its class total.
  assert.equal(assetValue(account).paise, 80000);
  assert.equal(account.class_bond_value, 30000);
  const parts = assetClassParts(account);
  assert.equal(parts.bond + parts.equity + parts.mf,
    assetValue(account).paise, "the classes add up to the account value");
  const page = classPage([account], { d1: rows }, "equity");
  assert.equal(page.total, 50000);
  assert.equal(page.rows.filter((r) => r.accountValue).length, 0,
    "no invented row where the row already holds the value");
  assert.ok(page.rows.every((r) => Number(r.value_paise) >= 0),
    "a class page never lists a negative value");
  const bondPage = classPage([account], { d1: rows }, "bond");
  assert.equal(bondPage.total, 30000);
  assert.equal(bondPage.rows[0].value_paise, 30000);
  assert.equal(bondPage.rows[0].atCost, true);
});
