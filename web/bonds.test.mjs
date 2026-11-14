import test from "node:test";
import assert from "node:assert/strict";
import { parseBondLabel, inferFace, bondAnalytics, bondSummary, accruedInterest,
  BOND_RATINGS, bondRatingRank, bondFillPlan, bondGrade, bondRatingChange,
  carryBrokerFields, soldGain, bondHomeOf, isLiveBondRow } from "./bonds.js";

test("parses the coupon and maturity from a bond label", () => {
  const p = parseBondLabel("10.25% TEST ISSUER PRIVATE LIMITED 31 DEC 2026");
  assert.equal(p.couponPct, 10.25);
  assert.equal(p.maturity, "2026-12-31");
});

test("a four-letter month still names the same date", () => {
  assert.equal(parseBondLabel("9.95% INE000000018 26 Sept 2026").maturity, "2026-09-26");
  assert.equal(parseBondLabel("9.95% TEST 26 September 2026").maturity, "2026-09-26");
});

test("a label with a date but no coupon still gives the maturity", () => {
  const p = parseBondLabel("B.N. TESTAGRI LIMITED 27 Nov 2028");
  assert.equal(p.couponPct, null);
  assert.equal(p.maturity, "2028-11-27");
  assert.equal(bondAnalytics({ label: "B.N. TESTAGRI LIMITED 27 Nov 2028",
    quantity: 30, cost_paise: 22069928, purchase_date: "2025-02-12" }), null);
});

test("infers the face value from the cost per unit", () => {
  assert.equal(inferFace(9982008, 1), 100000);
  assert.equal(inferFace(20574470, 1), 200000);
  assert.equal(inferFace(10288816, 100), 1000);
  assert.equal(inferFace(19529612, 20), 10000);
});

test("purchase yield and gain to maturity for the test issuer lot", () => {
  const a = bondAnalytics({
    label: "10.25% TEST ISSUER PRIVATE LIMITED 31 DEC 2026",
    security_id: "INE000000017", quantity: 1, cost_paise: 9982008,
    value_paise: 9982008, purchase_date: "2024-02-15",
  });
  assert.equal(a.face, 100000);
  assert.ok(Math.abs(a.price - 99.82008) < 0.0001);
  assert.ok(a.ytm > 10 && a.ytm < 10.6, `ytm ${a.ytm}`);
  assert.ok(a.couponIncome > 2900000 && a.couponIncome < 3000000);
  assert.ok(Math.abs(a.capitalGain - 17992) < 1);
  assert.ok(a.totalGain > 2950000 && a.totalGain < 3000000);
  assert.equal(a.hasMarket, false);
});

test("a market value gives the current price and gain", () => {
  const a = bondAnalytics({
    label: "10.25% TESTU CAPITAL LIMITED 24 OCT 2026",
    quantity: 200, cost_paise: 19817350, value_paise: 19922096,
    purchase_date: "2025-10-01",
  });
  assert.equal(a.face, 1000);
  assert.equal(a.hasMarket, true);
  assert.ok(a.marketPrice > 99 && a.marketPrice < 100);
  assert.ok(a.currentGain > 0);
});

test("a part-redeemed bond is priced on the principal still outstanding", () => {
  const a = bondAnalytics({
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 19527582,
    value_paise: 6000000, purchase_date: "2024-06-06",
    future_interest_paise: 97808, future_principal_paise: 10000000,
    returned_paise: 10000000, principal_dates: "2026-12-03",
  });
  assert.equal(a.purchaseFaceTotal, 20000000);
  assert.equal(a.faceTotal, 10000000);
  assert.equal(a.face, 50000);
  assert.ok(Math.abs(a.price - 97.63791) < 0.001);
  // 60,000 value on 1,00,000 still outstanding, not on the 2,00,000 bought.
  assert.ok(Math.abs(a.marketPrice - 60) < 0.01);
  // 1,00,000 still to come + 1,00,000 already back - 1,95,275.82 paid.
  assert.ok(Math.abs(a.capitalGain - 472418) < 2);
});

