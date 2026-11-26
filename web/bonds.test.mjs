import test from "node:test";
import assert from "node:assert/strict";
import { parseBondLabel, bondMaturity, splitMatured, inferFace, bondAnalytics,
  storedCoupon, termSourceKind, termSourceRank, bondWriteRow,
  bondLabelName, bondSummary, accruedInterest, BOND_RATINGS, bondRatingRank, bondFillPlan,
  bondGrade, bondRatingChange, carryBrokerFields, soldGain, bondHomeOf,
  bondInputsMissing, valueKindOf, isLiveBondRow } from "./bonds.js";

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

test("a label with a series date keeps the later maturity date", () => {
  const p = parseBondLabel("9.50% TEST SERIES 15 JAN 2020 31 DEC 2028");
  assert.equal(p.maturity, "2028-12-31");
});

test("reads the coupon and maturity out of a dashed broker name", () => {
  const p = parseBondLabel("TESTD-11.90%-3-12-26-PVT");
  assert.equal(p.couponPct, 11.9);
  assert.equal(p.maturity, "2026-12-03");
  assert.equal(p.dateUnread, false);
  // A trailing dash is the same shape.
  assert.equal(parseBondLabel("TESTE-11.4%-13-6-27-").maturity, "2027-06-13");
});

test("the dashed family is day-month-year, not month-day-year", () => {
  // The report's ISO Date column prints 2026-12-03 for 3-12-26 and 2027-06-13
  // for 13-6-27. A day above 12 in the first slot rules out M-D-Y for the whole
  // family, so 3-12-26 is read as 3 December, not 12 March.
  assert.equal(parseBondLabel("TESTD-11.90%-3-12-26-PVT").maturity, "2026-12-03");
  assert.equal(parseBondLabel("TESTE-11.4%-13-6-27-").maturity, "2027-06-13");
});

test("a two-digit dashed year follows one stated century rule", () => {
  // 00-79 are 2000-2079; 80-99 are 1980-1999.
  assert.equal(parseBondLabel("TESTF-9.5%-3-12-26-PVT").maturity, "2026-12-03");
  assert.equal(parseBondLabel("TESTF-9.5%-3-12-79-PVT").maturity, "2079-12-03");
  assert.equal(parseBondLabel("TESTF-9.5%-3-12-80-PVT").maturity, "1980-12-03");
  assert.equal(parseBondLabel("TESTF-9.5%-3-12-99-PVT").maturity, "1999-12-03");
  assert.equal(parseBondLabel("TESTF-9.5%-3-12-2026-PVT").maturity, "2026-12-03");
});

test("a dashed date that is not a real day stays unparsed", () => {
  for (const label of [
    "TESTF-11.90%-31-02-27-PVT",
    "TESTF-11.90%-3-13-27-PVT",
    "TESTF-11.90%-0-12-27-PVT",
    "TESTF-11.90%-3-12-2-PVT",
  ]) {
    const p = parseBondLabel(label);
    assert.equal(p.couponPct, 11.9, label);
    assert.equal(p.maturity, "", label);
    assert.equal(p.dateUnread, true, label);
  }
  // Without the rate the shape is not this family and is not read as a date.
  assert.equal(parseBondLabel("TEST SERIES-3-12-26"), null);
});

test("a coupon with no maturity still reaches the card", () => {
  const p = parseBondLabel("TESTF-11.90%-PVT");
  assert.equal(p.couponPct, 11.9);
  assert.equal(p.maturity, "");
  assert.equal(p.dateUnread, false);
  assert.equal(bondMaturity({ category: "bond",
    label: "TESTF-11.90%-PVT" }).maturity, "");
});

