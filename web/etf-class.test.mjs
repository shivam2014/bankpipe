import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { makeStore, useDemoStore, listAccounts } from "./db.js";
import { allocationByClass, assetClassParts, assetSections, assetValue, classPage,
  holdingClass, isFundAccount } from "./assets.js";
import { cleanFundLabel } from "./cas.js";
import { escapeHtml as esc, jsArg } from "./escape.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from > -1, `missing ${start}`);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return html.slice(from, to);
};

// The owner's labels and values, seeded with synthetic ISINs in the reserved
// 9999 namespace. The ISIN is INF, so the row says "mf" even though the demat
// holds the ETF.
const OWNER_ROWS = [
  { security_id: "INF999900001", label: "GOLDBEES-E", category: "mf",
    quantity: 100, cost_paise: 5000000, value_paise: 7300739 },
  { security_id: "INF999900002", label: "SILVERBEES-E", category: "mf",
    quantity: 100, cost_paise: 9000000, value_paise: 10016547 },
];
const GOLDBEES = 7300739;
const SILVERBEES = 10016547;
const TOTAL = GOLDBEES + SILVERBEES;

async function seededDemat(rows = OWNER_ROWS) {
  const store = makeStore(SQL, null);
  await store.open();
  store.createAccount({ id: "demat-1", label: "Broker demat", category: "demat",
    subtype: "equity", number: "IN99990000000001" });
  store.replaceHoldings("demat-1", rows, "2026-11-20");
  await useDemoStore(store);
  return store;
}

// The page's own holding card and class-tab helpers, run with their imports.
const holdingCards = new Function(
  "holdingValue", "money", "cleanFundLabel", "esc", "jsArg", "dateLabel",
  `${between("function holdingCardHtml(", "// Which class tab a demat page opens on.")}
   return holdingCards;`,
)((row) => Number(row?.value_paise ?? row?.cost_paise ?? 0), (p) => String(p),
  cleanFundLabel, esc, jsArg, (v) => String(v || ""));

const classFocusFor = new Function(
  "holdingClass", "isFundAccount", "assetClassParts",
  `${between("function classFocusFor(", "// The rupee value a class tab may show")}
   return classFocusFor;`,
)(holdingClass, isFundAccount, assetClassParts);

test("an ETF's name beats its INF ISIN and its stored fund category", () => {
  for (const row of OWNER_ROWS) {
    assert.equal(holdingClass(row), "equity", `${row.label} is an equity position`);
  }
  assert.equal(holdingClass({ label: "NIPPON INDIA ETF GOLD BEES",
    security_id: "INF999900001", category: "mf" }), "equity",
  "a spelled-out ETF name is an ETF");
  assert.equal(holdingClass({ label: "NIFTYBEES", security_id: "INF999900003" }),
    "equity", "the BeES family name is an ETF");
  assert.equal(holdingClass({ label: "CPSEETF", security_id: "INF999900001",
    category: "mf" }), "equity", "an ETF symbol ending in ETF is an ETF");
});

test("a fund, and a fund that buys ETFs, stay mutual funds", () => {
  assert.equal(holdingClass({ label: "Axis Bluechip Fund",
    security_id: "INF999900004", category: "mf" }), "mf");
  assert.equal(holdingClass({ label: "Motilal Oswal Nasdaq 100 ETF Fund of Fund",
    security_id: "INF999900005", category: "mf" }), "mf",
  "a fund of funds holds ETFs; it is not one");
  assert.equal(holdingClass({ label: "HDFC Liquid Fund", security_id: "INF999900006" }),
    "mf", "an INF row with no ETF marker is a fund");
});

test("a folio row keeps the fund class even when its name carries an ETF marker", () => {
  const folio = { id: "folio-1", category: "demat", subtype: "mutual fund",
    number: "123/4" };
  assert.equal(isFundAccount(folio), true);
  assert.equal(holdingClass({ label: "NIPPON INDIA ETF GOLD BEES",
    category: "mf" }, folio), "mf",
  "a folio cannot hold an ETF, so its rows are funds");
});

test("the stored mf rows reclassify to Equities without a re-import", async () => {
  const store = await seededDemat();
  const [account] = await listAccounts();
  assert.equal(account.class_mf_value, 0, "no mutual-fund value is left");
  assert.equal(account.class_equity_value, TOTAL, "both ETFs are in Equities");
  assert.equal(account.class_bond_value, 0);
  assert.equal(account.class_bond_value + account.class_equity_value
    + account.class_mf_value, account.holdings_live_value,
  "the class split still sums to the account total");
  assert.equal(assetValue(account).paise, TOTAL);

  const sections = assetSections([account]);
  assert.deepEqual(sections.map((s) => [s.id, s.label, s.total]),
    [["equity", "Equities", TOTAL]]);
  assert.equal(sections.reduce((t, s) => t + s.total, 0), TOTAL,
    "the Assets sections add up to the account total");

  const mfPage = classPage([account], { "demat-1": store.listHoldings("demat-1") },
    "mf");
  assert.equal(mfPage.total, 0, "the Mutual funds class page is empty");
  assert.equal(mfPage.rows.length, 0);
  const equityPage = classPage([account], { "demat-1": store.listHoldings("demat-1") },
    "equity");
  assert.equal(equityPage.total, TOTAL, "the Equities class page carries both rows");
  assert.deepEqual(equityPage.rows.map((r) => r.security_id).sort(),
    ["INF999900001", "INF999900002"]);

  const byClass = allocationByClass([account]);
  assert.equal(byClass.find((g) => g.id === "mf"), undefined,
    "the allocation ring has no Mutual funds slice");
  assert.equal(byClass.find((g) => g.id === "equity")?.total, TOTAL);

  const stored = store.listHoldings("demat-1");
  assert.ok(stored.every((r) => r.category === "mf"),
    "the rows were not rewritten; the class comes from the derived rule");
});

test("the demat opens on Equities, not Mutual funds, and the header offers equities", async () => {
  const store = await seededDemat();
  const [account] = await listAccounts();
  const rows = store.listHoldings("demat-1");

  assert.equal(classFocusFor(account, rows, "equity"), "equity",
    "an Equities tab has rows to land on");
  assert.equal(classFocusFor(account, rows, "mf"), "all",
    "the Mutual funds tab has nothing to land on");

  const equityPage = classPage([account], { "demat-1": rows }, "equity");
  const header = holdingCards(equityPage.groups[0].rows, "equity",
    { assetId: "demat-1" });
  assert.match(header, /Add equity/);
  assert.doesNotMatch(header, /Add mutual fund/,
    "an ETF is not offered a mutual fund editor");
});