test("a face fetched after a part return is read as the current face, not the purchase face", () => {
  // The T3 preview ledger held the face SMEST prints today (50,000 per unit)
  // with no returned principal and no payout schedule. The cost and units imply
  // a 1,00,000 face, so 1,00,000 came back and the old yield read -17.84%.
  const a = bondAnalytics({
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 19527582,
    value_paise: 6000000, purchase_date: "2024-06-06", face_paise: 5000000,
    frequency: "Monthly", interest_date: "2026-12-03",
    redemption_dates: "2026-06-03,2026-12-03",
  });
  assert.equal(a.purchaseFaceTotal, 20000000);
  assert.equal(a.faceTotal, 10000000);
  assert.equal(a.returned, 10000000);
  assert.ok(Math.abs(a.price - 97.63791) < 0.001);
  assert.ok(a.ytm > 11.5 && a.ytm < 12.1, `ytm ${a.ytm}`);
  assert.ok(Math.abs(a.capitalGain - 472418) < 2);
  assert.ok(Math.abs(a.currentYield - 19.83) < 0.02);
  assert.ok(Math.abs(a.marketPrice - 60) < 0.01);
  assert.ok(Math.abs(a.futureCoupon - 99167) < 2, `future ${a.futureCoupon}`);
  assert.ok(a.lifetimeTotal > 25000000 && a.lifetimeTotal < 25600000,
    `total ${a.lifetimeTotal}`);
  assert.ok(a.lifetimeGain > 5500000 && a.lifetimeGain < 6000000,
    `gain ${a.lifetimeGain}`);
  // Selling the whole position: 60,000 value + 1,00,000 back - 1,95,275.82.
  assert.equal(6000000 + a.returned - 19527582, -3527582);
});

test("coupon progress is measured against the original face", () => {
  const a = bondAnalytics({
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 19527582,
    value_paise: 6000000, purchase_date: "2024-06-06", face_paise: 5000000,
    frequency: "Monthly", interest_date: "2026-12-03",
    redemption_dates: "2026-06-03,2026-12-03",
  });
  // 30 monthly coupons on 2,00,000 at 11.9% is 59,500; the early repayment
  // removes 6,166 from the rest of the schedule.
  assert.ok(a.originalCouponEstimate > 5900000 && a.originalCouponEstimate < 6000000,
    `original ${a.originalCouponEstimate}`);
  assert.ok(a.couponProgress > 87 && a.couponProgress < 89,
    `progress ${a.couponProgress}`);
  assert.ok(a.couponLost > 600000 && a.couponLost < 630000,
    `lost ${a.couponLost}`);
  assert.equal(a.pastCoupon, a.couponEstimate - a.futureCoupon);
});

test("gain if sold includes the coupons already received", () => {
  const a = bondAnalytics({
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 19527582,
    value_paise: 6000000, purchase_date: "2024-06-06", face_paise: 5000000,
    frequency: "Monthly", interest_date: "2026-12-03",
    redemption_dates: "2026-06-03,2026-12-03",
  });
  const gain = soldGain(a);
  assert.equal(gain, a.value + a.returned + a.pastCoupon + a.accrued - a.cost);
  assert.ok(gain > 0, `gain ${gain}`);
});

test("a part-redeemed lookup stores the purchase face and the money already back", () => {
  const plan = bondFillPlan({ quantity: 2, cost_paise: 19527582 },
    { details: { face: 50000 }, market: null });
  assert.equal(plan.patch.face_paise, 10000000);
  assert.equal(plan.patch.returned_paise, 10000000);
  assert.equal(plan.patch.returned_source, "smest");
  assert.equal(plan.terms, true);
});

test("a BSE quote uses the remaining face after a part redemption", () => {
  const plan = bondFillPlan({ quantity: 2, cost_paise: 19527582,
    future_principal_paise: 10000000 },
  { details: null, market: { ltp: 60, date: "2026-11-09" } });
  assert.equal(plan.patch.value_paise, 6000000);
  assert.equal(plan.patch.value_source, "BSE");
  assert.equal(plan.patch.as_of, "2026-11-09");
});

test("selling one of two bonds halves the schedule and the repayment", () => {
  const c = carryBrokerFields({
    quantity: 2, returned_paise: 10000000, future_principal_paise: 10000000,
    future_interest_paise: 97808, payout_paise: 97808,
    yield_bps: 1400, rating: "ICRA BBB / Stable", interest_date: "2026-12-03",
    redemption_dates: "2026-06-03,2026-12-03",
  }, 1);
  assert.equal(c.returned_paise, 5000000);
  assert.equal(c.future_principal_paise, 5000000);
  assert.equal(c.future_interest_paise, 48904);
  assert.equal(c.payout_paise, 48904);
  assert.equal(c.yield_bps, 1400);
  assert.equal(c.rating, "ICRA BBB / Stable");
  assert.equal(c.interest_date, "2026-12-03");
  assert.equal(c.redemption_dates, "2026-06-03,2026-12-03");
});

