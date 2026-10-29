// Drafted by the local Bonsai model, reviewed and tested here. Pure functions:
// no DOM, no storage, no network. Holdings are a snapshot, not a ledger.

/**
 * Summarize all holdings into aggregate stats.
 * @param {Array<{quantity:number|null, cost_paise:number|null, value_paise:number|null}>} rows
 * @returns {{count:number, cost:number|null, value:number|null, gain:number|null, gainPct:number|null}}
 */
export function summarizeHoldings(rows) {
  const count = rows.length;
  let cost = null;
  let value = null;
  for (const r of rows) {
    if (r.cost_paise != null) cost = (cost ?? 0) + r.cost_paise;
    if (r.value_paise != null) value = (value ?? 0) + r.value_paise;
  }
  const gain = cost != null && value != null ? value - cost : null;
  const gainPct = gain != null && cost > 0 ? Math.round(gain * 10000 / cost) / 100 : null;
  return { count, cost, value, gain, gainPct };
}

/**
 * Group holdings by category and aggregate stats per group.
 * @param {Array<{category:string|null, cost_paise:number|null, value_paise:number|null}>} rows
 * @returns {{category:string, count:number, cost:number|null, value:number|null, gain:number|null}[]}
 */
export function groupHoldings(rows) {
  const groups = new Map();
  for (const r of rows) {
    const cat = r.category || "Unrated";
    if (!groups.has(cat)) groups.set(cat, { category: cat, count: 0, cost: null, value: null });
    const g = groups.get(cat);
    g.count++;
    if (r.cost_paise != null) g.cost = (g.cost ?? 0) + r.cost_paise;
    if (r.value_paise != null) g.value = (g.value ?? 0) + r.value_paise;
  }
  const result = [...groups.values()].map(g => ({
    ...g,
    gain: g.cost != null && g.value != null ? g.value - g.cost : null
  }));
  result.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.category.localeCompare(b.category));
  return result;
}

/**
 * Validate a single holding row.
 * @param {object} row
 * @returns {string[]}
 */
export function validateHolding(row) {
  const errors = [];
  if (!row.security_id) errors.push("missing security_id");
  if (!row.label) errors.push("missing label");
  if (row.quantity == null || row.quantity <= 0) errors.push("quantity <= 0");
  if (row.cost_paise == null || !Number.isInteger(row.cost_paise) || row.cost_paise < 0)
    errors.push("cost_paise not a non-negative integer");
  if (row.value_paise == null || !Number.isInteger(row.value_paise) || row.value_paise < 0)
    errors.push("value_paise not a non-negative integer");
  return errors;
}

/**
 * Build a stable identifier string for a holding.
 * @param {object} row
 * @returns {string}
 */
export function holdingKey(row) {
  return [
    row.asset_id,
    row.security_id,
    row.label,
    row.category,
    row.quantity,
    row.cost_paise,
    row.value_paise
  ].join("|");
}