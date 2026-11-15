// The bond holding form: the name it writes and the columns it is allowed to
// write. A column that is not in bondHoldingPatch() has no control in the form,
// so the store keeps the value already held. That is what protects the principal
// already returned and the principal schedule from an edit of some other field.

import { moneyText, bondDateLabel, DEFAULT_CURRENCY } from "./bond-book.js";

const BOND_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function bondLabelText(name, coupon, iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  const mon = BOND_MONTHS[(m || 1) - 1] || "";
  return `${Number(coupon)}% ${String(name || "").trim()} ${String(d || "")
    .padStart(2, "0")} ${mon} ${y || ""}`.trim();
}

/**
 * The columns the form owns, from the values its controls carry. Every other
 * holding column is left to the store: category, yield, rating at purchase,
 * principal returned, the principal schedule and future interest included.
 *
 * `face` is null when the field is blank: the store then keeps the stored face,
 * which is how the form has always treated an empty face field. The other money
 * fields use null to clear, because clearing them is a thing the person can do.
 * An untouched market value is not written at all (`valueTouched: false`), so a
 * price from BSE keeps its source and date through an edit of another field.
 * @param {object} input
 * @returns {object} a partial holding row for store.upsertHolding
 */
export function bondHoldingPatch(input) {
  const patch = {
    label: String(input.label || ""),
    security_id: String(input.isin || "").toUpperCase(),
    issuer: String(input.issuer || ""),
    redemption_dates: String(input.redemptions || ""),
    quantity: input.units,
    cost_paise: input.cost,
    purchase_date: String(input.purchaseDate || ""),
    rating: String(input.rating || ""),
    frequency: String(input.frequency || ""),
    payout_paise: input.payout,
    interest_date: String(input.interestDate || ""),
  };
  if (input.face !== null && input.face !== undefined) patch.face_paise = input.face;
  if (input.valueTouched !== false) {
    patch.value_paise = input.value;
    patch.value_source = input.value === null ? "" : "Manual";
    patch.as_of = String(input.asOf || "");
  }
  return patch;
}

/**
 * What the form will not change, in one muted line: principal already returned
 * and the principal still scheduled. Empty when the row has neither, so a plain
 * bond form says nothing extra.
 */
export function bondKeptLine(h, currency = DEFAULT_CURRENCY) {
  if (!h) return "";
  const bits = [];
  const returned = Number(h.returned_paise);
  if (Number.isFinite(returned) && returned > 0) {
    const on = h.returned_at || "";
    const source = h.returned_source === "bank" ? " from the bank"
      : h.returned_source === "cashflow" ? " from the Cashflow Future file"
        : h.returned_source === "smest" ? " from SMEST" : "";
    bits.push(`principal returned ${moneyText(returned, currency)}`
      + (on ? ` on ${bondDateLabel(on)}` : "") + source);
  }
  const dates = String(h.principal_dates || "").split(",")
    .map((d) => d.trim()).filter(Boolean).sort();
  const future = Number(h.future_principal_paise);
  if (dates.length || (Number.isFinite(future) && future > 0)) {
    const amount = Number.isFinite(future) && future > 0
      ? ` ${moneyText(future, currency)}` : "";
    const listed = dates.length > 2
      ? `${dates.slice(0, 2).map(bondDateLabel).join(", ")} and ${dates.length - 2} more`
      : dates.map(bondDateLabel).join(" and ");
    const when = dates.length
      ? ` in ${dates.length === 1 ? "one payment" : `${dates.length} payments`}, ${listed}`
      : "";
    bits.push(`principal still to come${amount}${when}`);
  }
  return bits.length ? `Kept as saved: ${bits.join("; ")}.` : "";
}