test("buying one more keeps the repayment already received", () => {
  const c = carryBrokerFields({
    quantity: 2, returned_paise: 10000000, future_principal_paise: 10000000,
  }, 3);
  assert.equal(c.returned_paise, 10000000);
  assert.equal(c.future_principal_paise, 15000000);
});

test("accrued interest is the part of the next coupon already earned", () => {
  const a = accruedInterest(1190000, "Monthly", "2026-12-03", "2026-11-11");
  assert.equal(a.from, "2026-11-03");
  assert.equal(a.to, "2026-12-03");
  assert.ok(Math.abs(a.accrued - 26082) < 2, `accrued ${a.accrued}`);
  // On the coupon day the new period starts at zero.
  assert.equal(accruedInterest(1190000, "Monthly", "2026-12-03", "2026-11-03").accrued, 0);
  // On the payment day itself the slice is not meaningful.
  assert.equal(accruedInterest(1190000, "Monthly", "2026-12-03", "2026-12-03").accrued, null);
});

test("the stored face value beats the cost heuristic", () => {
  const a = bondAnalytics({
    label: "9.75% TESTC 27 NOV 2028", quantity: 10, cost_paise: 7356643,
    value_paise: 9385020, purchase_date: "2025-02-12", face_paise: 1000000,
    frequency: "Quarterly", interest_date: "2026-11-27",
    future_principal_paise: 10000000,
  });
  assert.equal(a.purchaseFaceTotal, 10000000); // 10 × ₹10,000, not the ₹5,000 guess
  assert.equal(a.faceInferred, false);
  assert.ok(a.ytm > 18 && a.ytm < 20.5, `ytm ${a.ytm}`);
  assert.ok(Math.abs(a.currentYield - 10.39) < 0.05, `current ${a.currentYield}`);
  // Without the stored face, the old heuristic misreads the same lot.
  const legacy = bondAnalytics({
    label: "9.75% TESTC 27 NOV 2028", quantity: 10, cost_paise: 7356643,
    value_paise: 9385020, purchase_date: "2025-02-12",
    frequency: "Quarterly", interest_date: "2026-11-27",
  });
  assert.equal(legacy.faceInferred, true);
  assert.equal(legacy.face, 5000);
});

test("a lookup stores the face value SMEST prints", () => {
  const plan = bondFillPlan({ quantity: 10, cost_paise: 7356643 },
    { details: { face: 10000 }, market: null });
  assert.equal(plan.patch.face_paise, 1000000);
  assert.equal(plan.terms, true);
});

test("lifetime gain includes the coupons already received", () => {
  const a = bondAnalytics({
    label: "11.9% TESTD 03 Dec 2026", quantity: 2, cost_paise: 19527582,
    value_paise: 6000000, purchase_date: "2024-06-06",
    future_interest_paise: 97808, future_principal_paise: 10000000,
    returned_paise: 10000000, principal_dates: "2026-12-03",
    redemption_dates: "2026-06-03,2026-12-03",
  });
  // Coupons before June 2026 on 2L, after on 1L, plus the 2L principal.
  assert.ok(a.lifetimeTotal > 25000000 && a.lifetimeTotal < 26000000,
    `total ${a.lifetimeTotal}`);
  assert.ok(a.lifetimeGain > 5500000 && a.lifetimeGain < 6500000,
    `gain ${a.lifetimeGain}`);
});

test("summarizes a portfolio of bond lots", () => {
  const s = bondSummary([
    { label: "10.25% TEST ISSUER PRIVATE LIMITED 31 DEC 2026",
      quantity: 1, cost_paise: 9982008, value_paise: 9982008,
      purchase_date: "2024-02-15" },
    { label: "10.50% TESTH 03 JUL 2029",
      quantity: 100, cost_paise: 10288816, value_paise: 10288816,
      purchase_date: "2025-12-11" },
  ]);
  assert.equal(s.count, 2);
  assert.ok(s.ytm > 8 && s.ytm < 11);
  assert.ok(s.couponIncome > 0);
  assert.ok(s.totalGain > s.couponIncome - 500000);
});

