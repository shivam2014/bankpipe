import test from "node:test";
import assert from "node:assert/strict";
import { parseCas, casTotals, casRoute, cleanFundLabel, fundHouseFromLabel, fullAmcName, shortAmcName,
  numericColumns } from "./cas.js";
import { normalizeFolio } from "./folio.js";

test("the bond row's columns are checked by arithmetic, not position alone", () => {
  // TESTD: 2 × 30,000 = 60,000.
  assert.deepEqual(numericColumns(["2", "1,00,000.00", "30,000.00", "60,000.00"]),
    { ok: true, qty: 2, face: 100000, price: 30000, value: 60000 });
  // An equity row has no face column: 80 × 592.50 = 47,400.
  assert.deepEqual(numericColumns(["80", "592.50", "47,400.00"]),
    { ok: true, qty: 80, face: null, price: 592.5, value: 47400 });
  // A row with quantity and total only still reads; no per-unit guess.
  assert.deepEqual(numericColumns(["10", "98,150.00"]),
    { ok: true, qty: 10, face: null, price: null, value: 98150 });
  // Numbers that do not multiply are refused, so a wrapped cell cannot pass.
  assert.equal(numericColumns(["1", "2", "3", "4"]).ok, false);
  assert.equal(numericColumns(["one", "two"]).ok, false);
});

test("a fund name stops before the expense-ratio paragraph", () => {
  assert.equal(cleanFundLabel("TestOne Asset Cash Management Fund ) - Grand Total Average Total Expense Ratio above represents the average of annualized total expense charged in the respective schemes during the half-year period within"), "TestOne Asset Cash Management Fund");
  assert.equal(cleanFundLabel("TestOne Asset Large and Midcap Fund Fund) - Regular Plan"),
    "TestOne Asset Large and Midcap Fund - Regular Plan");
  assert.equal(cleanFundLabel("Test Four Flexi Cap Fund - Direct Plan - Growth"),
    "Test Four Flexi Cap Fund - Direct Plan - Growth");
  assert.equal(cleanFundLabel("Test Three Large Cap Fund - Growth-Regular Plan(formerly known as Test Three Frontline Equity Fund"),
    "Test Three Large Cap Fund - Growth-Regular Plan");
});

test("the AMC is the prefix before the first scheme word", () => {
  assert.equal(fundHouseFromLabel("TestOne Asset Cash Management Fund"), "TestOne Asset Mutual Fund");
  assert.equal(fundHouseFromLabel("TestOne Asset Large and Midcap Fund - Regular Plan"),
    "TestOne Asset Mutual Fund");
  assert.equal(fundHouseFromLabel("TestTwo ELSS- Tax Saver Fund - Regular Growth"),
    "TestTwo Mutual Fund");
  assert.equal(fundHouseFromLabel("Test Three Large Cap Fund - Growth-Regular Plan"),
    "Test Three Mutual Fund");
  assert.equal(fullAmcName("Test Three Mutual"), "Test Three Mutual Fund");
  assert.equal(shortAmcName("TestOne Asset Mutual Fund"), "TestOne Asset");
  assert.equal(shortAmcName("TestTwo Mutual Fund"), "TestTwo");
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
  line([60, "INE999900272"], [430, "27-Nov-2028"], [600, "10.00"], [660, "10,000.00"],
    [730, "10,075.26"], [800, "1,00,752.60"]),
  line([200, "B.N. TESTAGRI LIMITED"], [380, "9.75"]),
  line([200, "Fixed Interest Bonds"]),
];
const bondB = [
  line([200, "TEST POWER GENERATION PRIVATE LIMITED"], [380, "9.25"]),
  line([60, "INE000000011"], [430, "07-Oct-2029"], [600, "20.00"], [660, "10,000.00"],
    [730, "9,899.00"], [800, "1,97,980.00"]),
  line([200, "Fixed Interest Bonds"]),
];

test("a bond row is read even when its ISIN sits on the third line", () => {
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), bondA, bondB,
  ])] });
  assert.equal(out.holdings.length, 2);
  const [a, b] = out.holdings;
  assert.equal(a.isin, "INE999900272");
  assert.equal(a.quantity, 10);
  assert.equal(a.faceValuePaise, 1000000);
  assert.equal(a.valuePaise, 10075260);
  assert.equal(a.maturity, "2028-11-27");
  assert.equal(b.isin, "INE000000011");
  assert.equal(b.quantity, 20);
  assert.equal(b.kind, "bond");
  assert.equal(a.couponPct, 9.75);
  assert.equal(b.couponPct, 9.25);
});

