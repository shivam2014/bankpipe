import test from "node:test";
import assert from "node:assert/strict";
import { parseCas } from "./cas.js";
import { applyCasEvents, casEventKey, casLegacyEventKey, casReplacePlan, casSafety,
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

test("a sale larger than the holding records only the held units and a conflict", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 30, cost_paise: 60000, value_paise: 60000, as_of: "2026-08-01" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, date: "2026-08-12", type: "SALE",
    description: "SALE", quantity: 100, openingPaise: 10000, creditPaise: 0,
    debitPaise: 10000, closingPaise: 0 }]);
  assert.equal(result.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(result.sold[0].disposed_quantity, 30);
  assert.equal(result.sold[0].disposed_cost_paise, 60000);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /held 30 units; 30 were recorded/);
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

// --- re-import and multi-account routing -------------------------------------

test("re-importing the same full-sale statement does not resurrect the sold lot", () => {
  const parsed = fullSale();
  const args = { parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a", route: true,
    accounts: ["1200000000000001"] };
  const first = casReplacePlan(args);
  assert.equal(first.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(first.rows.filter((row) => row.disposed_at).length, 1);

  const again = casReplacePlan({ ...args, existing: first.rows });
  assert.equal(again.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(again.rows.filter((row) => row.disposed_at).length, 1);
  assert.equal(again.rows[0].disposed_quantity, 100);
});

test("re-importing the same partial sale keeps the live units and one sold row", () => {
  const parsed = fullSale({
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000, stampDutyPaise: 0 }],
  });
  const args = { parsed, existing: [brokerRow()], holdings: parsed.holdings,
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a", route: true,
    accounts: ["1200000000000001"] };
  const first = casReplacePlan(args);
  assert.equal(first.rows.find((row) => !row.disposed_at).quantity, 60);

  const again = casReplacePlan({ ...args, existing: first.rows });
  const live = again.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 60);
  assert.equal(live.cost_paise, 120000);
  assert.equal(again.rows.filter((row) => row.disposed_at).length, 1);
});

test("each demat receives only its own movements", () => {
  const ACCOUNT_A = "1200000000000001";
  const ACCOUNT_B = "1200000000000002";
  const holding = (isin, label, quantity, account, coupon, maturity) => ({
    isin, label, kind: "bond", quantity, valuePaise: quantity * 100000,
    couponPct: coupon, maturity, account,
  });
  const sale = (isin, account, open, debit, close) => ({ isin, account,
    security: "TEST BOND", date: "2026-08-12", type: "SALE", description: "SALE",
    quantity: debit / 100, openingPaise: open, creditPaise: 0, debitPaise: debit,
    closingPaise: close });
  const parsed = {
    holdings: [holding(ISIN_A, "A BOND", 100, ACCOUNT_A, 9, "2028-12-31"),
      holding(ISIN_B, "B BOND", 50, ACCOUNT_B, 8, "2029-12-31")],
    transactions: [
      sale(ISIN_A, ACCOUNT_A, 10000, 4000, 6000),
      sale(ISIN_B, ACCOUNT_B, 5000, 1000, 4000),
      sale(ISIN_A, ACCOUNT_B, 3000, 1000, 2000),
      sale(ISIN_B, ACCOUNT_A, 2000, 500, 1500),
    ],
    counts: { rows: 2, quarantined: 0 },
    printedTotalPaise: null,
  };
  const row = (isin, account, quantity) => ({ security_id: isin, label: "BOND",
    category: "bond", quantity, cost_paise: quantity * 1000, as_of: "2026-07-31",
    account });
  const planA = casReplacePlan({ parsed, existing: [row(ISIN_A, ACCOUNT_A, 100)],
    holdings: [parsed.holdings[0]], assetId: "demat-a", asOf: "2026-08-31",
    confirmed: true, accounts: [ACCOUNT_A], route: true });
  const planB = casReplacePlan({ parsed, existing: [row(ISIN_B, ACCOUNT_B, 50)],
    holdings: [parsed.holdings[1]], assetId: "demat-b", asOf: "2026-08-31",
    confirmed: true, accounts: [ACCOUNT_B], route: true });
  assert.deepEqual(planA.sold.map((sold) => sold.security_id).sort(),
    [ISIN_A, ISIN_B].sort());
  assert.deepEqual(planB.sold.map((sold) => sold.security_id).sort(),
    [ISIN_A, ISIN_B].sort());
  // Each account's own two movements are recorded, plus the foreign one that
  // names this account; the other account's movements are not.
  assert.equal(planA.sold.length, 2);
  assert.equal(planB.sold.length, 2);
});

