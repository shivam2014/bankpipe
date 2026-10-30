import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { makeStore, showDeleteAll } from "./db.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");

const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const rows = [
  { date: "2024-04-02", amount: 149525, balance: 12149525, description: "SALARY CR" },
  { date: "2024-04-03", amount: -120000, balance: 12029525, description: "UPI MERCHANT" },
  { date: "2024-04-04", amount: -50000, balance: 11979525, description: "ATM" },
];

test("a fresh import inserts every row", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const res = store.importRows("hdfc-dad", rows);
  assert.equal(res.inserted, 3);
  assert.equal(res.duplicates, 0);
  assert.equal(store.summary().facts, 3);
});

test("re-importing the same rows inserts nothing", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc-dad", rows);
  const again = store.importRows("hdfc-dad", rows);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 3);
  assert.equal(store.summary().facts, 3);
  assert.equal(store.summary().runs, 2);
});

test("a broken balance becomes one issue, not two", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const broken = [
    { date: "2024-04-02", amount: 100000, balance: 1100000, description: "A" },
    { date: "2024-04-03", amount: -20000, balance: 1079000, description: "B" },
    { date: "2024-04-04", amount: -10000, balance: 1069000, description: "C" },
  ];
  const res = store.importRows("icici-dad", broken);
  assert.equal(res.breaks, 1);
  assert.equal(store.summary().issues, 1);
});

test("persistence receives the database bytes", async () => {
  let saved = null;
  const store = makeStore(SQL, async (bytes) => { saved = bytes; });
  await store.open();
  store.importRows("sbi-dad", rows);
  await store.save();
  assert.ok(saved && saved.byteLength > 1000);
});

test("a manual account exists before any statement, and is listed", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "hdfc-dad-1234", label: "HDFC Bank", bank: "HDFC Bank",
    number: "99990234567890", holder: "dad", city: "New Delhi", type: "savings" });
  const rows = store.query("SELECT id, bank, number, type FROM account");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, "99990234567890");
  assert.equal(store.summary().facts, 0);
});

test("adding the same account twice updates it, it does not duplicate", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const a = { id: "hdfc-dad-1234", label: "HDFC Bank", bank: "HDFC Bank",
    number: "99990234567890", holder: "dad", city: "New Delhi", type: "savings" };
  store.createAccount(a);
  store.createAccount({ ...a, city: "Gurugram" });
  const rows = store.query("SELECT city FROM account");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].city, "Gurugram");
});

test("clearing removes manually added accounts too", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "cash", bank: "Cash", type: "cash" });
  assert.equal(store.summary().accounts, 1);
  store.raw().run("DELETE FROM fact; DELETE FROM import_run; DELETE FROM issue; DELETE FROM account;");
  assert.equal(store.summary().accounts, 0);
});

test("an older database gains the asset columns on open", async () => {
  const old = new SQL.Database();
  old.run("CREATE TABLE account(id TEXT PRIMARY KEY, label TEXT, bank TEXT, number TEXT,"
    + " holder TEXT, city TEXT, type TEXT)");
  old.run("INSERT INTO account(id,label,type) VALUES('hdfc','HDFC','savings')");
  old.run("INSERT INTO account(id,label,type) VALUES('zerodha','Zerodha','demat')");
  const bytes = old.export();
  const store = makeStore(SQL, null);
  await store.open(bytes);
  const rows = store.query("SELECT id, category, subtype FROM account ORDER BY id");
  assert.equal(rows[0].category, "bank");
  assert.equal(rows[0].subtype, "savings");
  assert.equal(rows[1].category, "demat");
  assert.deepEqual(store.query("SELECT value_paise FROM account").map((r) => r.value_paise),
    [null, null]);
});

test("an asset can carry a category, a manual value and notes", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "gold-locker", label: "Locker gold", category: "gold",
    subtype: "physical", bank: "SBI", holder: "mom", city: "Jaipur",
    value_paise: 48000000, value_date: "2026-03-31", notes: "22k, two chains" });
  const row = store.query("SELECT category, subtype, value_paise, value_date, notes"
    + " FROM account")[0];
  assert.equal(row.category, "gold");
  assert.equal(row.value_paise, 48000000);
  assert.equal(row.notes, "22k, two chains");
});

