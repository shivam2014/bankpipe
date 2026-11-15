// The bond book: a compact index on the left and the bond card on the right.
// The card is the same component the phone renders, so a fact cannot exist on
// one surface and not the other. The index adds comparison; it adds no facts.
//
// Presentation only. Every money figure comes from bondAnalytics()/bondRowView;
// this module formats what the ledger already decided.

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
// behind `Full breakdown`; the anchor is separate. A seventh visible fact means
// the card is doing two jobs.
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

// The comparison columns the index carries. Every one of them is also on the
// card; the index never introduces a seventh bond fact.
export const BOND_INDEX_FACTS = [
  { key: "bond", label: "Bond" },
  { key: "value", label: "Market value" },
  { key: "yield", label: "Current yield" },
  { key: "next", label: "Next interest" },
  { key: "maturity", label: "Matures" },
];

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

const fact = (key, label, val, cls = "") => `<div class="bond-fact" data-fact="${key}">
  <span class="k">${label}</span><span class="v ${cls}">${val}</span></div>`;

const maturityFact = (v, dateLabel) => `${v.maturity ? dateLabel(v.maturity) : "—"}${
  v.maturityGuessed ? `<div class="sub">read from the bond name — check it</div>` : ""}`;

/**
 * The bond card. This is the phone surface and the desktop dossier; it is the
 * same function so parity is structural, not a promise.
 * @param {object} v a bondRowView()
 * @param {string} assetId
 * @param {{matured?: boolean, currency?: string}} [options]
 */