test("a fund's invested is the Total Cost column, not the NAV", () => {
  const header = line([40, "ISIN"], [110, "Scheme Name"], [300, "Folio No."],
    [360, "No. of Units"], [430, "Average Cost Per Unit"], [500, "Total Cost"],
    [560, "NAV per unit"], [620, "Value in (₹)"]);
  const row = line([40, "INF999900303"], [110, "TestTwo ELSS- Tax Saver Fund - Regular Growth"],
    [300, "99990000001"], [360, "3,384.424"], [430, "70.9195"], [500, "2,40,021.76"],
    [560, "92.6537"], [620, "3,13,579.41"]);
  const out = parseCas({ pages: [page([[header], [row]])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].costPaise, 24002176);
  assert.equal(out.holdings[0].valuePaise, 31357941);
  assert.equal(out.holdings[0].amc, "TestTwo");
  assert.equal(out.holdings[0].amcFull, "TestTwo Mutual Fund");
});

test("an NSDL Current Value column is read for a zero-unit fund row", () => {
  const header = line([40, "ISIN"], [110, "Scheme Name"], [300, "Folio No."],
    [360, "No. of Units"], [430, "Total Cost"], [520, "Current Value"],
    [620, "Profit/(Loss)"]);
  const row = line([40, "INF999900303"],
    [110, "TestTwo ELSS- Tax Saver Fund - Regular Growth"], [300, "99990000001"],
    [360, "0.000"], [430, "2,40,021.76"], [520, "3,13,579.41"], [620, "73,557.65"]);
  const out = parseCas({ pages: [page([[header], [row]])] });
  assert.equal(out.holdings.length, 1);
  const holding = out.holdings[0];
  assert.equal(holding.folio, "99990000001");
  assert.equal(holding.quantity, 0);
  assert.equal(holding.costPaise, 24002176);
  assert.equal(holding.valuePaise, 31357941);
});

test("an NSDL Current / Value in heading reads the value for a zero-unit row", () => {
  // The real header stacks the two words: "Current" above "Value in".
  const header = [
    line([40, "ISIN"], [110, "Scheme Name"], [300, "Folio No."], [360, "No. of Units"],
      [430, "Total Cost"], [497, "Current"], [543, "Profit/(Loss)"]),
    line([491, "Value in"]),
  ];
  const row = line([40, "INF999900303"],
    [110, "TestTwo ELSS- Tax Saver Fund - Regular Growth"], [300, "99990000001"],
    [360, "0.000"], [430, "2,40,021.76"], [520, "3,13,579.41"], [620, "73,557.65"]);
  const out = parseCas({ pages: [page([header, [row]])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].costPaise, 24002176);
  assert.equal(out.holdings[0].valuePaise, 31357941);
});

test("two folios holding the same ISIN are two positions, not one", () => {
  const header = line([40, "ISIN"], [110, "Scheme Name"], [300, "Folio No."],
    [360, "No. of Units"], [430, "Average Cost Per Unit"], [500, "Total Cost"],
    [560, "NAV per unit"], [620, "Value in (₹)"]);
  const fund = (folio, units, avg, total, nav, value) => line(
    [40, "INF999900303"], [110, "TestTwo ELSS- Tax Saver Fund - Regular Growth"],
    [300, folio], [360, units], [430, avg], [500, total], [560, nav], [620, value]);
  const out = parseCas({ pages: [page([
    [header],
    [fund("111/1", "1,000.000", "70.0000", "70,000.00", "80.0000", "80,000.00")],
    [fund("222/2", "2,000.000", "60.0000", "1,20,000.00", "65.0000", "1,30,000.00")],
  ])] });
  assert.equal(out.holdings.length, 2);
  const byFolio = new Map(out.holdings.map((holding) => [holding.folio, holding]));
  assert.equal(byFolio.get("111/1").costPaise, 7000000);
  assert.equal(byFolio.get("111/1").valuePaise, 8000000);
  assert.equal(byFolio.get("222/2").costPaise, 12000000);
  assert.equal(byFolio.get("222/2").valuePaise, 13000000);
});

test("a repeated row without a folio still collapses to one position", () => {
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"), bondA,
  ]), page([
    heading("Corporate Bonds"), bondA,
  ])] });
  assert.equal(out.holdings.length, 1);
});

