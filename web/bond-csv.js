// The ongoing bond snapshot. Export the current portfolio, edit it in Excel
// (rating, current value), delete positions that have matured, then import the
// same file through the holdings importer. One row per lot, keyed by ISIN and
// units, so a round trip updates instead of duplicating.

import { bondAnalytics, parseBondLabel } from "./bonds.js";
import { csvCell as cell } from "./export.js";

export const BOND_CSV_HEADERS = ["ISIN", "Security", "Rating", "Coupon %",
  "Yield %", "Frequency", "Purchase Date", "Next Payout Date", "Units",
  "Cost", "Current Value", "Next Payout Amount"];

const rupees = (paise) => paise === null || paise === undefined
  ? "" : (paise / 100).toFixed(2);

export function bondHoldingsCsv(rows) {
  const lines = [BOND_CSV_HEADERS.map(cell).join(",")];
  for (const h of rows || []) {
    const ba = bondAnalytics(h);
    const parsed = parseBondLabel(h.label);
    const coupon = ba ? ba.couponPct : (parsed ? parsed.couponPct : "");
    const yieldPct = h.yield_bps !== null && h.yield_bps !== undefined
      ? (h.yield_bps / 100).toFixed(2)
      : (ba && ba.ytm !== null ? ba.ytm.toFixed(2) : "");
    // A value equal to cost is the old "no market price" placeholder. Leave
    // the cell blank so the user can fill a real value instead of re-importing
    // cost as if it were a market price.
    const priced = h.value_paise !== null && h.value_paise !== undefined
      && h.cost_paise !== null && h.cost_paise !== undefined
      && Math.abs(h.value_paise - h.cost_paise) >= 1;
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
      priced ? rupees(h.value_paise) : "",
      rupees(h.payout_paise),
    ];
    lines.push(line.map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
