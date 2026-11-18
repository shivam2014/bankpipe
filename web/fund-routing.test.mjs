import test from "node:test";
import assert from "node:assert/strict";
import { casRoute, casTotals, parseCas } from "./cas.js";
import { casGroupByAsset, casReplacePlan } from "./cas-apply.js";
import { duplicateFundPositions, normalizeFolio } from "./folio.js";
import { isFundAccount } from "./assets.js";
import { importAccountGaps } from "./import-flow.js";

// A synthetic NSDL CAS with the shape the owner's file has: a demat table that
// prints the mutual fund positions again, and one folio table per fund with the
// printed folio. The demat values differ from the folio values because the two
// sections are valued at different dates, which is why the duplicate used to
// hide: the same ISIN arrived twice with two different numbers.
const DEMAT = "IN99990001344321";
const FOLIO_ADITYA = "999900006290";
const FOLIO_AXIS = "999900003856";
const FOLIO_MIRAE = "999900004666";
const ISIN_ADITYA = "INF000000290";
const ISIN_AXIS = "INF000000385";
const ISIN_MIRAE = "INF000000466";
const TODAY = "2026-10-31";

const text = (str, x, y) => ({ str, x, y, width: 0 });
const money = (str, right, y) => ({ str, x: right - str.length * 6, width: str.length * 6, y });
const page = (items) => ({ items });

const DEMAT_HEADER = [
  text("ISIN", 50, 700), text("Security", 130, 700), text("Current", 300, 700),
  text("Frozen", 350, 700), text("Pledge", 400, 700),
  text("Market Price", 500, 700), text("Value", 560, 700),
];
const dematRow = (isin, label, units, price, value, y) => [
  text(isin, 50, y), text(label, 130, y), money(String(units), 310, y),
  money("--", 355, y), money("--", 395, y), money(price, 545, y),
  money(value, 578, y),
];
const FOLIO_HEADER = (y) => [
  text("ISIN", 50, y), text("Scheme Name", 130, y), text("Folio No.", 300, y),
  text("No. of Units", 360, y), text("Total Cost", 430, y),
  text("NAV per unit", 500, y), text("Value in", 570, y),
];
const folioRow = (isin, label, folio, units, cost, nav, value, y) => [
  text(isin, 50, y), text(label, 130, y), money(folio, 350, y),
  money(String(units), 380, y), money(cost, 470, y), money(nav, 540, y),
  money(value, 590, y),
];

const EQUITIES = [
  ["INE000000101", "TEST POWER LIMITED", 10, "1,000.00", "10,000.00"],
  ["INE000000102", "TEST FINANCE LIMITED", 20, "500.00", "10,000.00"],
  ["INE000000103", "TEST STEEL LIMITED", 5, "2,000.00", "10,000.00"],
  ["INE000000104", "TEST CEMENT LIMITED", 8, "1,250.00", "10,000.00"],
  ["INE000000105", "TEST MOTORS LIMITED", 40, "250.00", "10,000.00"],
  ["INE000000106", "TEST BANK LIMITED", 100, "100.00", "10,000.00"],
  ["INE000000107", "TEST CHEMICALS LIMITED", 12, "833.33", "10,000.00"],
  ["INE000000108", "TEST TEXTILES LIMITED", 25, "400.00", "10,000.00"],
  ["INE000000109", "TEST HOTELS LIMITED", 50, "200.00", "10,000.00"],
  ["INE000000110", "TEST LOGISTICS LIMITED", 4, "2,500.00", "10,000.00"],
  ["INE000000111", "TEST TELECOM LIMITED", 16, "625.00", "10,000.00"],
];

