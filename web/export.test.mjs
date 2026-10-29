import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeStore } from "./db.js";
import { toCsv, toJson, snapshotRows } from "./export.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

test("csv quotes commas, quotes and newlines the way spreadsheets expect", () => {
  const csv = toCsv([
    { account: "a", date: "2024-04-01", amount: 1, balance: 2, narration: 'SALARY, "APRIL"', ref: "", source_row: 3 },
    { account: "a", date: "2024-04-02", amount: -1, balance: 1, narration: "two\nlines", ref: "R1", source_row: 4 },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "account,date,amount,balance,narration,ref,source_row");
  assert.match(csv, /"SALARY, ""APRIL"""/);
  assert.match(csv, /"two\nlines"/);
  assert.ok(csv.endsWith("\n"), "a trailing newline is what POSIX tools expect");
});

test("nulls become empty cells, never the string 'null'", () => {
  const csv = toCsv([{ account: "a", date: null, amount: null, balance: null, narration: null, ref: null, source_row: null }]);
  assert.equal(csv, "account,date,amount,balance,narration,ref,source_row\na,,,,,,\n");
  assert.equal(csv.includes("null"), false);
  assert.equal(csv.includes("undefined"), false);
});

test("formula-looking text is neutralised but numbers stay numeric", () => {
  const csv = toCsv([
    { account: "a", narration: "=HYPERLINK(\"https://evil\")", amount: -1250, balance: 0 },
    { account: "b", narration: "+SUM(A1)", amount: 10, balance: 10 },
    { account: "c", narration: "@cmd", amount: 1, balance: 1 },
  ], ["account", "narration", "amount", "balance"]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+SUM/);
  assert.match(csv, /'@cmd/);
  assert.match(csv, /a,"'=HYPERLINK\(""https:\/\/evil""\)",-1250,0/);
  assert.match(csv, /,10,10/);
});

test("amounts stay integer paise in the export", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("hdfc-dad", [
    { date: "2024-04-02", amount: 149525, balance: 12149525, description: "SALARY" },
  ]);
  const rows = snapshotRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 149525);
  assert.equal(rows[0].balance, 12149525);
  assert.equal(typeof rows[0].amount, "number");
});

test("json export carries a count and every row", async () => {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("icici-mom", [
    { date: "2024-04-02", amount: 100, balance: 1000, description: "A" },
    { date: "2024-04-03", amount: -50, balance: 950, description: "B" },
  ]);
  const parsed = JSON.parse(toJson(snapshotRows(store)));
  assert.equal(parsed.count, 2);
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.exported_at);
  assert.equal(parsed.rows[0].account, "icici-mom");
});

test("an empty database exports a header row, not an empty file", () => {
  const csv = toCsv([]);
  assert.equal(csv, "account,date,amount,balance,narration,ref,source_row\n");
});
