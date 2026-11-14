import test from "node:test";
import assert from "node:assert/strict";
import { parseCas } from "./cas.js";
import { applyCasEvents, casEventKey, casReplacePlan, casSafety,
  classifyCasEvent } from "./cas-apply.js";

const ISIN_A = "INE000000031";
const ISIN_B = "INE000000032";

const text = (str, x, y) => ({ str, x, y, width: 0 });
// Numbers are right-aligned on a real statement, so the fixture gives every
// numeric cell a width and places it by its right edge.
const money = (str, right, y) => ({ str, x: right - str.length * 6, width: str.length * 6, y });
const page = (items) => ({ pages: [{ items }] });

const TXN_HEADER = [
  text("ISIN", 50, 700), text("Security", 142, 700), text("Transaction", 234, 700),
  text("Date", 327, 700), text("Op. Bal", 368, 700), text("Credit", 415, 700),
  text("Debit", 458, 700), text("Cl. Bal", 500, 700), text("Stamp", 546, 700),
];
const BOND_HEADER = [
  text("ISIN", 50, 560), text("ISIN Name", 127, 560), text("Coupon / Rate", 217, 560),
  text("Maturity", 310, 560), text("Quantity", 363, 560),
  text("Face Value per Bond", 415, 560), text("Value in", 526, 560),
];
const txnRow = (row, y) => [
  text(row.isin, 50, y), text(row.security || "SOME BOND", 142, y),
  text(row.type, 234, y), text(row.date, 327, y),
  money(String(row.open), 390, y), money(String(row.credit), 424, y),
  money(String(row.debit), 474, y), money(String(row.close), 524, y),
  money(String(row.stamp ?? 0), 584, y),
];
const bondRow = (row, y) => [
  text(row.isin, 50, y), text(row.label || "SOME BOND", 127, y),
  money(String(row.coupon ?? 9), 305, y), text(row.maturity || "31-Dec-2028", 310, y),
  money(String(row.quantity), 410, y), money("1,000.00", 470, y),
  money(String(row.value), 578, y),
];

function casPdf({ txns = [], bonds = [] }) {
  const items = [...TXN_HEADER];
  txns.forEach((row, index) => items.push(...txnRow(row, 660 - index * 40)));
  if (bonds.length) {
    const holdY = txns.length ? 660 - txns.length * 40 - 40 : 560;
    BOND_HEADER.forEach((header) => items.push({ ...header, y: holdY }));
    bonds.forEach((row, index) => items.push(...bondRow(row, holdY - 40 - index * 40)));
  }
  return page(items);
}

const sale = (over = {}) => ({
  isin: ISIN_A, security: "TEST BOND", type: "SALE", date: "12-08-2026",
  open: 100, credit: 0, debit: 100, close: 0, stamp: 0, ...over,
});
const fullSale = (over = {}) => ({
  depository: "CDSL", asOf: "31-08-2026",
  holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
    valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" }],
  transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
    type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
    creditPaise: 0, debitPaise: 10000, closingPaise: 0, stampDutyPaise: 0 }],
  counts: { rows: 1, quarantined: 0, transactions: 1 },
  printedTotalPaise: 10000000,
  ...over,
});

const brokerRow = (over = {}) => ({
  security_id: ISIN_A, label: "9.00% TEST BOND 31 Dec 2028", category: "bond",
  quantity: 100, cost_paise: 200000, value_paise: 1000000, face_paise: 10000000,
  purchase_date: "2024-06-06", as_of: "2026-07-31", source: "report",
  value_source: "motilal", frequency: "Annual", ...over,
});

// --- the parser -------------------------------------------------------------

test("a full sale is read from the trades table even when the holdings table still shows the bond", () => {
  const parsed = parseCas(casPdf({
    txns: [sale({ close: 0 })],
    bonds: [{ isin: ISIN_A, quantity: 100, value: "1,00,000.00" }],
  }));
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.transactions.length, 1);
  const txn = parsed.transactions[0];
  assert.equal(txn.isin, ISIN_A);
  assert.equal(txn.date, "2026-08-12");
  assert.equal(txn.type, "SALE");
  assert.equal(txn.quantity, 100);
  assert.equal(txn.openingPaise, 10000);
  assert.equal(txn.creditPaise, 0);
  assert.equal(txn.debitPaise, 10000);
  assert.equal(txn.closingPaise, 0);
  assert.equal(txn.stampDutyPaise, 0);
  assert.equal(parsed.counts.quarantined, 0);
});