test("deleting an asset removes its facts and issues, not other assets", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc", rows);
  store.importRows("icici", rows);
  assert.equal(store.summary().facts, 6);
  store.deleteAccount("hdfc");
  assert.equal(store.summary().facts, 3);
  assert.equal(store.summary().accounts, 1);
  assert.equal(store.query("SELECT id FROM account")[0].id, "icici");
});

test("financial fields survive a round trip", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "fd-1", label: "SBI FD", category: "fd", subtype: "fd",
    principal_paise: 10000000, rate_bps: 725, start_date: "2024-01-01",
    maturity_date: "2027-01-01", interest_paid_paise: 0,
    meta: { compounding: "quarterly" } });
  const row = store.query("SELECT principal_paise, rate_bps, start_date, maturity_date,"
    + " meta FROM account")[0];
  assert.equal(row.principal_paise, 10000000);
  assert.equal(row.rate_bps, 725);
  assert.equal(row.start_date, "2024-01-01");
  assert.equal(JSON.parse(row.meta).compounding, "quarterly");
});

test("month flow counts credits and debits separately", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc", rows);
  const flow = store.monthFlow("2024-04-01");
  assert.equal(flow.inn, 149525);
  assert.equal(flow.out, 170000);
  assert.equal(flow.n, 3);
});

test("a transaction can be corrected in place", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("a", [{ date: "2026-01-01", amount: 100, balance: 1000, description: "X" }]);
  const id = store.query("SELECT id FROM fact")[0].id;
  assert.equal(store.updateFact(id, { amount_paise: 200, balance_paise: 1200, narration: "Y" }), true);
  const row = store.query("SELECT amount_paise a, balance_paise b, narration n FROM fact")[0];
  assert.equal(row.a, 200);
  assert.equal(row.b, 1200);
  assert.equal(row.n, "Y");
  assert.equal(store.updateFact(id, { nope: 1 }), false);
});

test("a re-import corrects a changed running balance instead of duplicating", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const first = store.importRows("scb", [{ date: "2026-08-14", amount: -283384,
    balance: 31000018, description: "IN3OT260731000BK NOSTROACCOUNT|STANDARD CHARTER" }]);
  assert.equal(first.inserted, 1);
  const again = store.importRows("scb", [{ date: "2026-08-14", amount: -283384,
    balance: 8296611, description: "IN3OT260731000BK NOSTROACCOUNT|STANDARD CHARTER" }]);
  assert.equal(again.inserted, 0);
  assert.equal(again.corrected, 1);
  const rows = store.query("SELECT balance_paise AS b FROM fact");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].b, 8296611);
});

test("monthly flows group every month, newest first", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc", rows);
  store.importRows("hdfc", [
    { date: "2024-05-01", amount: -25000, balance: 11954525, description: "RENT" },
    { date: "", amount: 500, balance: 11955025, description: "NO DATE" },
  ]);
  const months = store.monthlyFlows();
  assert.equal(months.length, 2);
  assert.equal(months[0].month, "2024-05");
  assert.equal(months[0].inn, 0);
  assert.equal(months[0].out, 25000);
  assert.equal(months[0].n, 1);
  assert.equal(months[1].month, "2024-04");
  assert.equal(months[1].inn, 149525);
  assert.equal(months[1].out, 170000);
  assert.equal(store.monthlyFlows(1).length, 1);
});

test("a setting round-trips through the store", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.setSetting("credentials.v1", "ciphertext");
  assert.equal(store.getSetting("credentials.v1"), "ciphertext");
  assert.equal(store.getSetting("missing"), null);
});

