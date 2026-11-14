// The sold and transferred rows a holdings page shows. A disposal is history,
// so it must be visible with its date and units, and it must stay out of the
// live groups and totals above it.
//
// Pure: the page passes its own esc, money, dateLabel and jsArg formatters.

export function splitHoldings(rows = []) {
  const list = rows || [];
  return {
    live: list.filter((row) => !row.disposed_at),
    sold: list.filter((row) => !!row.disposed_at),
  };
}

export function soldTypeLabel(row) {
  return row?.disposed_type === "sale" ? "Sold"
    : row?.disposed_type === "transfer-out" ? "Transferred out" : "Disposed";
}

/**
 * @param {Array<object>} rows holding rows with disposed_at
 * @param {string} assetId
 * @param {{esc?: Function, money?: Function, dateLabel?: Function, jsArg?: Function}} [fmt]
 * @returns {string}
 */
export function soldHoldingsHtml(rows, assetId = "", fmt = {}) {
  const soldRows = (rows || []).filter((row) => !!row.disposed_at);
  if (!soldRows.length) return "";
  const esc = fmt.esc || ((value) => String(value ?? ""));
  const money = fmt.money || ((value) => String(value ?? ""));
  const dateLabel = fmt.dateLabel || ((value) => String(value ?? ""));
  const jsArg = fmt.jsArg || ((value) => JSON.stringify(value));
  const row = (holding) => `<div class="sold-row">
      <div><div class="sold-name">${esc(holding.label || holding.security_id || "Holding")}</div>
        <div class="muted">${esc(holding.security_id || "")}${holding.disposed_reason
          ? ` · ${esc(holding.disposed_reason)}` : ""}</div></div>
      <div class="sold-figs"><b>${esc(soldTypeLabel(holding))}</b>
        ${holding.disposed_quantity === null || holding.disposed_quantity === undefined
          ? "—" : esc(holding.disposed_quantity)} units
        ${holding.disposed_at ? ` · ${esc(dateLabel(holding.disposed_at))}` : ""}
        ${holding.disposed_cost_paise ? ` · cost ${esc(money(holding.disposed_cost_paise))}` : ""}</div>
      ${holding.id ? `<button class="mini-btn" title="Remove this recorded disposal"
        onclick="bpBondHoldingDelete(${jsArg(assetId)}, ${jsArg(holding.id)})">Remove</button>` : ""}
    </div>`;
  return `<details class="sold-holdings"><summary>Sold and transferred out (${soldRows.length})
      · not counted</summary>
      <div class="muted sold-note">Recorded from the depository statement. These units are no
      longer held, so they sit outside every total above. The date and quantity are what the
      CAS printed.</div>
      <div class="sold-list">${soldRows.slice()
        .sort((a, b) => String(b.disposed_at || "").localeCompare(String(a.disposed_at || "")))
        .map(row).join("")}</div>
    </details>`;
}