test("a rating sorts by its grade, with or without the agency", () => {
  assert.equal(bondRatingRank("AAA"), 0);
  assert.equal(bondRatingRank("CRISIL A / Stable"), BOND_RATINGS.indexOf("A"));
  assert.equal(bondRatingRank("ICRA AA+"), BOND_RATINGS.indexOf("AA+"));
  assert.equal(bondRatingRank("ACUITE BB+(CE)"), BOND_RATINGS.indexOf("BB+"));
  assert.equal(bondRatingRank("a"), BOND_RATINGS.indexOf("A"));
  // A better grade must rank lower than a worse one.
  assert.ok(bondRatingRank("CRISIL AA") < bondRatingRank("BWR BBB-"));
  assert.equal(bondRatingRank(""), 999);
  assert.equal(bondRatingRank("not rated"), 999);
});

test("a bulk fetch fills only what the lot is missing", () => {
  const fetched = {
    details: {
      face: 100000, frequency: "Monthly", nextInterest: "2026-11-30",
      rating: { text: "CRISIL A / Stable" }, ltp: 99.93,
    },
    market: { ltp: 99.93, date: "2026-10-16" },
  };
  const empty = { quantity: 2, cost_paise: 20000000, rating: "", frequency: "", interest_date: "" };
  const plan = bondFillPlan(empty, fetched);
  assert.equal(plan.patch.rating, "CRISIL A / Stable");
  assert.equal(plan.patch.frequency, "Monthly");
  assert.equal(plan.patch.interest_date, "2026-11-30");
  assert.equal(plan.patch.value_paise, 19986000);
  assert.equal(plan.terms, true);
  assert.equal(plan.priced, true);
  assert.equal(plan.unread, false);
});

test("a lot that already has a rating and frequency keeps them, unless the grade moved", () => {
  const same = {
    details: { face: 100000, frequency: "Quarterly", nextInterest: "2026-11-30",
      rating: { text: "A" } },
    market: null,
  };
  const kept = bondFillPlan(
    { quantity: 1, cost_paise: 9900000, face_paise: 10000000, rating: "A",
      frequency: "Monthly", interest_date: "2026-12-01" }, same);
  assert.deepEqual(kept.patch, {});
  assert.equal(kept.terms, false);
  assert.equal(kept.ratingChanged, false);

  // A different grade is the one thing a bulk fetch is allowed to replace:
  // `rating` is today's grade, and the baseline is kept separately.
  const moved = bondFillPlan(
    { quantity: 1, cost_paise: 9900000, face_paise: 10000000, rating: "AA",
      frequency: "Monthly", interest_date: "2026-12-01" }, same);
  assert.deepEqual(moved.patch, { rating: "A" });
  assert.equal(moved.ratingChanged, true);
  assert.equal(moved.added, false);
  assert.equal(moved.terms, true);
});

test("a lookup adds the issuer name, and a correction replaces a short one", () => {
  const details = { issuer: "Test Capital Advisors Private Limited" };
  const blank = bondFillPlan({ quantity: 1, cost_paise: 10000000, issuer: "" },
    { details, market: null });
  assert.equal(blank.patch.issuer, "Test Capital Advisors Private Limited");
  assert.equal(blank.terms, true);
  const short = bondFillPlan({ quantity: 1, cost_paise: 10000000, issuer: "TESTD" },
    { details, market: null });
  assert.equal(short.patch.issuer, "Test Capital Advisors Private Limited");
});

test("a lookup stores the redemption dates SMEST prints", () => {
  const plan = bondFillPlan({ quantity: 2, cost_paise: 19527582 },
    { details: { redemptions: ["2026-06-03", "2026-12-03"] }, market: null });
  assert.equal(plan.patch.redemption_dates, "2026-06-03,2026-12-03");
  assert.equal(plan.terms, true);
});

test("no units or no price means no market value, and nothing at all means unread", () => {
  const fetched = { details: { face: 100000 }, market: null };
  assert.equal(bondFillPlan({ quantity: 0 }, fetched).priced, false);
  assert.equal(bondFillPlan({ quantity: 2, cost_paise: 20000000 },
    { details: null, market: null }).unread, true);
});

