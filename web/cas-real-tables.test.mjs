import test from "node:test";
import assert from "node:assert/strict";
import { parseCas } from "./cas.js";
import { applyCasEvents, casEventKey, casReplacePlan } from "./cas-apply.js";

// These are the real NSDL/CDSL headers, with synthetic rows. The bond table is
// a holdings snapshot; the securities and mutual fund tables are movements.
const ISIN_A = "INE000000031";
const ISIN_B = "INE000000032";
const ISIN_MF = "INF000000041";

const text = (str, x, y) => ({ str, x, y, width: 0 });
const money = (str, right, y) => ({ str, x: right - str.length * 6, width: str.length * 6, y });
const page = (items) => ({ pages: [{ items }] });

const SEC_HEADER = [
  text("ISIN", 50, 700), text("Security", 142, 700), text("Transaction", 234, 700),
  text("Date", 327, 700), text("Op. Bal", 368, 700), text("Credit", 415, 700),
  text("Debit", 458, 700), text("Cl. Bal", 500, 700), text("Stamp", 548, 700),
];
const secRow = ({ isin, type = "SALE", date, open, credit = "--", debit, close,
  stamp = 0 }, y) => [
  text(isin, 50, y), text("TEST BOND", 142, y), text(type, 234, y),
  text(date, 327, y), money(String(open), 390, y), money(String(credit), 424, y),
  money(String(debit), 474, y), money(String(close), 524, y), money(String(stamp), 584, y),
];
const BOND_HOLD_HEADER = [
  text("ISIN", 50, 560), text("ISIN Name", 127, 560),
  text("Coupon Rate / Maturity Date", 217, 560), text("Quantity", 363, 560),
  text("Face Value Per Bond (in ₹)", 415, 560),
  text("Market Price Per Bond (in ₹)", 486, 560), text("Value in (₹)", 533, 560),
];
const bondHoldRow = ({ isin, quantity, value }, y) => [
  text(isin, 50, y), text("TEST BOND", 127, y), text("27-11-2028", 310, y),
  money(String(quantity), 410, y), money("1,000.00", 470, y),
  money("1,032.00", 545, y), money(String(value), 578, y),
];
const MF_HEADER = [
  text("Date", 39, 520), text("Transaction Description", 100, 520),
  text("Amount (₹)", 200, 520), text("NAV (₹)", 269, 520),
  text("Price (₹)", 327, 520), text("Units", 396, 520),
];
const mfRow = ({ date, description, amount, units }, y) => [
  text(date, 39, y), text(description, 100, y), money(String(amount), 254, y),
  money("50.0000", 314, y), money("50.0000", 374, y), money(String(units), 439, y),
];
const MF_HOLD_HEADER = [
  text("Scheme Name", 50, 560), text("ISIN", 200, 560), text("Folio No.", 260, 560),
  text("Bal (Units)", 340, 560), text("NAV (₹)", 420, 560),
  text("Amount (₹)", 480, 560), text("Valuation (₹)", 560, 560),
];
const mfHoldRow = (y) => [
  text("TEST FUND", 50, y), text(ISIN_MF, 200, y), text("99990000001", 260, y),
  money("150.000", 400, y), money("50.0000", 450, y),
  money("7,500.00", 510, y), money("7,500.00", 590, y),
];

function securitiesPdf({ rows = [], bonds = [] } = {}) {
  const items = [...SEC_HEADER];
  rows.forEach((row, index) => items.push(...secRow(row, 660 - index * 40)));
  const holdY = rows.length ? 660 - rows.length * 40 - 60 : 560;
  BOND_HOLD_HEADER.forEach((header) => items.push({ ...header, y: holdY }));
  bonds.forEach((row, index) => items.push(...bondHoldRow(row, holdY - 40 - index * 40)));
  return page(items);
}

function mfPdf({ rows = [], holdings = [] } = {}) {
  const items = [
    text("TEST FUND - DIRECT PLAN - GROWTH", 50, 620),
    text("ISIN :", 25, 600), text(ISIN_MF, 49, 600), text("UCC : TEST0001", 340, 600),
    ...MF_HEADER,
  ];
  rows.forEach((row, index) => items.push(...mfRow(row, 480 - index * 60)));
  if (holdings) {
    const holdY = 300;
    MF_HOLD_HEADER.forEach((header) => items.push({ ...header, y: holdY }));
    if (holdings) items.push(...mfHoldRow(holdY - 40));
  }
  return page(items);
}

test("the real bond holdings header stays a holding, never a trade", () => {
  const parsed = parseCas(securitiesPdf({
    bonds: [{ isin: ISIN_A, quantity: 100, value: "1,00,000.00" }],
  }));
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].isin, ISIN_A);
  assert.equal(parsed.holdings[0].kind, "bond");
  assert.equal(parsed.holdings[0].quantity, 100);
  assert.equal(parsed.holdings[0].valuePaise, 10000000);
  assert.equal(parsed.transactions.length, 0);
  assert.equal(parsed.counts.quarantined, 0);
});