test("a partial sale reads its moved units and losing balance", () => {
  const parsed = parseCas(casPdf({
    txns: [sale({ debit: 40, close: 60 })],
    bonds: [{ isin: ISIN_A, quantity: 60, value: "60,000.00" }],
  }));
  const txn = parsed.transactions[0];
  assert.equal(txn.quantity, 40);
  assert.equal(txn.openingPaise, 10000);
  assert.equal(txn.closingPaise, 6000);
});

test("an unbalanced trade row is quarantined and blocks the statement", () => {
  const parsed = parseCas(casPdf({ txns: [sale({ debit: 40, close: 70 })] }));
  assert.equal(parsed.transactions.length, 0);
  assert.equal(parsed.counts.quarantined, 1);
  assert.equal(parsed.warnings.some((warning) => warning.code === "txn_unbalanced"), true);
  const safety = casSafety(parsed);
  assert.equal(safety.blocked, true);
  const existing = [brokerRow()];
  const plan = casReplacePlan({ parsed, existing, holdings: [], confirmed: true });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.rows, existing);
});

test("a trade with no date is quarantined rather than guessed", () => {
  const parsed = parseCas(casPdf({ txns: [sale({ date: "" })] }));
  assert.equal(parsed.transactions.length, 0);
  assert.equal(parsed.counts.quarantined, 1);
});

test("a balance heading split over two lines still places its column", () => {
  const items = [
    text("ISIN", 50, 700), text("Security", 142, 700), text("Transaction", 234, 700),
    text("Date", 327, 700), text("Op.", 368, 700), text("Credit", 415, 700),
    text("Debit", 458, 700), text("Cl.", 500, 700), text("Stamp", 546, 700),
    text("Bal", 368, 686), text("Bal", 500, 686),
    ...txnRow(sale({ debit: 40, close: 60 }), 640),
  ];
  const parsed = parseCas(page(items));
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].openingPaise, 10000);
  assert.equal(parsed.transactions[0].debitPaise, 4000);
  assert.equal(parsed.transactions[0].closingPaise, 6000);
});

test("a trades-only statement does not turn its rows into holdings", () => {
  const parsed = parseCas(casPdf({ txns: [sale()] }));
  assert.equal(parsed.holdings.length, 0);
  assert.equal(parsed.transactions.length, 1);
});

// --- the event plan ---------------------------------------------------------

test("a full sale removes the live row and leaves a sold record", () => {
  const parsed = fullSale();
  const plan = casReplacePlan({ parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  assert.equal(plan.ok, true);
  assert.equal(plan.rows.length, 1);
  const sold = plan.rows[0];
  assert.equal(sold.quantity, 0);
  assert.equal(sold.security_id, ISIN_A);
  assert.equal(sold.disposed_at, "2026-08-12");
  assert.equal(sold.disposed_quantity, 100);
  assert.equal(sold.disposed_type, "sale");
  assert.equal(sold.disposed_source, "CAS");
  assert.equal(sold.disposed_reason, "SALE");
  assert.equal(sold.cost_paise, 0);
  assert.equal(sold.value_paise, 0);
  assert.equal(sold.txn_key, casEventKey(parsed.transactions[0], "demat-a"));
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.events[0].from, 100);
  assert.equal(plan.events[0].to, 0);
});

test("a partial sale reduces the lot and keeps the sold units as history", () => {
  const parsed = fullSale({
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
      valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" }],
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000, stampDutyPaise: 0 }],
  });
  const plan = casReplacePlan({ parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true });
  const live = plan.rows.find((row) => !row.disposed_at);
  const sold = plan.rows.find((row) => row.disposed_at);
  assert.equal(live.quantity, 60);
  assert.equal(live.cost_paise, 120000);
  assert.equal(sold.disposed_quantity, 40);
  assert.equal(sold.disposed_cost_paise, 80000);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].message, /still shows 100 units/);
});