test("a movement with no account goes only to the demat that holds it", () => {
  const ACCOUNT_A = "1200000000000001";
  const ACCOUNT_B = "1200000000000002";
  const holdingA = { isin: ISIN_A, label: "A BOND", kind: "bond", quantity: 100,
    valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31", account: ACCOUNT_A };
  const event = { isin: ISIN_A, account: "", security: "A BOND", date: "2026-08-12",
    type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
    creditPaise: 0, debitPaise: 4000, closingPaise: 6000 };
  const parsed = { holdings: [holdingA], transactions: [event],
    counts: { rows: 1, quarantined: 0 }, printedTotalPaise: null };
  const a = casReplacePlan({ parsed, existing: [{ security_id: ISIN_A,
    label: "A BOND", category: "bond", quantity: 100, cost_paise: 100000,
    as_of: "2026-07-31" }], holdings: [holdingA], assetId: "demat-a",
    asOf: "2026-08-31", confirmed: true, accounts: [ACCOUNT_A], route: true });
  const b = casReplacePlan({ parsed, existing: [{ security_id: ISIN_B,
    label: "B BOND", category: "bond", quantity: 50, cost_paise: 50000,
    as_of: "2026-07-31" }], holdings: [], assetId: "demat-b",
    asOf: "2026-08-31", confirmed: true, accounts: [ACCOUNT_B], route: true });
  assert.equal(a.sold.length, 1);
  assert.equal(b.sold.length, 0);
});

test("a debit larger than the largest lot consumes every live lot", () => {
  const lot = (quantity, costPaise) => ({ security_id: ISIN_A, label: "TEST BOND",
    category: "bond", quantity, cost_paise: costPaise, value_paise: costPaise,
    face_paise: costPaise * 100, as_of: "2026-08-01" });
  const event = { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
    type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
    creditPaise: 0, debitPaise: 10000, closingPaise: 0 };
  const result = applyCasEvents([lot(70, 70000), lot(30, 30000)], [event]);
  assert.equal(result.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(result.sold.length, 1);
  assert.equal(result.sold[0].disposed_quantity, 100);
  assert.equal(result.sold[0].disposed_cost_paise, 100000);
});

test("a partial debit consumes from each lot and leaves the rest priced", () => {
  const lot = (quantity, costPaise) => ({ security_id: ISIN_A, label: "TEST BOND",
    category: "bond", quantity, cost_paise: costPaise, value_paise: costPaise,
    face_paise: costPaise * 100, as_of: "2026-08-01" });
  const event = { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
    type: "SALE", description: "SALE", quantity: 80, openingPaise: 10000,
    creditPaise: 0, debitPaise: 8000, closingPaise: 2000 };
  const result = applyCasEvents([lot(70, 70000), lot(30, 30000)], [event]);
  const live = result.rows.filter((row) => !row.disposed_at);
  assert.equal(live.length, 1);
  assert.equal(live[0].quantity, 20);
  assert.equal(live[0].cost_paise, 20000);
  assert.equal(result.sold[0].disposed_cost_paise, 80000);
});

test("a credit across several lots adds only its units to the total", () => {
  const lot = (quantity, costPaise) => ({ security_id: ISIN_A, label: "TEST BOND",
    category: "bond", quantity, cost_paise: costPaise, value_paise: costPaise,
    as_of: "2026-08-01" });
  const event = { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
    type: "PURCHASE", description: "PURCHASE", quantity: 50, openingPaise: 10000,
    creditPaise: 5000, debitPaise: 0, closingPaise: 15000 };
  const result = applyCasEvents([lot(70, 70000), lot(30, 30000)], [event]);
  const live = result.rows.filter((row) => !row.disposed_at);
  assert.equal(live.reduce((sum, row) => sum + row.quantity, 0), 150);
  assert.deepEqual(live.map((row) => row.quantity).sort((a, b) => a - b), [30, 120]);
});

test("a transfer-out conflict is named as a transfer, not a sale", () => {
  const parsed = fullSale({
    holdings: [],
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "TRANSFER OUT TO CDSL", description: "TRANSFER OUT TO CDSL", quantity: 40,
      openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
  });
  const result = applyCasEvents([brokerRow({ as_of: "2026-09-30" })], parsed.transactions,
    { asOf: "2026-10-01" });
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /transferred out/);
  assert.equal(/sold/.test(result.conflicts[0].message), false);
});

test("a corporate-action conflict keeps its printed reason", () => {
  const parsed = fullSale({
    holdings: [],
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "CORPORATE ACTION", description: "CORPORATE ACTION", quantity: 40,
      openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
  });
  const result = applyCasEvents([brokerRow({ as_of: "2026-09-30" })], parsed.transactions,
    { asOf: "2026-10-01" });
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /disposed \(CORPORATE ACTION\)/);
});