test("a fund's invested uses the Cumulative Amount Invested column", () => {
  const header = line([40, "ISIN"], [110, "Scheme Name"], [300, "Folio No."],
    [360, "Closing Bal (Units)"], [430, "NAV"], [500, "Cumulative Amount Invested (INR)"],
    [620, "Valuation"]);
  const row = line([40, "INF000000013"], [110, "TestOne Asset Cash Management Fund"],
    [300, "99990000002"], [360, "109.932"], [430, "2952.1523"], [500, "3,00,000.00"],
    [620, "3,24,536.01"]);
  const total = line([500, "3,00,000.00"], [620, "3,24,536.01"]);
  const out = parseCas({ pages: [page([[header], [row], [total]])] });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].costPaise, 30000000);
  assert.equal(out.holdings[0].valuePaise, 32453601);
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
  const equity = [line([60, "INE000000015"], [200, "TEST MOTORS INDIA LTD"],
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
  const broken = [line([60, "INE000000014"], [200, "TEST STATE CAPITAL"],
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
    [line([60, "INE000000015"], [200, "TEST MOTORS INDIA LTD"], [600, "5.00"],
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

test("the printed grand total is exposed for the safety check", () => {
  const total = line([500, "Grand Total"], [620, "4,00,000.00"]);
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"),
    [line([60, "INE999900272"], [430, "27-Nov-2028"], [600, "10.00"],
      [660, "10,000.00"], [730, "10,075.26"], [800, "1,00,752.60"])],
    [total],
  ])] });
  assert.equal(out.printedTotalPaise, 40000000);
});

test("a statement without a grand total leaves the check unstated", () => {
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"),
    [line([60, "INE999900272"], [430, "27-Nov-2028"], [600, "10.00"],
      [660, "10,000.00"], [730, "10,075.26"], [800, "1,00,752.60"])],
  ])] });
  assert.equal(out.printedTotalPaise, null);
});

test("the first Grand Total is the portfolio, not a later section total", () => {
  // A CDSL transaction statement prints the portfolio Grand Total on its
  // summary page and a second one inside a mutual fund folio section.
  const out = parseCas({ pages: [page([
    heading("Corporate Bonds"),
    [line([500, "Grand Total"], [620, "36,56,296.47"])],
    [line([60, "INE999900272"], [430, "27-Nov-2028"], [600, "10.00"],
      [660, "10,000.00"], [730, "10,075.26"], [800, "1,00,752.60"])],
    [line([500, "Grand Total"], [620, "3,24,536.01"])],
  ])] });
  assert.equal(out.printedTotalPaise, 365629647);
});

// --- routing into the accounts already on file -----------------------------

const accounts = [
  { id: "b1", label: "Bonds · portfolio 1", category: "bonds",
    number: "IN99990001344321" },
  { id: "d1", label: "Demat · ICICI", category: "demat",
    number: "IN99990001344321" },
  { id: "m1", label: "TestTwo mutual fund", category: "demat", subtype: "mutual fund",
    number: "IN99990001344321" },
  { id: "x1", label: "Bonds · someone else", category: "bonds",
    number: "1200000012345678" },
];

const parsed = {
  demat: "IN99990001344321",
  holdings: [
    { isin: "INE999900272", kind: "bond", valuePaise: 100 },
    { isin: "INE000000016", kind: "bond", valuePaise: 200 },
    { isin: "INE000000015", kind: "equity", valuePaise: 50 },
    { isin: "INF000000011", kind: "mf", valuePaise: 70 },
  ],
};

