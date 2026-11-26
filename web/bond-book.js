// One fact model for the bond card. bondFacts() is the only ordered list; each
// fact names the section it ranks in, and the card groups that list. Money
// figures come from bondAnalytics()/bondRowView, never from this module.

import { bondAnalytics, bondInputsMissing, bondMaturity, parseBondLabel,
  bondRatingChange, bondRatingRank, soldGain, storedCoupon, termSourceKind,
  valueKindOf, BOND_RATINGS, couponMonths } from "./bonds.js";
import { escapeHtml as esc, jsArg } from "./escape.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A blank field is absent, not a zero. Use this before every Number() that
// reads a stored money, rate or date figure.
const numberOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const DEFAULT_CURRENCY = "₹";

// The four card sentences, in the owner's words. The demat statement supplies
// the quantity and value a card already shows; the dealer report is the file
// that carries cost and terms, so a gap line asks for that file and never
// denies the statement that produced the row.
export const BOND_GAP_COPY = Object.freeze({
  costTermsMarket: "No cost, terms or value yet. Your dealer's report has the cost and terms.",
  costTerms: "No cost or terms yet. Your dealer's report has both.",
  cost: "Cost not known yet",
  terms: "Coupon or maturity not known yet",
});

// Returns leads because the card answers "what is owed and what has been paid"
// before "what is it worth" and "what were the terms".
export const BOND_SECTIONS = ["Returns", "Market value", "Purchase"];

export function moneyText(paise, currency = DEFAULT_CURRENCY) {
  if (paise === null || paise === undefined) return "—";
  const v = Math.round(Number(paise));
  if (!Number.isFinite(v)) return "—";
  const neg = v < 0;
  const a = Math.abs(v);
  const whole = String(Math.trunc(a / 100));
  const frac = String(a % 100).padStart(2, "0");
  let out;
  const tail = whole.slice(-3);
  let head = whole.slice(0, -3);
  if (head) {
    const parts = [];
    while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
    if (head) parts.unshift(head);
    out = parts.join(",") + "," + tail;
  } else out = tail;
  return `${neg ? "-" : ""}${currency} ${out}.${frac}`;
}

export function bondDateLabel(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value || "");
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// The plain source line under a stored term. An old row with no provenance
// says nothing rather than claiming one; a label fallback is handled by the
// caller because it is a guess and stays amber.
export function bondTermSourceText(source, asOf = "") {
  const name = String(source || "").trim();
  if (!name || name.toLowerCase() === "stored") return "";
  const kind = termSourceKind(name);
  const line = kind === "manual" ? "entered by hand"
    : name.toLowerCase() === "cas" ? "from the CAS"
      : `from ${name}`;
  const day = String(asOf || "").slice(0, 10);
  return day ? `${line} · ${bondDateLabel(day)}` : line;
}

// A provenance source is named only when the row stores a name for it. Bare
// `report`, `stored` and `label` are not files, so they print nothing rather
// than a noun that tells the reader nothing.
function bondSourceName(source) {
  const name = String(source || "").trim();
  if (!name) return "";
  if (/^(stored|report|source not recorded)$/i.test(name)) return "";
  const kind = termSourceKind(name);
  if (kind === "label" || kind === "manual") return "";
  return name.toLowerCase() === "cas" ? "the CAS" : name;
}

function bondSourceDay(value) {
  const day = String(value || "").slice(0, 10);
  return day ? bondDateLabel(day) : "";
}

/**
 * The foot line. Each group of facts names the file that supplied it, with
 * that file's own date. One source reads as a plain `from ...` fragment; when
 * both the value file and the terms source appear, each carries its noun so
 * the pair stays readable. Nothing nameable prints nothing.
 */
function bondProvenanceFoot(v, matured) {
  const day = (value) => {
    const text = bondSourceDay(value);
    return text ? ` · ${text}` : "";
  };
  const rawValue = String(v.h.value_source ?? v.h.valueSource ?? "").trim();
  const manual = String(v.h.source || "").toLowerCase() === "manual"
    || termSourceKind(rawValue) === "manual";
  const file = manual ? "" : bondSourceName(rawValue);
  const valuePart = manual ? "entered by hand"
    : file ? `from ${esc(file)}${day(v.valueAsOf)}` : "";
  const term = [
    [v.couponSource, v.couponAsOf],
    [v.maturitySource, v.maturityAsOf],
    [v.faceSource, v.faceAsOf],
  ].map(([source, asOf]) => [bondSourceName(source), asOf])
    .find(([name]) => name) || ["", ""];
  const termsPart = term[0] ? `from ${esc(term[0])}${day(term[1])}` : "";
  if (matured) {
    if (termsPart) return termsPart;
    return manual ? "entered by hand" : "";
  }
  const parts = [];
  if (manual) {
    parts.push("entered by hand");
    if (termsPart) parts.push(`terms ${termsPart}`);
  } else if (valuePart && termsPart && valuePart === termsPart) {
    parts.push(valuePart);
  } else if (valuePart && termsPart) {
    parts.push(`value ${valuePart}`, `terms ${termsPart}`);
  } else {
    if (valuePart) parts.push(valuePart);
    if (termsPart) parts.push(termsPart);
  }
  const returnedKey = String(v.returnedSource || "").trim().toLowerCase();
  const returnedName = returnedKey === "smest" ? "SMEST"
    : returnedKey === "cashflow" ? "Cashflow Future"
      : returnedKey === "bank" ? "the bank" : "";
  if (v.returned && returnedName) parts.push(`repayment from ${returnedName}`);
  if (v.returnedRecordDate) parts.push("record date from BSE");
  if (v.pastCoupon !== null && v.pastCoupon !== undefined) parts.push("interest estimated");
  return parts.join(" · ");
}