test("a disposal with no live row takes its label and class from the parsed holding", () => {
  const parsed = fullSale({
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
      valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" }],
    printedTotalPaise: null,
    transactions: [{ isin: ISIN_A, security: "", date: "2026-08-12",
      type: "CORPORATE ACTION", description: "CORPORATE ACTION", quantity: 100,
      openingPaise: 10000, creditPaise: 0, debitPaise: 10000, closingPaise: 0 }],
  });
  const plan = casReplacePlan({ parsed, existing: [], holdings: [],
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].category, "bond");
  assert.equal(plan.rows[0].label, "9% TEST BOND 31 Dec 2028");
});

test("an older debit cannot be suppressed by a closing balance it predates", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 30, cost_paise: 60000, value_paise: 60000, as_of: "2026-07-31" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 40,
    openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }]);
  assert.equal(result.rows.filter((row) => !row.disposed_at).length, 0);
  assert.equal(result.sold[0].disposed_quantity, 30);
  assert.match(result.warnings.join(" "), /closes at 60 units/);
});

test("re-importing a credit does not compound the units", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST FUND", category: "mf",
    quantity: 100, cost_paise: 100000, value_paise: 100000, as_of: "2026-07-31" }];
  const event = { isin: ISIN_A, date: "2026-08-12", type: "PURCHASE",
    description: "PURCHASE", side: "credit", quantity: 50, creditPaise: null,
    debitPaise: null, closingPaise: null };
  const first = applyCasEvents(rows, [event], { asOf: "2026-08-31" });
  assert.equal(first.rows[0].quantity, 150);
  assert.equal(first.rows[0].as_of, "2026-08-12");
  const again = applyCasEvents(first.rows, [event], { asOf: "2026-08-31" });
  assert.equal(again.rows[0].quantity, 150);
});

test("two same-day sales of the same units get different event keys", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 100, cost_paise: 100000, value_paise: 100000, as_of: "2026-08-01" }];
  const events = [
    { isin: ISIN_A, date: "2026-08-12", type: "SALE", description: "SALE", quantity: 10,
      openingPaise: 10000, creditPaise: 0, debitPaise: 1000, closingPaise: 9000 },
    { isin: ISIN_A, date: "2026-08-12", type: "SALE", description: "SALE", quantity: 10,
      openingPaise: 9000, creditPaise: 0, debitPaise: 1000, closingPaise: 8000 },
  ];
  assert.notEqual(casEventKey(events[0]), casEventKey(events[1]));
  const result = applyCasEvents(rows, events, { asOf: "2026-08-31" });
  assert.equal(result.sold.length, 2);
  assert.equal(result.rows.find((row) => !row.disposed_at).quantity, 80);
});

// --- the second review round -------------------------------------------------

test("a balance-bearing sale keys the demat record the linked portfolio matches", () => {
  const event = { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
    type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
    creditPaise: 0, debitPaise: 4000, closingPaise: 6000 };
  const result = applyCasEvents([{ security_id: ISIN_A, label: "TEST BOND",
    category: "bond", quantity: 100, cost_paise: 200000, value_paise: 1000000,
    as_of: "2026-07-31" }], [event], { asOf: "2026-08-31", assetId: "demat-a" });
  assert.equal(result.sold.length, 1);
  assert.equal(casEventKey(result.applied[0], "demat-a"), result.sold[0].txn_key);
});

