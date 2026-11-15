// One fact model for the bond card. bondFacts() is the only ordered list; each
// fact names the section it ranks in, and the card groups that list. Money
// figures come from bondAnalytics()/bondRowView, never from this module.

import { bondAnalytics, bondMaturity, parseBondLabel, bondRatingChange,
  bondRatingRank, soldGain, BOND_RATINGS } from "./bonds.js";
import { escapeHtml as esc, jsArg } from "./escape.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DEFAULT_CURRENCY = "₹";

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

export function bondRatingOf(h) {
  const explicit = String(h?.rating || "").trim();
  if (explicit) return explicit;
  const cat = String(h?.category || "").trim();
  return BOND_RATINGS.includes(cat.toUpperCase()) ? cat : "";
}

export function bondPeriods(freq) {
  const f = String(freq || "").toLowerCase();
  if (f.includes("month")) return 12;
  if (f.includes("quarter")) return 4;
  if (f.includes("half")) return 2;
  if (f.includes("annual") || f.includes("year")) return 1;
  return null;
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
  const hasPrice = ba ? ba.hasMarket : (h.value_paise !== null && h.cost_paise !== null
    && Math.abs(h.value_paise - h.cost_paise) >= 1);
  const periods = bondPeriods(h.frequency);
  // Principal already returned is money in hand, so a sale of the rest is
  // measured against the full cost. Coupons already received and accrued
  // interest are also the seller's, so the total gain includes them.
  const returned = (ba && ba.returned) || 0;
  const today = new Date().toISOString().slice(0, 10);
  const pastReturn = String(h.redemption_dates || h.principal_dates || "")
    .split(",").map((d) => d.trim()).filter((d) => d && d <= today).sort().pop() || "";
  return {
    h, ba,
    rating: bondRatingOf(h),
    change: bondRatingChange(h.rating_at_purchase, h.rating),
    coupon: ba ? ba.couponPct : (parsed ? parsed.couponPct : (h.couponPct ?? null)),
    maturity: terms.maturity || (ba ? ba.maturity : ""),
    maturitySource: terms.source,
    maturityGuessed: terms.guessed,
    yieldPct: h.yield_bps !== null && h.yield_bps !== undefined
      ? h.yield_bps / 100 : (ba ? ba.ytm : null),
    frequency: bondFrequency(h.frequency),
    periods,
    payoutEstimated: !(h.payout_paise !== null && h.payout_paise !== undefined)
      && !!(ba && periods),
    interestDate: h.interest_date || "",
    payout: h.payout_paise !== null && h.payout_paise !== undefined
      ? h.payout_paise : (ba && periods ? ba.annualCoupon / periods : null),
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
    hasPrice,
    value: hasPrice ? h.value_paise : null,
    gain: hasPrice ? (ba ? soldGain(ba) : h.value_paise + returned - h.cost_paise) : null,
    pastCoupon: ba?.pastCoupon ?? null,
    originalCoupon: ba?.originalCouponEstimate ?? null,
    couponProgress: ba?.couponProgress ?? null,
    couponLost: ba?.couponLost ?? null,
    faceAtIssue: ba?.purchaseFaceTotal ?? null,
    principalLeft: ba?.faceTotal ?? null,
    marketPerUnit: hasPrice && Number(h.quantity) > 0 ? h.value_paise / Number(h.quantity) : null,
    valueAsOf: String(h.as_of || "").slice(0, 10),
    accrued: ba?.accrued ?? null,
    accruedFrom: ba?.accruedFrom || "",
    accruedTo: ba?.accruedTo || "",
    currentYield: ba?.currentYield ?? null,
    bought: h.purchase_date || "",
  };
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
 * @param {{matured?: boolean, assetId?: string, currency?: string}} [options]
 * @returns {Array<{key: string, label: string, value: string, sub?: string,
 *   section: string, kind: "anchor"|"fact"|"progress"|"sources", tone?: string,
 *   subTone?: string, actionHtml?: string, progress?: object|null, empty?: string}>}
 */
export function bondFacts(v, {
  matured = !!v.matured, assetId = "", currency = DEFAULT_CURRENCY,
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
  const policyNote = v.couponLost
    ? `${money(v.couponLost)} less after the early repayment`
    : "original schedule";
  const rawSource = v.h.value_source || (v.h.source === "manual" ? "Manual" : "CAS");
  const valueSourceLong = rawSource === "BSE" ? "from BSE"
    : rawSource === "Manual" ? "entered by hand" : "from the CAS";
  const enterValue = assetId && v.h.id
    ? `<button class="vupdate" data-bond-action="enter-value"
        onclick="bpBondHoldingEdit(${jsArg(assetId)},${jsArg(v.h.id)},true)">Enter it</button>`
    : "";
  const marketSub = v.value === null
    ? `not recorded${enterValue ? ` · ${enterValue}` : ""}`
    : [v.valueAsOf ? `as of ${dateLabel(v.valueAsOf)}` : "",
        valueSourceLong].filter(Boolean).join(" · ");
  const termsSource = v.h.source === "manual" ? "manual" : "CAS";
  const sources = matured
    ? `${v.h.source === "manual" ? "Terms entered by hand" : "Terms from the CAS"}${
      v.rating ? " · rating from SMEST" : ""}`
    : [
      termsSource,
      v.returned ? (v.returnedSource === "cashflow" ? "Cashflow Future"
        : v.returnedSource === "bank" ? "bank" : "SMEST") : "",
      v.returnedRecordDate ? "BSE" : "",
      v.pastCoupon !== null && v.pastCoupon !== undefined ? "interest estimated" : "",
    ].filter(Boolean).join(" · ");
  const changeTone = v.change ? (v.change.down ? "neg" : "pos") : "";
  const facts = [];

  facts.push(matured ? {
    key: "value-in-net-worth", label: "Value in net worth",
    value: money(v.value ?? v.h.cost_paise),
    sub: "stays in net worth until a bank credit is matched",
    section: "Returns", kind: "anchor",
  } : {
    key: "total-if-held", label: "Total if held",
    value: heldTotal === null ? "—" : money(heldTotal),
    sub: heldGain === null ? "not enough terms to estimate the gain"
      : `${heldGain < 0 ? "−" : "+"}${money(Math.abs(heldGain))} gain`,
    subTone: heldGain === null ? "" : (heldGain < 0 ? "neg" : "pos"),
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
    section: "Returns", kind: "fact",
  });
  facts.push({
    key: "principal-left", label: "Principal left",
    value: v.principalLeft ? money(v.principalLeft) : "—",
    sub: v.principalLeft ? (v.maturity ? `due ${dateLabel(v.maturity)}` : "") : "not recorded",
    section: "Returns", kind: "fact",
  });

  if (!matured) {
    facts.push({
      key: "next-interest", label: "Next interest",
      value: v.payout === null ? "—" : money(v.payout),
      sub: [v.payout === null ? "amount not recorded" : "",
        v.interestDate ? dateLabel(v.interestDate) : "",
        v.payoutEstimated ? "estimated" : ""].filter(Boolean).join(" · "),
      section: "Returns", kind: "fact",
    });
    facts.push({
      key: "gain-if-sold", label: "Gain if sold now",
      value: v.gain === null || v.gain === undefined ? "—"
        : `${v.gain < 0 ? "−" : v.gain > 0 ? "+" : ""}${money(Math.abs(v.gain))}`,
      sub: v.gain === null || v.gain === undefined ? "needs a market value" : "",
      tone: v.gain < 0 ? "neg" : v.gain > 0 ? "pos" : "",
      section: "Returns", kind: "fact",
    });
    facts.push({
      key: "interest-progress", label: "Interest received",
      value: progress === null ? "" : `${Math.round(progress)}% complete`,
      section: "Returns", kind: "progress",
      progress: progress === null ? null : {
        pct: progress,
        paid: v.pastCoupon || 0,
        total: v.originalCoupon || 0,
        note: `${policyNote} · estimated`,
      },
      empty: "Interest received needs the purchase date and coupon frequency.",
    });

    facts.push({
      key: "market-value", label: "Market value",
      value: money(v.value), sub: marketSub,
      actionHtml: enterValue,
      section: "Market value", kind: "fact",
    });
    facts.push({
      key: "per-unit", label: "Per unit", value: perUnit === null ? "—" : money(perUnit),
      sub: perUnit === null ? "needs a market value" : "",
      section: "Market value", kind: "fact",
    });
    facts.push({
      key: "current-yield", label: "Current yield",
      value: v.currentYield === null || v.currentYield === undefined
        ? "—" : `${v.currentYield.toFixed(2)}%`,
      sub: v.currentYield === null || v.currentYield === undefined
        ? "needs a market value" : "",
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
      section: "Market value", kind: "fact",
    });
  }

  facts.push({
    key: "invested", label: "Invested",
    value: money(v.h.cost_paise),
    sub: v.h.cost_paise === null || v.h.cost_paise === undefined ? "not recorded" : "",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "units", label: "Units", value: qty || "—",
    sub: qty ? "" : "not recorded",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-date", label: "Purchase date", value: v.bought ? dateLabel(v.bought) : "—",
    sub: v.bought ? "" : "not in the statement",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: matured ? "face-value" : "face-at-issue",
    label: matured ? "Face value" : "Face at issue",
    value: v.faceAtIssue ? money(v.faceAtIssue) : "—",
    sub: v.faceAtIssue
      ? (!matured && !(Number(v.h.face_paise) > 0) ? "inferred from invested" : "")
      : "not in the statement",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "coupon", label: "Interest rate",
    value: v.coupon === null ? "—" : `${v.coupon}%`,
    sub: v.coupon === null ? "not in the statement" : "",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "maturity", label: "Maturity date",
    value: v.maturity ? dateLabel(v.maturity) : "—",
    sub: v.maturity ? (v.maturityGuessed ? "read from the bond name — check it" : "")
      : "not in the statement",
    subTone: v.maturityGuessed ? "amber" : "",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "frequency", label: "Payment frequency", value: esc(v.frequency),
    sub: v.h.frequency ? "" : "not in the statement",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-yield", label: "Purchase yield",
    value: v.yieldPct === null ? "—" : `${v.yieldPct.toFixed(2)}%`,
    sub: v.yieldPct === null ? "not in the statement" : "",
    section: "Purchase", kind: "fact",
  });
  facts.push({
    key: "purchase-rating", label: "Purchase rating",
    value: v.h.rating_at_purchase ? esc(v.h.rating_at_purchase) : "—",
    sub: v.h.rating_at_purchase ? "" : "rating missing",
    section: "Purchase", kind: "fact",
  });

  facts.push({
    key: "sources", label: "Sources", value: sources,
    section: "Purchase", kind: "sources",
  });

  return facts;
}

/**
 * The desktop summary bar's figures, computed from the same bondRowView()
 * values the cards render. Presentation arithmetic only and live lots only: a
 * matured lot has no future total and stays on its own card.
 *
 * @param {Array<object>} views bondRowView() rows
 * @returns {{count: number, totalIfHeld: number|null, principalLeft: number|null,
 *   interestPct: number|null}|null}
 */
export function bondBookSummary(views) {
  const list = (views || []).filter((v) => !v.matured);
  if (!list.length) return null;
  let totalIfHeld = null;
  let principalLeft = null;
  let paid = 0;
  let original = 0;
  for (const v of list) {
    const held = heldTotalOf(v, false);
    if (held !== null && held !== undefined) totalIfHeld = (totalIfHeld ?? 0) + held;
    if (v.principalLeft !== null && v.principalLeft !== undefined) {
      principalLeft = (principalLeft ?? 0) + v.principalLeft;
    }
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
 * @param {{matured?: boolean, currency?: string}} [options]
 */
export function bondCardHtml(v, assetId, {
  matured = false, currency = DEFAULT_CURRENCY,
} = {}) {
  const money = (x) => moneyText(x, currency);
  const facts = bondFacts(v, { matured, assetId, currency });
  const sources = facts.find((f) => f.kind === "sources");
  const issuer = String(v.h.issuer || "").trim();
  const badge = matured
    ? `<span class="bond-matured-badge">Matured · awaiting payment</span>` : "";
  const sectionHtml = (section) => {
    const items = facts.filter((f) => f.section === section
      && f.kind !== "progress" && f.kind !== "sources");
    const progress = facts.find((f) => f.section === section && f.kind === "progress");
    if (!items.length && !progress) return "";
    const gridClass = section === "Purchase" ? " bond-grid-purchase" : "";
    return `<div class="bond-section" data-section="${section}">
      <h3 class="bond-section-title">${section}</h3>
      <div class="bond-grid${gridClass}">${items.map(factHtml).join("")}</div>
      ${progress ? progressBlock(progress, money) : ""}</div>`;
  };

  return `<div class="bond-card" data-bond-card="${esc(v.h.id || "")}"
      data-matured="${matured ? "true" : "false"}">
    <div class="bond-card-head"><div class="bond-card-title">
      <div class="bond-name">${esc(v.h.label || "—")}</div>
      <div class="sub">${issuer ? `${esc(issuer)} · ` : ""}${esc(v.h.security_id || "no ISIN")}${v.h.source === "manual"
        ? " · added by hand" : ""}${!issuer
        ? ` · <span class="need">issuer name missing</span>` : ""}</div></div>
      <div class="bond-card-actions">${badge}${actionButtons(v, assetId, { matured })}</div></div>
    ${BOND_SECTIONS.map(sectionHtml).join("")}
    <div class="bond-sources" data-fact="sources">${sources ? sources.value : ""}</div>
  </div>`;
}
