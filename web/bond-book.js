// One fact model for both bond surfaces. bondFacts() is the only ordered list;
// every fact names the surface it ranks on, so the ledger row and the band are
// filters over the same data the card renders. Presentation only: every money
// figure comes from bondAnalytics()/bondRowView.

import { bondAnalytics, bondMaturity, parseBondLabel, bondRatingChange,
  bondRatingRank, soldGain, BOND_RATINGS } from "./bonds.js";
import { escapeHtml as esc, jsArg } from "./escape.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DEFAULT_CURRENCY = "₹";

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

// The six facts the card shows without opening anything. Record facts live
// behind `Full breakdown`; the anchor and the interest progress are separate
// body blocks. A seventh visible fact means the card is doing two jobs.
export const BOND_CARD_FACTS = [
  { key: "coupon", label: "Interest rate" },
  { key: "maturity", label: "Maturity date" },
  { key: "next-interest", label: "Next interest" },
  { key: "invested", label: "Invested" },
  { key: "market-value", label: "Market value" },
  { key: "current-yield", label: "Current yield" },
];

// A matured lot has no future coupon or market quote to lead with. Its six
// facts answer "what is it, what did it cost, what is it carried at, and when
// did it mature". Face value stays in the breakdown so the budget holds.
export const BOND_MATURED_FACTS = [
  { key: "coupon", label: "Interest rate" },
  { key: "maturity", label: "Maturity date" },
  { key: "invested", label: "Invested" },
  { key: "units", label: "Units" },
  { key: "purchase-date", label: "Purchase date" },
  { key: "face-value", label: "Face value" },
];

// The band follows the card's own sections in the card's own order. Sources is
// the foot line, not a fourth section.
export const BOND_BAND_SECTIONS = ["Purchase", "Market", "Returns"];

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

/**
 * The one ordered fact list. `surface` is the rank the card gives the fact:
 * "row" for the body (anchor, the six visible facts, the interest progress)
 * and "band" for the Full breakdown set plus the sources foot. The ledger
 * row and band are filters over this list, never a second list.
 *
 * Row facts also carry `column` (display order in the comparison row) and
 * `columnLabel` where the header is shorter than the card label. Band facts
 * carry `section`. A revised split is a change to `surface` here.
 *
 * @param {object} v a bondRowView()
 * @param {{matured?: boolean, assetId?: string, currency?: string}} [options]
 * @returns {Array<{key: string, label: string, value: string, sub?: string,
 *   rowSub?: string, surface: "row"|"band", kind: "anchor"|"fact"|"progress"|"sources",
 *   section?: string, column?: number, columnLabel?: string, tone?: string,
 *   subTone?: string, actionHtml?: string, progress?: object|null, empty?: string}>}
 */
