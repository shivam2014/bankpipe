import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { makeStore, useDemoStore, listAccounts } from "./db.js";
import { casReplacePlan } from "./cas-apply.js";
import { assetMetrics } from "./finance.js";
import { assetSections, assetValue, classPage, totalAssets } from "./assets.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const LAKH = 10000000; // ₹1,00,000 in paise

// A demat row that has a price, and one that only has what was paid for it.
const priced = (over = {}) => ({
  security_id: "INE000000101", label: "Priced bond", category: "bond",
  quantity: 10, cost_paise: 2 * LAKH, value_paise: 2 * LAKH, ...over,
});
const costOnly = (over = {}) => ({
  security_id: "INE000000102", label: "Cost-only bond", category: "bond",
  quantity: 10, cost_paise: 2 * LAKH, value_paise: null, ...over,
});

async function seededStore(rows) {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "d1", label: "Demat", category: "demat",
    subtype: "equity" });
  store.replaceHoldings("d1", rows, "2026-10-31");
  await useDemoStore(store);
  return store;
}

test("a demat with one cost-only row counts it beside seventeen priced rows", () => {
  // The account-level aggregates the page reads: 17 priced rows worth 34 lakh
  // and one cost-only row paid for at 2 lakh.
  const account = {
    id: "d1", label: "Demat", category: "demat", subtype: "equity",
    holdings_count: 18, holdings_cost: 36 * LAKH,
    holdings_live_cost: 36 * LAKH,
    holdings_value: 34 * LAKH, holdings_live_value: 36 * LAKH,
    holdings_valued_count: 17,
    class_bond_value: 2 * LAKH, class_equity_value: 20 * LAKH,
    class_mf_value: 14 * LAKH,
  };
  const m = assetMetrics(account, "demat");
  assert.equal(m.value, 36 * LAKH,
    "the account value includes the cost-only row");
  assert.equal(m.invested, 36 * LAKH);
  assert.equal(m.gain, 0,
    "a row carried at cost contributes no gain");
  assert.match(m.note, /17 priced/);

  const sections = assetSections([account]);
  const totals = Object.fromEntries(sections.map((s) => [s.id, s.total]));
  assert.equal(totals.bond, 2 * LAKH,
    "the cost-only bond is in the bond class total");
  assert.equal(totals.equity, 20 * LAKH);
  assert.equal(totals.mf, 14 * LAKH);
  assert.equal(totals.bond + totals.equity + totals.mf, 36 * LAKH,
    "the class totals add up to the account value");
});

test("the SQL class totals carry a cost-only row beside priced rows", async () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => priced({
      security_id: `INE0000002${String(i).padStart(2, "0")}`,
      category: "equity", label: `Share ${i + 1}`,
    })),
    ...Array.from({ length: 7 }, (_, i) => priced({
      security_id: `INF0000002${String(i).padStart(2, "0")}`,
      category: "mf", label: `Fund ${i + 1}`,
    })),
    costOnly(),
  ];
  await seededStore(rows);
  const [account] = await listAccounts();
  assert.equal(account.class_bond_value, 2 * LAKH,
    "the unpriced bond still contributes its cost");
  assert.equal(account.class_equity_value, 20 * LAKH);
  assert.equal(account.class_mf_value, 14 * LAKH);
  assert.equal(account.holdings_live_value, 36 * LAKH);
  assert.equal(account.holdings_value, 34 * LAKH,
    "the priced-only field keeps its old meaning");
  assert.equal(assetValue(account).paise, 36 * LAKH);
  const sections = assetSections([account]);
  assert.equal(sections.reduce((total, section) => total + section.total, 0),
    36 * LAKH);
});

test("a disposed row is in neither the account value nor its class page", async () => {
  const live = priced({ security_id: "INE000000401", cost_paise: 2 * LAKH,
    value_paise: 3 * LAKH });
  const sold = costOnly({ security_id: "INE000000402", cost_paise: 2 * LAKH,
    value_paise: 0, disposed_at: "2026-09-01", disposed_quantity: 10,
    disposed_type: "sale" });
  await seededStore([live, sold]);
  const [account] = await listAccounts();
  assert.equal(account.holdings_count, 1);
  assert.equal(account.holdings_live_value, 3 * LAKH);
  assert.equal(account.class_bond_value, 3 * LAKH);
  assert.equal(assetValue(account).paise, 3 * LAKH);
  const page = classPage([account], { d1: [live, sold] }, "bond");
  assert.equal(page.total, 3 * LAKH);
  assert.equal(page.rows.length, 1);
});

test("a CAS that prices 10 of 17 broker rows leaves net worth unchanged", async () => {
  const rows = Array.from({ length: 17 }, (_, i) => costOnly({
    security_id: `INE0000003${String(i).padStart(2, "0")}`,
    label: `TEST BOND ${i + 1}`,
    cost_paise: 2 * LAKH,
  }));
  const store = await seededStore(rows);
  const beforeAssets = await listAccounts();
  const before = totalAssets(beforeAssets);
  assert.equal(before, 34 * LAKH, "17 rows at cost before the CAS");

  // The CAS names 10 of the 17 rows and prices each at what it cost. The other
  // seven rows are not in the statement and are preserved, still at cost.
  const parsed = {
    asOf: "2026-10-31",
    holdings: rows.slice(0, 10).map((row) => ({
      isin: row.security_id, label: row.label, kind: "bond",
      quantity: row.quantity, valuePaise: row.cost_paise,
    })),
    transactions: [],
    counts: { rows: 10, quarantined: 0 },
  };
  const plan = casReplacePlan({ parsed, existing: store.listHoldings("d1"),
    holdings: parsed.holdings, assetId: "d1", asOf: parsed.asOf });
  assert.equal(plan.rows.length, 17, "the seven rows the CAS omits are kept");
  store.replaceHoldings("d1", plan.rows, parsed.asOf);

  const afterAssets = await listAccounts();
  const after = totalAssets(afterAssets);
  assert.equal(after, before,
    "pricing some rows does not drop the rows the CAS did not name");
  assert.equal(assetValue(afterAssets[0]).paise, before);
  assert.equal(afterAssets[0].class_bond_value, before);
  assert.equal(store.listHoldings("d1").filter((row) => !row.disposed_at).length,
    17);
});
