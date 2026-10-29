// Bond analytics from a holdings row. The label carries the coupon and the
// maturity ("10.25% NAVI ... 31 DEC 2026"); the row carries the quantity,
// cost, purchase date and, when a market snapshot exists, the current value.
// No prices are fetched here: this is arithmetic on what the ledger holds.

import { yearsBetween } from "./finance.js";

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// Face values seen in Indian retail bond lots. Pick the one that makes the
// clean price closest to 100; that is the only sane unit for the lot.
const FACES = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];

export function parseBondLabel(label) {
  const text = String(label || "");
  const coupon = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const date = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!coupon || !date) return null;
  const month = MONTHS[date[2].toUpperCase()];
  if (!month) return null;
  return {
    couponPct: Number(coupon[1]),
    maturity: `${date[3]}-${String(month).padStart(2, "0")}-${String(date[1]).padStart(2, "0")}`,
    name: text,
  };
}

export function inferFace(costPaise, quantity) {
  const qty = Number(quantity) || 0;
  const cost = Number(costPaise) || 0;
  if (!qty || !cost) return null;
  const perUnit = cost / qty / 100; // rupees per unit
  return FACES.reduce((best, face) =>
    Math.abs(perUnit - face) < Math.abs(perUnit - best) ? face : best, FACES[0]);
}

export function bondAnalytics(h) {
  const parsed = parseBondLabel(h?.label);
  if (!parsed) return null;
  const qty = Number(h.quantity) || 0;
  const cost = Number(h.cost_paise);
  const face = inferFace(cost, qty);
  if (!qty || !face || !Number.isFinite(cost) || cost <= 0) return null;
  const faceTotal = face * qty * 100; // paise
  const price = (cost / faceTotal) * 100;
  const buy = h.purchase_date || "";
  const years = buy ? yearsBetween(buy, parsed.maturity) : null;
  const annualCoupon = (faceTotal * parsed.couponPct) / 100; // paise
  let ytm = null, couponIncome = null, capitalGain = null, totalGain = null;
  if (years !== null && years > 0) {
    couponIncome = annualCoupon * years;
    capitalGain = faceTotal - cost;
    totalGain = couponIncome + capitalGain;
    // Standard approximate YTM. Coupon frequency is not in the export, so this
    // is labelled approximate rather than pretending to be exact.
    ytm = ((annualCoupon + capitalGain / years) / ((faceTotal + cost) / 2)) * 100;
  }
  // A cashflow export states the whole remaining schedule, gross of tax. When it
  // is there it beats face + coupon: it already knows about part redemptions.
  const schedIn = h.future_interest_paise === null || h.future_interest_paise === undefined
    ? null : Number(h.future_interest_paise);
  const schedPrin = h.future_principal_paise === null || h.future_principal_paise === undefined
    ? null : Number(h.future_principal_paise);
  const schedule = schedIn !== null && schedPrin !== null
    && Number.isFinite(schedIn) && Number.isFinite(schedPrin)
    ? { interest: schedIn, principal: schedPrin, total: schedIn + schedPrin,
      // Face at purchase minus face still to come. A bond that returns part of
      // its principal early is not a loss; that money is already back.
      returned: Number(h.returned_paise) || 0,
      gain: (Number(h.returned_paise) || 0) + schedIn + schedPrin - cost,
      parts: String(h.principal_dates || "").split(",").filter(Boolean).length,
      short: (Number(h.returned_paise) || 0) + schedIn + schedPrin < cost }
    : null;
  const value = Number(h.value_paise);
  const hasMarket = Number.isFinite(value) && value > 0 && Math.abs(value - cost) >= 1;
  const marketPrice = hasMarket ? (value / faceTotal) * 100 : null;
  const currentYield = hasMarket ? (annualCoupon / value) * 100 : (annualCoupon / cost) * 100;
  return {
    ...parsed, qty, face, faceTotal, cost, price, years,
    purchase_date: buy,
    annualCoupon, couponIncome, capitalGain, totalGain, ytm,
    value: hasMarket ? value : null,
    hasMarket, marketPrice, currentYield,
    currentGain: hasMarket ? value - cost : null,
    schedule,
  };
}

