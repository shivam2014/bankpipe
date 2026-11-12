// The sample portfolio must land in the real schema, because the app reads it
// with the same queries as an import. These tests seed a real in-memory store
// and check the rows through the store's own API.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { makeStore } from "./db.js";
import { seedDemoDb } from "./demo-store.js";
import { bondAnalytics, parseBondLabel } from "./bonds.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");

const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});
const data = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const transactions = JSON.parse(
  readFileSync(new URL("./demo-transactions.json", import.meta.url), "utf8"));

async function seeded(save = null) {
  const store = makeStore(SQL, save);
  await store.open();
  const result = seedDemoDb(store, data, transactions);
  return { store, result };
}

test("the seed writes every sample account into the real account table", async () => {
  const { store, result } = await seeded();
  const accounts = store.query("SELECT id, category, subtype FROM account ORDER BY id");
  assert.equal(result.seeded, true);
  assert.equal(accounts.length, result.accounts);
  for (const account of data.accounts) {
    assert.ok(accounts.some((a) => a.id === account.id), `bank ${account.id}`);
  }
  const demats = accounts.filter((a) => a.category === "demat");
  assert.equal(demats.length, 2, "one demat per sample holder");
  assert.ok(accounts.some((a) => a.category === "fd"));
  assert.ok(accounts.some((a) => a.category === "gold"));
  assert.ok(accounts.some((a) => a.category === "insurance"));
  assert.ok(accounts.some((a) => a.id.startsWith("sample-ppf-")));
});

test("every bank statement closes on the balance the sample declares", async () => {
  const { store } = await seeded();
  for (const account of data.accounts) {
    const last = store.query(
      "SELECT balance_paise FROM fact WHERE account_id=? AND balance_paise IS NOT NULL"
      + " ORDER BY txn_date DESC, id DESC LIMIT 1", [account.id])[0];
    if (!transactions.some((t) => t.account === account.id)) {
      assert.equal(last, undefined, `${account.id} has no sample statement`);
      continue;
    }
    assert.equal(last.balance_paise, account.balance, account.id);
  }
});

test("the sample statements chain without a break", async () => {
  const { store, result } = await seeded();
  assert.equal(result.facts, transactions.length);
  for (const account of new Set(transactions.map((t) => t.account))) {
    assert.deepEqual(store.balanceBreaks(account), [], account);
  }
  assert.equal(store.summary().issues, 0);
});

test("the demat holds bonds, shares and fund units the real cards can read", async () => {
  const { store } = await seeded();
  const demats = store.query("SELECT id FROM account WHERE category='demat' ORDER BY id");
  const rows = demats.flatMap((d) => store.listHoldings(d.id));
  const classes = new Set(rows.map((r) => r.category));
  assert.deepEqual([...classes].sort(), ["bond", "equity", "mf"]);

  const bonds = rows.filter((r) => r.category === "bond");
  assert.equal(bonds.length, 3);
  for (const bond of bonds) {
    const parsed = parseBondLabel(bond.label);
    assert.ok(parsed?.maturity, `maturity in ${bond.label}`);
    assert.ok(parsed.couponPct > 0, `coupon in ${bond.label}`);
    assert.ok(Number(bond.face_paise) > 0, `face on ${bond.label}`);
    assert.ok(bond.purchase_date, `purchase date on ${bond.label}`);
    assert.ok(bond.frequency, `frequency on ${bond.label}`);
    assert.ok(bond.rating, `rating on ${bond.label}`);
    const analytics = bondAnalytics(bond);
    assert.ok(analytics, `analytics for ${bond.label}`);
    assert.ok(analytics.ytm > 0, `yield for ${bond.label}`);
  }
  const partial = bonds.find((b) => Number(b.returned_paise) > 0);
  assert.ok(partial, "one bond shows a principal already returned");

  for (const row of rows.filter((r) => r.category !== "bond")) {
    assert.ok(row.security_id, `ISIN on ${row.label}`);
    assert.ok(row.purchase_date, `purchase date on ${row.label}`);
    assert.ok(Number(row.cost_paise) > 0, `cost on ${row.label}`);
    assert.ok(Number(row.value_paise) > 0, `value on ${row.label}`);
  }
});

test("each sample FD is nested under the bank that holds it", async () => {
  const { store } = await seeded();
  const banks = new Map(store.query(
    "SELECT id, bank FROM account WHERE category='bank'").map((r) => [r.id, r.bank]));
  const fds = store.query(
    "SELECT id, bank, meta FROM account WHERE category='fd' ORDER BY id");
  assert.ok(fds.length > 0);
  for (const fd of fds) {
    const meta = JSON.parse(fd.meta || "{}");
    assert.ok(banks.has(meta.linked_account_id), `${fd.id} links to a bank account`);
    // bankKeyFor() groups by the bank string, so the FD must carry the same
    // spelling as the account it belongs to.
    assert.equal(fd.bank, banks.get(meta.linked_account_id), `${fd.id} bank`);
  }
});

test("seeding never calls the save hook", async () => {
  // db.js hands the demo store a null save hook, so this call count is the
  // whole persistence surface: zero here means zero IndexedDB writes.
  let saves = 0;
  const { store } = await seeded(() => { saves += 1; });
  assert.equal(saves, 0);
  assert.equal(store.exportBytes().length > 0, true);
});

test("re-seeding an already seeded store leaves the rows alone", async () => {
  const { store } = await seeded();
  const again = seedDemoDb(store, data, transactions);
  assert.equal(again.seeded, false);
  assert.equal(store.query("SELECT COUNT(*) AS n FROM account")[0].n, again.accounts);
});
