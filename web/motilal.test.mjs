import test from "node:test";
import assert from "node:assert/strict";
import { parseMotilalPages, motilalHoldingPatch } from "./motilal.js";

const item = (str, x, y, width) => ({ str, x, y, width });
const page = (items) => ({ items });

function bondsPage() {
  return page([
    item("BONDS", 57, 800, 38),
    item("Last", 761, 775, 13),
    item("Type", 247, 772, 16),
    item("Coupon", 278, 771, 25),
    item("Interest", 323, 771, 26),
    item("Investment", 369, 771, 37),
    item("Avg", 440, 771, 13),
    item("Price", 454, 771, 17),
    item("Per", 472, 771, 11),
    item("Investment", 498, 771, 37),
    item("Market", 554, 771, 24),
    item("Price", 580, 771, 17),
    item("Market", 621, 771, 24),
    item("Maturity", 664, 771, 29),
    item("Principle", 710, 771, 29),
    item("Category", 62, 766, 30),
    item("ISIN", 120, 766, 14),
    item("Instrument", 180, 766, 36),
    item("Qty", 417, 766, 12),
    item("Price", 760, 766, 17),
    item("(%)", 285, 762, 10),
    item("Frequency", 319, 762, 34),
    item("Date", 380, 762, 16),
    item("Bond", 453, 762, 17),
    item("Amount", 503, 762, 26),
    item("Per", 560, 762, 11),
    item("Bond", 573, 762, 17),
    item("Value", 623, 762, 19),
    item("Date", 670, 762, 16),
    item("Maturity", 710, 762, 29),
    item("Rating", 245, 761, 21),
    item("Date", 760, 757, 16),
    item("DEBTR", 244, 743, 23),
    item("TESTD-11.90%-3-12-", 163, 742, 69),
    item("2026-", 664, 742, 19),
    item("INE000000023", 102, 738, 50),
    item("11.9000", 277, 738, 27),
    item("06 Jun", 369, 738, 34),
    item("MONTHLY", 314, 738, 36),
    item("2", 417, 738, 4),
    item("1,00,000.00", 440, 738, 38),
    item("2,00,000.00", 493, 738, 38),
    item("1,00,000.00", 549, 738, 38),
    item("2,00,000.00", 612, 738, 38),
    item("2,00,000.00", 703, 738, 38),
    item("26-PVT", 163, 734, 24),
    item("2024", 379, 734, 17),
    item("12-03", 664, 734, 19),
    item("DEBTR", 244, 718, 23),
    item("TESTE-11.4%-13-6-27-", 163, 717, 69),
    item("2027-", 664, 717, 19),
    item("INE000000024", 102, 713, 50),
    item("11.4000", 277, 713, 27),
    item("19 Jun", 369, 713, 34),
    item("MONTHLY", 314, 713, 36),
    item("2", 417, 713, 4),
    item("1,00,000.00", 440, 713, 38),
    item("2,00,000.00", 493, 713, 38),
    item("1,00,000.00", 549, 713, 38),
    item("2,00,000.00", 612, 713, 38),
    item("2,00,000.00", 703, 713, 38),
    item("PVT", 163, 709, 17),
    item("2024", 379, 709, 17),
    item("06-13", 664, 709, 19),
    item("Total", 62, 680, 26),
    item("27,90,855.51", 493, 680, 42),
  ]);
}

function equityPage() {
  return page([
    item("DIRECT EQUITY", 57, 800, 82),
    item("ISIN", 120, 766, 14),
    item("Instrument", 180, 766, 36),
    item("Qty", 417, 766, 12),
    item("Investment", 369, 771, 37),
    item("Date", 380, 762, 16),
    item("Avg", 440, 771, 13),
    item("Price", 454, 771, 17),
    item("Investment", 498, 771, 37),
    item("Amount", 503, 762, 26),
    item("Market", 554, 771, 24),
    item("Price", 580, 771, 17),
    item("Market", 621, 771, 24),
    item("Value", 623, 762, 19),
    item("INE000000015", 102, 738, 50),
    item("TEST MOTORS INDIA LTD", 163, 738, 130),
    item("10", 417, 738, 8),
    item("12 Feb 2024", 369, 738, 72),
    item("11,977.70", 440, 738, 38),
    item("1,19,777.00", 493, 738, 38),
    item("13,185.00", 549, 738, 38),
    item("1,31,850.00", 612, 738, 38),
  ]);
}

