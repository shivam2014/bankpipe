import test from "node:test";
import assert from "node:assert/strict";
import { casApplyRows, casClosedRow, casHoldingLabel, casImportHoldings,
  casReplacePlan, casSafety } from "./cas-apply.js";

const ISIN_A = "INE000000031";
const ISIN_B = "INE000000032";

const existingBroker = (over = {}) => ({
  security_id: ISIN_A, label: "9.00% TEST BOND 31 Dec 2027", category: "bond",
  quantity: 100, cost_paise: 200000, value_paise: 1000000,
  purchase_date: "2024-06-06", frequency: "Annual", payout_paise: 100000,
  value_source: "motilal", as_of: "2026-11-05", source: "report", ...over,
});

const casHolding = (over = {}) => ({
  isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 40,
  valuePaise: 400000, couponPct: 9, maturity: "2027-12-31", ...over,
});

test("a CAS row takes quantity and value while the broker cost and purchase date carry", () => {
  const plan = casApplyRows({
    existing: [existingBroker()], holdings: [casHolding()],
    asOf: "2026-10-31", preserveAbsent: false,
  });
  assert.equal(plan.rows.length, 1);
  const row = plan.rows[0];
  assert.equal(row.security_id, ISIN_A);
  assert.equal(row.quantity, 40);
  assert.equal(row.value_paise, 400000);
  assert.equal(row.value_source, "CAS");
  assert.equal(row.cost_paise, 200000);
  assert.equal(row.purchase_date, "2024-06-06");
  assert.equal(row.frequency, "Annual");
  assert.equal(row.payout_paise, 40000);
  assert.equal(row.as_of, "2026-10-31");
  assert.equal(plan.carried, 1);
});

test("a quantity move with no cost in the statement keeps the last known cost", () => {
  const plan = casApplyRows({
    existing: [existingBroker()], holdings: [casHolding()],
    asOf: "2026-10-31", preserveAbsent: false,
  });
  assert.equal(plan.rows[0].quantity, 40);
  assert.equal(plan.rows[0].cost_paise, 200000);
  assert.equal(plan.rows[0].purchase_date, "2024-06-06");
  assert.equal(plan.carried, 1);
});

test("a debit movement still allocates the cost of the units it removes", () => {
  const parsed = {
    asOf: "2026-11-05",
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 8,
      valuePaise: 800000 }],
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-11-03",
      type: "SALE", description: "SALE", quantity: 2, openingPaise: 10000,
      creditPaise: 0, debitPaise: 2000, closingPaise: 8000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: null,
  };
  const plan = casReplacePlan({ parsed, existing: [existingBroker({ quantity: 10,
    cost_paise: 100000 })], holdings: parsed.holdings, asOf: "2026-11-05",
  assetId: "demat-a" });
  const live = plan.rows.find((row) => !row.disposed_at);
  const sold = plan.rows.find((row) => row.disposed_at);
  assert.equal(live.quantity, 8);
  assert.equal(live.cost_paise, 80000);
  assert.equal(sold.disposed_quantity, 2);
  assert.equal(sold.disposed_cost_paise, 20000);
});

test("a CAS label carries the coupon and the maturity", () => {
  assert.equal(casHoldingLabel(casHolding()),
    "9% TEST BOND 31 Dec 2027");
});

test("a label that already ends in a September date is not given a second one", () => {
  // Node's en-IN renders September as "Sept", four letters. A three-letter
  // guard missed it and appended the same date in its "Sep" form. A dated label
  // is returned as written, which is the existing contract.
  assert.equal(casHoldingLabel(casHolding({ label: "TEST BOND 15 Sept 2029",
    maturity: "2029-09-15" })), "TEST BOND 15 Sept 2029");
  assert.equal(casHoldingLabel(casHolding({ label: "TEST BOND 15 September 2029",
    maturity: "2029-09-15" })), "TEST BOND 15 September 2029");
});