test("the same statement applied twice does not sell the bond twice", () => {
  const parsed = fullSale({
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000, stampDutyPaise: 0 }],
  });
  const first = casReplacePlan({ parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true });
  const second = applyCasEvents(first.rows, parsed.transactions, { asOf: "2026-08-31" });
  const live = second.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 60);
  assert.equal(second.sold.length, 0);
  assert.equal(second.rows.filter((row) => row.disposed_at).length, 1);
  assert.equal(second.applied[0].status, "already");
});

test("a full sale and a re-buy in one stale statement end with a live lot, not zero", () => {
  const parsed = fullSale({
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
      valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" }],
    counts: { rows: 1, quarantined: 0, transactions: 2 },
    transactions: [
      { isin: ISIN_A, security: "TEST BOND", date: "2026-08-03", type: "SALE",
        description: "SALE", quantity: 100, openingPaise: 10000, creditPaise: 0,
        debitPaise: 10000, closingPaise: 0, stampDutyPaise: 0 },
      { isin: ISIN_A, security: "TEST BOND", date: "2026-08-20", type: "PURCHASE",
        description: "PURCHASE", quantity: 50, openingPaise: 0, creditPaise: 5000,
        debitPaise: 0, closingPaise: 5000, stampDutyPaise: 0 },
    ],
  });
  const plan = casReplacePlan({ parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  const live = plan.rows.find((row) => !row.disposed_at);
  const sold = plan.rows.find((row) => row.disposed_at);
  assert.equal(live.quantity, 50);
  assert.equal(live.purchase_date, "2026-08-20");
  assert.equal(live.cost_paise, null);
  assert.equal(live.txn_key, casEventKey(parsed.transactions[1], "demat-a"));
  assert.equal(sold.disposed_quantity, 100);
  assert.equal(sold.disposed_cost_paise, 200000);
  // The stale snapshot still said 100, so the disagreement is named rather than
  // being mistaken for the final state.
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].message, /still shows 100 units/);

  const again = applyCasEvents(plan.rows, parsed.transactions, { asOf: "2026-08-31",
    assetId: "demat-a" });
  assert.equal(again.rows.find((row) => !row.disposed_at).quantity, 50);
  assert.equal(again.rows.filter((row) => row.disposed_at).length, 1);
  assert.equal(again.sold.length, 0);
  assert.equal(again.applied.every((event) => event.status === "already"), true);
});

test("a sale recorded before any holding exists still leaves a sold row", () => {
  const parsed = fullSale({ holdings: [], printedTotalPaise: null });
  const plan = casReplacePlan({ parsed, existing: [], holdings: [], asOf: "2026-08-31",
    confirmed: true });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].disposed_at, "2026-08-12");
  assert.equal(plan.rows[0].disposed_quantity, 100);
  assert.equal(plan.rows[0].label, "TEST BOND");
});

// --- what a debit means -----------------------------------------------------

test("a sale and a transfer out are different states, and an unclear row is a disposal", () => {
  const base = { creditPaise: 0, debitPaise: 4000, quantity: 40, date: "2026-08-12" };
  assert.equal(classifyCasEvent({ ...base, type: "SALE" }).kind, "sale");
  assert.equal(classifyCasEvent({ ...base, type: "TRANSFER OUT TO CDSL" }).kind,
    "transfer-out");
  const other = classifyCasEvent({ ...base, type: "CORPORATE ACTION" });
  assert.equal(other.kind, "disposed");
  assert.equal(other.reason, "CORPORATE ACTION");
});

test("a credit adds units only when the wording is a purchase or transfer in", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 50, cost_paise: 100000, value_paise: 100000, as_of: "2026-08-01" }];
  const purchase = [{ isin: ISIN_A, date: "2026-08-12", type: "PURCHASE",
    description: "PURCHASE", quantity: 10, openingPaise: 5000, creditPaise: 1000,
    debitPaise: 0, closingPaise: 6000 }];
  const bought = applyCasEvents(rows, purchase);
  assert.equal(bought.rows[0].quantity, 60);
  assert.equal(bought.sold.length, 0);

  const ambiguous = applyCasEvents(rows, [{ ...purchase[0], type: "CREDIT",
    description: "CREDIT" }]);
  assert.equal(ambiguous.rows[0].quantity, 50);
  assert.equal(ambiguous.skipped.length, 1);
  assert.match(ambiguous.warnings.join(" "), /no purchase or transfer-in wording/);
});