test("a sale named by an account absent from the holdings table is written", () => {
  const ACCOUNT = "1200000000000002";
  const parsed = {
    holdings: [{ isin: ISIN_B, account: "1200000000000001", kind: "bond",
      label: "A BOND", quantity: 100, valuePaise: 10000000 }],
    transactions: [{ isin: ISIN_A, account: ACCOUNT, security: "B BOND",
      date: "2026-08-12", type: "SALE", description: "SALE", quantity: 40,
      openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
    counts: { rows: 1, quarantined: 0 }, printedTotalPaise: null,
  };
  const plan = casReplacePlan({ parsed, existing: [{ security_id: ISIN_A,
    label: "B BOND", category: "bond", quantity: 100, cost_paise: 100000,
    value_paise: 1000000, as_of: "2026-07-31" }], holdings: [], events: parsed.transactions,
    assetId: "demat-b", asOf: "2026-08-31", confirmed: true,
    accounts: [ACCOUNT], route: true });
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.sold[0].security_id, ISIN_A);
  assert.equal(plan.rows.find((row) => !row.disposed_at).quantity, 60);
});

test("a sold row written before the balance key is still recognised", () => {
  const ACCOUNT = "1200000000000001";
  const event = { isin: ISIN_A, account: ACCOUNT, security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 40,
    openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 };
  const sold = { security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 40, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", disposed_cost_paise: 80000,
    txn_key: casLegacyEventKey(event, "demat-a") };
  const live = { security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 60, cost_paise: 120000, value_paise: 600000, as_of: "2026-08-31" };
  const parsed = { holdings: [], asOf: "2026-08-31", transactions: [event],
    counts: { rows: 0, quarantined: 0 }, printedTotalPaise: null };
  const plan = casReplacePlan({ parsed, existing: [live, sold], holdings: [],
    events: [event], assetId: "demat-a", asOf: "2026-08-31", confirmed: true,
    accounts: [ACCOUNT], route: true });
  assert.equal(plan.rows.filter((row) => !row.disposed_at).length, 1);
  assert.equal(plan.rows.find((row) => !row.disposed_at).quantity, 60);
  assert.equal(plan.rows.filter((row) => row.disposed_at).length, 1);
  assert.equal(plan.sold.length, 0);
  assert.equal(plan.events[0].status, "already");
});

test("a face value is per unit and survives a partial sale and a re-buy", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 100, cost_paise: 100000, value_paise: 1000000, face_paise: 10000000,
    as_of: "2026-08-01" }];
  const events = [
    { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12", type: "SALE",
      description: "SALE", quantity: 60, openingPaise: 10000, creditPaise: 0,
      debitPaise: 6000, closingPaise: 4000 },
    { isin: ISIN_A, security: "TEST BOND", date: "2026-08-20", type: "PURCHASE",
      description: "PURCHASE", quantity: 10, openingPaise: 4000, creditPaise: 1000,
      debitPaise: 0, closingPaise: 5000 },
  ];
  const result = applyCasEvents(rows, events, { asOf: "2026-08-31" });
  const live = result.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 50);
  assert.equal(live.face_paise, 10000000);
  assert.equal(live.value_paise, 500000);
});

test("a foreign movement does not pin an absent row on another demat", () => {
  const ACCOUNT_A = "1200000000000001";
  const ACCOUNT_B = "1200000000000002";
  const holdingA = { isin: ISIN_A, account: ACCOUNT_A, label: "A BOND",
    kind: "bond", quantity: 100, valuePaise: 10000000, couponPct: 9,
    maturity: "2028-12-31" };
  const parsed = {
    holdings: [holdingA],
    transactions: [{ isin: ISIN_B, account: ACCOUNT_B, security: "B BOND",
      date: "2026-08-12", type: "SALE", description: "SALE", quantity: 10,
      openingPaise: 5000, creditPaise: 0, debitPaise: 1000, closingPaise: 4000 }],
    counts: { rows: 1, quarantined: 0 },
    // The routing question is about a complete statement: the printed total
    // matches, so this replace may remove a row the statement does not name.
    printedTotalPaise: 10000000,
  };
  const existing = [
    { security_id: ISIN_A, label: "A BOND", category: "bond", quantity: 100,
      cost_paise: 100000, as_of: "2026-07-31" },
    { security_id: ISIN_B, label: "B BOND", category: "bond", quantity: 50,
      cost_paise: 50000, as_of: "2026-07-31" },
  ];
  const plan = casReplacePlan({ parsed, existing, holdings: [holdingA],
    events: parsed.transactions, assetId: "demat-a", asOf: "2026-08-31",
    confirmed: true, accounts: [ACCOUNT_A], route: true });
  assert.deepEqual(plan.dropped.map((row) => row.isin), [ISIN_B]);
  assert.equal(plan.rows.some((row) => row.security_id === ISIN_B), false);
  assert.equal(plan.sold.length, 0);
});