function mutualFundPage() {
  return page([
    item("MUTUAL FUND", 57, 800, 74),
    item("ISIN", 120, 766, 14),
    item("Scheme", 180, 766, 32),
    item("Units", 417, 766, 24),
    item("Purchase", 369, 771, 36),
    item("Date", 380, 762, 16),
    item("Avg", 440, 771, 13),
    item("NAV", 454, 771, 17),
    item("Investment", 498, 771, 37),
    item("Amount", 503, 762, 26),
    item("Current", 554, 771, 27),
    item("NAV", 580, 771, 17),
    item("Market", 621, 771, 24),
    item("Value", 623, 762, 19),
    item("INF000000012", 102, 738, 50),
    item("Test Midcap Fund Direct Growth", 163, 738, 190),
    item("100.500", 417, 738, 24),
    item("01 Jan 2025", 369, 738, 72),
    item("100.00", 440, 738, 32),
    item("10,050.00", 493, 738, 38),
    item("120.00", 549, 738, 32),
    item("12,060.00", 612, 738, 38),
  ]);
}

test("reads a BONDS row whose instrument and dates wrap", () => {
  const parsed = parseMotilalPages([bondsPage()]);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.sections, ["bond"]);
  const testd = parsed.rows.find((row) => row.isin === "INE000000023");
  assert.equal(testd.section, "bond");
  assert.equal(testd.label, "TESTD-11.90%-3-12-26-PVT");
  assert.equal(testd.quantity, 2);
  assert.equal(testd.cost_paise, 20000000);
  assert.equal(testd.purchase_date, "2024-06-06");
  assert.equal(testd.coupon_pct, 11.9);
  assert.equal(testd.frequency, "monthly");
  assert.equal(testd.maturity_date, "2026-12-03");
  assert.equal(testd.face_paise, 20000000);
  // The report's market value is at par and must never be written as the CAS
  // value; the parser keeps it only so the preview can show what it ignored.
  assert.equal(testd.market_value_paise, 20000000);
});

test("reads DIRECT EQUITY and MUTUAL FUND sections", () => {
  const parsed = parseMotilalPages([equityPage(), mutualFundPage()]);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.sections, ["equity", "mf"]);
  const equity = parsed.rows.find((row) => row.isin === "INE000000015");
  assert.equal(equity.section, "equity");
  assert.equal(equity.quantity, 10);
  assert.equal(equity.cost_paise, 11977700);
  assert.equal(equity.purchase_date, "2024-02-12");
  const fund = parsed.rows.find((row) => row.isin === "INF000000012");
  assert.equal(fund.section, "mf");
  assert.equal(fund.quantity, 100.5);
  assert.equal(fund.cost_paise, 1005000);
  assert.equal(fund.purchase_date, "2025-01-01");
  assert.equal(fund.face_paise, null);
});

test("a section with No record found adds no rows", () => {
  const parsed = parseMotilalPages([page([
    item("BONDS", 57, 800, 38),
    item("No record found", 62, 760, 80),
  ])]);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 0);
  assert.deepEqual(parsed.sections, ["bond"]);
});

test("fails closed on a PDF that is not the Motilal report", () => {
  const parsed = parseMotilalPages([page([
    item("Account Statement", 57, 800, 100),
    item("Some other table", 57, 760, 100),
  ])]);
  assert.match(parsed.error, /not a Motilal Oswal/);
  assert.equal(parsed.rows.length, 0);
});

test("reads the report date without treating it as a holding", () => {
  const parsed = parseMotilalPages([page([
    item("Report Period", 57, 820, 60),
    item("Since Inception to 12 Nov 2026", 140, 820, 150),
    item("BONDS", 57, 800, 38),
  ])]);
  assert.equal(parsed.asOf, "2026-11-12");
});

test("reads the CLIENT UCID that a broker-only account can attach to", () => {
  const parsed = parseMotilalPages([page([
    item("CLIENT UCID : 9990001", 57, 840, 160),
    ...bondsPage().items,
  ])]);
  assert.equal(parsed.clientUcid, "9990001");
  assert.equal(parsed.rows.length, 2);
  const ucidNo = parseMotilalPages([page([
    item("UCID NO. : 9990001", 57, 840, 160),
    ...bondsPage().items,
  ])]);
  assert.equal(ucidNo.clientUcid, "9990001");
});