// The demat section's fund valuation is the one the owner saw on the account
// page. The folio section is the home; the duplicate values must not win.
const DEMAT_FUNDS = [
  [ISIN_ADITYA, "TEST ADITYA FUND - GROWTH", 2, "36.0750", "72.15"],
  [ISIN_AXIS, "TEST AXIS ELSS - GROWTH", 3000, "105.7174", "3,17,152.34"],
  [ISIN_MIRAE, "TEST MIRAE FUND - GROWTH", 4, "34.5600", "138.24"],
];
const FOLIOS = [
  [FOLIO_ADITYA, ISIN_ADITYA, "TEST ADITYA FUND - GROWTH", 2, "70.00",
    "35.7350", "71.47"],
  [FOLIO_AXIS, ISIN_AXIS, "TEST AXIS ELSS - GROWTH", 3000, "2,40,000.00",
    "104.52647", "3,13,579.41"],
  [FOLIO_MIRAE, ISIN_MIRAE, "TEST MIRAE FUND - GROWTH", 4, "130.00",
    "35.0725", "140.29"],
];

function statement() {
  const demat = [...DEMAT_HEADER];
  let y = 660;
  for (const [isin, label, units, price, value] of EQUITIES) {
    demat.push(...dematRow(isin, label, units, price, value, y));
    y -= 42;
  }
  for (const [isin, label, units, price, value] of DEMAT_FUNDS) {
    demat.push(...dematRow(isin, label, units, price, value, y));
    y -= 42;
  }
  const first = page([
    text("National Securities Depository Limited", 50, 780),
    text("DP Name : TEST DEPOSITORY LIMITED", 20, 760),
    text("BO ID : IN99990001344321", 420, 760),
    ...demat,
  ]);
  const folios = [];
  let fy = 700;
  for (const [folio, isin, label, units, cost, nav, value] of FOLIOS) {
    folios.push(...FOLIO_HEADER(fy));
    folios.push(...folioRow(isin, label, folio, units, cost, nav, value, fy - 40));
    fy -= 120;
  }
  const second = page([
    text("Mutual Fund Folios", 50, 780),
    ...folios,
    text("Grand Total", 20, 80), money("4,23,791.17", 578, 80),
  ]);
  return { pages: [first, second] };
}

const assets = [
  { id: "d1", label: "Demat · NSDL", category: "demat", subtype: "equity",
    number: DEMAT },
  ...[ [ "f1", FOLIO_ADITYA], ["f2", FOLIO_AXIS], ["f3", FOLIO_MIRAE] ]
    .map(([id, folio]) => ({ id, label: `${id} mutual fund`, category: "demat",
      subtype: "mutual fund", type: "mf", number: folio,
      meta: JSON.stringify({ amc: id, folios: [folio] }) })),
];

const valueOf = (rows) => rows.reduce((total, row) =>
  total + (Number(row.valuePaise ?? row.value_paise) || 0), 0);

test("a fund ISIN printed in the demat table is read as a fund row", () => {
  const parsed = parseCas(statement());
  const funds = parsed.holdings.filter((holding) => holding.kind === "mf");
  assert.equal(funds.length, 3);
  for (const holding of funds) {
    assert.match(holding.isin, /^INF/);
    assert.ok(holding.folio, "the folio section supplies the printed folio");
    assert.equal(holding.quantity > 0, true);
  }
  // The demat section printed three extra rows; they are one position per folio,
  // not six.
  assert.equal(parsed.holdings.length, EQUITIES.length + FOLIOS.length);
});

test("the demat holds only non-fund rows and each folio holds one position", () => {
  const parsed = parseCas(statement());
  assert.equal(casTotals(parsed, parsed.printedTotalPaise).ok, true);
  const route = casRoute(parsed, assets);
  const byAsset = casGroupByAsset({ holdings: parsed.holdings,
    groups: route.groups, importDay: TODAY });

  const dematRows = byAsset.get("d1") || [];
  assert.equal(dematRows.length, EQUITIES.length);
  assert.equal(dematRows.some((row) => /^INF/i.test(row.isin)), false);

  const folioRows = ["f1", "f2", "f3"].map((id) => byAsset.get(id) || []);
  for (const rows of folioRows) assert.equal(rows.length, 1);
  assert.deepEqual(folioRows.map((rows) => rows[0].isin),
    [ISIN_ADITYA, ISIN_AXIS, ISIN_MIRAE]);

  const written = [...byAsset.values()].flat();
  assert.equal(valueOf(written), parsed.printedTotalPaise);
  assert.equal(route.homeless.length, 0);
});

