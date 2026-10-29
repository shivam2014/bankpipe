import test from "node:test";
import assert from "node:assert/strict";
import { parseBondLabel, inferFace, bondAnalytics, bondSummary,
  BOND_RATINGS, bondRatingRank, bondFillPlan, bondGrade, bondRatingChange } from "./bonds.js";

test("parses the coupon and maturity from a bond label", () => {
  const p = parseBondLabel("10.25% NAVI FINSERV PRIVATE LIMITED 31 DEC 2026");
  assert.equal(p.couponPct, 10.25);
  assert.equal(p.maturity, "2026-12-31");
});

test("infers the face value from the cost per unit", () => {
  assert.equal(inferFace(9982008, 1), 100000);
  assert.equal(inferFace(20574470, 1), 200000);
  assert.equal(inferFace(10288816, 100), 1000);
  assert.equal(inferFace(19529612, 20), 10000);
});

test("purchase yield and gain to maturity for the NAVI lot", () => {
  const a = bondAnalytics({
    label: "10.25% NAVI FINSERV PRIVATE LIMITED 31 DEC 2026",
    security_id: "INE342T07429", quantity: 1, cost_paise: 9982008,
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
    label: "10.25% UGRO CAPITAL LIMITED 24 OCT 2026",
    quantity: 200, cost_paise: 19817350, value_paise: 19922096,
    purchase_date: "2025-10-01",
  });
  assert.equal(a.face, 1000);
  assert.equal(a.hasMarket, true);
  assert.ok(a.marketPrice > 99 && a.marketPrice < 100);
  assert.ok(a.currentGain > 0);
});

test("summarizes a portfolio of bond lots", () => {
  const s = bondSummary([
    { label: "10.25% NAVI FINSERV PRIVATE LIMITED 31 DEC 2026",
      quantity: 1, cost_paise: 9982008, value_paise: 9982008,
      purchase_date: "2024-02-15" },
    { label: "10.50% NIDO HFL 03 JUL 2029",
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
    { quantity: 1, cost_paise: 9900000, rating: "A", frequency: "Monthly",
      interest_date: "2026-12-01" }, same);
  assert.deepEqual(kept.patch, {});
  assert.equal(kept.terms, false);
  assert.equal(kept.ratingChanged, false);

  // A different grade is the one thing a bulk fetch is allowed to replace:
  // `rating` is today's grade, and the baseline is kept separately.
  const moved = bondFillPlan(
    { quantity: 1, cost_paise: 9900000, rating: "AA", frequency: "Monthly",
      interest_date: "2026-12-01" }, same);
  assert.deepEqual(moved.patch, { rating: "A" });
  assert.equal(moved.ratingChanged, true);
  assert.equal(moved.added, false);
  assert.equal(moved.terms, true);
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
    label: "9.75% B N AGRITECH LIMITED 27 NOV 2028", quantity: 20, cost_paise: 19500000,
    purchase_date: "2025-11-27",
    future_interest_paise: 4500000, future_principal_paise: 20000000,
    principal_dates: "2028-02-27,2028-05-27,2028-08-27,2028-11-27",
  });
  assert.equal(a.schedule.parts, 4);
  assert.equal(a.schedule.total, 24500000);
  assert.equal(a.schedule.gain, 24500000 - 19500000);
  // Without a schedule the old estimate still stands.
  const b = bondAnalytics({
    label: "9.75% B N AGRITECH LIMITED 27 NOV 2028", quantity: 20, cost_paise: 19500000,
    purchase_date: "2025-11-27",
  });
  assert.equal(b.schedule, null);
});

test("a schedule that promises less than was paid has no gain", () => {
  const a = bondAnalytics({
    label: "12.00% VCCL 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    purchase_date: "2024-09-26",
    future_interest_paise: 297534, future_principal_paise: 5000000,
    principal_dates: "2027-03-23",
  });
  assert.equal(a.schedule.total, 5297534);
  assert.equal(a.schedule.short, true);
  // The face-value estimate would have said 1,00,000 + interest; the imported
  // sheet says half the principal is missing, so no gain is claimed.
  const b = bondAnalytics({
    label: "12.00% VCCL 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    future_interest_paise: 297534, future_principal_paise: 10000000,
  });
  assert.equal(b.schedule.short, false);
});

test("principal already returned counts towards the gain", () => {
  const a = bondAnalytics({
    label: "12.00% VCCL 23 MAR 2027", quantity: 1, cost_paise: 9859863,
    future_interest_paise: 297534, future_principal_paise: 5000000,
    principal_dates: "2027-03-23", returned_paise: 5000000,
  });
  assert.equal(a.schedule.returned, 5000000);
  assert.equal(a.schedule.gain, 5000000 + 297534 + 5000000 - 9859863);
  assert.equal(a.schedule.short, false);
});
