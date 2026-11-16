import { test } from "node:test";
import assert from "node:assert/strict";
import { bondHoldingsCsv, BOND_CSV_HEADERS } from "./bond-csv.js";
import { parseCsv } from "./digifinn.js";
import { parseHoldingsMatrix } from "./holding-import.js";

const row = {
  security_id: "INE000000012",
  label: "10.00% TESTA 18 AUG 2028",
  rating: "AA",
  frequency: "Monthly Payout",
  yield_bps: 1074,
  payout_paise: 246575,
  quantity: 30,
  cost_paise: 29949658,
  value_paise: null,
  purchase_date: "2026-08-21",
  interest_date: "2026-10-18",
};

test("bond CSV exports the standard columns", () => {
  const csv = bondHoldingsCsv([row]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], BOND_CSV_HEADERS.join(","));
  assert.match(lines[1], /INE000000012/);
  assert.match(lines[1], /,AA,/);
  assert.match(lines[1], /,10\.74,/);
  assert.match(lines[1], /,Monthly Payout,/);
  assert.match(lines[1], /,299496\.58,,2465\.75/);
});

test("bond CSV round-trips through the holdings importer", () => {
  const csv = bondHoldingsCsv([row]);
  const parsed = parseHoldingsMatrix(parseCsv(csv));
  assert.equal(parsed.rows.length, 1);
  const h = parsed.rows[0];
  assert.equal(h.security_id, "INE000000012");
  assert.equal(h.label, "10.00% TESTA 18 AUG 2028");
  assert.equal(h.rating, "AA");
  assert.equal(h.frequency, "Monthly Payout");
  assert.equal(h.yield_bps, 1074);
  assert.equal(h.payout_paise, 246575);
  assert.equal(h.quantity, 30);
  assert.equal(h.cost_paise, 29949658);
  assert.equal(h.value_paise, null);
  assert.equal(h.purchase_date, "2026-08-21");
  assert.equal(h.interest_date, "2026-10-18");
});

test("a coupon-only dashed label keeps its coupon in the CSV", () => {
  // parseBondLabel now returns the rate even when the name carries no date.
  // The exporter can use it; the label column still preserves the source.
  const csv = bondHoldingsCsv([{ ...row, label: "TESTD-11.90%-PVT",
    cost_paise: null, quantity: 2 }]);
  const matrix = parseCsv(csv);
  assert.equal(matrix[1][1], "TESTD-11.90%-PVT");
  assert.equal(matrix[1][3], "11.9");
  const parsed = parseHoldingsMatrix(matrix);
  assert.equal(parsed.rows[0].label, "TESTD-11.90%-PVT");
});

test("bond CSV quotes labels with commas and keeps a real market value", () => {
  const priced = { ...row, label: "13.00% TESTB, SERIES II 19 DEC 2028",
    value_paise: 31000000 };
  const csv = bondHoldingsCsv([priced]);
  assert.match(csv, /"13\.00% TESTB, SERIES II 19 DEC 2028"/);
  const parsed = parseHoldingsMatrix(parseCsv(csv));
  assert.equal(parsed.rows[0].label, "13.00% TESTB, SERIES II 19 DEC 2028");
  assert.equal(parsed.rows[0].value_paise, 31000000);
});

test("a CAS statement figure is not exported as Current Value", () => {
  const cas = { ...row, value_source: "CAS", value_paise: 31000000 };
  const parsed = parseHoldingsMatrix(parseCsv(bondHoldingsCsv([cas])));
  assert.equal(parsed.rows[0].value_paise, null);
  const bse = { ...row, value_source: "BSE", value_paise: 31000000 };
  const market = parseHoldingsMatrix(parseCsv(bondHoldingsCsv([bse])));
  assert.equal(market.rows[0].value_paise, 31000000);
});

test("blank cost, yield and payout are blank cells, not zero", () => {
  const blank = { ...row, cost_paise: "", yield_bps: "", payout_paise: "",
    value_paise: "" };
  const parsed = parseHoldingsMatrix(parseCsv(bondHoldingsCsv([blank])));
  assert.equal(parsed.rows[0].cost_paise, null);
  assert.equal(parsed.rows[0].value_paise, null);
  assert.equal(parsed.rows[0].payout_paise, null);
  assert.equal(parsed.rows[0].yield_bps, null);
});

test("bond CSV neutralises every spreadsheet formula prefix", () => {
  // A label is free text and comes from a broker export, so any of the four
  // triggers would run as a formula when the file is opened in Excel.
  for (const prefix of ["=", "+", "-", "@"]) {
    const label = `${prefix}SUM(A1)`;
    const csv = bondHoldingsCsv([{ ...row, label }]);
    assert.ok(csv.includes(`,'${label},`),
      `${prefix} must be stored as text with an apostrophe`);
    assert.doesNotMatch(csv, new RegExp(`(^|,)${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}SUM`),
      `${prefix} must not start a cell`);
    const parsed = parseHoldingsMatrix(parseCsv(csv));
    assert.equal(parsed.rows[0].label, `'${label}`,
      "the round trip keeps the neutralising apostrophe");
  }
});