test("manual holdings survive a report sync", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bonds1", label: "Bonds", category: "bonds" });
  const id = store.upsertHolding("bonds1", { label: "10.00% TEST 31 DEC 2030",
    security_id: "INE000000001", quantity: 1, cost_paise: 100000,
    purchase_date: "2024-01-01", rating: "AA", frequency: "Annual" });
  assert.ok(id);
  let rows = store.listHoldings("bonds1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "manual");
  assert.equal(rows[0].rating, "AA");

  store.upsertHolding("bonds1", { id, label: "10.50% TEST 31 DEC 2030",
    security_id: "INE000000001", quantity: 2, cost_paise: 200000 });
  rows = store.listHoldings("bonds1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.match(rows[0].label, /10\.50%/);

  const kept = store.replaceHoldings("bonds1", [
    { security_id: "INE000000002", label: "9.00% OTHER 31 DEC 2028",
      quantity: 1, cost_paise: 500000 }], "2026-10-27");
  assert.equal(kept.manualKept, 1);
  assert.equal(kept.manualSuperseded, 0);
  rows = store.listHoldings("bonds1");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.security_id === "INE000000001").source, "manual");
  assert.equal(rows.find((r) => r.security_id === "INE000000002").source, "report");

  const replaced = store.replaceHoldings("bonds1", [
    { security_id: "INE000000001", label: "10.00% TEST 31 DEC 2030",
      quantity: 1, cost_paise: 100000 }], "2026-10-28");
  assert.equal(replaced.manualSuperseded, 1);
  assert.equal(replaced.manualKept, 0);
  rows = store.listHoldings("bonds1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "report");
  assert.equal(store.deleteHolding(rows[0].id), true);
  assert.equal(store.listHoldings("bonds1").length, 0);
});

test("holdings replace as a snapshot, not append", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "zerodha", label: "Zerodha", category: "demat" });
  const lots = [
    { security_id: "INE002A01018", label: "Reliance", quantity: 10,
      cost_paise: 12500000, value_paise: 15000000, source_row: 2 },
    { security_id: "INE008A01015", label: "REC Bond", quantity: 5,
      cost_paise: 5000000, value_paise: 5250000, source_row: 3 },
  ];
  store.replaceHoldings("zerodha", lots, "2026-03-31");
  assert.equal(store.listHoldings("zerodha").length, 2);
  store.replaceHoldings("zerodha", lots.slice(0, 1), "2026-04-30");
  assert.equal(store.listHoldings("zerodha").length, 1);
});

test("holdings keep rating, frequency and purchase yield", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bonds", label: "Bonds", category: "bonds" });
  store.replaceHoldings("bonds", [{
    security_id: "INE000000001", label: "10.00% TEST 01 JAN 2030", category: "bond",
    rating: "AA", frequency: "Monthly Payout", yield_bps: 1100, payout_paise: 87055,
    quantity: 1, cost_paise: 100000, value_paise: null, purchase_date: "2025-01-01",
    interest_date: "2026-11-01",
  }], "2026-10-26");
  const row = store.listHoldings("bonds")[0];
  assert.equal(row.rating, "AA");
  assert.equal(row.frequency, "Monthly Payout");
  assert.equal(row.yield_bps, 1100);
  assert.equal(row.payout_paise, 87055);
  assert.equal(row.purchase_date, "2025-01-01");
});

test("holdings totals appear on the asset row", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "zerodha", label: "Zerodha", category: "demat" });
  store.replaceHoldings("zerodha", [
    { security_id: "A", label: "A", quantity: 1, cost_paise: 100, value_paise: 125 },
    { security_id: "B", label: "B", quantity: 1, cost_paise: 200, value_paise: 175 },
  ], "2026-03-31");
  const row = store.query("SELECT"
    + " (SELECT SUM(cost_paise) FROM holding WHERE asset_id='zerodha') AS holdings_cost,"
    + " (SELECT SUM(value_paise) FROM holding WHERE asset_id='zerodha') AS holdings_value,"
    + " (SELECT COUNT(*) FROM holding WHERE asset_id='zerodha') AS holdings_count")[0];
  assert.equal(row.holdings_cost, 300);
  assert.equal(row.holdings_value, 300);
  assert.equal(row.holdings_count, 2);
});