test("a sale floors at zero and never leaves a negative quantity", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 30, cost_paise: 60000, value_paise: 60000, as_of: "2026-08-01" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, date: "2026-08-12", type: "SALE",
    description: "SALE", quantity: 100, openingPaise: 10000, creditPaise: 0,
    debitPaise: 10000, closingPaise: 0 }]);
  assert.equal(result.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(result.sold[0].disposed_quantity, 100);
  assert.equal(result.sold[0].disposed_cost_paise, 60000);
});

// --- the quantity-precedence fix --------------------------------------------

test("a snapshot that already reflects the sale is not reduced a second time", () => {
  const parsed = fullSale({
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 60,
      valuePaise: 6000000, couponPct: 9, maturity: "2028-12-31" }],
    counts: { rows: 1, quarantined: 0, transactions: 1 },
    printedTotalPaise: 6000000,
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000, stampDutyPaise: 0 }],
  });
  const plan = casReplacePlan({ parsed, existing: [brokerRow({ quantity: 60 })],
    holdings: parsed.holdings, asOf: "2026-08-31", confirmed: true });
  const live = plan.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 60);
  assert.equal(plan.events[0].status, "reflected");
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.sold[0].disposed_quantity, 40);
  assert.equal(plan.conflicts.length, 0);
});

test("a broker report newer than the sale that still shows the old quantity is surfaced", () => {
  const parsed = fullSale({
    holdings: [],
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
      creditPaise: 0, debitPaise: 10000, closingPaise: 0, stampDutyPaise: 0 }],
  });
  const start = Date.parse("2026-08-12T00:00:00Z");
  const days = (n) => new Date(start + n * 86400000).toISOString().slice(0, 10);
  const result = applyCasEvents([brokerRow({ as_of: days(50) })], parsed.transactions,
    { asOf: "2026-10-01" });
  assert.equal(result.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(result.sold.length, 1);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /still shows 100 units/);
  assert.match(result.conflicts[0].message, /sold on/);
});

test("a newer report that omits the bond still receives the sale", () => {
  const parsed = fullSale({
    holdings: [],
    printedTotalPaise: null,
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
      creditPaise: 0, debitPaise: 10000, closingPaise: 0, stampDutyPaise: 0 }],
  });
  const plan = casReplacePlan({ parsed, existing: [brokerRow({ as_of: "2026-09-30" })],
    holdings: [], asOf: "2026-08-31", confirmed: true });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].disposed_at, "2026-08-12");
  assert.equal(plan.keptEvents, 1);
});

test("applying a movement never deletes an unrelated holding", () => {
  const rows = [
    brokerRow(),
    brokerRow({ security_id: ISIN_B, label: "8.00% OTHER BOND", quantity: 5,
      cost_paise: 50000 }),
  ];
  const result = applyCasEvents(rows, [{
    isin: ISIN_A, date: "2026-08-12", type: "SALE", description: "SALE", quantity: 100,
    openingPaise: 10000, creditPaise: 0, debitPaise: 10000, closingPaise: 0,
  }]);
  const other = result.rows.find((row) => row.security_id === ISIN_B);
  assert.equal(other.quantity, 5);
  assert.equal(other.cost_paise, 50000);
});

test("the preview and the writer share one event plan", () => {
  const parsed = fullSale({
    holdings: [
      { isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
        valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" },
      { isin: ISIN_B, label: "OTHER BOND", kind: "bond", quantity: 5,
        valuePaise: 500000, couponPct: 8, maturity: "2029-12-31" },
    ],
    counts: { rows: 2, quarantined: 0, transactions: 1 },
    printedTotalPaise: 10500000,
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
      creditPaise: 0, debitPaise: 10000, closingPaise: 0, stampDutyPaise: 0 }],
  });
  const existing = [brokerRow(),
    brokerRow({ security_id: ISIN_B, label: "8.00% OTHER BOND", quantity: 5,
      cost_paise: 50000 })];
  const preview = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: false });
  const write = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true });
  assert.deepEqual(preview.events, write.events);
  assert.deepEqual(preview.sold, write.sold);
  assert.deepEqual(preview.conflicts, write.conflicts);
  assert.deepEqual(
    preview.rows.map((row) => [row.security_id, row.quantity, row.disposed_at || ""]).sort(),
    write.rows.map((row) => [row.security_id, row.quantity, row.disposed_at || ""]).sort(),
  );
});