test("the issuer name keeps no terms when the label is rebuilt", () => {
  // The edit form writes `coupon% name date`, so a name that still held the
  // dashed terms would come back with them twice.
  assert.equal(bondLabelName("TESTD-11.90%-3-12-26-PVT"), "TESTD-PVT");
  assert.equal(bondLabelName("TESTE-11.4%-13-6-27-"), "TESTE");
  assert.equal(bondLabelName("TESTF-11.90%-PVT"), "TESTF-PVT");
  // The rate and its dashed date start the label, so the dashed rule has to run
  // before the leading-rate strip or the date stays behind in the name.
  assert.equal(bondLabelName("11.90%-3-12-26-PVT"), "PVT");
  assert.equal(bondLabelName("11.9% TESTD 03 Dec 2026"), "TESTD");
  assert.equal(bondLabelName("TEST SERIES-3-12-26"), "TEST SERIES-3-12-26");
});

test("a stored maturity is the source, not the first date in the name", () => {
  const row = { category: "bond", label: "9.50% TEST SERIES 15 JAN 2020 31 DEC 2028",
    maturity: "2032-05-15" };
  assert.deepEqual(bondMaturity(row),
    { maturity: "2032-05-15", source: "stored", guessed: false });
});

test("a label fallback is a named guess and ignores an earlier series date", () => {
  const terms = bondMaturity({ category: "bond",
    label: "9.50% TEST SERIES 15 JAN 2020 31 DEC 2028" });
  assert.equal(terms.maturity, "2028-12-31");
  assert.equal(terms.source, "label");
  assert.equal(terms.guessed, true);
});

test("a share or fund name with a date is not a matured bond", () => {
  assert.equal(bondMaturity({ category: "equity",
    label: "TEST EQUITY 15 JAN 2020" }).maturity, "");
});

test("a stated coupon beats the rate in the name and is not a guess", () => {
  const a = bondAnalytics({
    label: "TESTD-11.90%-3-12-26-PVT", couponPct: 9.5,
    quantity: 2, cost_paise: 20000000, purchase_date: "2024-06-06",
    frequency: "Monthly",
  });
  assert.equal(a.couponPct, 9.5);
  assert.equal(a.couponSource, "stored");
  assert.equal(a.couponGuessed, false);
});

test("a stated maturity beats the date in the name and is not a guess", () => {
  const a = bondAnalytics({
    label: "TESTD-11.90%-3-12-26-PVT", maturity: "2031-01-01",
    quantity: 2, cost_paise: 20000000, purchase_date: "2024-06-06",
    frequency: "Monthly",
  });
  assert.equal(a.maturity, "2031-01-01");
  assert.equal(a.maturitySource, "stored");
  assert.equal(a.maturityGuessed, false);
});

test("a stored term carries its own source and date", () => {
  const a = bondAnalytics({
    label: "TESTD-11.90%-3-12-26-PVT",
    coupon_pct: 9.5, coupon_source: "SMEST", coupon_as_of: "2026-11-16",
    maturity: "2031-01-01", maturity_source: "SMEST", maturity_as_of: "2026-11-16",
    quantity: 2, cost_paise: 20000000, purchase_date: "2024-06-06",
    frequency: "Monthly",
  });
  assert.equal(a.couponPct, 9.5);
  assert.equal(a.couponSource, "SMEST");
  assert.equal(a.couponAsOf, "2026-11-16");
  assert.equal(a.couponGuessed, false);
  assert.equal(a.maturitySource, "SMEST");
  assert.equal(a.maturityAsOf, "2026-11-16");
  assert.equal(a.maturityGuessed, false);
});

test("a value stored as a label guess stays marked as one", () => {
  const terms = bondMaturity({ category: "bond", label: "9.00% TEST BOND",
    maturity: "2028-12-31", maturity_source: "label" });
  assert.equal(terms.maturity, "2028-12-31");
  assert.equal(terms.source, "label");
  assert.equal(terms.guessed, true);
  const coupon = storedCoupon({ coupon_pct: 9, coupon_source: "label" });
  assert.equal(coupon.value, 9);
  assert.equal(coupon.source, "label");
  assert.equal(termSourceKind(coupon.source), "label");
});