test("a balance break can be listed and resolved", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc", [
    { date: "2024-04-02", amount: 100000, balance: 1100000, description: "A" },
    { date: "2024-04-03", amount: -20000, balance: 1079000, description: "B" },
  ]);
  const open = store.listIssues();
  assert.equal(open.length, 1);
  assert.equal(open[0].account, "hdfc");
  store.resolveIssue(open[0].id, "accepted");
  assert.equal(store.listIssues().length, 0);
});

test("re-importing held rows does not add review items", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  const broken = [
    { date: "2024-04-02", amount: 100000, balance: 1100000, description: "A" },
    { date: "2024-04-03", amount: -20000, balance: 1079000, description: "B" },
  ];
  store.importRows("hdfc", broken);
  const first = store.summary().issues;
  store.importRows("hdfc", broken);
  assert.equal(store.summary().issues, first);
});

test("searchFacts filters by description, date, amount and account", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "hdfc-dad", label: "HDFC savings", bank: "HDFC" });
  store.createAccount({ id: "icici-dad", label: "ICICI savings", bank: "ICICI" });
  store.importRows("hdfc-dad", [
    { date: "2024-04-02", amount: 149525, balance: 12149525, description: "SALARY CR" },
    { date: "2024-04-03", amount: -120000, balance: 12029525, description: "UPI MERCHANT" },
  ]);
  store.importRows("icici-dad", [
    { date: "2024-05-01", amount: -50000, balance: 500000, description: "ATM" },
  ]);
  const salary = store.searchFacts({ q: "salary" });
  assert.equal(salary.totals.n, 1);
  assert.equal(salary.rows[0].description, "SALARY CR");
  assert.equal(salary.rows[0].account_label, "HDFC savings");
  const april = store.searchFacts({ from: "2024-04-01", to: "2024-04-30" });
  assert.equal(april.totals.n, 2);
  const debits = store.searchFacts({ min: -200000, max: -10000 });
  assert.equal(debits.totals.n, 2);
  const onlyIcici = store.searchFacts({ account: "icici-dad" });
  assert.equal(onlyIcici.totals.n, 1);
  const page = store.searchFacts({ limit: 1, offset: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.totals.n, 3);
});

test("an IFSC and branch can be added to an existing asset", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "sbi-dad", label: "SBI", bank: "SBI" });
  assert.equal(store.updateAccount("sbi-dad", { ifsc: "SBIN0001234", branch: "Pitampura" }), true);
  const row = store.query("SELECT ifsc, branch FROM account WHERE id='sbi-dad'")[0];
  assert.equal(row.ifsc, "SBIN0001234");
  assert.equal(row.branch, "Pitampura");
});

test("validation and the gap filter find a blank date and a blank balance", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "hdfc-dad", label: "HDFC savings", bank: "HDFC" });
  store.importRows("hdfc-dad", [
    { date: "", amount: 100000, balance: null, description: "NO DATE OR BALANCE" },
    { date: "2024-04-02", amount: -50000, balance: 50000, description: "NORMAL" },
  ]);
  const noDate = store.searchFacts({ gap: "date" });
  assert.equal(noDate.totals.n, 1);
  const noBalance = store.searchFacts({ gap: "balance" });
  assert.equal(noBalance.totals.n, 1);
  const v = store.validation();
  assert.equal(v.accounts.length, 1);
  assert.equal(v.accounts[0].missing_date, 1);
  assert.equal(v.accounts[0].missing_balance, 1);
  assert.equal(v.duplicates, 0);
  assert.equal(v.totals.facts, 2);
  assert.equal(v.totals.accounts, 1);
});

test("a holding current value can be updated without changing its cost", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bonds-a", label: "Bonds", category: "bonds" });
  store.replaceHoldings("bonds-a", [
    { security_id: "INE000000001", label: "A bond", quantity: 1,
      cost_paise: 100000, value_paise: 100000, source_row: 2 },
  ], "2024-04-01");
  const before = store.listHoldings("bonds-a")[0];
  assert.ok(before.id);
  store.updateHoldingValue(before.id, 105000);
  const after = store.listHoldings("bonds-a")[0];
  assert.equal(after.cost_paise, 100000);
  assert.equal(after.value_paise, 105000);
});