export function bondRatingOf(h) {
  const explicit = String(h?.rating || "").trim();
  if (explicit) return explicit;
  const cat = String(h?.category || "").trim();
  return BOND_RATINGS.includes(cat.toUpperCase()) ? cat : "";
}

// One frequency parser, so a spelling the maths accepts is accepted here too.
export function bondPeriods(freq) {
  const months = couponMonths(freq);
  return months ? 12 / months : null;
}

export function bondFrequency(freq) {
  const p = bondPeriods(freq);
  return p === 12 ? "Monthly" : p === 4 ? "Quarterly" : p === 2 ? "Half-yearly"
    : p === 1 ? "Annual" : (freq || "—");
}

export function bondRowView(h) {
  const ba = bondAnalytics(h);
  // splitMatured() attaches the date it resolved. Keep its source and guess
  // flag; re-reading the row would mistake the attached date for a stored one.
  const terms = h.maturitySource
    ? { maturity: h.maturity || "", source: h.maturitySource,
      guessed: !!h.maturityGuessed }
    : bondMaturity(h);
  const parsed = parseBondLabel(h.label);
  // A coupon can be in the name without a maturity date, and parseBondLabel
  // only returns when it has a date. Read the rate from the label too, so a
  // coupon-only row can still show the term it has.
  const labelCoupon = String(h.label || "").match(/(\d+(?:\.\d+)?)\s*%/);
  const couponFromLabel = parsed?.couponPct
    ?? (labelCoupon ? Number(labelCoupon[1]) : null);
  const couponTerm = storedCoupon(h);
  const hasStoredCoupon = couponTerm.stored;
  const couponSource = hasStoredCoupon ? (couponTerm.source || "stored")
    : (couponFromLabel !== null ? "label" : "");
  // The source decides the label, not arithmetic. A CAS figure is a statement
  // figure even when a broker cost lets the price maths run; a BSE quote is a
  // market value even when there is no cost to measure it against.
  const kind = valueKindOf(h);
  const finiteValue = numberOrNull(h.value_paise);
  const marketValue = kind === "market" && finiteValue !== null && finiteValue > 0
    ? finiteValue : null;
  const statementValue = kind === "statement" ? finiteValue : null;
  const costPaise = numberOrNull(h.cost_paise);
  const yieldBps = numberOrNull(h.yield_bps);
  const payoutPaise = numberOrNull(h.payout_paise);
  const periods = bondPeriods(h.frequency);
  // Principal already returned is money in hand, so a sale of the rest is
  // measured against the full cost. Coupons already received and accrued
  // interest are also the seller's, so the total gain includes them. A row
  // with no analytics still has an explicit repayment to show.
  const returned = ba ? (ba.returned || 0)
    : (h.returned_paise === null || h.returned_paise === undefined
      ? 0 : Number(h.returned_paise) || 0);
  const today = new Date().toISOString().slice(0, 10);
  const pastReturn = String(h.redemption_dates || h.principal_dates || "")
    .split(",").map((d) => d.trim()).filter((d) => d && d <= today).sort().pop() || "";
  return {
    h, ba,
    rating: bondRatingOf(h),
    change: bondRatingChange(h.rating_at_purchase, h.rating),
    coupon: ba ? ba.couponPct
      : (hasStoredCoupon ? couponTerm.value : couponFromLabel),
    couponSource: ba ? ba.couponSource : couponSource,
    couponAsOf: ba ? ba.couponAsOf : (hasStoredCoupon ? couponTerm.asOf : ""),
    couponGuessed: ba ? !!ba.couponGuessed
      : (!hasStoredCoupon || termSourceKind(couponSource) === "label")
        && couponFromLabel !== null,
    maturity: terms.maturity || (ba ? ba.maturity : ""),
    maturitySource: terms.source,
    maturityAsOf: String(h.maturityAsOf ?? h.maturity_as_of ?? "").slice(0, 10),
    maturityGuessed: terms.guessed,
    maturityUnread: !terms.maturity && !!(parsed?.dateUnread),
    yieldPct: yieldBps !== null ? yieldBps / 100 : (ba ? ba.ytm : null),
    frequency: bondFrequency(h.frequency),
    periods,
    payoutEstimated: payoutPaise === null && !!(ba && periods),
    interestDate: h.interest_date || "",
    payout: payoutPaise !== null
      ? payoutPaise : (ba && periods ? ba.annualCoupon / periods : null),
    totalCoupon: ba ? ba.couponIncome : null,
    capitalGain: ba ? ba.capitalGain : null,
    expectedMaturity: ba ? (ba.schedule ? ba.schedule.total : ba.faceTotal + ba.couponIncome) : null,
    expectedGain: ba ? (ba.schedule ? (ba.schedule.short ? null : ba.schedule.gain) : ba.totalGain) : null,
    expectedGainPct: ba ? ba.totalGainPct : null,
    parts: ba?.schedule?.parts || 0,
    returned,
    returnedAt: h.returned_at || pastReturn,
    returnedRecordDate: h.returned_record_date || "",
    returnedSource: h.returned_source || "",
    shortSchedule: !!(ba && ba.schedule && ba.schedule.short),
    cost: costPaise,
    marketValue,
    value: marketValue,
    // The figure the statement supplied, kept apart from the calculated
    // market value. Source decides; a CAS value with a cost is still a
    // statement figure, never a price.
    statementValue,
    gain: marketValue === null ? null
      : (ba && ba.hasMarket ? soldGain(ba)
        : (costPaise === null ? null : marketValue + returned - costPaise)),
    pastCoupon: ba?.pastCoupon ?? null,
    originalCoupon: ba?.originalCouponEstimate ?? null,
    couponProgress: ba?.couponProgress ?? null,
    couponLost: ba?.couponLost ?? null,
    faceAtIssue: ba?.purchaseFaceTotal ?? null,
    faceSource: String(h.face_source || "").trim(),
    faceAsOf: String(h.face_as_of || "").slice(0, 10),
    principalLeft: ba?.faceTotal ?? null,
    marketPerUnit: marketValue !== null && Number(h.quantity) > 0
      ? marketValue / Number(h.quantity) : null,
    // The clean price the "Enter market values" screen pre-fills. It is null
    // for a statement figure, even when the row also has a cost.
    marketPrice: marketValue !== null && ba?.faceTotal > 0
      ? (marketValue / ba.faceTotal) * 100 : null,
    valueAsOf: String(h.as_of || "").slice(0, 10),
    accrued: ba?.accrued ?? null,
    accruedFrom: ba?.accruedFrom || "",
    accruedTo: ba?.accruedTo || "",
    currentYield: marketValue === null ? null : (ba?.currentYield ?? null),
    bought: h.purchase_date || "",
  };
}