test("an absent row is preserved by default and dropped only for a complete confirmed replace", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, label: "8.00% OTHER BOND 31 Dec 2028" })];
  const holdings = [casHolding()];
  const kept = casApplyRows({ existing, holdings, asOf: "2026-10-31",
    preserveAbsent: true });
  assert.equal(kept.rows.length, 2);
  assert.equal(kept.absent.length, 1);
  assert.equal(kept.absent[0].isin, ISIN_B);
  assert.equal(kept.dropped.length, 0);

  const replaced = casApplyRows({ existing, holdings, asOf: "2026-10-31",
    preserveAbsent: false });
  assert.equal(replaced.rows.length, 1);
  assert.equal(replaced.absent.length, 0);
  assert.equal(replaced.dropped.length, 1);
  assert.equal(replaced.dropped[0].isin, ISIN_B);
});

test("a row bought after the statement date is kept even in a complete replace", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, purchase_date: "2026-11-02" })];
  const plan = casApplyRows({ existing, holdings: [casHolding()],
    asOf: "2026-10-31", preserveAbsent: false });
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.keptNewer, 1);
  assert.equal(plan.dropped.length, 0);
});

test("a quarantined CAS is blocked and leaves the existing rows untouched", () => {
  const existing = [existingBroker()];
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 100 }],
    counts: { rows: 1, quarantined: 2 },
    printedTotalPaise: null,
  };
  const safety = casSafety(parsed);
  assert.equal(safety.blocked, true);
  assert.equal(safety.complete, false);
  const plan = casReplacePlan({ parsed, existing, holdings: [casHolding()],
    asOf: "2026-10-31", confirmed: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.rows, existing);
  assert.equal(plan.dropped.length, 0);
  assert.match(plan.safety.reasons.join(" "), /could not be read/i);
});

test("a printed total that disagrees with the rows blocks the replace", () => {
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: 500000,
  };
  const safety = casSafety(parsed);
  assert.equal(safety.blocked, true);
  assert.equal(safety.totals.ok, false);
  assert.equal(safety.totals.diffPaise, -100000);
  // The explicit no-total override is not a way past a printed mismatch.
  const plan = casReplacePlan({ parsed, existing: [existingBroker()],
    holdings: parsed.holdings, asOf: "2026-10-31", confirmed: true,
    replaceWithoutTotal: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.blocked, true);
});

test("a statement with no printed total cannot remove a row, and names what a replace would", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, label: "8.00% OTHER BOND 31 Dec 2028",
      value_paise: 250000 })];
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: null,
  };
  const safety = casSafety(parsed);
  // Not a refusal: the rows the file does name are still worth recording.
  assert.equal(safety.blocked, false);
  assert.equal(safety.totalPrinted, false);
  assert.equal(safety.complete, false);
  assert.match(safety.note, /prints no total/i);

  const plan = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-10-31", confirmed: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.preserveAbsent, true);
  assert.equal(plan.dropped.length, 0);
  assert.deepEqual(plan.rows.map((row) => row.security_id).sort(),
    [ISIN_A, ISIN_B]);
  // The dialog can name exactly what the choice would delete.
  assert.deepEqual(plan.wouldDrop.map((row) => row.isin), [ISIN_B]);
  assert.equal(plan.wouldDrop[0].value_paise, 250000);
  assert.equal(plan.wouldDropPaise, 250000);
});

test("the no-total replace needs the explicit override and removes those rows", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, value_paise: 250000 })];
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: null,
  };
  const plan = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-10-31", confirmed: true, replaceWithoutTotal: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.preserveAbsent, false);
  assert.deepEqual(plan.dropped.map((row) => row.isin), [ISIN_B]);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].security_id, ISIN_A);
});