test("a manual target can record a movement the account does not hold", () => {
  const event = { isin: ISIN_A, account: "", security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 40,
    openingPaise: 0, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 };
  const parsed = { holdings: [], asOf: "2026-08-31", transactions: [event],
    counts: { rows: 0, quarantined: 0 }, printedTotalPaise: null };
  const args = { parsed, existing: [], holdings: [], events: [event], assetId: "manual",
    asOf: "2026-08-31", confirmed: true, route: true };
  assert.equal(casReplacePlan({ ...args, accounts: [] }).sold.length, 0);
  const manual = casReplacePlan({ ...args, accounts: [], manualTarget: true });
  assert.equal(manual.sold.length, 1);
  assert.equal(manual.sold[0].security_id, ISIN_A);
});

test("two demats sharing an ISIN keep their own units", () => {
  const ACCOUNT_A = "1200000000000001";
  const ACCOUNT_B = "1200000000000002";
  const ACCOUNT_C = "1200000000000003";
  const holding = (account, quantity) => ({ isin: ISIN_A, account, label: "SHARED BOND",
    kind: "bond", quantity, valuePaise: quantity * 100000, couponPct: 9,
    maturity: "2028-12-31" });
  const sale = (account, quantity, open, close) => ({ isin: ISIN_A, account,
    security: "SHARED BOND", date: "2026-08-12", type: "SALE", description: "SALE",
    quantity, openingPaise: open, creditPaise: 0, debitPaise: quantity * 100,
    closingPaise: close });
  const parsed = {
    holdings: [holding(ACCOUNT_A, 100), holding(ACCOUNT_B, 40)],
    transactions: [sale(ACCOUNT_A, 10, 10000, 9000), sale(ACCOUNT_B, 5, 4000, 3500),
      sale(ACCOUNT_C, 7, 2000, 1300)],
    counts: { rows: 2, quarantined: 0 }, printedTotalPaise: null,
  };
  const row = (quantity) => ({ security_id: ISIN_A, label: "SHARED BOND",
    category: "bond", quantity, cost_paise: quantity * 1000, as_of: "2026-07-31" });
  const planA = casReplacePlan({ parsed, existing: [row(100)],
    holdings: [parsed.holdings[0]], assetId: "demat-a", asOf: "2026-08-31",
    confirmed: true, accounts: [ACCOUNT_A], route: true });
  const planB = casReplacePlan({ parsed, existing: [row(40)],
    holdings: [parsed.holdings[1]], assetId: "demat-b", asOf: "2026-08-31",
    confirmed: true, accounts: [ACCOUNT_B], route: true });
  // Account C is named only by its movement, not by a holdings row.
  const planC = casReplacePlan({ parsed, existing: [row(20)], holdings: [],
    assetId: "demat-c", asOf: "2026-08-31", confirmed: true,
    accounts: [ACCOUNT_C], route: true });
  assert.equal(planA.sold.length, 1);
  assert.equal(planA.sold[0].disposed_quantity, 10);
  assert.equal(planA.rows.find((entry) => !entry.disposed_at).quantity, 90);
  assert.equal(planB.sold.length, 1);
  assert.equal(planB.sold[0].disposed_quantity, 5);
  assert.equal(planB.rows.find((entry) => !entry.disposed_at).quantity, 35);
  assert.equal(planC.sold.length, 1);
  assert.equal(planC.sold[0].disposed_quantity, 7);
  assert.equal(planC.rows.find((entry) => !entry.disposed_at).quantity, 13);
});

test("a zero-unit position with a sale keeps the same rows on re-import", () => {
  const ACCOUNT = "1200000000000001";
  const holding = { isin: ISIN_A, account: ACCOUNT, label: "TEST BOND", kind: "bond",
    quantity: 0, valuePaise: 0, couponPct: 9, maturity: "2020-01-01" };
  const parsed = {
    holdings: [holding], asOf: "2026-08-31",
    transactions: [{ isin: ISIN_A, account: ACCOUNT, security: "TEST BOND",
      date: "2026-08-12", type: "CORPORATE ACTION", description: "CORPORATE ACTION",
      quantity: 10, openingPaise: 1000, creditPaise: 0, debitPaise: 1000,
      closingPaise: 0 }],
    counts: { rows: 1, quarantined: 0 }, printedTotalPaise: null,
  };
  const args = { parsed, existing: [], holdings: [holding], asOf: "2026-08-31",
    confirmed: true, assetId: "demat-a", accounts: [ACCOUNT], route: true };
  const signature = (plan) => plan.rows.map((row) =>
    `${row.security_id}|${row.quantity}|${row.disposed_at || ""}`).sort();
  const first = casReplacePlan(args);
  const second = casReplacePlan({ ...args, existing: first.rows });
  assert.deepEqual(signature(first), signature(second));
});