/**
 * How much of a bond card is worth rendering for the facts it has.
 *
 * A matured lot is awaiting payment, not work, so it always keeps its full
 * card. A live lot with neither cost nor terms gets one sentence and its
 * present facts, not a wall of dashes. A lot missing one side keeps the other
 * and one line for the absent side. Everything else is the full card.
 *
 * A cost-less row can still have a market value when its source is BSE or
 * Manual; a CAS or broker figure is a statement value, never a price.
 *
 * @param {object} v a bondRowView()
 * @param {{matured?: boolean}} [options]
 * @returns {{noCost: boolean, noTerms: boolean, noMarket: boolean,
 *   treatment: "one-line"|"cost-line"|"terms-line"|"full"}}
 */
export function bondCardGap(v, { matured = !!v.matured } = {}) {
  const input = bondInputsMissing(v.h || {});
  const noMarket = v.value === null;
  const gap = { noCost: input.noCost, noTerms: input.noTerms, noMarket };
  if (matured) return { ...gap, treatment: "full" };
  if (input.noCost && input.noTerms) return { ...gap, treatment: "one-line" };
  if (input.noCost) return { ...gap, treatment: "cost-line" };
  if (input.noTerms) return { ...gap, treatment: "terms-line" };
  return { ...gap, treatment: "full" };
}

/**
 * The coverage line for a partial total. Empty when every lot is covered, so
 * a complete book does not carry a redundant scope.
 * @param {number} covered
 * @param {number} count
 * @param {string} noun
 * @returns {string}
 */
export function bondCoverageText(covered, count, noun) {
  return covered < count ? `${covered} of ${count} ${noun}` : "";
}

/**
 * The page banner as one action. The sentence is the label; the arrow is the
 * only decoration. An account with no id gets the same row as a div, because a
 * button that does nothing is worse than plain text.
 *
 * @param {{text: string}} banner
 * @param {string} [importTarget]
 * @param {"broker"|"page"} [importVia]
 * @returns {string}
 */