test("every class lands in the one demat account the statement names", () => {
  const route = casRoute(parsed, accounts);
  assert.equal(route.demat, "IN99990001344321");
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

// --- a folio is identified by its number, not its AMC -----------------------

test("a folio routes to its folio account, not into the demat", () => {
  const parsed = {
    depository: "CDSL",
    demat: "1200000012345678",
    accounts: [{
      boId: "1200000012345678", dpName: "MOTILAL OSWAL FINANCIAL SERVICES LIMITED",
      holdings: [
        { isin: "INE000000001", kind: "bond", valuePaise: 100 },
        { isin: "INF999900287", kind: "mf", valuePaise: 200, quantity: 10, folio: "123/4", amc: "TestOne" },
      ],
    }],
    holdings: [
      { isin: "INE000000001", kind: "bond", valuePaise: 100 },
      { isin: "INF999900287", kind: "mf", valuePaise: 200, quantity: 10, folio: "123/4", amc: "TestOne" },
    ],
  };
  const withFolio = [
    { id: "d1", label: "Demat · Motilal · …5678", category: "demat",
      number: "1200000012345678" },
    { id: "m1", label: "TestOne mutual fund", category: "demat", subtype: "mutual fund",
      number: "123/4", meta: JSON.stringify({ folios: ["123/4"] }) },
  ];
  const route = casRoute(parsed, withFolio);
  assert.equal(route.groups.find((g) => g.kind === "bond").assetId, "d1");
  assert.equal(route.groups.find((g) => g.kind === "mf").assetId, "m1");

  // With no AMC account the folio is homeless, and its AMC travels with it.
  const route2 = casRoute(parsed, [withFolio[0]]);
  const folio = route2.homeless.find((g) => g.kind === "mf");
  assert.equal(folio.amc, "TestOne");
  assert.equal(folio.folio, true);
});

test("two folios of one AMC never merge, and a third folio is a new position", () => {
  const demat = "IN99990001344321";
  const row = (folio, isin) => ({ isin, kind: "mf", valuePaise: 100, quantity: 10,
    folio, amc: "TestOne" });
  const parsed = {
    depository: "NSDL",
    demat,
    accounts: [{ boId: demat, dpName: "NSDL", holdings: [
      row("123/4", "INF000000001"),
      row("567/8", "INF999900287"),
      row("999/0", "INF000000003"),
    ] }],
    holdings: [],
  };
  const accountsWithFolios = [
    { id: "d1", label: "Demat · NSDL", category: "demat", number: demat },
    { id: "m1", label: "TestOne mutual fund", category: "demat", subtype: "mutual fund",
      number: "123/4", meta: JSON.stringify({ folios: ["123/4"] }) },
    { id: "m2", label: "TestOne mutual fund", category: "demat", subtype: "mutual fund",
      number: "567/8", meta: JSON.stringify({ folios: ["567/8"] }) },
  ];
  const route = casRoute(parsed, accountsWithFolios);
  const byFolio = new Map(route.groups.map((group) => [group.folioNo, group]));
  assert.equal(byFolio.get("123/4").assetId, "m1");
  assert.equal(byFolio.get("567/8").assetId, "m2");
  assert.equal(route.groups.length, 2);
  const third = route.homeless.find((group) => group.folio && group.folioNo === "999/0");
  assert.ok(third, "a folio that matches no account is homeless");
  assert.equal(third.assetId, "");
});

test("an exact folio match survives an AMC rename", () => {
  const parsed = {
    demat: "IN99990001344321",
    accounts: [{ boId: "IN99990001344321", holdings: [
      { isin: "INF000000001", kind: "mf", valuePaise: 100, quantity: 10,
        folio: "123/4", amc: "Old House" },
    ] }],
    holdings: [],
  };
  const renamed = [
    { id: "m1", label: "Renamed House mutual fund", category: "demat",
      subtype: "mutual fund", number: "123/4",
      meta: JSON.stringify({ folios: ["123/4"] }) },
  ];
  const route = casRoute(parsed, renamed);
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].assetId, "m1");
  assert.equal(route.groups[0].folioNo, "123/4");
});