test("searchFacts can sort by amount ascending and descending", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "sort-a", label: "Sort", bank: "S" });
  store.importRows("sort-a", [
    { date: "2024-04-01", amount: 300, balance: 300, description: "C" },
    { date: "2024-04-02", amount: -100, balance: 200, description: "A" },
    { date: "2024-04-03", amount: 200, balance: 400, description: "B" },
  ]);
  const asc = store.searchFacts({ sort: "amount", dir: 1 });
  assert.deepEqual(asc.rows.map((r) => r.amount), [-100, 200, 300]);
  const desc = store.searchFacts({ sort: "amount", dir: -1 });
  assert.deepEqual(desc.rows.map((r) => r.amount), [300, 200, -100]);
});

test("factIds lists every match, not just the rendered page", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bulk-a", label: "Bulk", bank: "B" });
  const many = Array.from({ length: 450 }, (_, i) => ({
    date: `2024-05-${String((i % 28) + 1).padStart(2, "0")}`,
    amount: i + 1, balance: i + 1,
    description: `ROW ${i + 1} ${i % 2 ? "SHOP" : "SALARY"}`,
  }));
  store.importRows("bulk-a", many);
  const ids = store.factIds({ account: "bulk-a" });
  assert.equal(ids.length, 450);
  assert.equal(new Set(ids).size, 450, "no duplicate ids");
  const firstPage = store.searchFacts({ account: "bulk-a" });
  assert.equal(firstPage.rows.length, 200, "the ledger itself still pages");
  assert.ok(ids.length > firstPage.rows.length, "the selection is not the page");

  const salary = store.factIds({ account: "bulk-a", q: "SALARY" });
  assert.equal(salary.length, 225);
  assert.ok(salary.every((id) => ids.includes(id)), "filtered ids stay in the account");
  const ranged = store.factIds({ account: "bulk-a", from: "2024-05-01", to: "2024-05-05" });
  assert.ok(ranged.length > 0 && ranged.length < ids.length);
  assert.deepEqual(store.factIds({ account: "bulk-a", q: "NO SUCH ROW" }), []);
});

test("Delete all is offered only for a whole-account selection", () => {
  assert.equal(showDeleteAll(0, 0), false, "an empty ledger has nothing to delete");
  assert.equal(showDeleteAll(0, 1046), false, "nothing selected");
  assert.equal(showDeleteAll(200, 1046), false, "one page is not the account");
  assert.equal(showDeleteAll(1046, 1046), true, "the whole account is selected");
  assert.equal(showDeleteAll(1047, 1046), false, "more than the account is not safe");
  assert.equal(showDeleteAll("1046", "1046"), true, "data attributes arrive as strings");
});

test("locker records stay with their account", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bob-dad", label: "BOB", bank: "Bank of Baroda",
    category: "bank", type: "savings" });
  const id = store.saveLocker({ account_id: "bob-dad", number: "402",
    branch: "Pitampura", size: "Medium", contents: "Gold jewellery, Property papers" });
  const list = store.listLockers("bob-dad");
  assert.equal(list.length, 1);
  assert.equal(list[0].number, "402");
  assert.match(list[0].contents, /Gold/);
  store.deleteLocker(id);
  assert.equal(store.listLockers("bob-dad").length, 0);
});

test("locker rent payments are found from the account's narrations", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "bob-dad", label: "BOB", bank: "Bank of Baroda",
    category: "bank", type: "savings" });
  store.importRows("bob-dad", [
    { date: "2024-08-01", amount: -295000, balance: 1000000, description: "LOCKER RENT 402" },
    { date: "2024-09-01", amount: -50000, balance: 950000, description: "UPI" },
  ]);
  const rows = store.lockerPayments("bob-dad");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_paise, -295000);
});