export function bondGapBannerHtml(banner, importTarget = "", importVia = "broker") {
  const content = `<span>${esc(banner?.text || "")}</span><span aria-hidden="true">→</span>`;
  const action = importVia === "page" ? "go('import')"
    : `bpBondDealerImport(${jsArg(importTarget)})`;
  return importTarget
    ? `<button type="button" class="bond-gap-banner" data-bond-gap-banner onclick="${action}">${content}</button>`
    : `<div class="bond-gap-banner" data-bond-gap-banner>${content}</div>`;
}

export function bondSortValue(v, key) {
  if (key === "rating") return bondRatingRank(v.rating);
  if (key === "yield") return v.yieldPct === null ? -Infinity : v.yieldPct;
  if (key === "current-yield") return v.currentYield === null ? -Infinity : v.currentYield;
  if (key === "coupon") return v.coupon === null ? -Infinity : v.coupon;
  if (key === "maturity") return v.maturity || "9999-99-99";
  if (key === "bought") return v.bought || "9999-99-99";
  if (key === "payout") return v.payout === null ? -Infinity : v.payout;
  if (key === "value") return v.value === null ? (v.h.cost_paise || -Infinity) : v.value;
  if (key === "gain") return v.gain === null ? -Infinity : v.gain;
  return 0;
}

// A matured lot has no future value to hold, so the book total ignores it. The
// card carries its own net-worth figure instead.
function heldTotalOf(v, matured) {
  if (matured) return null;
  const still = v.expectedMaturity;
  return v.ba?.lifetimeTotal ?? (still === null || still === undefined
    ? null : still + (v.returned || 0));
}

/**
 * The one ordered fact list. Each fact carries the `section` it renders under
 * and a `kind`: "anchor" (the one figure the card leads with), "fact",
 * "progress" (the one tinted block) or "sources" (the foot line). The card
 * groups this list; there is no second surface.
 *
 * @param {object} v a bondRowView()
 * @param {{matured?: boolean, assetId?: string, currency?: string, atCost?: boolean}} [options]
 *   `atCost` says the account this lot sits in is valued at cost, so an
 *   unpriced lot shows the cost as its value rather than a missing figure.
 *
 * Every fact says whether its figure is actually present, so a card with a
 * fillable gap can keep what it has instead of printing a wall of dashes.
 *
 * @returns {Array<{key: string, label: string, value: string, sub?: string,
 *   present: boolean, section: string, kind: "anchor"|"fact"|"progress"|"sources",
 *   tone?: string, subTone?: string, actionHtml?: string, progress?: object|null,
 *   empty?: string}>}
 */