test("term sources rank a statement above a lookup above the name", () => {
  assert.equal(termSourceRank("label"), 1);
  assert.equal(termSourceRank("SMEST"), 2);
  assert.equal(termSourceRank("BSE"), 2);
  assert.equal(termSourceRank("DigiFinn investment report"), 3);
  assert.equal(termSourceRank("Manual"), 3);
  assert.equal(termSourceRank(""), 0);
});

test("terms read from a dashed name feed the money maths", () => {
  const a = bondAnalytics({
    label: "TESTD-11.90%-3-12-26-PVT",
    quantity: 2, cost_paise: 20000000, value_paise: 21000000,
    purchase_date: "2024-06-06", frequency: "Monthly",
  });
  assert.ok(a, "coupon and maturity together are enough");
  assert.equal(a.couponPct, 11.9);
  assert.equal(a.maturity, "2026-12-03");
  assert.equal(a.couponGuessed, true);
  assert.equal(a.maturityGuessed, true);
  assert.ok(a.lifetimeTotal > 25000000 && a.lifetimeTotal < 27000000,
    `total ${a.lifetimeTotal}`);
  assert.ok(a.lifetimeGain > 5500000 && a.lifetimeGain < 6500000,
    `gain ${a.lifetimeGain}`);
  assert.ok(a.couponIncome > 5500000 && a.couponIncome < 6100000,
    `coupons ${a.couponIncome}`);
  assert.ok(a.futureCoupon > 0, `future ${a.futureCoupon}`);
  assert.ok(a.ytm > 11 && a.ytm < 13, `ytm ${a.ytm}`);
});

test("without a frequency the totals still compute", () => {
  const a = bondAnalytics({
    label: "TESTD-11.90%-3-12-26-PVT",
    quantity: 2, cost_paise: 20000000, value_paise: 21000000,
    purchase_date: "2024-06-06",
  });
  assert.ok(a, "a frequency is not required for the lifetime estimate");
  assert.ok(a.lifetimeTotal > 25000000, `total ${a.lifetimeTotal}`);
  assert.ok(a.lifetimeGain > 5500000, `gain ${a.lifetimeGain}`);
  assert.ok(a.futureCoupon > 0, `future ${a.futureCoupon}`);
});

test("matured, live and disposed lots are three different states", () => {
  const today = "2026-11-15";
  const rows = [
    { id: "matured", category: "bond", label: "9.50% TEST 15 MAY 2020",
      maturity: "2020-05-15", quantity: 1, cost_paise: 50000000,
      value_paise: 50000000 },
    { id: "live", category: "bond", label: "9.50% TEST 15 MAY 2030",
      maturity: "2030-05-15", quantity: 1, cost_paise: 10000000,
      value_paise: 10000000 },
    { id: "sold", category: "bond", label: "9.50% TEST 15 MAY 2020",
      maturity: "2020-05-15", quantity: 0, cost_paise: 0, value_paise: 0,
      disposed_at: "2026-06-01" },
  ];
  const split = splitMatured(rows, today);
  assert.deepEqual(split.current.map((h) => h.id), ["live"]);
  assert.deepEqual(split.matured.map((h) => h.id), ["matured"]);
  assert.deepEqual(split.disposed.map((h) => h.id), ["sold"]);
  assert.equal(split.maturedValue, 50000000);
  assert.equal(split.maturedGuessed, 0);
});

test("a label date attached for display is not written back as a stored term", () => {
  const split = splitMatured([{ id: "label", category: "bond",
    label: "9.50% TEST 15 MAY 2020", quantity: 1, cost_paise: 10000000 }],
  "2026-11-15");
  const displayed = split.matured[0];
  assert.equal(displayed.maturity, "2020-05-15");
  assert.equal(displayed.maturitySource, "label");

  const written = bondWriteRow(displayed, { rating: "AA" });
  assert.equal("maturity" in written, false, "the label guess is not promoted");
  assert.equal(written.rating, "AA");
  assert.equal(written.maturitySource, "label", "the view still knows its source");

  // A real stored maturity is copied through, and a fetched one replaces it.
  const stored = bondWriteRow({ category: "bond", label: "TEST",
    maturity: "2030-05-15", maturity_source: "SMEST" }, { rating: "AA" });
  assert.equal(stored.maturity, "2030-05-15");
  const fetched = bondWriteRow(displayed, { maturity: "2031-01-01",
    maturity_source: "SMEST" });
  assert.equal(fetched.maturity, "2031-01-01");
});

