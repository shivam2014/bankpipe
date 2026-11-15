// Bond analytics from a holdings row. The label carries the coupon and the
// maturity ("10.25% NAVI ... 31 DEC 2026"); the row carries the quantity,
// cost, purchase date and, when a market snapshot exists, the current value.
// No prices are fetched here: this is arithmetic on what the ledger holds.

import { yearsBetween } from "./finance.js";
import { boId } from "./bo-id.js";

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// A disposal is history. Only a live bond participates in a link, a reconcile
// or a cost calculation.
export const isLiveBondRow = (row) => !row?.disposed_at
  && String(row?.category || "").toLowerCase() === "bond";

const isoDay = (value) => {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
};

// Where a stored term came from, ranked. A report or a person outranks a
// lookup, and the label is the last resort. A value with no source is treated
// as a statement: it was written before provenance existed, so a lookup must
// not replace it.
const TERM_SOURCE_RANK = { label: 1, lookup: 2, report: 3, manual: 3 };
export function termSourceKind(source) {
  const s = String(source || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "label") return "label";
  if (s === "manual" || s.includes("by hand") || s.includes("entered")) return "manual";
  if (s.includes("smest") || s.includes("bse")
    || s.includes("lookup") || s.includes("market")) {
    return "lookup";
  }
  return "report";
}
export function termSourceRank(source) {
  const kind = termSourceKind(source);
  return kind ? TERM_SOURCE_RANK[kind] : 0;
}

// The coupon a row actually stores, never the one parsed out of its name. The
// label stays a render-time fallback so an old row does not gain a fake fact.
export function storedCoupon(row) {
  const raw = row?.couponPct ?? row?.coupon_pct;
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { value: null, source: "", asOf: "", stored: false };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { value: null, source: "", asOf: "", stored: false };
  }
  return {
    value,
    source: String(row?.couponSource ?? row?.coupon_source ?? "").trim(),
    asOf: String(row?.couponAsOf ?? row?.coupon_as_of ?? "").slice(0, 10),
    stored: true,
  };
}

export const isDisposed = (row) => !!String(row?.disposed_at || "").trim();

// One notion of maturity, shared by the value maths, the Matured section and
// the account status line. A stored date is evidence. A date read out of the
// name is a guess, allowed only for a bond row and reported as one; a share or
// fund with a date in its name is never matured. The label parser takes the
// latest date, because a series or issue date can sit earlier in the name.
export function bondMaturity(row) {
  const stored = isoDay(row?.maturity) || isoDay(row?.maturity_date);
  if (stored) {
    const source = String(row?.maturitySource ?? row?.maturity_source ?? "").trim();
    return {
      maturity: stored,
      source: source || "stored",
      guessed: termSourceKind(source) === "label",
    };
  }
  const category = String(row?.category || row?.kind || "").trim().toLowerCase();
  if (category && category !== "bond") {
    return { maturity: "", source: "", guessed: false };
  }
  const parsed = parseBondLabel(row?.label);
  if (!parsed?.maturity) return { maturity: "", source: "", guessed: false };
  return { maturity: parsed.maturity, source: "label", guessed: true };
}

// What a lot contributes to the account it sits in. A priced lot uses its
// value; an unpriced one uses cost, the same fallback assetMetrics() uses, so
// the "matured" line and the account total can never disagree.
const lotValue = (row) => {
  const value = row?.value_paise;
  if (value !== null && value !== undefined && value !== "") return Number(value) || 0;
  const cost = row?.cost_paise;
  if (cost !== null && cost !== undefined && cost !== "") return Number(cost) || 0;
  return 0;
};

/**
 * Split bond lots into current, matured and disposed. Matured means live and
 * past its maturity date; a disposal is a third state and never appears in the
 * matured list or its amount. Pure, so the page, the import inbox and a test
 * can all use the same rule.
 * @param {Array<object>} rows
 * @param {string} [today]
 * @returns {{current: Array<object>, matured: Array<object>, disposed: Array<object>,
 *   maturedValue: number, maturedGuessed: number}}
 */
export function splitMatured(rows = [], today = new Date().toISOString().slice(0, 10)) {
  const current = [], matured = [], disposed = [];
  for (const row of rows || []) {
    if (isDisposed(row)) { disposed.push(row); continue; }
    const terms = bondMaturity(row);
    if (terms.maturity && terms.maturity < today) {
      matured.push({ ...row, maturity: terms.maturity,
        maturitySource: terms.source, maturityGuessed: terms.guessed });
    } else {
      current.push(row);
    }
  }
  return {
    current, matured, disposed,
    maturedValue: matured.reduce((total, row) => total + lotValue(row), 0),
    maturedGuessed: matured.filter((row) => row.maturityGuessed).length,
  };
}

// The row a market fetch writes back. splitMatured() attaches the label's
// maturity for display; that date is a guess and must not become a stored fact
// just because another field on the lot was filled. A real stored maturity
// keeps its own column and is copied through.
export function bondWriteRow(row, patch = {}) {
  const out = { ...row };
  if (!row?.maturity_source && row?.maturitySource === "label") delete out.maturity;
  return { ...out, ...patch };
}