export function bondFacts(v, {
  matured = !!v.matured, assetId = "", currency = DEFAULT_CURRENCY, atCost = false,
} = {}) {
  const money = (x) => moneyText(x, currency);
  const dateLabel = bondDateLabel;
  const qty = Number(v.h.quantity) || 0;
  const returned = v.returned || 0;
  const heldTotal = heldTotalOf(v, matured);
  const heldGain = matured ? null : (v.ba?.lifetimeGain ?? v.expectedGain);
  const perUnit = v.marketPerUnit;
  const progress = v.couponProgress === null || v.couponProgress === undefined
    ? null : Math.max(0, Math.min(100, v.couponProgress));
  // The early-repayment note is a claim that a redemption shrank the estimate.
  // That needs both facts the estimate itself uses: a past redemption date and
  // money already back. A rounding gap leaves a few rupees in couponLost either
  // way, and a redemption date alone proves nothing was repaid.
  const policyNote = v.couponLost && v.returned > 0 && v.ba?.firstPast
    ? `${money(v.couponLost)} less after the early repayment`
    : "original schedule";
  // A figure names the source that supplied it. Never turn an unknown or
  // empty source into CAS; the legacy empty source says so plainly.
  const rawValueSource = String(v.h.value_source ?? v.h.valueSource ?? "").trim();
  const valueSourceLong = !rawValueSource ? "source not recorded"
    : rawValueSource.toUpperCase() === "BSE" ? "from BSE"
      : rawValueSource.toUpperCase() === "MANUAL" ? "entered by hand"
        : rawValueSource.toUpperCase() === "CAS" ? "from the CAS"
          : `from ${esc(rawValueSource)}`;
  const statementPaise = Number(v.statementValue);
  const hasStatementValue = Number.isFinite(statementPaise) && statementPaise > 0;
  // The book's lotValue() counts the stored value first, then cost. The
  // matured anchor must be the same amount the divider totals.
  const anchorPaise = matured
    ? (v.value ?? (hasStatementValue ? statementPaise : null) ?? v.cost)
    : null;
  const anchorSource = !matured ? ""
    : (v.value !== null || hasStatementValue) ? valueSourceLong
      : v.cost !== null ? "at cost" : "";
  const anchorSub = `stays in net worth until a bank credit is matched${
    anchorSource ? ` · ${anchorSource}` : ""}`;
  const rowSource = String(v.h.source || "").trim();
  const rowSourceKey = rowSource.toLowerCase();
  // A cost-only lot in an at-cost account is measured by what was paid, so its
  // value line carries the cost and names the source. The words are the account
  // hero's own: held at cost, cost from the file.
  const atCostValue = atCost && v.value === null && v.cost !== null;
  const costSourceLong = rowSourceKey === "report"
    ? (rawValueSource && !["MANUAL", "CAS", "BSE"].includes(rawValueSource.toUpperCase())
      ? `cost from ${esc(rawValueSource)}` : "")
    : rowSourceKey === "cas" ? "cost from the CAS"
      : rowSourceKey === "manual" ? "cost entered by hand"
        : "";
  const enterValue = assetId && v.h.id
    ? `<button class="vupdate" data-bond-action="enter-value"
        onclick="bpBondHoldingEdit(${jsArg(assetId)},${jsArg(v.h.id)},true)">${
        atCostValue ? "Enter market value" : "Enter it"}</button>`
    : "";
  const marketSub = atCostValue
    ? ["held at cost", costSourceLong, enterValue].filter(Boolean).join(" · ")
    : v.value === null
      ? `not recorded${enterValue ? ` · ${enterValue}` : ""}`
      : [v.valueAsOf ? `as of ${dateLabel(v.valueAsOf)}` : "",
          valueSourceLong].filter(Boolean).join(" · ");
  // A cost figure has no market behind it, so the market-derived lines say why
  // they are blank instead of asking for work the account deliberately skips.
  const noMarketSub = atCostValue ? "no market value yet" : "needs a market value";
  const sources = bondProvenanceFoot(v, matured);
  const changeTone = v.change ? (v.change.down ? "neg" : "pos") : "";
  // A CAS row can carry the face per unit with no cost, so there is no
  // purchase face to derive. The statement's face and quantity are still a
  // fact, named as the statement's face rather than a cost-implied guess.
  const facePaise = numberOrNull(v.h.face_paise);
  const faceFallback = !v.ba && facePaise !== null && facePaise > 0 && qty > 0
    ? facePaise * qty : null;
  const faceValue = v.faceAtIssue || faceFallback || null;
  const faceFromStatement = !v.faceAtIssue && faceFallback !== null;
  const gap = bondCardGap(v, { matured });
  const facts = [];

  facts.push(matured ? {
    key: "value-in-net-worth", label: "Value in net worth",
    value: money(anchorPaise),
    sub: anchorSub,
    present: anchorPaise !== null,
    section: "Returns", kind: "anchor",
  } : {
    key: "total-if-held", label: "Total if held",
    value: heldTotal === null ? "—" : money(heldTotal),
    sub: heldGain === null ? "not enough terms to estimate the gain"
      : `${heldGain < 0 ? "−" : "+"}${money(Math.abs(heldGain))} gain`,
    subTone: heldGain === null ? "" : (heldGain < 0 ? "neg" : "pos"),
    present: heldTotal !== null,
    section: "Returns", kind: "anchor",
  });

  facts.push({
    key: "principal-returned", label: "Principal returned",
    value: returned ? money(returned) : "—",
    sub: returned
      ? [v.returnedAt ? `on ${dateLabel(v.returnedAt)}` : "",
        v.returnedRecordDate ? `face reduced ${dateLabel(v.returnedRecordDate)}` : ""]
        .filter(Boolean).join(" · ")
      : "none yet",
    present: !!returned,
    section: "Returns", kind: "fact",
  });
  facts.push({
    key: "principal-left", label: "Principal left",
    value: v.principalLeft ? money(v.principalLeft) : "—",
    sub: v.principalLeft ? (v.maturity ? `due ${dateLabel(v.maturity)}` : "") : "not recorded",
    present: !!v.principalLeft,
    section: "Returns", kind: "fact",
  });

  if (!matured) {
    facts.push({
      key: "next-interest", label: "Next interest",
      value: v.payout === null ? "—" : money(v.payout),
      sub: [v.payout === null
        ? (v.periods === null
          ? (v.h.frequency ? "no periodic payment" : "needs the payment frequency")
          : "amount not recorded") : "",
        v.interestDate ? dateLabel(v.interestDate) : "",
        v.payoutEstimated ? "estimated" : ""].filter(Boolean).join(" · "),
      present: v.payout !== null && v.payout !== undefined,
      section: "Returns", kind: "fact",
    });
    facts.push({
      key: "gain-if-sold", label: "Gain if sold now",
      value: v.gain === null || v.gain === undefined ? "—"
        : `${v.gain < 0 ? "−" : v.gain > 0 ? "+" : ""}${money(Math.abs(v.gain))}`,
      sub: v.gain === null || v.gain === undefined ? noMarketSub : "",
      tone: v.gain < 0 ? "neg" : v.gain > 0 ? "pos" : "",
      present: v.gain !== null && v.gain !== undefined,
      section: "Returns", kind: "fact",
    });
    facts.push({
      key: "interest-progress", label: "Interest received",
      value: progress === null ? "" : `${Math.round(progress)}% complete`,
      present: progress !== null,
      section: "Returns", kind: "progress",
      progress: progress === null ? null : {
        pct: progress,
        paid: v.pastCoupon || 0,
        total: v.originalCoupon || 0,
        note: `${policyNote} · estimated`,
      },
      empty: "Interest received needs the purchase date and coupon frequency.",
    });

    // A statement value is not a market value. It keeps the name of the
    // source that supplied it, and the calculated figure stays empty. An
    // empty string is not a zero: only a finite positive figure is a value.
    if (v.value === null && hasStatementValue) {
      facts.push({
        key: "statement-value", label: "Statement value",
        value: money(statementPaise),
        sub: [v.valueAsOf ? `as on ${dateLabel(v.valueAsOf)}` : "", valueSourceLong]
          .filter(Boolean).join(", "),
        present: true,
        section: "Market value", kind: "fact",
      });
    }
    facts.push({
      key: "market-value", label: atCostValue ? "Value now" : "Market value",
      value: money(atCostValue ? v.cost : v.value), sub: marketSub,
      actionHtml: enterValue,
      present: atCostValue || v.value !== null,
      section: "Market value", kind: "fact",
    });
    facts.push({
      key: "per-unit", label: "Per unit", value: perUnit === null ? "—" : money(perUnit),
      sub: perUnit === null ? noMarketSub : "",
      present: perUnit !== null,
      section: "Market value", kind: "fact",
    });
    facts.push({
      key: "current-yield", label: "Current yield",
      value: v.currentYield === null || v.currentYield === undefined
        ? "—" : `${v.currentYield.toFixed(2)}%`,
      sub: v.currentYield === null || v.currentYield === undefined
        ? noMarketSub : "",
      present: v.currentYield !== null && v.currentYield !== undefined,
      section: "Market value", kind: "fact",
    });
    facts.push({
      key: "current-rating", label: "Current rating",
      value: v.rating ? esc(v.rating) : "—",
      sub: v.rating
        ? (v.change ? `${v.change.down ? "downgraded" : "upgraded"} from ${esc(v.change.from)}`
          : (v.h.rating_at_purchase ? "unchanged since purchase" : ""))
        : "rating missing",
      tone: changeTone, subTone: changeTone,
      present: !!v.rating,
      section: "Market value", kind: "fact",
    });
  }

  facts.push({
    key: "invested", label: "Invested",
    value: money(v.cost),
    sub: v.cost === null ? "not recorded" : "",
    present: v.cost !== null,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "units", label: "Units", value: qty || "—",
    sub: qty ? "" : "not recorded",
    present: qty > 0,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-date", label: "Purchase date", value: v.bought ? dateLabel(v.bought) : "—",
    sub: v.bought ? "" : "not in the statement",
    present: !!v.bought,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: matured ? "face-value" : "face-at-issue",
    label: matured || faceFromStatement ? "Face value" : "Face at issue",
    value: faceValue ? money(faceValue) : "—",
    sub: faceValue
      ? (faceFromStatement ? ""
        : (!matured && !(Number(v.h.face_paise) > 0) ? "inferred from invested"
          : bondTermSourceText(v.faceSource, v.faceAsOf)))
      : "not in the statement",
    present: !!faceValue,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "coupon", label: "Interest rate",
    value: v.coupon === null ? "—" : `${v.coupon}%`,
    sub: v.coupon === null ? "not in the statement"
      : (v.couponGuessed ? "read from the bond name"
        : bondTermSourceText(v.couponSource, v.couponAsOf)),
    subTone: v.couponGuessed ? "amber" : "",
    present: v.coupon !== null && v.coupon !== undefined,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "maturity", label: "Maturity date",
    value: v.maturity ? dateLabel(v.maturity) : "—",
    sub: v.maturity ? (v.maturityGuessed ? "read from the bond name"
      : bondTermSourceText(v.maturitySource, v.maturityAsOf))
      : (v.maturityUnread ? "the date in the name could not be read"
        : "not in the statement"),
    subTone: v.maturityGuessed || v.maturityUnread ? "amber" : "",
    // An unreadable date is a present fact about the name: keep the dash and
    // its note even on a gap card, or the card cannot say why it is missing.
    present: !!v.maturity || v.maturityUnread,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "frequency", label: "Payment frequency", value: esc(v.frequency),
    sub: v.h.frequency ? "" : "not in the statement",
    present: !!v.h.frequency,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-yield", label: "Purchase yield",
    value: v.yieldPct === null ? "—" : `${v.yieldPct.toFixed(2)}%`,
    sub: v.yieldPct === null ? "not in the statement" : "",
    present: v.yieldPct !== null && v.yieldPct !== undefined,
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-rating", label: "Purchase rating",
    value: v.h.rating_at_purchase ? esc(v.h.rating_at_purchase) : "—",
    sub: v.h.rating_at_purchase ? "" : "rating missing",
    present: !!v.h.rating_at_purchase,
    section: "Purchase", kind: "fact",
  });

  facts.push({
    key: "sources", label: "Sources", value: sources,
    present: true,
    section: "Purchase", kind: "sources",
  });

  // A card with a fillable gap shows what it has, not every field the schema
  // could produce. Market value stays beside its Enter it action; the sources
  // always stay as the foot.
  if (gap.treatment !== "full") {
    return facts.filter((fact) => fact.present
      || fact.kind === "sources"
      || (fact.key === "market-value" && !!enterValue));
  }
  return facts;
}