test("a matured lot with no value is counted at cost", () => {
  const split = splitMatured([{ id: "m", category: "bond",
    label: "9.50% TEST 15 MAY 2020", quantity: 2, cost_paise: 7500000 }],
  "2026-11-15");
  assert.equal(split.maturedValue, 7500000);
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

test("the report's QUATERLY spelling still accrues quarterly interest", () => {
  const quarterly = accruedInterest(1190000, "Quarterly", "2026-12-03", "2026-11-11");
  const misspelled = accruedInterest(1190000, "QUATERLY", "2026-12-03", "2026-11-11");
  assert.ok(quarterly.accrued > 0);
  assert.deepEqual(misspelled, quarterly);
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

test("a lookup fills a missing coupon and maturity with its source and date", () => {
  const plan = bondFillPlan({ quantity: 2, cost_paise: 20000000 },
    { details: { coupon: 9.5, maturity: "2029-10-07", source: "SMEST" },
      market: null }, "2026-11-16");
  assert.equal(plan.patch.coupon_pct, 9.5);
  assert.equal(plan.patch.coupon_source, "SMEST");
  assert.equal(plan.patch.coupon_as_of, "2026-11-16");
  assert.equal(plan.patch.maturity, "2029-10-07");
  assert.equal(plan.patch.maturity_source, "SMEST");
  assert.equal(plan.patch.maturity_as_of, "2026-11-16");
  assert.equal(plan.terms, true);
});

test("a lookup replaces a name guess but not a report or a person", () => {
  const fetched = { details: { coupon: 9.5, maturity: "2029-10-07" }, market: null };
  const fromName = bondFillPlan({ quantity: 1, cost_paise: 10000000,
    label: "11.9% TEST 03 Dec 2026" }, fetched, "2026-11-16");
  assert.equal(fromName.patch.coupon_pct, 9.5);
  assert.equal(fromName.patch.maturity, "2029-10-07");

  const fromLookup = bondFillPlan({ quantity: 1, cost_paise: 10000000,
    coupon_pct: 9.5, coupon_source: "BSE", maturity: "2029-10-07",
    maturity_source: "BSE" }, fetched, "2026-11-16");
  assert.equal(fromLookup.patch.coupon_source, "SMEST");
  assert.equal(fromLookup.patch.maturity_source, "SMEST");

  for (const source of ["Manual", "DigiFinn investment report", "CAS"]) {
    const stated = bondFillPlan({ quantity: 1, cost_paise: 10000000,
      coupon_pct: 8, coupon_source: source, maturity: "2030-01-01",
      maturity_source: source }, fetched, "2026-11-16");
    assert.deepEqual(stated.patch, {}, source);
    assert.equal(stated.terms, false, source);
  }
});

test("a lookup records the face it filled", () => {
  const plan = bondFillPlan({ quantity: 10, cost_paise: 7356643 },
    { details: { face: 10000, source: "SMEST" }, market: null }, "2026-11-16");
  assert.equal(plan.patch.face_paise, 1000000);
  assert.equal(plan.patch.face_source, "SMEST");
  assert.equal(plan.patch.face_as_of, "2026-11-16");
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

test("a portfolio's market subset follows the value source", () => {
  const base = { label: "10.25% TEST ISSUER PRIVATE LIMITED 31 DEC 2026",
    quantity: 1, cost_paise: 9982008, value_paise: 11000000,
    purchase_date: "2024-02-15" };
  const summary = bondSummary([
    { ...base, value_source: "CAS" },
    { ...base, value_source: "BSE" },
  ]);
  assert.equal(summary.marketCount, 1);
  assert.equal(summary.marketValue, 11000000,
    "the CAS statement figure is not a market value");
});

test("a portfolio with only a CAS value has no market total", () => {
  const summary = bondSummary([{
    label: "10.25% TEST ISSUER PRIVATE LIMITED 31 DEC 2026",
    quantity: 1, cost_paise: 9982008, value_paise: 11000000,
    value_source: "CAS", purchase_date: "2024-02-15",
  }]);
  assert.equal(summary.marketCount, 0);
  assert.equal(summary.marketValue, null);
});

test("a blank stored coupon is absent, not zero", () => {
  const a = bondAnalytics({ label: "TEST BOND 15 May 2030", quantity: 1,
    cost_paise: 100000, face_paise: 100000, couponPct: "" });
  assert.equal(a, null);
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

test("a bare CAS bond is missing both cost and terms", () => {
  const bare = { security_id: "INE000000124", label: "TEST BARE BOND",
    category: "bond", quantity: 100, value_paise: 2500000, value_source: "CAS" };
  assert.deepEqual(bondInputsMissing(bare), { noCost: true, noTerms: true });
  assert.deepEqual(bondInputsMissing({ ...bare, cost_paise: "" }),
    { noCost: true, noTerms: true }, "an empty cost is not a cost");
});

test("one term is not enough: bondAnalytics needs a coupon and a maturity", () => {
  // A coupon without a date, or a date without a coupon, cannot be estimated
  // and the card cannot compute its anchor. It is still a terms gap.
  const base = { category: "bond", quantity: 1, cost_paise: 100 };
  assert.deepEqual(bondInputsMissing({ ...base, coupon_pct: 8 }),
    { noCost: false, noTerms: true });
  assert.deepEqual(bondInputsMissing({ ...base, label: "8.25% TEST BOND" }),
    { noCost: false, noTerms: true });
  assert.deepEqual(bondInputsMissing({ ...base, maturity: "2030-05-15" }),
    { noCost: false, noTerms: true });
  assert.deepEqual(bondInputsMissing({ ...base, label: "TEST BOND 15 May 2030" }),
    { noCost: false, noTerms: true });
});

test("a stored value is classified by its source, not by arithmetic", () => {
  assert.equal(valueKindOf({ value_source: "BSE" }), "market");
  assert.equal(valueKindOf({ value_source: "bse" }), "market");
  assert.equal(valueKindOf({ value_source: "Manual" }), "market");
  assert.equal(valueKindOf({ value_source: "manual" }), "market");
  assert.equal(valueKindOf({ value_source: "CAS" }), "statement");
  assert.equal(valueKindOf({ value_source: "Motilal" }), "statement");
  assert.equal(valueKindOf({ value_source: "SMEST" }), "statement");
  assert.equal(valueKindOf({ value_source: "" }), "market",
    "an empty source is the legacy market value");
  assert.equal(valueKindOf({ valueSource: "CAS" }), "statement",
    "the camel alias is read too");
});

test("a purchase yield alone is not a coupon", () => {
  // The card prints a coupon, never a yield. A yield from a broker report is
  // not the terms the card is missing.
  const row = { category: "bond", label: "TEST BOND", quantity: 1,
    cost_paise: 100, yield_bps: 900 };
  assert.deepEqual(bondInputsMissing(row), { noCost: false, noTerms: true });
  assert.equal(bondAnalytics(row), null, "a yield does not make analytics");
});

test("terms are a bond idea, not an equity one", () => {
  assert.deepEqual(bondInputsMissing({ category: "equity", label: "TEST EQUITY",
    quantity: 1 }), { noCost: true, noTerms: false });
  assert.deepEqual(bondInputsMissing({ kind: "bond", label: "TEST BOND",
    quantity: 1 }), { noCost: true, noTerms: false },
  "the shared rule reads category, the field the card reads");
});