test("a live fund row with no printed folio never falls into the demat", () => {
  const parsed = {
    depository: "NSDL",
    demat: DEMAT,
    accounts: [{ boId: DEMAT, dpName: "NSDL", holdings: [
      { isin: "INE000000101", kind: "equity", valuePaise: 1000, quantity: 1 },
      { isin: "INF000000999", kind: "mf", valuePaise: 2000, quantity: 5 },
    ] }],
    holdings: [],
    transactions: [],
  };
  const route = casRoute(parsed, assets);
  const demat = route.groups.filter((group) => group.assetId === "d1");
  assert.equal(demat.reduce((total, group) => total + group.count, 0), 1);
  assert.equal(route.groups.some((group) => group.kind === "mf"), false);
  assert.equal(route.homeless.some((group) => group.kind === "mf"), true);
});

test("a fund row already stored in a demat is named with both amounts", () => {
  const demat = { id: "d1", label: "Demat · NSDL", category: "demat",
    subtype: "equity", number: DEMAT };
  const folio = assets[1];
  const rows = [
    { security_id: ISIN_AXIS, quantity: 3000, value_paise: 31715234 },
    { security_id: "INE000000101", quantity: 10, value_paise: 1000000 },
  ];
  const duplicates = duplicateFundPositions(demat, rows,
    [{ account: demat, holdings: rows }, { account: folio,
      holdings: [{ security_id: ISIN_AXIS, quantity: 3000, value_paise: 31357941 }] }]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].isin, ISIN_AXIS);
  assert.equal(duplicates[0].dematPaise, 31715234);
  assert.equal(duplicates[0].folioPaise, 31357941);
  const gap = importAccountGaps(demat, rows, (value) => value, TODAY, {
    accounts: [{ account: demat, holdings: rows }, { account: folio,
      holdings: [{ security_id: ISIN_AXIS, quantity: 3000, value_paise: 31357941 }] }],
  });
  const line = gap.gaps.find((item) => item.kind === "duplicate-fund");
  assert.ok(line, "the demat's gap line names the duplicate");
  assert.match(line.text, /3,17,152\.34/);
  assert.match(line.text, /3,13,579\.41/);
});

test("a demat with a BO ID is an account, not a folio, whatever its subtype says", () => {
  assert.equal(isFundAccount({ category: "demat", subtype: "mutual fund",
    number: DEMAT }), false);
  assert.equal(isFundAccount({ category: "demat", subtype: "mutual fund",
    number: FOLIO_AXIS }), true);
  assert.equal(isFundAccount({ category: "demat", subtype: "mutual fund" }), true);
});

test("an old demat fund duplicate is a would-drop, never a silent delete", () => {
  const existing = [{ security_id: ISIN_AXIS, label: "TEST AXIS ELSS",
    category: "mf", quantity: 3000, value_paise: 31715234 }];
  const parsed = { holdings: [{ valuePaise: 1000 }], printedTotalPaise: 1000,
    counts: { quarantined: 0 }, transactions: [] };
  const preview = casReplacePlan({ parsed, existing, holdings: [], asOf: TODAY,
    confirmed: false, assetId: "d1" });
  assert.equal(preview.preserveAbsent, true);
  assert.equal(preview.wouldDrop.length, 1);
  assert.equal(preview.wouldDrop[0].isin, ISIN_AXIS);
  assert.equal(preview.wouldDrop[0].value_paise, 31715234);
});

test("a zero-unit folio history row still stays with the demat", () => {
  const parsed = {
    depository: "NSDL",
    demat: DEMAT,
    accounts: [{ boId: DEMAT, holdings: [
      { isin: ISIN_MIRAE, kind: "mf", valuePaise: 0, quantity: 0,
        folio: FOLIO_MIRAE },
    ] }],
    holdings: [],
    transactions: [],
  };
  const route = casRoute(parsed, assets);
  assert.equal(route.groups.find((group) => group.kind === "mf").assetId, "d1");
  assert.equal(normalizeFolio(FOLIO_MIRAE), FOLIO_MIRAE);
});
