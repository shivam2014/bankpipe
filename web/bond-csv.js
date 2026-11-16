// The ongoing bond snapshot. Export the current portfolio, edit it in Excel
// (rating, current value), delete positions that have matured, then import the
// same file through the holdings importer. One row per lot, keyed by ISIN and
// units, so a round trip updates instead of duplicating.

import { bondAnalytics, parseBondLabel, valueKindOf } from "./bonds.js";
import { csvCell as cell } from "./export.js";

export const BOND_CSV_HEADERS = ["ISIN", "Security", "Rating", "Coupon %",
  "Yield %", "Frequency", "Purchase Date", "Next Payout Date", "Units",
  "Cost", "Current Value", "Next Payout Amount"];

const blankToNull = (value) => value === null || value === undefined
  || (typeof value === "string" && value.trim() === "") ? null : value;
const numberOrNull = (value) => {
  const raw = blankToNull(value);
  if (raw === null) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};
const rupees = (paise) => blankToNull(paise) === null
  ? "" : (Number(paise) / 100).toFixed(2);

export function bondHoldingsCsv(rows) {
  const lines = [BOND_CSV_HEADERS.map(cell).join(",")];
  for (const h of rows || []) {
    const ba = bondAnalytics(h);
    const parsed = parseBondLabel(h.label);
    const coupon = ba ? ba.couponPct : (parsed ? parsed.couponPct : "");
    const yieldBps = numberOrNull(h.yield_bps);
    const yieldPct = yieldBps !== null
      ? (yieldBps / 100).toFixed(2)
      : (ba && ba.ytm !== null ? ba.ytm.toFixed(2) : "");
    // The source decides whether a stored figure is a market value. A CAS or
    // broker statement must not be exported as Current Value.
    const value = numberOrNull(h.value_paise);
    const priced = valueKindOf(h) === "market" && value !== null && value > 0;
    const line = [
      h.security_id || "",
      h.label || "",
      h.rating || "",
      coupon,
      yieldPct,
      h.frequency || "",
      h.purchase_date || "",
      h.interest_date || "",
      h.quantity === null || h.quantity === undefined ? "" : h.quantity,
      rupees(h.cost_paise),
      priced ? rupees(value) : "",
      rupees(h.payout_paise),
    ];
    lines.push(line.map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