/**
 * The desktop summary bar's figures, computed from the same bondRowView()
 * values the cards render. Presentation arithmetic only and live lots only: a
 * matured lot has no future total and stays on its own card.
 *
 * `costed` and `priced` are the coverage counts, so the bar can say when its
 * totals cover only part of the book.
 *
 * @param {Array<object>} views bondRowView() rows
 * @returns {{count: number, totalIfHeld: number|null, principalLeft: number|null,
 *   interestPct: number|null, costed: number, priced: number}|null}
 */
export function bondBookSummary(views) {
  const list = (views || []).filter((v) => !v.matured);
  if (!list.length) return null;
  let totalIfHeld = null;
  let principalLeft = null;
  let paid = 0;
  let original = 0;
  let costed = 0;
  let priced = 0;
  for (const v of list) {
    const held = heldTotalOf(v, false);
    if (held !== null && held !== undefined) totalIfHeld = (totalIfHeld ?? 0) + held;
    if (v.principalLeft !== null && v.principalLeft !== undefined) {
      principalLeft = (principalLeft ?? 0) + v.principalLeft;
    }
    if (v.cost !== null && v.cost !== undefined) costed += 1;
    if (v.value !== null && v.value !== undefined) priced += 1;
    if (Number(v.originalCoupon) > 0
      && v.pastCoupon !== null && v.pastCoupon !== undefined) {
      paid += Number(v.pastCoupon);
      original += Number(v.originalCoupon);
    }
  }
  return {
    count: list.length,
    totalIfHeld,
    principalLeft,
    interestPct: original > 0 ? Math.min(100, (paid / original) * 100) : null,
    costed,
    priced,
  };
}

