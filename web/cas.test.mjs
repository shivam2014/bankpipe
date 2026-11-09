import test from "node:test";
import assert from "node:assert/strict";
import { parseCas, casTotals, casRoute, cleanFundLabel } from "./cas.js";

test("a fund name stops before the expense-ratio paragraph", () => {
  assert.equal(cleanFundLabel("Mirae Asset Cash Management Fund ) - Grand Total Average Total Expense Ratio above represents the average of annualized total expense charged in the respective schemes during the half-year period within"), "Mirae Asset Cash Management Fund");
  assert.equal(cleanFundLabel("Mirae Asset Large and Midcap Fund Fund) - Regular Plan"),
    "Mirae Asset Large and Midcap Fund - Regular Plan");
  assert.equal(cleanFundLabel("Parag Parikh Flexi Cap Fund - Direct Plan - Growth"),
    "Parag Parikh Flexi Cap Fund - Direct Plan - Growth");
});

// A synthetic page laid out like a depository statement: one heading line, then
// a block of lines per holding. Fields sit at fixed x; the ISIN is printed on a
// different line of the block each time, which is what breaks a parser that
// reads rows line by line.
const line = (...cells) => cells;
const heading = (str) => [line([200, str])];
const page = (rows) => {
  const items = [];
  let y = 800;
  for (const row of rows) {
    for (let n = 0; n < row.length; n++) {
      for (const [x, str] of row[n]) items.push({ str, x, y: y - n * 15 });
    }
    y -= 60;
  }
  return { items };
};

const bondA = [
  line([60, "INE999900033"], [430, "27-Nov-2028"], [600, "10.00"], [660, "10,000.00"],
    [730, "10,075.26"], [800, "1,00,752.60"]),
  line([200, "B.N. AGRITECH LIMITED"], [380, "9.75"]),
  line([200, "Fixed Interest Bonds"]),
];
const bondB = [
  line([200, "OPG POWER GENERATION PRIVATE LIMITED"], [380, "9.25"]),
  line([60, "INE999900058"], [430, "07-Oct-2029"], [600, "20.00"], [660, "10,000.00"],
    [730, "9,899.00"], [800, "1,97,980.00"]),
  line([200, "Fixed Interest Bonds"]),
];

test("a bond row is read even when its ISIN sits on the third line", () => {
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), bondA, bondB,
  ])] });
  assert.equal(out.holdings.length, 2);
  const [a, b] = out.holdings;
  assert.equal(a.isin, "INE999900033");
  assert.equal(a.quantity, 10);
  assert.equal(a.faceValuePaise, 1000000);
  assert.equal(a.valuePaise, 10075260);
  assert.equal(a.maturity, "2028-11-27");
  assert.equal(b.isin, "INE999900058");
  assert.equal(b.quantity, 20);
  assert.equal(b.kind, "bond");
  assert.equal(a.couponPct, 9.75);
  assert.equal(b.couponPct, 9.25);
});

test("the Depository is named from the statement, not guessed", () => {
  const cdsl = page([heading("Central Depository Services (India) Limited"),
    heading("Corporate Bonds"), bondA]);
  assert.equal(parseCas({ pages: [cdsl] }).depository, "CDSL");
  const nsdl = page([heading("National Securities Depository Limited"),
    heading("Corporate Bonds"), bondA]);
  assert.equal(parseCas({ pages: [nsdl] }).depository, "NSDL");
});

test("an equity row with no maturity date is still read", () => {
  const equity = [line([60, "INE999900041"], [200, "MARUTI SUZUKI INDIA LTD"],
    [600, "5.00"], [660, "5"], [730, "11,672.00"], [800, "58,360.00"])];
  const out = parseCas({ pages: [page([
    heading("Equity Shares"), equity,
  ])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].kind, "equity");
  assert.equal(out.holdings[0].quantity, 5);
  assert.equal(out.holdings[0].valuePaise, 5836000);
});

test("a row with one number is quarantined, never guessed", () => {
  const broken = [line([60, "INE999900074"], [200, "ANDHRA PRADESH CAPITAL"],
    [800, "50,150.50"])];
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), broken,
  ])] });
  assert.equal(out.holdings.length, 0);
  assert.equal(out.counts.quarantined, 1);
});

test("a heading split across two items still starts a section", () => {
  // "Equity" and "Shares" arrive as separate items on the same line.
  const split = [
    [line([200, "Equity"], [260, "Shares"])],
    [line([60, "INE999900041"], [200, "MARUTI SUZUKI INDIA LTD"], [600, "5.00"],
      [660, "5"], [730, "11,672.00"], [800, "58,360.00"])],
  ];
  const out = parseCas({ pages: [page(split)] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].kind, "equity");
});

test("a page with no ISIN reports nothing instead of inventing rows", () => {
  const out = parseCas({ pages: [page([heading("Corporate Bonds")])] });
  assert.equal(out.holdings.length, 0);
  assert.equal(out.counts.rows, 0);
});

