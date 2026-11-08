// Attaching what was paid to what is held. The depository says how many bonds
// are in the account; the seller's report says what they cost. Neither file has
// both, so the join is by ISIN and only where the quantities agree — a partial
// match would put the price of thirty bonds on twenty.
//
// Pure: the caller passes the two sets of rows and applies the result itself.

const clean = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {{positions?: Array<object>, lots?: Array<object>}} input
 * @returns {{updates: Array<object>, matched: string[], skipped: Array<object>}}
 */
export function attachCost({ positions = [], lots = [] } = {}) {
  const byIsin = new Map();
  for (const lot of lots || []) {
    const isin = clean(lot.security_id);
    if (!isin) continue;
    if (!byIsin.has(isin)) byIsin.set(isin, []);
    byIsin.get(isin).push(lot);
  }
  const updates = [];
  const matched = [];
  const skipped = [];
  for (const position of positions || []) {
    const isin = clean(position.security_id);
    if (!isin) continue;
    if (position.cost_paise !== null && position.cost_paise !== undefined) {
      skipped.push({ isin, reason: "has-cost" });
      continue;
    }
    const group = byIsin.get(isin);
    if (!group || !group.length) {
      skipped.push({ isin, reason: "no-lot" });
      continue;
    }
    const lotQty = group.reduce((t, l) => t + num(l.quantity), 0);
    const heldQty = num(position.quantity);
    if (!heldQty || Math.abs(lotQty - heldQty) > 1e-6) {
      skipped.push({ isin, reason: "quantity", heldQty, lotQty });
      continue;
    }
    const known = group.filter((l) => l.cost_paise !== null && l.cost_paise !== undefined);
    if (known.length !== group.length) {
      skipped.push({ isin, reason: "lot-without-cost" });
      continue;
    }
    const cost = known.reduce((t, l) => t + num(l.cost_paise), 0);
    // The earliest purchase date is the one the holding has held longest, which
    // is what a holding period is measured from.
    const dates = group.map((l) => String(l.purchase_date || "")).filter(Boolean).sort();
    updates.push({ security_id: isin, cost_paise: Math.round(cost),
      purchase_date: dates[0] || "" });
    matched.push(isin);
  }
  return { updates, matched, skipped };
}

/**
 * Which cost sources are fully represented in the matched positions. A source
 * with even one unmatched lot has to keep counting: retiring it would drop that
 * bond's value from net worth without ever putting its cost on a depository row.
 * @param {Array<{id: string, lots: Array<object>}>} sources
 * @param {string[]} matched ISINs that found a position
 * @returns {Array<{id: string, fully: boolean}>}
 */
export function coverageBySource(sources = [], matched = []) {
  const hit = new Set((matched || []).map(clean));
  return (sources || []).map((source) => ({
    id: source.id,
    fully: (source.lots || []).length > 0
      && (source.lots || []).every((lot) => hit.has(clean(lot.security_id))),
  }));
}

/**
 * Merge the cost updates into the position rows, so the caller can write the
 * whole snapshot back without losing the fields it does not own.
 * @param {Array<object>} positions
 * @param {Array<object>} updates from attachCost
 * @returns {Array<object>}
 */
export function applyCost(positions = [], updates = []) {
  const byIsin = new Map(updates.map((u) => [clean(u.security_id), u]));
  return (positions || []).map((p) => {
    const hit = byIsin.get(clean(p.security_id));
    return hit ? { ...p, cost_paise: hit.cost_paise,
      purchase_date: hit.purchase_date || p.purchase_date } : p;
  });
}