// --- the third review round --------------------------------------------------

test("a reflected sale records the printed units, not the post-sale remainder", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 40, cost_paise: 40000, value_paise: 400000, as_of: "2026-08-31" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 60,
    openingPaise: 10000, creditPaise: 0, debitPaise: 6000, closingPaise: 4000 }],
  { asOf: "2026-09-30" });
  assert.equal(result.sold.length, 1);
  assert.equal(result.sold[0].disposed_quantity, 60);
  assert.equal(result.sold[0].disposed_cost_paise, 60000);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.rows.find((row) => !row.disposed_at).quantity, 40);
  assert.deepEqual(result.applied.map((event) => [event.status, event.from, event.to]),
    [["reflected", 40, 40]]);
});

test("a full sale and a re-buy restarts the lot through the sold record", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 100, cost_paise: 100000, value_paise: 1000000, face_paise: 10000000,
    as_of: "2026-08-01" }];
  const events = [
    { isin: ISIN_A, security: "TEST BOND", date: "2026-08-12", type: "SALE",
      description: "SALE", quantity: 100, openingPaise: 10000, creditPaise: 0,
      debitPaise: 10000, closingPaise: 0 },
    { isin: ISIN_A, security: "TEST BOND", date: "2026-08-20", type: "PURCHASE",
      description: "PURCHASE", quantity: 50, openingPaise: 0, creditPaise: 5000,
      debitPaise: 0, closingPaise: 5000 },
  ];
  const result = applyCasEvents(rows, events, { asOf: "2026-08-31" });
  const live = result.rows.find((row) => !row.disposed_at);
  assert.equal(live.quantity, 50);
  assert.equal(live.cost_paise, null);
  assert.equal(live.face_paise, 10000000);
  assert.equal(live.purchase_date, "2026-08-20");
  assert.equal(result.sold.length, 1);
  assert.equal(result.sold[0].disposed_quantity, 100);
});

// --- the fourth review round -------------------------------------------------

test("a reflected partial sale prices the printed units once", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 60, cost_paise: 60000, value_paise: 600000, as_of: "2026-08-31" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 40,
    openingPaise: 10000, creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
  { asOf: "2026-09-30" });
  assert.equal(result.sold.length, 1);
  assert.equal(result.sold[0].disposed_quantity, 40);
  assert.equal(result.sold[0].disposed_cost_paise, 40000);
  assert.equal(result.rows.find((row) => !row.disposed_at).quantity, 60);
  assert.equal(result.rows.find((row) => !row.disposed_at).cost_paise, 60000);
  assert.equal(result.conflicts.length, 0);
});

test("a reflected fund redemption prices the printed units once", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST FUND", category: "mf",
    quantity: 150, cost_paise: 500000, value_paise: 500000, as_of: "2026-08-31" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, date: "2026-08-16",
    type: "REDEMPTION", description: "REDEMPTION", side: "debit", quantity: 50,
    creditPaise: null, debitPaise: null, closingPaise: null }], { asOf: "2026-08-31" });
  assert.equal(result.sold[0].disposed_quantity, 50);
  assert.equal(result.sold[0].disposed_cost_paise, 166667);
  assert.equal(result.rows.find((row) => !row.disposed_at).quantity, 150);
  assert.equal(result.conflicts.length, 0);
});

test("a reflected sale on a post-sale row costs the printed units, not the ratio twice", () => {
  const rows = [{ security_id: ISIN_A, label: "TEST BOND", category: "bond",
    quantity: 50, cost_paise: 50000, value_paise: 500000, as_of: "2026-08-31" }];
  const result = applyCasEvents(rows, [{ isin: ISIN_A, security: "TEST BOND",
    date: "2026-08-12", type: "SALE", description: "SALE", quantity: 20,
    openingPaise: 7000, creditPaise: 0, debitPaise: 2000, closingPaise: 5000 }],
  { asOf: "2026-09-30" });
  assert.equal(result.sold[0].disposed_quantity, 20);
  assert.equal(result.sold[0].disposed_cost_paise, 20000);
  assert.equal(result.rows.find((row) => !row.disposed_at).quantity, 50);
});