export function bondCardHtml(v, assetId, { matured = false, currency = DEFAULT_CURRENCY } = {}) {
  const money = (x) => moneyText(x, currency);
  const moneyOrDash = money;
  const dateLabel = bondDateLabel;
  const rawSource = v.h.value_source || (v.h.source === "manual" ? "Manual" : "CAS");
  const valueSourceLong = rawSource === "BSE" ? "from BSE"
    : rawSource === "Manual" ? "entered by hand" : "from the CAS";
  const qty = Number(v.h.quantity) || 0;
  const returned = v.returned || 0;
  const still = v.expectedMaturity;
  const heldTotal = matured ? null
    : (v.ba?.lifetimeTotal ?? (still === null || still === undefined
      ? null : still + returned));
  const heldGain = matured ? null : (v.ba?.lifetimeGain ?? v.expectedGain);
  const perUnit = v.value !== null && v.value !== undefined && qty > 0
    ? v.value / qty : null;
  const progress = v.couponProgress === null || v.couponProgress === undefined
    ? null : Math.max(0, Math.min(100, v.couponProgress));
  const policyNote = v.couponLost
    ? `${money(v.couponLost)} less after the early repayment`
    : "original schedule";
  const progressBlock = progress === null
    ? `<div class="bond-progress-empty">Interest received
        needs the purchase date and coupon frequency.</div>`
    : `<div class="bond-progress">
        <div class="bp-top"><span>Interest received</span>
          <span><b>${money(v.pastCoupon || 0)}</b> of ${money(v.originalCoupon || 0)}
            · ${Math.round(progress)}% complete</span></div>
        <div class="progress-track" role="progressbar" aria-valuemin="0"
          aria-valuemax="100" aria-valuenow="${Math.round(progress)}"
          aria-label="Interest received">
          <div class="progress-fill" style="width:${progress}%"></div></div>
        <div class="sub">${policyNote} · estimated</div>
      </div>`;
  const marketSub = v.value === null
    ? `not recorded${assetId && v.h.id ? ` · <button class="vupdate"
        onclick="bpBondHoldingEdit(${jsArg(assetId)},${jsArg(v.h.id)},true)">Enter it</button>` : ""}`
    : [v.valueAsOf ? `as of ${dateLabel(v.valueAsOf)}` : "",
        valueSourceLong].filter(Boolean).join(" · ");
  const maturedBadge = matured
    ? `<span class="bond-matured-badge">Matured · awaiting payment</span>` : "";
  const actions = `<div class="bond-card-actions">
    ${maturedBadge}
    ${assetId && v.h.id && v.h.security_id ? `<a class="mini-btn"
      href="https://smest.in/bond-details/x/${encodeURIComponent(v.h.security_id)}"
      target="_blank" rel="noopener"
      title="Open this bond on SMEST, the source of the rating and terms">SMEST ↗</a>` : ""}
    ${assetId && v.h.id && !matured ? `<button class="mini-btn"
      title="Ask SMEST for this bond's terms and BSE for its last traded price"
      onclick="bpBondFetchAll(${jsArg(assetId)},${jsArg(v.h.id)})">Refresh</button>` : ""}
    ${assetId && v.h.id ? `<button class="mini-btn"
      onclick="bpBondHoldingEdit(${jsArg(assetId)},${jsArg(v.h.id)})">Edit</button>` : ""}
    ${assetId && v.h.id ? `<button class="mini-btn"
      onclick="bpBondHoldingDelete(${jsArg(assetId)},${jsArg(v.h.id)})">Remove</button>` : ""}
  </div>`;

  const anchor = matured
    ? `<div class="bond-anchor">
        <span class="k">Value in net worth</span>
        <span class="v">${moneyOrDash(v.value ?? v.h.cost_paise)}</span>
        <span class="sub">stays in net worth until a bank credit is matched</span>
      </div>`
    : `<div class="bond-anchor">
        <span class="k">Total if held</span>
        <span class="v">${heldTotal === null ? "—" : money(heldTotal)}</span>
        ${heldGain === null ? `<span class="sub">not enough terms to estimate the gain</span>`
          : `<span class="sub ${heldGain < 0 ? "neg" : "pos"}">${
            heldGain < 0 ? "−" : "+"}${money(Math.abs(heldGain))} gain</span>`}
      </div>`;

  const facts = matured ? [
    fact("coupon", "Interest rate", v.coupon === null ? "—" : `${v.coupon}%`),
    fact("maturity", "Maturity date", maturityFact(v, dateLabel)),
    fact("invested", "Invested", moneyOrDash(v.h.cost_paise)),
    fact("units", "Units", qty || "—"),
    fact("purchase-date", "Purchase date", v.bought ? dateLabel(v.bought) : "—"),
    fact("face-value", "Face value", v.faceAtIssue ? money(v.faceAtIssue) : "—"),
  ] : [
    fact("coupon", "Interest rate", v.coupon === null ? "—" : `${v.coupon}%`),
    fact("maturity", "Maturity date", maturityFact(v, dateLabel)),
    fact("next-interest", "Next interest", v.payout === null ? "—" : `${money(v.payout)}${
      v.interestDate || v.payoutEstimated ? `<div class="sub">${
        [v.interestDate ? dateLabel(v.interestDate) : "",
          v.payoutEstimated ? "estimated" : ""].filter(Boolean).join(" · ")
      }</div>` : ""}`),
    fact("invested", "Invested", moneyOrDash(v.h.cost_paise)),
    fact("market-value", "Market value", `${moneyOrDash(v.value)}${
      v.value === null ? "" : `<div class="sub">${marketSub}</div>`}`),
    fact("current-yield", "Current yield", v.currentYield === null || v.currentYield === undefined
      ? "—" : `${v.currentYield.toFixed(2)}%`),
  ];

  const purchaseGrid = matured
    ? `<div class="bond-grid">
        ${fact("frequency", "Payment frequency", esc(v.frequency))}
        ${fact("purchase-yield", "Purchase yield", v.yieldPct === null ? "—" : `${v.yieldPct.toFixed(2)}%`)}
        ${fact("purchase-rating", "Purchase rating", v.h.rating_at_purchase
          ? esc(v.h.rating_at_purchase)
          : `—<div class="sub need">rating missing</div>`)}
      </div>`
    : `<div class="bond-grid">
        ${fact("purchase-date", "Purchase date", v.bought ? dateLabel(v.bought) : "—")}
        ${fact("units", "Units", qty || "—")}
        ${fact("face-at-issue", "Face at issue", v.faceAtIssue ? `${money(v.faceAtIssue)}${
          !(Number(v.h.face_paise) > 0)
            ? `<div class="sub">inferred from invested</div>` : ""}` : "—")}
        ${fact("frequency", "Payment frequency", esc(v.frequency))}
        ${fact("purchase-yield", "Purchase yield", v.yieldPct === null ? "—" : `${v.yieldPct.toFixed(2)}%`)}
        ${fact("purchase-rating", "Purchase rating", v.h.rating_at_purchase
          ? esc(v.h.rating_at_purchase)
          : `—<div class="sub need">rating missing</div>`)}
      </div>`;
  const marketGrid = matured ? "" : `<div class="bond-section">
      <h3 class="bond-section-title">Market value</h3>
      <div class="bond-grid">
        ${fact("per-unit", "Per unit", perUnit === null ? "—" : money(perUnit))}
        ${fact("current-rating", "Current rating", v.rating ? `${esc(v.rating)}${
          v.change ? `<div class="sub ${v.change.down ? "neg" : "pos"}">${
            v.change.down ? "downgraded" : "upgraded"} from ${esc(v.change.from)}</div>`
            : v.h.rating_at_purchase ? `<div class="sub">unchanged since purchase</div>` : ""
        }` : `—<div class="sub need">rating missing</div>`, v.change ? (v.change.down ? "neg" : "pos") : "")}
      </div>
    </div>`;
  const returnsGrid = `<div class="bond-section">
      <h3 class="bond-section-title">Returns</h3>
      <div class="bond-grid">
        ${fact("principal-returned", "Principal returned", returned ? `${money(returned)}${
          v.returnedAt ? `<div class="sub">on ${dateLabel(v.returnedAt)}</div>` : ""}${
          v.returnedRecordDate ? `<div class="sub">face reduced ${
            dateLabel(v.returnedRecordDate)}</div>` : ""}` : "—")}
        ${fact("principal-left", "Principal left", v.principalLeft ? `${money(v.principalLeft)}${
          v.maturity ? `<div class="sub">due ${dateLabel(v.maturity)}</div>` : ""}` : "—")}
        ${matured ? "" : fact("gain-if-sold", "Gain if sold now",
          v.gain === null || v.gain === undefined ? "—" : `${v.gain < 0 ? "−" : v.gain > 0 ? "+" : ""}${money(Math.abs(v.gain))}`,
          v.gain < 0 ? "neg" : v.gain > 0 ? "pos" : "")}
        ${matured ? "" : fact("maturity-value", "Maturity value",
          v.expectedMaturity === null || v.expectedMaturity === undefined
            ? "—" : `${money(v.expectedMaturity)}${
            v.expectedGain === null || v.expectedGain === undefined ? ""
              : `<div class="sub ${v.expectedGain < 0 ? "neg" : "pos"}">${
                v.expectedGain < 0 ? "−" : "+"}${money(Math.abs(v.expectedGain))}${
                v.parts > 1 ? ` · principal in ${v.parts} parts` : ""}</div>`}`)}
      </div>
      ${matured ? "" : progressBlock}
    </div>`;
  const sources = matured
    ? `Terms from the CAS${v.rating ? " · rating from SMEST" : ""}`
    : [
      "CAS",
      v.returned ? (v.returnedSource === "cashflow" ? "Cashflow Future"
        : v.returnedSource === "bank" ? "bank" : "SMEST") : "",
      v.returnedRecordDate ? "BSE" : "",
      v.pastCoupon !== null && v.pastCoupon !== undefined ? "interest estimated" : "",
    ].filter(Boolean).join(" · ");

  return `<div class="bond-card" data-bond-card="${esc(v.h.id || "")}"
      data-matured="${matured ? "true" : "false"}">
    <div class="bond-card-head"><div class="bond-card-title">
      <div class="bond-name">${esc(v.h.label || "—")}</div>
      <div class="sub">${v.h.issuer ? `${esc(v.h.issuer)} · ` : ""}${esc(v.h.security_id || "no ISIN")}${v.h.source === "manual"
        ? " · added by hand" : ""}${!String(v.h.issuer || "").trim()
        ? ` · <span class="need">issuer name missing</span>` : ""}</div></div>
      ${actions}</div>
    ${anchor}
    <div class="bond-grid bond-facts">${facts.join("")}</div>
    <details class="bond-breakdown"><summary>Full breakdown</summary>
      <div class="bond-section">
        <h3 class="bond-section-title">Purchase</h3>
        ${purchaseGrid}
      </div>
      ${marketGrid}
      ${returnsGrid}
    </details>
    <div class="bond-sources">${sources}</div>
  </div>`;
}