export function bondSummary(rows) {
  const items = (rows || []).map(bondAnalytics).filter(Boolean);
  if (!items.length) return null;
  const sum = (key) => items.reduce((t, x) => t + (Number(x[key]) || 0), 0);
  const cost = sum("cost");
  const faceTotal = sum("faceTotal");
  const withYtm = items.filter((x) => x.ytm !== null);
  const ytmCost = withYtm.reduce((t, x) => t + x.cost, 0);
  const ytm = ytmCost
    ? withYtm.reduce((t, x) => t + x.ytm * x.cost, 0) / ytmCost : null;
  const couponIncome = sum("couponIncome");
  const capitalGain = sum("capitalGain");
  const totalGain = couponIncome + capitalGain;
  const market = items.filter((x) => x.hasMarket);
  const marketValue = market.reduce((t, x) => t + x.value, 0);
  const marketCost = market.reduce((t, x) => t + x.cost, 0);
  // Prefer the imported schedule where a lot has one; fall back to the estimate.
  const expected = items.reduce((t, x) => t + (x.schedule ? x.schedule.total
    : (x.faceTotal || 0) + (x.couponIncome || 0)), 0);
  const gainToMaturity = items.reduce((t, x) => t + (x.schedule
    ? (x.schedule.short ? 0 : x.schedule.gain) : (x.totalGain || 0)), 0);
  const inParts = items.filter((x) => x.schedule && x.schedule.parts > 1).length;
  const shortSchedule = items.filter((x) => x.schedule && x.schedule.short).length;
  const returned = items.reduce((t, x) => t + (x.schedule ? x.schedule.returned : 0), 0);
  return {
    count: items.length,
    cost, faceTotal,
    price: faceTotal ? (cost / faceTotal) * 100 : null,
    ytm,
    couponIncome, capitalGain, totalGain,
    expected, gainToMaturity, inParts, shortSchedule, returned,
    totalGainPct: cost ? (totalGain / cost) * 100 : null,
    marketCount: market.length,
    marketValue: market.length ? marketValue : null,
    marketGain: market.length ? marketValue - marketCost : null,
    currentYield: market.length
      ? market.reduce((t, x) => t + x.annualCoupon, 0) / marketValue * 100 : null,
  };
}

// Rating grades, best first. A rating is typed as the bare grade ("AA+") but
// arrives as "CRISIL A / Stable" when fetched, so the grade is read out of
// whatever sits in the field and the agency is ignored for ordering.
export const BOND_RATINGS = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+",
  "BBB", "BBB-", "BB+", "BB", "BB-", "B+", "B", "B-", "C", "CC", "CCC", "D"];

export function bondRatingRank(rating) {
  const grade = bondGrade(rating);
  return grade ? BOND_RATINGS.indexOf(grade) : 999;
}

// The grade inside "CRISIL A / Stable" or a bare "AA+", or "" when the text
// carries no grade. Split on anything that is not a grade character so AA+,
// AA- and BB+(CE) stay whole.
export function bondGrade(rating) {
  for (const token of String(rating || "").toUpperCase().split(/[^A-Z0-9+-]+/)) {
    if (BOND_RATINGS.includes(token)) return token;
  }
  return "";
}

// A rating that moved. Agencies re-rate an issuer rather than a lot, so one
// change shows on every bond of that issuer — which is the point.
export function bondRatingChange(atPurchase, current) {
  const from = bondGrade(atPurchase);
  const to = bondGrade(current);
  if (!from || !to || from === to) return null;
  return { from, to, down: BOND_RATINGS.indexOf(to) > BOND_RATINGS.indexOf(from) };
}

// What a fetched record would add to a lot. Only fields the lot is missing are
// proposed — a rating or a payment frequency already on the row is a fact the
// user chose, and a bulk fetch must not rewrite it. The value is clinical:
// face × units × price, and only when the price and the units are both known.
export function bondFillPlan(row, fetched) {
  const details = fetched?.details || null;
  const market = fetched?.market || null;
  const patch = {};
  if (details) {
    // The rating is the one field that is meant to move: `rating` is today's
    // grade and `rating_at_purchase` keeps the baseline. A bulk fetch that only
    // ever filled blanks could never notice a downgrade.
    if (details.rating?.text && details.rating.text !== String(row.rating || "").trim()) {
      patch.rating = details.rating.text;
    }
    if (!String(row.frequency || "").trim() && details.frequency) patch.frequency = details.frequency;
    if (!String(row.interest_date || "").trim() && details.nextInterest) patch.interest_date = details.nextInterest;
  }
  const ltp = Number(market?.ltp ?? details?.ltp) || 0;
  const units = Number(row.quantity) || 0;
  if (ltp > 0 && units > 0) {
    const face = Number(details?.face) > 0 ? Number(details.face) : inferFace(row.cost_paise, units);
    if (face) patch.value_paise = Math.round(face * units * ltp);
  }
  return {
    patch,
    added: !!(patch.frequency || patch.interest_date),
    ratingChanged: !!(patch.rating && String(row.rating || "").trim()),
    terms: !!(patch.rating || patch.frequency || patch.interest_date),
    priced: patch.value_paise !== undefined,
    unread: !details && !market,
  };
}