export function bondFacts(v, {
  matured = !!v.matured, assetId = "", currency = DEFAULT_CURRENCY,
} = {}) {
  const money = (x) => moneyText(x, currency);
  const dateLabel = bondDateLabel;
  const qty = Number(v.h.quantity) || 0;
  const returned = v.returned || 0;
  const still = v.expectedMaturity;
  const heldTotal = matured ? null
    : (v.ba?.lifetimeTotal ?? (still === null || still === undefined
      ? null : still + returned));
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
  const marketRowSub = v.value === null ? "not recorded"
    : [v.valueAsOf ? dateLabel(v.valueAsOf) : "",
        rawSource === "BSE" ? "BSE" : rawSource === "Manual" ? "manual" : "CAS"]
      .filter(Boolean).join(" · ");
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
    rowSub: "carried until matched",
    surface: "row", kind: "anchor", column: 1, columnLabel: "Value in net worth",
  } : {
    key: "total-if-held", label: "Total if held",
    value: heldTotal === null ? "—" : money(heldTotal),
    sub: heldGain === null ? "not enough terms to estimate the gain"
      : `${heldGain < 0 ? "−" : "+"}${money(Math.abs(heldGain))} gain`,
    subTone: heldGain === null ? "" : (heldGain < 0 ? "neg" : "pos"),
    surface: "row", kind: "anchor", column: 1, columnLabel: "Total if held",
  });

  facts.push({
    key: "coupon", label: "Interest rate",
    value: v.coupon === null ? "—" : `${v.coupon}%`,
    surface: "row", kind: "fact",
  });

  facts.push({
    key: "maturity", label: "Maturity date",
    value: v.maturity ? dateLabel(v.maturity) : "—",
    sub: v.maturityGuessed ? "read from the bond name — check it" : "",
    rowSub: v.maturityGuessed ? "read from the name — check" : "",
    subTone: v.maturityGuessed ? "amber" : "",
    surface: "row", kind: "fact",
    column: matured ? 2 : 6, columnLabel: "Maturity",
  });

  if (!matured) {
    facts.push({
      key: "next-interest", label: "Next interest",
      value: v.payout === null ? "—" : money(v.payout),
      sub: [v.interestDate ? dateLabel(v.interestDate) : "",
        v.payoutEstimated ? "estimated" : ""].filter(Boolean).join(" · "),
      rowSub: [v.interestDate ? dateLabel(v.interestDate) : "",
        v.payoutEstimated ? "est" : ""].filter(Boolean).join(" · "),
      surface: "row", kind: "fact", column: 5, columnLabel: "Next interest",
    });
  }

  facts.push({
    key: "invested", label: "Invested",
    value: money(v.h.cost_paise),
    surface: "row", kind: "fact", column: 3, columnLabel: "Invested",
  });

  if (!matured) {
    facts.push({
      key: "market-value", label: "Market value",
      value: money(v.value), sub: marketSub, rowSub: marketRowSub,
      actionHtml: enterValue,
      surface: "row", kind: "fact", column: 2, columnLabel: "Market value",
    });

    facts.push({
      key: "current-yield", label: "Current yield",
      value: v.currentYield === null || v.currentYield === undefined
        ? "—" : `${v.currentYield.toFixed(2)}%`,
      surface: "row", kind: "fact", column: 4, columnLabel: "Current yield",
    });

    facts.push({
      key: "interest-progress", label: "Interest received",
      value: progress === null ? "" : `${Math.round(progress)}% complete`,
      surface: "row", kind: "progress",
      progress: progress === null ? null : {
        pct: progress,
        paid: v.pastCoupon || 0,
        total: v.originalCoupon || 0,
        note: `${policyNote} · estimated`,
      },
      empty: "Interest received needs the purchase date and coupon frequency.",
    });
  }

  if (matured) {
    facts.push({
      key: "units", label: "Units", value: qty || "—",
      surface: "row", kind: "fact", column: 4, columnLabel: "Units",
    });
    facts.push({
      key: "purchase-date", label: "Purchase date", value: v.bought ? dateLabel(v.bought) : "—",
      surface: "row", kind: "fact", column: 5, columnLabel: "Purchase date",
    });
    facts.push({
      key: "face-value", label: "Face value",
      value: v.faceAtIssue ? money(v.faceAtIssue) : "—",
      surface: "row", kind: "fact", column: 6, columnLabel: "Face value",
    });
  } else {
    facts.push({
      key: "purchase-date", label: "Purchase date", value: v.bought ? dateLabel(v.bought) : "—",
      surface: "band", kind: "fact", section: "Purchase",
    });
    facts.push({
      key: "units", label: "Units", value: qty || "—",
      surface: "band", kind: "fact", section: "Purchase",
    });
    facts.push({
      key: "face-at-issue", label: "Face at issue",
      value: v.faceAtIssue ? money(v.faceAtIssue) : "—",
      sub: v.faceAtIssue && !(Number(v.h.face_paise) > 0) ? "inferred from invested" : "",
      surface: "band", kind: "fact", section: "Purchase",
    });
  }

  facts.push({
    key: "frequency", label: "Payment frequency", value: esc(v.frequency),
    surface: "band", kind: "fact", section: "Purchase",
  });
  facts.push({
    key: "purchase-yield", label: "Purchase yield",
    value: v.yieldPct === null ? "—" : `${v.yieldPct.toFixed(2)}%`,
    surface: "band", kind: "fact", section: "Purchase",
  });
  facts.push({
    key: "purchase-rating", label: "Purchase rating",
    value: v.h.rating_at_purchase ? esc(v.h.rating_at_purchase) : "—",
    sub: v.h.rating_at_purchase ? "" : "rating missing",
    surface: "band", kind: "fact", section: "Purchase",
  });

  if (!matured) {
    facts.push({
      key: "per-unit", label: "Per unit", value: perUnit === null ? "—" : money(perUnit),
      surface: "band", kind: "fact", section: "Market",
    });
    facts.push({
      key: "current-rating", label: "Current rating",
      value: v.rating ? esc(v.rating) : "—",
      sub: v.rating
        ? (v.change ? `${v.change.down ? "downgraded" : "upgraded"} from ${esc(v.change.from)}`
          : (v.h.rating_at_purchase ? "unchanged since purchase" : ""))
        : "rating missing",
      tone: changeTone, subTone: changeTone,
      surface: "band", kind: "fact", section: "Market",
    });
  }

  facts.push({
    key: "principal-returned", label: "Principal returned",
    value: returned ? money(returned) : "—",
    sub: returned
      ? [v.returnedAt ? `on ${dateLabel(v.returnedAt)}` : "",
        v.returnedRecordDate ? `face reduced ${dateLabel(v.returnedRecordDate)}` : ""]
        .filter(Boolean).join(" · ")
      : "",
    surface: "band", kind: "fact", section: "Returns",
  });
  facts.push({
    key: "principal-left", label: "Principal left",
    value: v.principalLeft ? money(v.principalLeft) : "—",
    sub: v.principalLeft && v.maturity ? `due ${dateLabel(v.maturity)}` : "",
    surface: "band", kind: "fact", section: "Returns",
  });
  if (!matured) {
    facts.push({
      key: "gain-if-sold", label: "Gain if sold now",
      value: v.gain === null || v.gain === undefined ? "—"
        : `${v.gain < 0 ? "−" : v.gain > 0 ? "+" : ""}${money(Math.abs(v.gain))}`,
      tone: v.gain < 0 ? "neg" : v.gain > 0 ? "pos" : "",
      surface: "band", kind: "fact", section: "Returns",
    });
  }

  facts.push({
    key: "sources", label: "Sources", value: sources,
    surface: "band", kind: "sources",
  });

  return facts;
}