const indexCell = (value, sub = "") => `<span class="bi-num">${value}${
  sub ? `<span class="bi-sub">${sub}</span>` : ""}</span>`;

function bondIndexRow(v, assetId, selected, currency) {
  const money = (x) => moneyText(x, currency);
  const on = selected === String(v.h.id);
  const value = v.matured ? (v.value ?? v.h.cost_paise) : v.value;
  return `<button type="button" class="bond-index-row" data-bond-id="${esc(v.h.id || "")}"
      aria-pressed="${on ? "true" : "false"}" aria-controls="bond-dossier"
      onclick="bpBondSelect(${jsArg(assetId)},${jsArg(v.h.id)})">
    <span class="bi-name">${esc(v.h.label || "—")}</span>
    ${indexCell(value === null || value === undefined ? "—" : money(value))}
    ${indexCell(v.matured || v.currentYield === null || v.currentYield === undefined
      ? "—" : `${v.currentYield.toFixed(2)}%`)}
    ${indexCell(v.matured || v.payout === null ? "—" : money(v.payout),
      v.matured ? "" : (v.interestDate ? bondDateLabel(v.interestDate)
        : (v.payoutEstimated ? "estimated" : "")))}
    ${indexCell(v.maturity ? bondDateLabel(v.maturity) : "—")}
  </button>`;
}