const factHtml = (f) => `<div class="bond-fact${f.kind === "anchor" ? " bond-fact-anchor" : ""}" data-fact="${f.key}" data-section="${f.section}"><span class="k">${f.label}</span><span class="v ${f.tone || ""}">${f.value}${f.sub
  ? `<span class="sub ${f.subTone || ""}">${f.sub}</span>` : ""}</span></div>`;

function progressBlock(f, money) {
  if (!f.progress) {
    return `<div class="bond-progress-empty" data-fact="${f.key}"
      data-section="${f.section}">${f.empty}</div>`;
  }
  const { pct, paid, total, note } = f.progress;
  return `<div class="bond-progress" data-fact="${f.key}" data-section="${f.section}">
    <div class="bp-top"><span>${f.label}</span>
      <span><b>${money(paid)}</b> of ${money(total)} · ${Math.round(pct)}% complete</span></div>
    <div class="progress-track" role="progressbar" aria-valuemin="0"
      aria-valuemax="100" aria-valuenow="${Math.round(pct)}"
      aria-label="${f.label}"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="sub">${note}</div>
  </div>`;
}

function actionButtons(v, assetId, { matured = false } = {}) {
  return `${assetId && v.h.id && v.h.security_id ? `<a class="mini-btn" data-bond-action="smest"
      href="https://smest.in/bond-details/x/${encodeURIComponent(v.h.security_id)}"
      target="_blank" rel="noopener"
      title="Open this bond on SMEST, the source of the rating and terms">SMEST ↗</a>` : ""}
    ${assetId && v.h.id && !matured ? `<button class="mini-btn" data-bond-action="refresh"
      title="Ask SMEST for this bond's terms and BSE for its last traded price"
      onclick="bpBondFetchAll(${jsArg(assetId)},${jsArg(v.h.id)})">Refresh</button>` : ""}
    ${assetId && v.h.id ? `<button class="mini-btn" data-bond-action="edit"
      onclick="bpBondHoldingEdit(${jsArg(assetId)},${jsArg(v.h.id)})">Edit</button>` : ""}
    ${assetId && v.h.id ? `<button class="mini-btn" data-bond-action="remove"
      onclick="bpBondHoldingDelete(${jsArg(assetId)},${jsArg(v.h.id)})">Remove</button>` : ""}`;
}

/**
 * The bond card, every fact inline. Returns leads with one anchor figure, then
 * the interest progress; Market value and Purchase follow. The grid collapses
 * to one card per row below 1000px.
 * @param {object} v a bondRowView()
 * @param {string} assetId
 * @param {{matured?: boolean, currency?: string, importTarget?: string,
 *   importVia?: "broker"|"page", atCost?: boolean}} [options]
 *   `atCost` says the account values an unpriced lot at its cost; the value
 *   line then shows that cost instead of an empty market figure.
 */