test("a rating that moved is reported with both grades", () => {
  assert.deepEqual(bondRatingChange("AA", "CRISIL A+"), { from: "AA", to: "A+", down: true });
  assert.deepEqual(bondRatingChange("A", "AA"), { from: "A", to: "AA", down: false });
  // Same grade, different agency or outlook: not a change.
  assert.equal(bondRatingChange("CRISIL A / Stable", "ICRA A / Negative"), null);
  assert.equal(bondRatingChange("", "AA"), null);
  assert.equal(bondRatingChange("AA", ""), null);
  assert.equal(bondRatingChange("not rated", "AA"), null);
});

test("the grade is read out of whatever the field holds", () => {
  assert.equal(bondGrade("CRISIL A / Stable"), "A");
  assert.equal(bondGrade("BB+(CE)"), "BB+");
  assert.equal(bondGrade("aa-"), "AA-");
  assert.equal(bondGrade(""), "");
});

test("an imported schedule beats the face-value estimate and knows the parts", () => {
  const a = bondAnalytics({
    label: "9.75% B N TESTAGRI LIMITED 27 NOV 2028", quantity: 20, cost_paise: 19500000,
    purchase_date: "2025-11-27",
    future_interest_paise: 4500000, future_principal_paise: 20000000,
    principal_dates: "2028-02-27,2028-05-27,2028-08-27,2028-11-27",
  });
  assert.equal(a.schedule.parts, 4);
  assert.equal(a.schedule.total, 24500000);
  assert.equal(a.schedule.gain, 24500000 - 19500000);
  // Without a schedule the old estimate still stands.
  const b = bondAnalytics({
    label: "9.75% B N TESTAGRI LIMITED 27 NOV 2028", quantity: 20, cost_paise: 19500000,
    purchase_date: "2025-11-27",
  });
  assert.equal(b.schedule, null);
});

test("a schedule that promises less than was paid has no gain", () => {
  const a = bondAnalytics({
    label: "12.00% TESTG 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    purchase_date: "2024-09-26",
    future_interest_paise: 297534, future_principal_paise: 5000000,
    principal_dates: "2027-03-23",
  });
  assert.equal(a.schedule.total, 5297534);
  assert.equal(a.schedule.short, true);
  // The face-value estimate would have said 1,00,000 + interest; the imported
  // sheet says half the principal is missing, so no gain is claimed.
  const b = bondAnalytics({
    label: "12.00% TESTG 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    future_interest_paise: 297534, future_principal_paise: 10000000,
  });
  assert.equal(b.schedule.short, false);
});

test("principal already returned counts towards the gain", () => {
  const a = bondAnalytics({
    label: "12.00% TESTG 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    future_interest_paise: 297534, future_principal_paise: 5000000,
    principal_dates: "2027-03-23", returned_paise: 5000000,
  });
  assert.equal(a.schedule.returned, 5000000);
  assert.equal(a.schedule.gain, 5000000 + 297534 + 5000000 - 9859863);
  assert.equal(a.schedule.short, false);
});

test("a cost portfolio resolves to its demat by link, number, then ISIN overlap", () => {
  const demats = [
    { id: "d1", category: "demat", number: "IN99990001344321" },
    { id: "d2", category: "demat", number: "IN99990005344322" },
  ];
  const positionsOf = new Map([
    ["d1", [{ security_id: "INE000000001" }]],
    ["d2", [{ security_id: "INE000000002" }]],
  ]);
  assert.equal(bondHomeOf([], { id: "p1",
    meta: JSON.stringify({ linked_asset: "d1" }) }, demats, positionsOf), "d1");
  assert.equal(bondHomeOf([], { id: "p1", number: "IN99990005344322" },
    demats, positionsOf), "d2");
  assert.equal(bondHomeOf([{ security_id: "INE000000001" }], { id: "p1" },
    demats, positionsOf), "d1");
  assert.equal(bondHomeOf([{ security_id: "INE000000009" }], { id: "p1" },
    demats, positionsOf), "");
});

test("a disposed row is not a live bond", () => {
  assert.equal(isLiveBondRow({ category: "bond", quantity: 0 }), true);
  assert.equal(isLiveBondRow({ category: "bond", disposed_at: "2026-08-12" }), false);
  assert.equal(isLiveBondRow({ category: "equity" }), false);
});