const factHtml = (f) => `<div class="bond-fact" data-fact="${f.key}"
  data-surface="${f.surface}"><span class="k">${f.label}</span><span class="v ${
  f.tone || ""}">${f.value}${f.sub ? `<div class="sub ${f.subTone || ""}">${f.sub}</div>` : ""}</span></div>`;

const anchorHtml = (f) => `<div class="bond-anchor" data-fact="${f.key}"
  data-surface="${f.surface}"><span class="k">${f.label}</span><span class="v">${f.value}</span>${
  f.sub ? `<span class="sub ${f.subTone || ""}">${f.sub}</span>` : ""}</div>`;

function progressBlock(f, money) {
  if (!f.progress) {
    return `<div class="bond-progress-empty" data-fact="${f.key}"
      data-surface="${f.surface}">${f.empty}</div>`;
  }
  const { pct, paid, total, note } = f.progress;
  return `<div class="bond-progress" data-fact="${f.key}" data-surface="${f.surface}">
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
 * The bond card. This is the phone surface; the desktop band is the same fact
 * list with the same surfaces. The interest progress sits in the body, above
 * the disclosure, because it ranks with the row.
 * @param {object} v a bondRowView()
 * @param {string} assetId
 * @param {{matured?: boolean, currency?: string, open?: boolean}} [options]
 */
export function bondCardHtml(v, assetId, {
  matured = false, currency = DEFAULT_CURRENCY, open = false,
} = {}) {
  const money = (x) => moneyText(x, currency);
  const facts = bondFacts(v, { matured, assetId, currency });
  const anchor = facts.find((f) => f.kind === "anchor");
  const visible = facts.filter((f) => f.surface === "row" && f.kind === "fact");
  const progress = facts.find((f) => f.kind === "progress");
  const sources = facts.find((f) => f.kind === "sources");
  const band = facts.filter((f) => f.surface === "band" && f.kind === "fact");
  const issuer = String(v.h.issuer || "").trim();
  const badge = matured
    ? `<span class="bond-matured-badge">Matured · awaiting payment</span>` : "";
  const toggle = assetId && v.h.id
    ? ` ontoggle="bpBondCardToggle(${jsArg(assetId)},${jsArg(v.h.id)},this.open)"` : "";
  const sections = BOND_BAND_SECTIONS.map((section) => {
    const items = band.filter((f) => f.section === section);
    if (!items.length) return "";
    return `<div class="bond-section"><h3 class="bond-section-title">${section}</h3>
      <div class="bond-grid">${items.map(factHtml).join("")}</div></div>`;
  }).join("");

  return `<div class="bond-card" data-bond-card="${esc(v.h.id || "")}"
      data-matured="${matured ? "true" : "false"}">
    <div class="bond-card-head"><div class="bond-card-title">
      <div class="bond-name">${esc(v.h.label || "—")}</div>
      <div class="sub">${issuer ? `${esc(issuer)} · ` : ""}${esc(v.h.security_id || "no ISIN")}${v.h.source === "manual"
        ? " · added by hand" : ""}${!issuer
        ? ` · <span class="need">issuer name missing</span>` : ""}</div></div>
      <div class="bond-card-actions">${badge}${actionButtons(v, assetId, { matured })}</div></div>
    ${anchorHtml(anchor)}
    <div class="bond-grid bond-facts">${visible.map(factHtml).join("")}</div>
    ${progress ? progressBlock(progress, money) : ""}
    <details class="bond-breakdown"${open ? " open" : ""}${toggle}><summary>Full breakdown</summary>
      ${sections}
    </details>
    <div class="bond-sources" data-fact="sources" data-surface="band">${sources.value}</div>
  </div>`;
}

const bandIdOf = (id) => `bond-band-${String(id || "").replace(/[^A-Za-z0-9_-]/g, "_")}`;

const bandKv = (f) => `<div class="bl-kv" data-fact="${f.key}" data-surface="${f.surface}">
  <dt>${f.label}</dt><dd class="${f.tone || ""}">${f.value}${
  f.sub ? `<small class="${f.subTone || ""}">${f.sub}</small>` : ""}</dd></div>`;

function rowProgress(f, money) {
  if (!f) return "";
  if (!f.progress) {
    return `<span class="bl-progress" data-row-fact="${f.key}" data-surface="${f.surface}">
      <span class="bl-progress-label">${f.label}</span>
      <span class="bl-progress-text">${f.empty}</span></span>`;
  }
  const { pct, paid, total, note } = f.progress;
  return `<span class="bl-progress" data-row-fact="${f.key}" data-surface="${f.surface}">
    <span class="bl-progress-label">${f.label}</span>
    <span class="bl-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
    <span class="bl-progress-text"><b>${money(paid)}</b> of ${money(total)} · ${
  Math.round(pct)}% complete · ${note}</span></span>`;
}

function ledgerRow(v, facts, columns, matured, selected, assetId, currency) {
  const money = (x) => moneyText(x, currency);
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const coupon = byKey.get("coupon");
  const progress = facts.find((f) => f.kind === "progress");
  const id = String(v.h.id || "");
  const label = v.h.label || "—";
  const issuer = String(v.h.issuer || "").trim();
  const parsedCoupon = parseBondLabel(v.h.label)?.couponPct;
  const labelHasCoupon = parsedCoupon !== null && parsedCoupon !== undefined
    && v.coupon !== null && Math.abs(Number(parsedCoupon) - Number(v.coupon)) < 0.001;
  const couponChip = coupon && coupon.value !== "—" && !labelHasCoupon
    ? ` · <span class="bl-coupon">${coupon.value}</span>` : "";
  const identifierSub = `${issuer ? `${esc(issuer)} · ` : ""}${
    esc(v.h.security_id || "no ISIN")}${v.h.source === "manual" ? " · added by hand" : ""}${
    !issuer ? ` · <span class="need">issuer name missing</span>` : ""}${couponChip}`;
  const cells = columns.map((col) => {
    const f = byKey.get(col.key);
    if (!f) return "";
    const sub = f.rowSub ?? f.sub;
    return `<span class="bl-num${f.kind === "anchor" ? " bl-anchor" : ""}"
      data-row-fact="${f.key}" data-surface="row">${f.value}${
      sub ? `<span class="bl-sub ${f.subTone || ""}">${sub}</span>` : ""}</span>`;
  }).join("");
  return `<button type="button" class="bl-row" data-bond-id="${esc(id)}"
      data-matured="${matured ? "true" : "false"}" aria-expanded="${selected ? "true" : "false"}"
      aria-controls="${bandIdOf(id)}"
      onclick="bpBondSelect(${jsArg(assetId)},${jsArg(id)})">
    <span class="bl-id" data-row-fact="coupon" data-surface="row">
      <span class="bl-name" title="${esc(label)}">${esc(label)}</span>
      <span class="bl-sub">${identifierSub}</span></span>
    ${cells}
    ${matured ? "" : rowProgress(progress, money)}
  </button>`;
}

function ledgerBand(v, facts, matured, selected, assetId) {
  const id = String(v.h.id || "");
  const band = facts.filter((f) => f.surface === "band" && f.kind === "fact");
  const sources = facts.find((f) => f.kind === "sources");
  const market = facts.find((f) => f.key === "market-value");
  const columns = BOND_BAND_SECTIONS.map((section) => {
    const items = band.filter((f) => f.section === section);
    if (!items.length) return "";
    const missing = section === "Market" && market && market.value === "—"
      ? `<div class="bl-missing">Market value not recorded · ${market.actionHtml || ""}</div>`
      : "";
    return `<div class="bl-col" data-section="${section}"><h3>${section}</h3>
      <dl>${items.map(bandKv).join("")}</dl>${missing}</div>`;
  }).join("");
  return `<div class="bl-band" id="${bandIdOf(id)}" data-band-id="${esc(id)}"
      data-matured="${matured ? "true" : "false"}" role="region"
      aria-label="${esc(v.h.label || "Bond")} breakdown"${selected ? "" : " hidden"}>
    <div class="bl-cols">${columns}</div>
    <div class="bl-foot"><div class="bl-src" data-fact="sources"
      data-surface="band">${sources ? sources.value : ""}</div>
      <div class="bl-actions">${actionButtons(v, assetId, { matured })}</div></div>
  </div>`;
}

function maturedNote(matured, maturedValue, maturedGuessed, currency) {
  return `${matured.length} matured · ${maturedValue
    ? `${moneyText(maturedValue, currency)} ` : ""}awaiting payment. Carried in net worth
    until a bank credit is matched.${maturedGuessed ? ` For ${maturedGuessed} lot${
    maturedGuessed === 1 ? "" : "s"}, the date was read from the bond name; check it against
    the statement.` : ""} Delete a lot only if you know it was paid.`;
}

/**
 * One ledger with one open band. The live and matured lots keep their own
 * tables because the anchor means different things; the row and band facts
 * are filters over bondFacts(), so a fact cannot rank on one surface only.
 * @param {Array<object>} views bondRowView() rows, each with `matured`
 * @param {string} assetId
 * @param {{selectedId?: string, currency?: string, maturedValue?: number,
 *   maturedGuessed?: number}} [options]
 */
export function bondLedgerHtml(views, assetId, {
  selectedId = "", currency = DEFAULT_CURRENCY, maturedValue = 0, maturedGuessed = 0,
} = {}) {
  const rows = views || [];
  if (!rows.length) return "";
  const live = rows.filter((v) => !v.matured);
  const matured = rows.filter((v) => v.matured);
  const pick = rows.find((v) => String(v.h.id) === String(selectedId))
    || live[0] || matured[0] || rows[0];
  const pickId = pick ? String(pick.h.id) : "";

  const tableFor = (list, isMatured) => {
    if (!list.length) return "";
    const sample = bondFacts(list[0], { matured: isMatured, assetId, currency });
    const columns = sample
      .filter((f) => f.surface === "row" && f.kind !== "progress" && f.key !== "coupon")
      .sort((a, b) => (a.column ?? 99) - (b.column ?? 99));
    const head = `<div class="bl-head" aria-hidden="true"><span>Bond</span>${
      columns.map((f) => `<span class="num">${f.columnLabel || f.label}</span>`).join("")}</div>`;
    const body = list.map((v) => {
      const facts = bondFacts(v, { matured: isMatured, assetId, currency });
      const on = String(v.h.id) === pickId;
      return ledgerRow(v, facts, columns, isMatured, on, assetId, currency)
        + ledgerBand(v, facts, isMatured, on, assetId);
    }).join("");
    return `<div class="bl-table${isMatured ? " bl-matured" : ""}" role="group"
        aria-label="${isMatured ? "Matured bonds" : "Bonds"}">
      ${isMatured ? `<div class="bl-divider">Matured · awaiting payment</div>` : ""}
      ${head}
      ${body}
      ${isMatured ? `<div class="bl-note">${
        maturedNote(matured, maturedValue, maturedGuessed, currency)}</div>` : ""}
    </div>`;
  };

  return `<div class="bond-ledger">${tableFor(live, false)}${tableFor(matured, true)}</div>`;
}
