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
  const date = text.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
  // A coupon and a date are not always both present: a CAS can know the
  // maturity without the coupon. The date alone still belongs on the card.
  if (!date) return null;
  // "Sept", "September" and "Sep" are the same month; three letters are enough.
  const month = MONTHS[date[2].toUpperCase().slice(0, 3)];
  if (!month) return null;
  return {
    couponPct: coupon ? Number(coupon[1]) : null,
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

// The slice of the next coupon earned since the previous one. Estimated from the
// frequency and the next interest date; real day counts vary by issuer.
function couponMonths(frequency) {
  const f = String(frequency || "").toLowerCase();
  return f.includes("month") ? 1
    : f.includes("quarter") ? 3
      : (f.includes("half") || f.includes("semi")) ? 6
        : (f.includes("annual") || f.includes("year")) ? 12 : 0;
}

export function accruedInterest(annualCouponPaise, frequency, interestDate,
  today = new Date().toISOString().slice(0, 10)) {
  const months = couponMonths(frequency);
  const to = String(interestDate || "").slice(0, 10);
  const coupon = Number(annualCouponPaise);
  if (!months || !to || !Number.isFinite(coupon) || coupon <= 0) {
    return { accrued: null, from: "", to };
  }
  const next = new Date(to + "T00:00:00Z");
  const last = new Date(next);
  last.setUTCMonth(last.getUTCMonth() - months);
  const day = new Date(String(today).slice(0, 10) + "T00:00:00Z");
  if (!(day >= last && day < next)) return { accrued: null, from: "", to };
  const days = Math.round((day - last) / 86400000);
  return { accrued: Math.round(coupon * (days / 365)),
    from: last.toISOString().slice(0, 10), to };
}

// How many coupons still land between today and maturity. A monthly bond with
// its next coupon on the maturity date has one; a quarterly bond two years out
// has eight. The walk is bounded so a bad frequency cannot spin.
function futureCouponCount(interestDate, frequency, maturity, today) {
  const months = couponMonths(frequency);
  const start = String(interestDate || "").slice(0, 10);
  const end = String(maturity || "").slice(0, 10);
  const from = String(today || "").slice(0, 10);
  if (!months || !start || !end || !from) return null;
  const d = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  const now = new Date(from + "T00:00:00Z");
  if (isNaN(d.getTime()) || isNaN(stop.getTime()) || isNaN(now.getTime())) return null;
  let count = 0;
  for (let i = 0; i < 480 && d <= stop; i++) {
    if (d > now) count++;
    d.setUTCMonth(d.getUTCMonth() + months);
  }
  return count;
}

export function bondAnalytics(h) {
  const parsed = parseBondLabel(h?.label);
  if (!parsed || parsed.couponPct === null || parsed.couponPct === undefined) return null;
  const qty = Number(h.quantity) || 0;
  const cost = Number(h.cost_paise);
  const storedFace = Number(h.face_paise) > 0 ? Number(h.face_paise) / 100 : 0;
  const inferred = inferFace(cost, qty);
  const currentFace = storedFace || inferred;
  if (!qty || !currentFace || !Number.isFinite(cost) || cost <= 0) return null;
  const storedTotal = storedFace ? storedFace * qty * 100 : 0;
  const inferredTotal = inferred ? inferred * qty * 100 : 0;
  const futurePrin = Number(h.future_principal_paise);
  const hasFuturePrin = Number.isFinite(futurePrin) && futurePrin > 0;
  const explicitReturned = h.returned_paise === null || h.returned_paise === undefined
    ? null : Number(h.returned_paise);
  const today = new Date().toISOString().slice(0, 10);
  const redemptions = String(h.redemption_dates || "").split(",")
    .map((d) => d.trim()).filter(Boolean).sort();
  const principalDates = String(h.principal_dates || "").split(",")
    .map((d) => d.trim()).filter(Boolean).sort();
  const firstPast = redemptions.filter((d) => d <= today).pop() || "";
  // A schedule that promises less than the cost-implied face is not proof that
  // the difference was returned. A past redemption date, or a stored face below
  // the cost-implied one, is. Without that evidence the schedule is short and
  // the gain is not claimed.
  const pastWeReturn = [...redemptions, ...principalDates].some((d) => d <= today);
  const storedLooksCurrent = storedTotal > 0 && storedTotal < inferredTotal;
  const canDeriveReturn = pastWeReturn || storedLooksCurrent;
  // The face a statement prints can be the face at purchase (CAS) or the face
  // after a part repayment (SMEST). The larger of it and the cost-implied face
  // is the face bought; the smaller is what is left. The difference is money
  // already back, even when no payout file was imported.
  const purchaseFaceTotal = Math.max(storedTotal, inferredTotal,
    hasFuturePrin ? futurePrin + (explicitReturned > 0 ? explicitReturned : 0) : 0);
  const faceTotal = hasFuturePrin
    ? (canDeriveReturn && explicitReturned === null
      ? Math.min(purchaseFaceTotal, futurePrin) : futurePrin)
    : explicitReturned !== null ? Math.max(0, purchaseFaceTotal - explicitReturned)
      : Math.min(purchaseFaceTotal, storedTotal || purchaseFaceTotal);
  const returnedPaise = explicitReturned !== null ? explicitReturned
    : hasFuturePrin && !canDeriveReturn ? 0
      : Math.max(0, purchaseFaceTotal - faceTotal);
  const face = faceTotal / qty / 100;
  const purchaseFace = purchaseFaceTotal / qty / 100;
  const price = (cost / purchaseFaceTotal) * 100;
  const buy = h.purchase_date || "";
  const years = buy ? yearsBetween(buy, parsed.maturity) : null;
  const annualCoupon = (faceTotal * parsed.couponPct) / 100; // paise for the face left
  // Coupons already received are not in the "future" export. Estimate them from
  // the rate and the redemption dates: original face before the first repayment,
  // what is left after it. The lifetime figures are what the person actually
  // gets back for the money invested.
  const yearsLeft = parsed.maturity ? yearsBetween(today, parsed.maturity) : null;
  const periods = couponMonths(h.frequency) ? 12 / couponMonths(h.frequency) : null;
  const couponsLeft = futureCouponCount(h.interest_date, h.frequency, parsed.maturity, today);
  const futureCoupon = couponsLeft > 0 && periods
    ? Math.round((annualCoupon / periods) * couponsLeft)
    : Math.round(annualCoupon * Math.max(0, yearsLeft || 0));
  let couponEstimate = futureCoupon;
  if (years !== null && years > 0) {
    if (returnedPaise > 0) {
      if (firstPast) {
        const y1 = yearsBetween(buy, firstPast);
        const y2 = yearsBetween(firstPast, parsed.maturity);
        const c1 = y1 !== null ? (purchaseFaceTotal * parsed.couponPct / 100) * y1 : 0;
        const c2 = y2 !== null && y2 > 0 ? (faceTotal * parsed.couponPct / 100) * y2 : 0;
        couponEstimate = c1 + c2;
      } else {
        // Without a recorded redemption date, use the face originally bought for
        // the whole term. Better to overstate a little than to hide the coupons.
        couponEstimate = (purchaseFaceTotal * parsed.couponPct / 100) * years;
      }
    } else {
      couponEstimate = annualCoupon * years;
    }
  }
  const couponIncome = couponEstimate;
  const pastCoupon = Math.max(0, couponEstimate - futureCoupon);
  const annualCouponBought = (purchaseFaceTotal * parsed.couponPct) / 100;
  const totalPeriods = years !== null && periods ? Math.round(years * periods) : null;
  const originalCouponEstimate = totalPeriods && totalPeriods > 0
    ? Math.round((annualCouponBought / periods) * totalPeriods)
    : (years !== null ? Math.round(annualCouponBought * years) : null);
  const couponProgress = originalCouponEstimate > 0
    ? Math.min(100, Math.max(0, (pastCoupon / originalCouponEstimate) * 100)) : null;
  const couponLost = originalCouponEstimate !== null
    ? Math.max(0, originalCouponEstimate - couponEstimate) : null;
  const capitalGain = faceTotal + returnedPaise - cost;
  const totalGain = couponEstimate + capitalGain;
  const lifetimeTotal = purchaseFaceTotal + couponEstimate;
  const lifetimeGain = lifetimeTotal - cost;
  // Standard approximate YTM over the money actually invested: average coupons
  // across the whole life, plus the pull to the face still outstanding.
  const ytm = years !== null && years > 0
    ? ((couponEstimate / years + capitalGain / years)
      / ((purchaseFaceTotal + cost) / 2)) * 100
    : null;
  const accrual = accruedInterest(annualCoupon, h.frequency, h.interest_date);
  const schedIn = h.future_interest_paise === null || h.future_interest_paise === undefined
    ? null : Number(h.future_interest_paise);
  const schedPrin = h.future_principal_paise === null || h.future_principal_paise === undefined
    ? null : Number(h.future_principal_paise);
  const schedule = schedIn !== null && schedPrin !== null
    && Number.isFinite(schedIn) && Number.isFinite(schedPrin)
    ? { interest: schedIn, principal: schedPrin, total: schedIn + schedPrin,
      // Face at purchase minus face still to come. A bond that returns part of
      // its principal early is not a loss; that money is already back.
      returned: returnedPaise,
      gain: returnedPaise + schedIn + schedPrin - cost,
      parts: String(h.principal_dates || "").split(",").filter(Boolean).length,
      short: returnedPaise + schedIn + schedPrin < cost }
    : null;
  const value = Number(h.value_paise);
  const hasMarket = Number.isFinite(value) && value > 0 && Math.abs(value - cost) >= 1;
  const marketPrice = hasMarket ? (value / faceTotal) * 100 : null;
  const currentYield = hasMarket ? (annualCoupon / value) * 100 : (annualCoupon / cost) * 100;
  return {
    ...parsed, qty, face, faceTotal, purchaseFace, purchaseFaceTotal, cost, price, years,
    faceInferred: !storedFace,
    faceBoughtInferred: !storedFace || purchaseFace > storedFace,
    returned: returnedPaise,
    purchase_date: buy,
    annualCoupon, couponIncome, futureCoupon, pastCoupon,
    originalCouponEstimate, couponProgress, couponLost,
    capitalGain, totalGain, ytm,
    couponEstimate, lifetimeTotal, lifetimeGain,
    accrued: accrual.accrued, accruedFrom: accrual.from, accruedTo: accrual.to,
    value: hasMarket ? value : null,
    hasMarket, marketPrice, currentYield,
    currentGain: hasMarket ? value - cost : null,
    schedule,
  };
}

// A sale changes the units, not the terms. The broker schedule on file was for
// the old count, so scale its money with the units. A purchase keeps the
// repayment already received: the new units did not get that earlier payment.
// What the person actually walks away with if they sell today. The clean market
// value is not the whole story: principal already returned, coupons already
// received and the accrued slice of the next coupon are all cash in hand.
export function soldGain(ba) {
  if (!ba || !ba.hasMarket || ba.value === null || ba.value === undefined) return null;
  return ba.value + (ba.returned || 0) + (ba.pastCoupon || 0)
    + (ba.accrued || 0) - ba.cost;
}

export function carryBrokerFields(oldRow, newQty) {
  if (!oldRow) return {};
  const oldQty = Number(oldRow.quantity) || 0;
  const qty = Number(newQty) || 0;
  const ratio = oldQty > 0 && qty > 0 ? qty / oldQty : 1;
  const scale = (v) => (v === null || v === undefined)
    ? (v ?? null) : Math.round(Number(v) * ratio);
  return {
    rating: oldRow.rating || "",
    rating_at_purchase: oldRow.rating_at_purchase || oldRow.rating || "",
    yield_bps: oldRow.yield_bps ?? null,
    interest_date: oldRow.interest_date || "",
    principal_dates: oldRow.principal_dates || "",
    redemption_dates: oldRow.redemption_dates || "",
    payout_paise: scale(oldRow.payout_paise),
    future_interest_paise: scale(oldRow.future_interest_paise),
    future_principal_paise: scale(oldRow.future_principal_paise),
    returned_paise: ratio < 1 ? scale(oldRow.returned_paise)
      : (oldRow.returned_paise ?? null),
    returned_at: oldRow.returned_at || "",
    returned_record_date: oldRow.returned_record_date || "",
    returned_source: oldRow.returned_source || "",
  };
}

export function bondSummary(rows) {
  const items = (rows || []).map(bondAnalytics).filter(Boolean);
  if (!items.length) return null;
  const sum = (key) => items.reduce((t, x) => t + (Number(x[key]) || 0), 0);
  const cost = sum("cost");
  const faceTotal = sum("faceTotal");
  const purchaseFaceTotal = items.reduce((t, x) => t + (x.purchaseFaceTotal || 0), 0);
  const withYtm = items.filter((x) => x.ytm !== null);
  const ytmCost = withYtm.reduce((t, x) => t + x.cost, 0);
  const ytm = ytmCost
    ? withYtm.reduce((t, x) => t + x.ytm * x.cost, 0) / ytmCost : null;
  // The summary is about the money still to come. Coupons already paid are in
  // the lifetime figures on each card, not here.
  const couponIncome = sum("futureCoupon");
  const capitalGain = sum("capitalGain");
  const totalGain = items.reduce((t, x) => t + (x.futureCoupon || 0) + (x.capitalGain || 0), 0);
  const market = items.filter((x) => x.hasMarket);
  const marketValue = market.reduce((t, x) => t + x.value, 0);
  const marketCost = market.reduce((t, x) => t + x.cost, 0);
  // Prefer the imported schedule where a lot has one; fall back to the estimate.
  const expected = items.reduce((t, x) => t + (x.schedule ? x.schedule.total
    : (x.faceTotal || 0) + (x.futureCoupon || 0)), 0);
  const gainToMaturity = items.reduce((t, x) => t + (x.schedule
    ? (x.schedule.short ? 0 : x.schedule.gain)
    : (x.futureCoupon || 0) + (x.capitalGain || 0)), 0);
  const inParts = items.filter((x) => x.schedule && x.schedule.parts > 1).length;
  const shortSchedule = items.filter((x) => x.schedule && x.schedule.short).length;
  const returned = items.reduce((t, x) => t + (x.returned || 0), 0);
  return {
    count: items.length,
    cost, faceTotal, purchaseFaceTotal,
    price: purchaseFaceTotal ? (cost / purchaseFaceTotal) * 100 : null,
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
  const units = Number(row.quantity) || 0;
  const patch = {};
  if (details) {
    // The rating is the one field that is meant to move: `rating` is today's
    // grade and `rating_at_purchase` keeps the baseline. A bulk fetch that only
    // ever filled blanks could never notice a downgrade.
    if (details.rating?.text && details.rating.text !== String(row.rating || "").trim()) {
      patch.rating = details.rating.text;
    }
    // The CAS prints a short code ("ACAPL"); SMEST knows the issuer's name.
    if (details.issuer && details.issuer !== String(row.issuer || "").trim()) {
      patch.issuer = details.issuer;
    }
    // SMEST prints the face now. Store the face bought instead, and keep the
    // difference as principal already returned, so a part redemption cannot
    // make the purchase yield look negative on the next render.
    if (Number(details.face) > 0 && units > 0) {
      const currentFace = Number(details.face);
      const boughtFace = Math.max(currentFace, inferFace(row.cost_paise, units) || 0);
      const facePaise = Math.round(boughtFace * 100);
      if (facePaise !== Number(row.face_paise || 0)) patch.face_paise = facePaise;
      const back = Math.round((boughtFace - currentFace) * units * 100);
      if (back > 0 && (row.returned_paise === null || row.returned_paise === undefined)) {
        patch.returned_paise = back;
        patch.returned_source = "smest";
        const today = new Date().toISOString().slice(0, 10);
        const past = (details.redemptions || []).map(String)
          .filter((d) => d && d <= today).sort().pop();
        if (past) patch.returned_at = past;
      }
    }
    if (!String(row.frequency || "").trim() && details.frequency) patch.frequency = details.frequency;
    if (!String(row.interest_date || "").trim() && details.nextInterest) patch.interest_date = details.nextInterest;
    // The redemption schedule is what dates the early principal repayment.
    if (Array.isArray(details.redemptions) && details.redemptions.length) {
      const dates = details.redemptions.map(String).filter(Boolean).join(",");
      if (dates && dates !== String(row.redemption_dates || "")) {
        patch.redemption_dates = dates;
      }
    }
  }
  const ltp = Number(market?.ltp ?? details?.ltp) || 0;
  if (ltp > 0 && units > 0) {
    // The face still outstanding beats the cost-inferred face: a part-redeemed
    // bond trades on what is left, not on what was bought.
    const scheduled = Number(row.future_principal_paise) > 0
      ? Number(row.future_principal_paise) / units / 100 : 0;
    const face = Number(details?.face) > 0 ? Number(details.face)
      : (Number(row.face_paise) > 0 ? Number(row.face_paise) / 100
        : (scheduled || inferFace(row.cost_paise, units)));
    if (face) {
      patch.value_paise = Math.round(face * units * ltp);
      // The value is a quote, not today's guess: carry the trade date so the
      // card can say when the mark was taken.
      if (market?.date) patch.as_of = String(market.date).slice(0, 10);
      patch.value_source = "BSE";
    }
  }
  return {
    patch,
    added: !!(patch.frequency || patch.interest_date),
    ratingChanged: !!(patch.rating && String(row.rating || "").trim()),
    terms: !!(patch.rating || patch.issuer || patch.face_paise || patch.returned_paise
      || patch.frequency || patch.interest_date || patch.redemption_dates),
    priced: patch.value_paise !== undefined,
    unread: !details && !market,
  };
}