test("the override belongs to one plan and is not inherited by the next", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, value_paise: 250000 })];
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: null,
  };
  const asked = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-10-31", confirmed: true, replaceWithoutTotal: true });
  const next = casReplacePlan({ parsed, existing, holdings: parsed.holdings,
    asOf: "2026-10-31", confirmed: true });
  assert.equal(asked.preserveAbsent, false);
  assert.equal(next.preserveAbsent, true);
  assert.equal(next.dropped.length, 0);
});

test("a holdings-only statement with no total still records its rows in an empty account", () => {
  // An absolute block would strand this file: with no rows on file, nothing can
  // be deleted, and the four holdings it does name are worth keeping.
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: null,
  };
  assert.equal(casSafety(parsed).blocked, false);
  const plan = casReplacePlan({ parsed, existing: [], holdings: parsed.holdings,
    asOf: "2026-10-31", confirmed: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].security_id, ISIN_A);
});

test("the preview and the writer agree on absent rows", () => {
  const existing = [existingBroker(),
    existingBroker({ security_id: ISIN_B, label: "8.00% OTHER BOND 31 Dec 2028" })];
  const parsed = {
    holdings: [{ isin: ISIN_A, valuePaise: 400000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: 400000,
  };
  const preview = casReplacePlan({ parsed, existing, holdings: [casHolding()],
    asOf: "2026-10-31", confirmed: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.preserveAbsent, true);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.dropped.length, 0);

  const write = casReplacePlan({ parsed, existing, holdings: [casHolding()],
    asOf: "2026-10-31", confirmed: true });
  assert.equal(write.ok, true);
  assert.equal(write.preserveAbsent, false);
  assert.equal(write.rows.length, 1);
  assert.equal(write.dropped.length, 1);
});

// --- rows on file -----------------------------------------------------------

test("a sold row never shadows the live cost of the same ISIN", () => {
  const live = existingBroker({ quantity: 60, cost_paise: 120000 });
  const sold = { security_id: ISIN_A, label: "9.00% TEST BOND 31 Dec 2027",
    category: "bond", quantity: 0, cost_paise: 0, value_paise: 0,
    disposed_at: "2026-08-12", disposed_quantity: 40, disposed_type: "sale",
    txn_key: "sale-key" };
  const plan = casApplyRows({ existing: [live, sold],
    holdings: [casHolding({ quantity: 60 })], asOf: "2026-10-31" });
  const kept = plan.rows.find((row) => !row.disposed_at);
  assert.equal(kept.quantity, 60);
  assert.equal(kept.cost_paise, 120000);
  assert.equal(kept.purchase_date, "2024-06-06");
  assert.equal(plan.rows.filter((row) => row.disposed_at).length, 1);
});

test("a manual holding with a partial sale keeps its remaining units and source", () => {
  const manual = { security_id: ISIN_A, label: "MANUAL BOND", category: "bond",
    quantity: 100, cost_paise: 200000, value_paise: 1000000, as_of: "2026-07-31",
    source: "manual" };
  const parsed = {
    holdings: [],
    asOf: "2026-08-31",
    transactions: [{ isin: ISIN_A, security: "MANUAL BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
    counts: { rows: 0, quarantined: 0 },
    printedTotalPaise: null,
  };
  const plan = casReplacePlan({ parsed, existing: [manual], holdings: [],
    asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  const live = plan.rows.find((row) => !row.disposed_at);
  const sold = plan.rows.find((row) => row.disposed_at);
  assert.equal(live.quantity, 60);
  assert.equal(live.source, "manual");
  assert.equal(sold.disposed_quantity, 40);
  assert.equal(sold.disposed_cost_paise, 80000);
});

test("a movements-only statement never drops a live row it does not name", () => {
  const parsed = {
    holdings: [],
    asOf: "2026-08-31",
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 100, openingPaise: 10000,
      creditPaise: 0, debitPaise: 10000, closingPaise: 0 }],
    counts: { rows: 0, quarantined: 0 },
    printedTotalPaise: null,
  };
  const other = existingBroker({ security_id: ISIN_B, label: "8.00% OTHER BOND",
    quantity: 200, cost_paise: 200000 });
  const plan = casReplacePlan({ parsed, existing: [existingBroker(), other],
    holdings: [], asOf: "2026-08-31", confirmed: true, assetId: "demat-a" });
  assert.equal(plan.preserveAbsent, true);
  assert.equal(plan.dropped.length, 0);
  const kept = plan.rows.find((row) => row.security_id === ISIN_B && !row.disposed_at);
  assert.equal(kept.quantity, 200);
  assert.equal(plan.sold.length, 1);
  assert.equal(plan.sold[0].security_id, ISIN_A);
});

test("the plan takes its date from the parsed statement when asOf is omitted", () => {
  const parsed = {
    holdings: [{ isin: ISIN_A, label: "TEST BOND", kind: "bond", quantity: 100,
      valuePaise: 10000000, couponPct: 9, maturity: "2028-12-31" }],
    asOf: "2026-08-31",
    transactions: [{ isin: ISIN_A, security: "TEST BOND", date: "2026-08-12",
      type: "SALE", description: "SALE", quantity: 40, openingPaise: 10000,
      creditPaise: 0, debitPaise: 4000, closingPaise: 6000 }],
    counts: { rows: 1, quarantined: 0 },
    printedTotalPaise: 10000000,
  };
  const plan = casReplacePlan({ parsed, existing: [existingBroker()],
    holdings: parsed.holdings, confirmed: true, assetId: "demat-a" });
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].message, /still shows 100 units/);
});

// --- the second review round -------------------------------------------------

test("a CAS holding keeps a manual row's source", () => {
  const manual = { security_id: ISIN_A, label: "MANUAL BOND", category: "bond",
    quantity: 100, cost_paise: 200000, source: "manual", as_of: "2026-07-31" };
  const plan = casApplyRows({ existing: [manual],
    holdings: [casHolding({ quantity: 100 })], asOf: "2026-08-31" });
  const row = plan.rows.find((entry) => !entry.disposed_at);
  assert.equal(row.source, "manual");
});

test("an identity-only target contributes no rows to the import", () => {
  const holdingB = { isin: ISIN_B, label: "B BOND", kind: "bond", quantity: 40,
    valuePaise: 400000, account: "1200000000000002" };
  const parsed = {
    holdings: [{ isin: ISIN_A, label: "A BOND", kind: "bond", quantity: 100,
      valuePaise: 1000000, account: "1200000000000001" }, holdingB],
    accounts: [
      { boId: "1200000000000001", holdings: [parsedHoldingA()] },
      { boId: "1200000000000002", holdings: [holdingB] },
    ],
  };
  function parsedHoldingA() {
    return { isin: ISIN_A, label: "A BOND", kind: "bond", quantity: 100,
      valuePaise: 1000000, account: "1200000000000001" };
  }
  const targets = [
    { boId: "1200000000000001", plan: { identityOnly: false,
      decisions: [{ isin: ISIN_A, action: "create" }] } },
    { boId: "1200000000000002", plan: { identityOnly: true,
      decisions: [{ isin: ISIN_A, action: "create" }, { isin: ISIN_B, action: "create" }] } },
  ];
  const out = casImportHoldings({ parsed, targets });
  assert.deepEqual(out.accounts.map((account) => account.boId),
    ["1200000000000001"]);
  assert.deepEqual(out.holdings.map((holding) => holding.isin), [ISIN_A]);
});

test("a closed row is dropped but a matured zero row is history", () => {
  assert.equal(casClosedRow({ quantity: 0, valuePaise: 0, kind: "equity" }), true);
  assert.equal(casClosedRow({ quantity: 0, valuePaise: 0, kind: "bond",
    label: "9% TEST 01 Jan 2020", maturity: "2020-01-01" }), false);
  assert.equal(casClosedRow({ quantity: 5, valuePaise: 0 }), false);
});