test("the rows must add up to the total the statement prints", () => {
  const parsed = { holdings: [{ valuePaise: 100 }, { valuePaise: 250 }] };
  assert.equal(casTotals(parsed, 350).ok, true);
  const bad = casTotals(parsed, 400);
  assert.equal(bad.ok, false);
  assert.equal(bad.diffPaise, -50);
});

test("an unstated total is not a failure", () => {
  const res = casTotals({ holdings: [{ valuePaise: 100 }] }, null);
  assert.equal(res.ok, true);
  assert.equal(res.diffPaise, null);
});

// --- routing into the accounts already on file -----------------------------

const accounts = [
  { id: "b1", label: "Bonds · portfolio 1", category: "bonds",
    number: "IN99990009183122" },
  { id: "d1", label: "Demat · ICICI", category: "demat",
    number: "IN99990009183122" },
  { id: "m1", label: "Axis mutual fund", category: "demat", subtype: "mutual fund",
    number: "IN99990009183122" },
  { id: "x1", label: "Bonds · someone else", category: "bonds",
    number: "9999000001140907" },
];

const parsed = {
  demat: "IN99990009183122",
  holdings: [
    { isin: "INE999900033", kind: "bond", valuePaise: 100 },
    { isin: "INE999900082", kind: "bond", valuePaise: 200 },
    { isin: "INE999900041", kind: "equity", valuePaise: 50 },
    { isin: "INF999900345", kind: "mf", valuePaise: 70 },
  ],
};

test("every class lands in the one demat account the statement names", () => {
  const route = casRoute(parsed, accounts);
  assert.equal(route.demat, "IN99990009183122");
  assert.equal(route.groups.length, 3);
  for (const group of route.groups) assert.equal(group.assetId, "d1");
  assert.equal(route.homeless.length, 0);
});

test("a fund lands in the demat account, not a folio guess", () => {
  const route = casRoute(parsed, accounts);
  assert.equal(route.groups.find((g) => g.kind === "mf").assetId, "d1");
});

test("with no demat account every class is reported, none is written", () => {
  const route = casRoute(parsed, [accounts[0]]);
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.reduce((t, g) => t + g.count, 0), 4);
});

test("a different demat on file is never written to", () => {
  const route = casRoute(parsed, accounts);
  assert.equal(route.groups.some((g) => g.assetId === "x1"), false);
});

test("a class with no account is reported, not forced into another", () => {
  const route = casRoute(parsed, [accounts[1]]);
  assert.equal(route.groups.length, 3);
  assert.equal(route.homeless.length, 0);
});

test("an unreadable account number routes nowhere", () => {
  const route = casRoute({ demat: "", holdings: parsed.holdings }, accounts);
  assert.equal(route.accounts.length, 0);
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.reduce((t, g) => t + g.count, 0), 4);
});

// --- folios belong to an AMC, not to a demat ---------------------------------

test("a folio routes to its AMC account, not into the demat", () => {
  const parsed = {
    depository: "CDSL",
    demat: "9999000001140907",
    accounts: [{
      boId: "9999000001140907", dpName: "MOTILAL OSWAL FINANCIAL SERVICES LIMITED",
      holdings: [
        { isin: "INE000000001", kind: "bond", valuePaise: 100 },
        { isin: "INF999900287", kind: "mf", valuePaise: 200, quantity: 10, folio: "123/4", amc: "Mirae" },
      ],
    }],
    holdings: [
      { isin: "INE000000001", kind: "bond", valuePaise: 100 },
      { isin: "INF999900287", kind: "mf", valuePaise: 200, quantity: 10, folio: "123/4", amc: "Mirae" },
    ],
  };
  const withFolio = [
    { id: "d1", label: "Demat · Motilal · …0907", category: "demat",
      number: "9999000001140907" },
    { id: "m1", label: "Mirae mutual fund", category: "demat", subtype: "mutual fund" },
  ];
  const route = casRoute(parsed, withFolio);
  assert.equal(route.groups.find((g) => g.kind === "bond").assetId, "d1");
  assert.equal(route.groups.find((g) => g.kind === "mf").assetId, "m1");

  // With no AMC account the folio is homeless, and its AMC travels with it.
  const route2 = casRoute(parsed, [withFolio[0]]);
  const folio = route2.homeless.find((g) => g.kind === "mf");
  assert.equal(folio.amc, "Mirae");
  assert.equal(folio.folio, true);
});

test("a folio without units stays in the demat until it is complete", () => {
  const parsed = {
    depository: "NSDL",
    demat: "IN99990009183122",
    accounts: [{
      boId: "IN99990009183122", dpName: "NSDL",
      holdings: [{ isin: "INF000000009", kind: "mf", valuePaise: 900, folio: "9/9", amc: "Axis" }],
    }],
    holdings: [],
  };
  const route = casRoute(parsed, [
    { id: "d1", label: "Demat · NSDL", category: "demat", number: "IN99990009183122" },
  ]);
  assert.equal(route.groups.find((g) => g.kind === "mf").assetId, "d1");
  assert.equal(route.homeless.length, 0);
});