/**
 * Master-detail book. The left index is comparison only; the right dossier is
 * the phone card exactly. Selecting a row changes the dossier, not the page.
 * @param {Array<object>} views bondRowView() rows, each with `matured`
 * @param {string} assetId
 * @param {{selectedId?: string, currency?: string, maturedValue?: number,
 *   maturedGuessed?: number}} [options]
 */
export function bondBookHtml(views, assetId, {
  selectedId = "", currency = DEFAULT_CURRENCY, maturedValue = 0, maturedGuessed = 0,
} = {}) {
  const rows = views || [];
  if (!rows.length) return "";
  const live = rows.filter((v) => !v.matured);
  const matured = rows.filter((v) => v.matured);
  const pick = rows.find((v) => String(v.h.id) === String(selectedId)) || rows[0];
  const note = matured.length ? `<div class="bond-index-note">
      ${matured.length} matured · ${maturedValue ? `${moneyText(maturedValue, currency)} ` : ""}awaiting payment.
      The money stays in the account value until a bank credit is matched.${maturedGuessed
        ? ` For ${maturedGuessed} lot${maturedGuessed === 1 ? "" : "s"}, the date was read from
          the bond name; check it against the statement.` : ""}
      Delete a lot only if you know it was paid.
    </div>` : "";
  return `<div class="bond-book">
    <div class="bond-index">
      <div class="bond-index-head" aria-hidden="true">
        ${BOND_INDEX_FACTS.map((f, index) => `<span${index ? ` class="num"` : ""}>${f.label}</span>`).join("")}
      </div>
      <div class="bond-index-list" role="group" aria-label="Bond book">
        ${live.map((v) => bondIndexRow(v, assetId, String(pick.h.id), currency)).join("")}
        ${matured.length ? `<div class="bond-index-divider">Matured · awaiting payment</div>
          ${matured.map((v) => bondIndexRow(v, assetId, String(pick.h.id), currency)).join("")}` : ""}
      </div>
      ${note}
    </div>
    <div class="bond-dossier" id="bond-dossier" aria-live="polite">${
      bondCardHtml(pick, assetId, { matured: !!pick.matured, currency })}</div>
  </div>`;
}