test("the exact bond sale is read once from the securities transactions header", () => {
  const parsed = parseCas(securitiesPdf({
    rows: [{ isin: ISIN_A, date: "12-08-2026", open: 100, credit: "--", debit: 100,
      close: 0 }],
    bonds: [{ isin: ISIN_A, quantity: 100, value: "1,00,000.00" }],
  }));
  assert.equal(parsed.transactions.length, 1);
  const sale = parsed.transactions[0];
  assert.equal(sale.isin, ISIN_A);
  assert.equal(sale.quantity, 100);
  assert.equal(sale.creditPaise, 0);
  assert.equal(sale.debitPaise, 10000);
  assert.equal(sale.closingPaise, 0);
  assert.equal(parsed.counts.quarantined, 0);

  const plan = casReplacePlan({ parsed,
    existing: [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
      quantity: 100, cost_paise: 200000, value_paise: 1000000, as_of: "2026-07-31" }],
    holdings: parsed.holdings, asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  // One path read it: one sold row, not a holding plus an event applied twice.
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].disposed_at, "2026-08-12");
  assert.equal(plan.rows[0].disposed_quantity, 100);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].status, "applied");
});

test("a bond block carries the ISIN and opening balance to its next rows", () => {
  const items = [...SEC_HEADER,
    ...secRow({ isin: ISIN_A, date: "09-08-2026", open: 100, credit: 20, debit: "--",
      close: 120 }, 660),
    // The second movement repeats no ISIN and no opening balance.
    text("15-08-2026", 327, 620), money("30", 424, 620), money("--", 474, 620),
    money("150", 524, 620), money("0", 584, 620),
  ];
  const parsed = parseCas(page(items));
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[1].isin, ISIN_A);
  assert.equal(parsed.transactions[1].openingPaise, 12000);
  assert.equal(parsed.transactions[1].creditPaise, 3000);
  assert.equal(parsed.transactions[1].closingPaise, 15000);
});

test("a mutual fund redemption maps Units, never Amount, NAV or Price", () => {
  const parsed = parseCas(mfPdf({
    rows: [{ date: "16-08-2026", description: "REDEMPTION", amount: 5000, units: 100 }],
    holdings: false,
  }));
  assert.equal(parsed.transactions.length, 1);
  const sale = parsed.transactions[0];
  assert.equal(sale.isin, ISIN_MF);
  assert.equal(sale.quantity, 100);
  assert.equal(sale.side, "debit");
  assert.equal(sale.date, "2026-08-16");
  assert.equal(sale.openingPaise, null);
  assert.equal(sale.closingPaise, null);
});

test("a fund fully redeemed out of the statement still leaves a sold record", () => {
  const parsed = parseCas(mfPdf({
    rows: [{ date: "16-08-2026", description: "REDEMPTION", amount: 5000, units: 100 }],
    holdings: false,
  }));
  const existing = [{ security_id: ISIN_MF, label: "TEST FUND", category: "mf",
    quantity: 100, cost_paise: 500000, value_paise: 550000, as_of: "2026-07-31" }];
  const plan = casReplacePlan({ parsed, existing, holdings: [], asOf: "2026-08-31",
    confirmed: true, assetId: "folio-a" });
  const sold = plan.rows.find((row) => row.disposed_at);
  assert.equal(sold.disposed_quantity, 100);
  assert.equal(sold.disposed_type, "sale");
  assert.equal(plan.rows.some((row) => !row.disposed_at), false);
});

test("a fund whose holdings row already reflects the sale is not reduced again", () => {
  const parsed = parseCas(mfPdf({
    rows: [{ date: "16-08-2026", description: "REDEMPTION", amount: 2500, units: 50 }],
    holdings: false,
  }));
  const existing = [{ security_id: ISIN_MF, label: "TEST FUND", category: "mf",
    quantity: 150, cost_paise: 500000, value_paise: 750000, as_of: "2026-08-31" }];
  const plan = casReplacePlan({ parsed, existing, holdings: [],
    asOf: "2026-08-31", confirmed: true, assetId: "folio-a" });
  const live = plan.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 150);
  assert.equal(plan.events[0].status, "reflected");
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.sold[0].disposed_quantity, 50);
});

test("the mutual fund holdings header does not become a trade", () => {
  const parsed = parseCas(mfPdf({ rows: [], holdings: true }));
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].isin, ISIN_MF);
  assert.equal(parsed.transactions.length, 0);
});

test("a fund purchase after a redemption restarts a live row", () => {
  const events = [
    { isin: ISIN_MF, date: "2026-08-10", type: "REDEMPTION", description: "REDEMPTION",
      side: "debit", quantity: 100, creditPaise: null, debitPaise: null, closingPaise: null },
    { isin: ISIN_MF, date: "2026-08-20", type: "PURCHASE", description: "PURCHASE",
      side: "credit", quantity: 40, creditPaise: null, debitPaise: null, closingPaise: null },
  ];
  const result = applyCasEvents([{ security_id: ISIN_MF, label: "TEST FUND",
    category: "mf", quantity: 100, cost_paise: 500000, value_paise: 550000,
    as_of: "2026-07-31" }], events, { asOf: "2026-08-31", assetId: "folio-a" });
  const live = result.rows.find((row) => !row.disposed_at);
  const sold = result.rows.find((row) => row.disposed_at);
  assert.equal(live.quantity, 40);
  assert.equal(live.txn_key, casEventKey(events[1], "folio-a"));
  assert.equal(sold.disposed_quantity, 100);
});
