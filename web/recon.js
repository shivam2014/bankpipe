// The bond audit. Two sources describe the same position and neither is
// complete: a seller report knows what was paid and when, a depository statement
// knows what is still held. This compares them per ISIN and returns a verdict.
// It never edits a number, and it never moves money between sources.
//
// The caller passes one demat account at a time. The same ISIN in two accounts is
// two owners, not a duplicate, so merging them before the comparison would hide
// exactly the error this exists to find. Pure: no storage, no network.

import { parseBondLabel } from "./bonds.js";

// What the verdict means, in the order a receipt should list them.
export const RECON_STATES = [
  "quantity_differs",
  "not_settled",
  "cost_missing",
  "in_transit",
  "matched",
  "closed",
];

const qty = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function rowFor(map, isin) {
  if (!map.has(isin)) {
    map.set(isin, {
      isin, label: "", lotQty: 0, custodianQty: 0, lotCount: 0,
      costPaise: 0, costKnown: 0, maturity: "", firstPurchase: "",
    });
  }
  return map.get(isin);
}

/**
 * One verdict per ISIN, from a seller's lots and a depository's positions.
 * @param {object} input
 * @param {Array<{security_id:string, label?:string, quantity:number,
 *   cost_paise?:number|null, purchase_date?:string}>} input.lots
 * @param {Array<{security_id:string, label?:string, quantity:number,
 *   maturity?:string}>} input.positions
 * @param {string} [input.today] ISO date; a maturity before it closes the lot
 * @param {string} [input.asOf] ISO date of the depository statement
 * @returns {Array<object>} lines, breaks first
 */
export function reconPositions({ lots = [], positions = [], today = "", asOf = "" } = {}) {
  const map = new Map();

  for (const lot of lots || []) {
    const isin = String(lot.security_id ?? "").trim().toUpperCase();
    if (!isin) continue;
    const row = rowFor(map, isin);
    const n = qty(lot.quantity);
    if (!n) continue;
    row.lotQty += n;
    row.lotCount += 1;
    if (lot.cost_paise !== null && lot.cost_paise !== undefined) {
      row.costPaise += Number(lot.cost_paise) || 0;
      row.costKnown += 1;
    }
    const bought = String(lot.purchase_date ?? "");
    if (bought && (!row.firstPurchase || bought < row.firstPurchase)) {
      row.firstPurchase = bought;
    }
    if (!row.label && lot.label) row.label = String(lot.label);
  }

  for (const position of positions || []) {
    const isin = String(position.security_id ?? "").trim().toUpperCase();
    if (!isin) continue;
    const row = rowFor(map, isin);
    row.custodianQty += qty(position.quantity);
    if (position.maturity) row.maturity = String(position.maturity);
    if (position.label) row.label = String(position.label);
  }

  const lines = [];
  for (const row of map.values()) {
    if (!row.lotQty && !row.custodianQty) continue;
    // A bond matured before the statement date is history, not a holding. Say so
    // before any quantity comparison, or the leftovers read as missing units.
    if (!row.maturity && row.label) {
      const parsed = parseBondLabel(row.label);
      if (parsed) row.maturity = parsed.maturity;
    }
    let state;
    if (row.maturity && today && row.maturity < today) {
      state = "closed";
    } else if (row.lotQty > 0 && row.custodianQty > 0) {
      state = row.lotQty === row.custodianQty ? "matched" : "quantity_differs";
    } else if (row.lotQty > 0) {
      // Bought, but not in the statement. If it was bought after the statement
      // date it is still settling; before it, something is genuinely missing.
      state = asOf && row.firstPurchase && row.firstPurchase > asOf
        ? "in_transit" : "not_settled";
    } else {
      state = "cost_missing";
    }
    lines.push({ ...row, state });
  }

  const rank = (s) => {
    const at = RECON_STATES.indexOf(s);
    return at < 0 ? RECON_STATES.length : at;
  };
  lines.sort((a, b) => rank(a.state) - rank(b.state) || a.isin.localeCompare(b.isin));
  return lines;
}

/**
 * Counts for a receipt line: "7 positions · 5 matched · 2 breaks".
 * A closed position is neither: it is history and must not read as a problem.
 * @param {Array<object>} lines from reconPositions
 * @returns {{total:number, breaks:number, counts:object, costPaise:number}}
 */
export function reconSummary(lines = []) {
  const counts = {};
  for (const state of RECON_STATES) counts[state] = 0;
  let costPaise = 0;
  for (const line of lines || []) {
    if (counts[line.state] === undefined) counts[line.state] = 0;
    counts[line.state] += 1;
    costPaise += Number(line.costPaise) || 0;
  }
  const breaks = (lines || []).filter((l) =>
    l.state !== "matched" && l.state !== "closed").length;
  return { total: (lines || []).length, breaks, counts, costPaise };
}