function assetMeta(asset) {
  try {
    return typeof asset?.meta === "string" ? JSON.parse(asset.meta) || {} : (asset?.meta || {});
  } catch (e) {
    return {};
  }
}

// A holding lot with no quantity is unknown, not empty. A zero is a closed
// position and does not participate in a link or a cost calculation.
const hasUnits = (row) => row?.quantity === null || row?.quantity === undefined
  || Number(row.quantity) > 0;

/**
 * The demat account a bond portfolio feeds. The explicit link wins, then the
 * demat number the portfolio names, then the demat holding most of its ISINs.
 * The overlap is counted over distinct ISINs, so a portfolio with several lots
 * of one bond cannot outvote two other bonds, and history is not counted.
 * @param {Array<object>} lots
 * @param {object} asset a bond portfolio
 * @param {Array<object>} demats
 * @param {Map<string, Array<object>>} positionsOf
 * @returns {string} demat account id, or ""
 */
export function bondHomeOf(lots, asset, demats, positionsOf) {
  const meta = assetMeta(asset);
  if (meta.linked_asset && demats.some((d) => d.id === meta.linked_asset)) {
    return meta.linked_asset;
  }
  const wanted = boId(meta.demat || asset?.number || "").boId;
  if (wanted) {
    const hit = demats.find((d) => boId(d.number).boId === wanted);
    if (hit) return hit.id;
  }
  const isins = new Set();
  for (const lot of lots || []) {
    if (lot?.disposed_at || !hasUnits(lot)) continue;
    const isin = String(lot.security_id || "").toUpperCase();
    if (isin) isins.add(isin);
  }
  const count = new Map();
  for (const isin of isins) {
    for (const demat of demats) {
      if (!(positionsOf.get(demat.id) || []).some((p) =>
        String(p.security_id || "").toUpperCase() === isin && hasUnits(p))) continue;
      count.set(demat.id, (count.get(demat.id) || 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// Face values seen in Indian retail bond lots. Pick the one that makes the
// clean price closest to 100; that is the only sane unit for the lot.
const FACES = [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];

// A dashed broker name writes the date as D-M-YY. Both observed shapes agree:
// 3-12-26 is 3 Dec 2026 and 13-6-27 is 13 Jun 2027, and the report's own ISO
// Date column prints 2026-12-03 and 2027-06-13. A day above 12 in the first
// slot rules out M-D-Y for this family, so the order is fixed rather than
// guessed per label. A date that is not a real calendar day is left unparsed.
const DASHED_LABEL_DATE = /(\d+(?:\.\d+)?)\s*%\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{4}|\d{2})(?=-|$|[^0-9])/g;
const DASHED_DATE_SHAPE = /\d+(?:\.\d+)?\s*%\s*-\s*\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{1,4}(?!\d)/;

// An unqualified year in a bond name is the maturity's last two digits. Years
// 00-79 are 2000-2079; 80-99 are 1980-1999, so an older matured lot still reads
// correctly. Four-digit years must already be in 1900-2099.
function dashedYear(value) {
  const year = Number(value);
  if (String(value).length === 4) return year;
  return year <= 79 ? 2000 + year : 1900 + year;
}

function dashedIso(dayText, monthText, yearText) {
  const day = Number(dayText);
  const month = Number(monthText);
  const year = dashedYear(yearText);
  if (!(year >= 1900 && year <= 2099)) return "";
  if (!(month >= 1 && month <= 12)) return "";
  if (!(day >= 1 && day <= 31)) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseBondLabel(label) {
  const text = String(label || "");
  const coupon = text.match(/(\d+(?:\.\d+)?)\s*%/);
  // A name can carry a series, issue or record date as well as the maturity.
  // The latest date is the redemption date; taking the first one turned a
  // series date into a false maturity. "Sept", "September" and "Sep" are the
  // same month; three letters are enough.
  let maturity = "";
  for (const match of text.matchAll(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/g)) {
    const month = MONTHS[match[2].toUpperCase().slice(0, 3)];
    if (!month) continue;
    const iso = `${match[3]}-${String(month).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
    if (!maturity || iso > maturity) maturity = iso;
  }
  // Motilal and its peers can print the same terms as NAME-<rate>%-<d>-<m>-<yy>
  // instead of a month word. The rate is part of the shape, so a bare code like
  // SERIES-3-12-26 is not a date.
  for (const match of text.matchAll(DASHED_LABEL_DATE)) {
    const iso = dashedIso(match[2], match[3], match[4]);
    if (iso && (!maturity || iso > maturity)) maturity = iso;
  }
  const couponPct = coupon ? Number(coupon[1]) : null;
  // A coupon and a date are not always both present: a CAS can know the
  // maturity without the coupon, and a dashed name can carry the rate with no
  // readable date. Either one still belongs on the card. A date-shaped run that
  // is not a real date is reported so the card can say it could not be read
  // instead of pretending the name never held a date.
  if (couponPct === null && !maturity) return null;
  return { couponPct, maturity, name: text,
    dateUnread: !maturity && DASHED_DATE_SHAPE.test(text) };
}

// The issuer half of a label, with the terms taken out. The edit form rebuilds
// the label from this name plus the coupon and date fields, so a name that kept
// the dashed terms would come back with them twice.
export function bondLabelName(label) {
  return String(label || "")
    .replace(/[-\s]*\d+(?:\.\d+)?\s*%\s*-\s*\d{1,2}\s*-\s*\d{1,2}\s*-\s*(?:\d{4}|\d{2})[-\s]*/g, "-")
    // A dashed name can carry the rate with no date yet.
    .replace(/([A-Za-z0-9])\s*-\s*\d+(?:\.\d+)?\s*%(?=\s*-\s*[A-Za-z])/g, "$1")
    .replace(/^\s*\d+(?:\.\d+)?\s*%\s*/, "")
    .replace(/\s*\d{1,2}\s+[A-Za-z]{3}[A-Za-z]*\s+\d{4}\s*$/, "")
    .replace(/^-+|-+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const parsedLabel = parseBondLabel(h?.label);
  const terms = bondMaturity(h);
  // A coupon the statement or the broker prints is a fact. The label is only a
  // fallback, and the card reports that fallback as a guess. The old order
  // preferred the name and could silently replace a stated rate.
  const stored = storedCoupon(h);
  const hasStoredCoupon = stored.stored;
  const labelCoupon = parsedLabel?.couponPct ?? null;
  const couponPct = hasStoredCoupon ? stored.value
    : (labelCoupon !== null && Number.isFinite(labelCoupon) ? labelCoupon : null);
  if (!terms.maturity || couponPct === null) return null;
  const couponSource = hasStoredCoupon ? (stored.source || "stored")
    : (labelCoupon !== null && Number.isFinite(labelCoupon) ? "label" : "");
  const parsed = { ...(parsedLabel || {}), couponPct,
    couponSource,
    couponAsOf: hasStoredCoupon ? stored.asOf : "",
    couponGuessed: !hasStoredCoupon || termSourceKind(couponSource) === "label",
    maturity: terms.maturity, maturitySource: terms.source,
    maturityAsOf: String(h?.maturityAsOf ?? h?.maturity_as_of ?? "").slice(0, 10),
    maturityGuessed: terms.guessed,
    dateUnread: terms.maturity ? false : !!parsedLabel?.dateUnread,
    name: String(h?.label || "") };
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
    firstPast,
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
export function bondFillPlan(row, fetched, today = new Date().toISOString().slice(0, 10)) {
  const details = fetched?.details || null;
  const market = fetched?.market || null;
  const units = Number(row.quantity) || 0;
  const patch = {};
  const source = details?.source === "BSE" ? "BSE" : "SMEST";
  // A lookup may fill an empty term or replace another lookup. It never
  // replaces a report or a person, and a stored value with no provenance is
  // old enough to be either, so it is left alone.
  const canTake = (value, oldSource) => {
    if (value === null || value === undefined || value === "") return true;
    const kind = termSourceKind(oldSource);
    return kind === "label" || kind === "lookup";
  };
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
    const oldCoupon = storedCoupon(row);
    const coupon = Number(details.coupon);
    if (Number.isFinite(coupon) && coupon > 0
        && canTake(oldCoupon.value, oldCoupon.source)
        && (oldCoupon.value !== coupon || oldCoupon.source !== source)) {
      patch.coupon_pct = coupon;
      patch.coupon_source = source;
      patch.coupon_as_of = today;
    }
    const oldMaturity = bondMaturity(row);
    const maturity = isoDay(details.maturity);
    if (maturity && canTake(oldMaturity.maturity, oldMaturity.source)
        && (oldMaturity.maturity !== maturity || oldMaturity.source !== source)) {
      patch.maturity = maturity;
      patch.maturity_source = source;
      patch.maturity_as_of = today;
    }
    // SMEST prints the face now. Store the face bought instead, and keep the
    // difference as principal already returned, so a part redemption cannot
    // make the purchase yield look negative on the next render. A report or a
    // person already named the face, so a lookup leaves it alone.
    const oldFaceSource = String(row.faceSource ?? row.face_source ?? "").trim();
    const faceCanTake = !(Number(row.face_paise) > 0)
      || ["label", "lookup"].includes(termSourceKind(oldFaceSource));
    if (Number(details.face) > 0 && units > 0 && faceCanTake) {
      const currentFace = Number(details.face);
      const boughtFace = Math.max(currentFace, inferFace(row.cost_paise, units) || 0);
      const facePaise = Math.round(boughtFace * 100);
      if (facePaise !== Number(row.face_paise || 0)) {
        patch.face_paise = facePaise;
        patch.face_source = source;
        patch.face_as_of = today;
      }
      const back = Math.round((boughtFace - currentFace) * units * 100);
      if (back > 0 && (row.returned_paise === null || row.returned_paise === undefined)) {
        patch.returned_paise = back;
        patch.returned_source = "smest";
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
      || patch.frequency || patch.interest_date || patch.redemption_dates
      || patch.coupon_pct !== undefined || patch.maturity !== undefined),
    priced: patch.value_paise !== undefined,
    unread: !details && !market,
  };
}