test("a folio printed with soft hyphens or zero-width spaces still matches", () => {
  assert.equal(normalizeFolio("123\u00AD/4\u200B"), "123/4");
  const demat = "IN99990001344321";
  const parsed = {
    demat,
    accounts: [{ boId: demat, holdings: [
      { isin: "INF000000001", kind: "mf", valuePaise: 100, quantity: 10,
        folio: "123\u00AD/4\u200B", amc: "TestOne" },
    ] }],
    holdings: [],
  };
  const accounts = [
    { id: "m1", label: "TestOne mutual fund", category: "demat",
      subtype: "mutual fund", number: "123/4",
      meta: JSON.stringify({ folios: ["123/4"] }) },
  ];
  const route = casRoute(parsed, accounts);
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].assetId, "m1");
});

test("two AMCs sharing a folio are two homeless positions", () => {
  const demat = "IN99990001344321";
  const row = (amc, isin) => ({ isin, kind: "mf", valuePaise: 100, quantity: 10,
    folio: "123/4", amc });
  const parsed = {
    demat,
    accounts: [{ boId: demat, holdings: [
      row("AMC One", "INF000000001"),
      row("AMC Two", "INF999900287"),
    ] }],
    holdings: [],
  };
  const route = casRoute(parsed, [
    { id: "d1", label: "Demat · NSDL", category: "demat", number: demat },
  ]);
  const folios = route.homeless.filter((group) => group.folio);
  assert.equal(folios.length, 2);
  assert.deepEqual(folios.map((group) => group.amc).sort(), ["AMC One", "AMC Two"]);
});

test("a shared folio routes to the account of its own AMC", () => {
  const demat = "IN99990001344321";
  const row = (amc, isin) => ({ isin, kind: "mf", valuePaise: 100, quantity: 10,
    folio: "123/4", amc });
  const parsed = {
    demat,
    accounts: [{ boId: demat, holdings: [
      row("AMC One", "INF000000001"),
      row("AMC Two", "INF999900287"),
    ] }],
    holdings: [],
  };
  const accounts = [
    { id: "one", label: "AMC One mutual fund", category: "demat",
      subtype: "mutual fund", number: "123/4",
      meta: JSON.stringify({ amc: "AMC One", folios: ["123/4"] }) },
    { id: "two", label: "AMC Two mutual fund", category: "demat",
      subtype: "mutual fund", number: "123/4",
      meta: JSON.stringify({ amc: "AMC Two", folios: ["123/4"] }) },
  ];
  const route = casRoute(parsed, accounts);
  assert.equal(route.groups.find((group) => group.amc === "AMC One").assetId, "one");
  assert.equal(route.groups.find((group) => group.amc === "AMC Two").assetId, "two");
});

test("an exact folio under a renamed AMC is still the home", () => {
  const demat = "IN99990001344321";
  const parsed = {
    demat,
    accounts: [{ boId: demat, holdings: [
      { isin: "INF000000001", kind: "mf", valuePaise: 100, quantity: 10,
        folio: "123/4", amc: "AMC Two" },
    ] }],
    holdings: [],
  };
  const accounts = [
    { id: "one", label: "AMC One mutual fund", category: "demat",
      subtype: "mutual fund", number: "123/4",
      meta: JSON.stringify({ amc: "AMC One", folios: ["123/4"] }) },
  ];
  const route = casRoute(parsed, accounts);
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].assetId, "one");
  assert.equal(route.groups[0].folioNo, "123/4");
  assert.equal(route.homeless.length, 0);
});

test("a folio without units stays in the demat until it is complete", () => {
  const parsed = {
    depository: "NSDL",
    demat: "IN99990001344321",
    accounts: [{
      boId: "IN99990001344321", dpName: "NSDL",
      holdings: [{ isin: "INF000000009", kind: "mf", valuePaise: 900, folio: "9/9", amc: "TestTwo" }],
    }],
    holdings: [],
  };
  const route = casRoute(parsed, [
    { id: "d1", label: "Demat · NSDL", category: "demat", number: "IN99990001344321" },
  ]);
  assert.equal(route.groups.find((g) => g.kind === "mf").assetId, "d1");
  assert.equal(route.homeless.length, 0);
});