export function bondCardHtml(v, assetId, {
  matured = false, currency = DEFAULT_CURRENCY, importTarget = assetId,
  importVia = "broker", atCost = false,
} = {}) {
  const money = (x) => moneyText(x, currency);
  const facts = bondFacts(v, { matured, assetId, currency, atCost });
  const sources = facts.find((f) => f.kind === "sources");
  const issuer = String(v.h.issuer || "").trim();
  const badge = matured
    ? `<span class="bond-matured-badge">Matured · awaiting payment</span>` : "";
  const gap = bondCardGap(v, { matured });
  const statementFigure = Number(v.statementValue);
  const statementOnly = v.value === null && Number.isFinite(statementFigure)
    && statementFigure > 0;
  const atCostValue = atCost && v.value === null && v.cost !== null;
  const headerSub = gap.treatment === "full"
    ? `${issuer ? `${esc(issuer)} · ` : ""}${esc(v.h.security_id || "no ISIN")}${v.h.source === "manual"
      ? " · added by hand" : ""}${!issuer
      ? ` · <span class="need">issuer name missing</span>` : ""}`
    : [issuer ? esc(issuer) : "", esc(v.h.security_id || "no ISIN"),
      v.h.source === "manual" ? "added by hand" : ""].filter(Boolean).join(" · ");
  const importAction = importVia === "page"
    ? "go('import')" : `bpBondDealerImport(${jsArg(importTarget)})`;
  const importLink = importTarget
    ? `<button type="button" class="bond-gap-link" data-bond-action="import-broker"
        onclick="${importAction}">Import</button>` : "";
  // A statement value is a value. The line must not say the card has none just
  // because the demat file supplied a statement figure instead of a market
  // price, so only a row with no figure at all gets the value sentence.
  const oneLineBase = gap.noMarket && !statementOnly && !atCostValue
    ? BOND_GAP_COPY.costTermsMarket : BOND_GAP_COPY.costTerms;
  const oneLineCopy = importTarget ? oneLineBase
    : `${oneLineBase.split(". ")[0]}.`;
  const gapLine = gap.treatment === "one-line"
    ? `<div class="bond-gap-line">${oneLineCopy}${
      importLink ? ` ${importLink}` : ""}</div>`
    : gap.treatment === "cost-line"
      ? `<div class="bond-gap-line">${BOND_GAP_COPY.cost}${
        importLink ? ` ${importLink}` : ""}</div>`
      : gap.treatment === "terms-line"
        ? `<div class="bond-gap-line">${BOND_GAP_COPY.terms}${
          importLink ? ` ${importLink}` : ""}</div>`
        : "";
  // A matured lot is money already owed, not a task. Say what is missing
  // quietly, with no Import and no action attribute.
  // A matured lot always has a maturity date; its terms gap can only be the
  // coupon. Never claim the known date is unknown.
  const maturedGap = matured
    ? (gap.noCost && gap.noTerms ? "Cost or coupon not known"
      : gap.noCost ? "Cost not known"
        : gap.noTerms ? "Coupon not known" : "")
    : "";
  const sectionHtml = (section) => {
    const items = facts.filter((f) => f.section === section
      && f.kind !== "progress" && f.kind !== "sources");
    const progress = facts.find((f) => f.section === section && f.kind === "progress");
    if (!items.length && !progress) return "";
    const gridClass = section === "Purchase" ? " bond-grid-purchase" : "";
    // A MARKET VALUE heading over a statement figure would name it as a
    // market value, and over a cost figure it would do the same. Keep the
    // section's facts, drop the heading when its only priced figure is the
    // statement's or the account's cost.
    const title = section === "Market value" && (statementOnly || atCostValue)
      ? "" : `<h3 class="bond-section-title">${section}</h3>`;
    return `<div class="bond-section" data-section="${section}">
      ${title}
      <div class="bond-grid${gridClass}">${items.map(factHtml).join("")}</div>
      ${progress ? progressBlock(progress, money) : ""}</div>`;
  };

  return `<div class="bond-card" data-bond-card="${esc(v.h.id || "")}"
      data-matured="${matured ? "true" : "false"}"${
      gap.treatment !== "full" ? ` data-gap-treatment="${gap.treatment}"` : ""}>
    <div class="bond-card-head"><div class="bond-card-title">
      <div class="bond-name">${esc(v.h.label || "—")}</div>
      <div class="sub">${headerSub}</div></div>
      <div class="bond-card-actions">${badge}${actionButtons(v, assetId, { matured })}</div></div>
    ${gapLine}${maturedGap
      ? `<div class="bond-matured-gap">${maturedGap}</div>` : ""}${
      BOND_SECTIONS.map(sectionHtml).join("")}
    <div class="bond-sources" data-fact="sources">${sources ? sources.value : ""}</div>
  </div>`;
}
