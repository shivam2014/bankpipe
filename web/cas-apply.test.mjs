import test from "node:test";
import assert from "node:assert/strict";
import { casApplyRows, casHoldingLabel, casReplacePlan, casSafety } from "./cas-apply.js";

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
  assert.equal(row.cost_paise, 80000);
  assert.equal(row.purchase_date, "2024-06-06");
  assert.equal(row.frequency, "Annual");
  assert.equal(row.payout_paise, 40000);
  assert.equal(row.as_of, "2026-10-31");
  assert.equal(plan.carried, 1);
});

test("a CAS label carries the coupon and the maturity", () => {
  assert.equal(casHoldingLabel(casHolding()),
    "9% TEST BOND 31 Dec 2027");
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
