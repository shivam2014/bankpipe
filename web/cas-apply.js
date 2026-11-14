// The CAS write path, as pure functions. A depository statement is a dated
// snapshot: it owns quantity and value, while the latest broker report owns
// cost and terms. This module builds the rows for that write, decides whether
// the statement is safe to apply, and says what happens to rows the statement
// does not name. Nothing here touches the DOM or the database.

import { casTotals } from "./cas.js";
import { carryBrokerFields } from "./bonds.js";

/**
 * The label a CAS row is stored under. The label carries the coupon and the
 * maturity because the bond card reads them from there.
 * @param {object} h a parsed CAS holding
 * @returns {string}
 */
export function casHoldingLabel(h) {
  const name = String(h.label || h.isin).replace(/\s+/g, " ").trim();
  if (h.kind !== "bond") return name;
  if (/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(name)) return name;
  const when = h.maturity
    ? new Date(`${h.maturity}T00:00:00Z`).toLocaleDateString("en-IN",
      { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : "";
  const coupon = h.couponPct === null || h.couponPct === undefined ? "" : `${h.couponPct}% `;
  return `${coupon}${name}${when ? ` ${when}` : ""}`.trim();
}

/**
 * Whether a CAS may replace a demat. A row that did not parse is a partial
 * statement, and a partial statement must never delete a holding. The printed
 * total is the second check: when the parser exposes one, the rows must add up
 * to it.
 * @param {{holdings?: Array<object>, counts?: object, printedTotalPaise?: number|null}} parsed
 * @param {number|null} [statedTotalPaise]
 * @returns {{blocked: boolean, complete: boolean, quarantined: number,
 *   totals: object, reasons: Array<string>}}
 */
export function casSafety(parsed = {}, statedTotalPaise = parsed?.printedTotalPaise) {
  const quarantined = Number(parsed?.counts?.quarantined) || 0;
  const totals = casTotals(parsed, statedTotalPaise);
  const reasons = [];
  if (quarantined > 0) {
    reasons.push(`${quarantined} row${quarantined === 1 ? "" : "s"} could not be read; the statement is not safe to replace this account.`);
  }
  if (!totals.ok) {
    reasons.push("The rows do not add up to the total the statement prints; the statement is not safe to replace this account.");
  }
  return { blocked: reasons.length > 0, complete: reasons.length === 0,
    quarantined, totals, reasons };
}

/**
 * Build the rows a CAS writes. Existing broker cost and purchase date carry to
 * the new quantity; a row the CAS does not name is preserved by default, so a
 * partial or older statement cannot silently delete a holding.
 * @param {{existing?: Array<object>, holdings?: Array<object>, asOf?: string,
 *   preserveAbsent?: boolean}} input
 * @returns {{rows: Array<object>, absent: Array<object>, dropped: Array<object>,
 *   manualKept: number, keptNewer: number, carried: number}}
 */
export function casApplyRows({ existing = [], holdings = [], asOf = "",
  preserveAbsent = true } = {}) {
  const oldByIsin = new Map();
  const withCost = new Map();
  for (const old of existing || []) {
    const isin = String(old.security_id || old.isin || "").toUpperCase();
    if (!isin) continue;
    oldByIsin.set(isin, old);
    if (old.cost_paise !== null && old.cost_paise !== undefined) withCost.set(isin, old);
  }
  const rows = [];
  const stamped = new Set();
  let carried = 0;
  for (const h of holdings || []) {
    const isin = String(h.isin || h.security_id || "").toUpperCase();
    if (isin) stamped.add(isin);
    const old = withCost.get(isin);
    const oldRow = oldByIsin.get(isin);
    const qty = Number(h.quantity) || 0;
    const oldQty = old ? Number(old.quantity) || 0 : 0;
    // A sale changes the units, not the price per unit: carry the broker cost
    // rather than dropping it on the floor.
    const carriedCost = old && qty > 0 && oldQty > 0
      ? Math.round(Number(old.cost_paise) * (qty / oldQty)) : null;
    if (carriedCost) carried += 1;
    const nextLabel = casHoldingLabel(h);
    // The CAS often has the maturity but not the coupon; a broker label has both.
    const keepOld = h.kind === "bond" && !/\d+(?:\.\d+)?%/.test(nextLabel)
      && /\d+(?:\.\d+)?%/.test(oldRow?.label || "");
    rows.push({
      security_id: h.isin || h.security_id || "",
      label: keepOld ? oldRow.label : nextLabel,
      issuer: oldRow?.issuer || "",
      category: h.kind,
      frequency: h.frequency || oldRow?.frequency || "",
      quantity: h.quantity,
      face_paise: h.faceValuePaise ?? oldRow?.face_paise ?? null,
      cost_paise: h.costPaise ?? carriedCost ?? null,
      value_paise: h.valuePaise,
      value_source: "CAS",
      purchase_date: carriedCost && old ? old.purchase_date || "" : "",
      ...carryBrokerFields(oldRow, h.quantity),
      as_of: asOf,
    });
  }

  const absent = [];
  const dropped = [];
  let manualKept = 0;
  let keptNewer = 0;
  for (const old of existing || []) {
    const isin = String(old.security_id || old.isin || "").toUpperCase();
    if (!isin || stamped.has(isin)) continue;
    if (old.source === "manual") {
      manualKept += 1;
      continue;
    }
    // A bond or fund bought after the statement date is too new for the paper,
    // not missing from the demat.
    const boughtAfter = !!asOf && !!old.purchase_date && old.purchase_date > asOf;
    if (boughtAfter || preserveAbsent) {
      rows.push({ ...old });
      if (boughtAfter) keptNewer += 1;
      absent.push({ isin, label: old.label || "", action: "flag",
        reason: boughtAfter ? "bought after the statement date; kept"
          : "not in this statement; kept" });
    } else {
      dropped.push({ isin, label: old.label || "", action: "remove",
        reason: "not in the complete statement" });
    }
  }
  return { rows, absent, dropped, manualKept, keptNewer, carried };
}

/**
 * The one decision the preview and the writer share. A blocked statement
 * returns the existing rows unchanged, so calling it is safe even when the UI
 * has not checked first. Absent rows are preserved unless the statement is
 * complete and the replace was explicitly confirmed.
 * @param {{parsed?: object, existing?: Array<object>, holdings?: Array<object>,
 *   asOf?: string, confirmed?: boolean, merge?: boolean, safety?: object}} input
 * @returns {object}
 */
export function casReplacePlan({ parsed = {}, existing = [], holdings = [], asOf = "",
  confirmed = false, merge = false, safety = null } = {}) {
  const verdict = safety || casSafety(parsed);
  if (verdict.blocked) {
    return { ok: false, blocked: true, safety: verdict, rows: existing, absent: [],
      dropped: [], manualKept: 0, keptNewer: 0, carried: 0, preserveAbsent: true };
  }
  const preserveAbsent = merge || !(confirmed && verdict.complete);
  const applied = casApplyRows({ existing, holdings, asOf, preserveAbsent });
  return { ok: true, blocked: false, safety: verdict, preserveAbsent, ...applied };
}