const bondRow = {
  isin: "INE000000023", section: "bond", label: "TESTD-11.90%-3-12-26-PVT",
  quantity: 2, purchase_date: "2024-06-06", cost_paise: 20000000,
  coupon_pct: 11.9, frequency: "monthly", maturity_date: "2026-12-03",
  face_paise: 20000000,
};

test("fills a bond's cost, date, terms and per-unit face", () => {
  const patch = motilalHoldingPatch(bondRow, {
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: null,
    purchase_date: "", frequency: "", face_paise: null,
  });
  assert.deepEqual(patch, {
    cost_paise: 20000000,
    purchase_date: "2024-06-06",
    frequency: "monthly",
    face_paise: 10000000,
  });
});

test("never overwrites a bond's existing cost, terms or label", () => {
  const patch = motilalHoldingPatch(bondRow, {
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 20000000,
    purchase_date: "2024-06-06", frequency: "monthly", face_paise: 10000000,
  });
  assert.deepEqual(patch, {});
});

test("the report's stated terms win over a rate and date in the name", () => {
  const patch = motilalHoldingPatch(
    { ...bondRow, coupon_pct: 9.5, maturity_date: "2031-01-01" },
    { label: "TESTD-11.90%-3-12-26-PVT", quantity: 2, cost_paise: 20000000,
      purchase_date: "2024-06-06", frequency: "monthly", face_paise: 10000000 },
  );
  assert.deepEqual(patch, { label: "9.5% TESTD-PVT 01 Jan 2031" });
});

test("a report that agrees with the name leaves the label alone", () => {
  const patch = motilalHoldingPatch(bondRow, {
    label: "TESTD-11.90%-3-12-26-PVT", quantity: 2, cost_paise: 20000000,
    purchase_date: "2024-06-06", frequency: "monthly", face_paise: 10000000,
  });
  assert.deepEqual(patch, {});
});

test("fills an incomplete bond label from the report", () => {
  const patch = motilalHoldingPatch(bondRow, {
    label: "TESTD", quantity: 2, cost_paise: 20000000,
    purchase_date: "2024-06-06", frequency: "monthly", face_paise: 10000000,
  });
  assert.equal(patch.label, "11.9% TESTD 03 Dec 2026");
});

test("a coupon-only label still receives the report's maturity", () => {
  // The dashed family can print the rate without a date. A parsed coupon must
  // not be mistaken for a parsed maturity, or the broker's date is dropped.
  for (const [label, rebuilt] of [
    ["TESTD-11.90%-PVT", "11.9% TESTD-PVT 03 Dec 2026"],
    ["11.9% TESTD", "11.9% TESTD 03 Dec 2026"],
  ]) {
    const patch = motilalHoldingPatch({
      ...bondRow, label, coupon_pct: 11.9, maturity_date: "2026-12-03",
    }, { label, quantity: 2, cost_paise: 20000000,
      purchase_date: "2024-06-06", frequency: "monthly", face_paise: 10000000 });
    assert.equal(patch.label, rebuilt, label);
  }
});

test("fills only cost and date on an equity", () => {
  const patch = motilalHoldingPatch({
    isin: "INE000000015", section: "equity", label: "TESTMOTORS",
    quantity: 10, purchase_date: "2024-02-12", cost_paise: 11977700,
    coupon_pct: null, frequency: "", maturity_date: "", face_paise: null,
  }, { label: "TESTMOTORS", quantity: 10, cost_paise: null, purchase_date: "" });
  assert.deepEqual(patch, { cost_paise: 11977700, purchase_date: "2024-02-12" });
});

test("fills only cost and date on a mutual fund", () => {
  const patch = motilalHoldingPatch({
    isin: "INF000000012", section: "mf", label: "Test Midcap",
    quantity: 100.5, purchase_date: "2025-01-01", cost_paise: 1005000,
    coupon_pct: null, frequency: "", maturity_date: "", face_paise: null,
  }, { label: "Test Midcap", quantity: 100.5, cost_paise: 1005000,
    purchase_date: "" });
  assert.deepEqual(patch, { purchase_date: "2025-01-01" });
});
