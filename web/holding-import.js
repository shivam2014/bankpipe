// Holdings file import. Broker and depository exports vary, so this reads the
// header row it finds and resolves columns by name through the alias table
// below. A required number that cannot be read refuses the file with the row
// and column, rather than importing a partial ledger. Pure functions: the
// caller owns the file, the preview and the database write.

import { resolveColumns, readNumber, parseAmount, parseDate,
  refusalResult } from "./table-schema.js";

// Every spelling a holdings table may print for a field. `loose` accepts a
// header that starts or ends with the alias, for "Quantity (Units)" and
// "Holding Quantity"; a field without it must match its alias exactly.
export const HOLDINGS_SCHEMA = {
  security_id: { label: "ISIN or Symbol", loose: true,
    aliases: ["isin", "isin code", "security id", "scrip code", "symbol", "ticker"] },
  label: { label: "Security name", loose: true,
    aliases: ["security name", "security", "instrument", "scrip", "company", "scheme",
      "description", "name"] },
  quantity: { label: "Quantity", loose: true,
    aliases: ["quantity", "qty", "units", "holding qty", "balance"] },
  cost: { label: "Buy value", loose: true,
    aliases: ["buy value", "cost value", "amount invested", "total cost", "acquisition cost",
      "purchase value", "invested", "cost"] },
  value: { label: "Current value", loose: true,
    aliases: ["current value", "market value", "present value", "current amount",
      "valuation", "value"] },
  purchase_date: { label: "Purchase date", loose: true,
    aliases: ["purchase date", "date of purchase", "buy date", "acquisition date"] },
  interest_date: { label: "Interest date", loose: true,
    aliases: ["next payout date", "interest date", "coupon date"] },
  rating: { label: "Rating", loose: true, aliases: ["rating", "credit rating"] },
  frequency: { label: "Frequency", loose: true,
    aliases: ["frequency", "payout frequency", "interest frequency",
      "coupon frequency", "payment frequency"] },
  yield_pct: { label: "Yield", loose: true,
    aliases: ["yield", "ytm", "yield to maturity", "purchase yield"] },
  payout: { label: "Next payout", loose: true,
    aliases: ["next payout amount", "payout amount", "coupon amount", "payout"] },
};

export { parseDate };

export function parseHoldingsMatrix(matrix, source = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const { columns, labels } = resolveColumns(rows[r], HOLDINGS_SCHEMA);
    const hits = Object.keys(columns).length;
    const usable = hits >= 3 && (columns.label !== undefined || columns.security_id !== undefined);
    if (usable && (!best || hits > best.hits)) best = { row: r, columns, labels, hits };
  }
  if (!best) {
    return { rows: [], headerRow: -1, columns: {}, skipped: 0,
      error: "No holdings header found. Expected columns like ISIN, Security, Quantity, "
        + "Buy Value, Current Value." };
  }
  const out = [];
  let skipped = 0;
  const where = { file: source.file || "", table: source.table || "holdings" };
  try {
    for (let r = best.row + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const cell = (field) => best.columns[field] === undefined ? "" : row[best.columns[field]];
      const label = String(cell("label") || "").replace(/\s+/g, " ").trim();
      const securityId = String(cell("security_id") || "").replace(/\s+/g, " ").trim();
      if (!label && !securityId) { skipped++; continue; }
      if (/^(grand\s*)?total$/i.test(label) || /^(grand\s*)?total$/i.test(securityId)) {
        skipped++;
        continue;
      }
      const quantity = readNumber(row, best.columns, "quantity",
        { where, schema: HOLDINGS_SCHEMA, rowNumber: r + 1 });
      const cost = readNumber(row, best.columns, "cost",
        { where, schema: HOLDINGS_SCHEMA, rowNumber: r + 1 });
      const value = readNumber(row, best.columns, "value",
        { where, schema: HOLDINGS_SCHEMA, rowNumber: r + 1 });
      const yieldPct = readNumber(row, best.columns, "yield_pct",
        { where, schema: HOLDINGS_SCHEMA, rowNumber: r + 1 });
      // A zero-quantity line is a closed position, not a holding.
      if (quantity !== null && quantity <= 0) { skipped++; continue; }
      if (quantity === null && value === null && cost === null) { skipped++; continue; }
      out.push({
        security_id: securityId,
        label,
        category: "",
        rating: String(cell("rating") || "").replace(/\s+/g, " ").trim(),
        frequency: String(cell("frequency") || "").replace(/\s+/g, " ").trim(),
        yield_bps: yieldPct === null ? null : Math.round(yieldPct * 100),
        payout_paise: parseMoney(cell("payout")),
        quantity,
        cost_paise: cost === null ? null : Math.round(cost * 100),
        value_paise: value === null ? null : Math.round(value * 100),
        purchase_date: parseDate(cell("purchase_date")),
        interest_date: parseDate(cell("interest_date")),
        source_row: r + 1,
      });
    }
  } catch (error) {
    return { rows: [], headerRow: best.row, columns: best.columns, skipped, ...refusalResult(error) };
  }
  return { rows: out, headerRow: best.row, columns: best.columns, skipped };
}

export function parseNumber(raw) {
  return parseAmount(raw);
}

export function parseMoney(raw) {
  const value = parseAmount(raw);
  return value === null ? null : Math.round(value * 100);
}

const keyOf = (r) => String(r.security_id || r.label || "").trim().toLowerCase();

export function diffHoldings(before, after, keyFn = keyOf) {
  const oldMap = new Map();
  for (const r of before || []) {
    const k = keyFn(r);
    if (k) oldMap.set(k, r);
  }
  const newMap = new Map();
  for (const r of after || []) {
    const k = keyFn(r);
    if (k) newMap.set(k, r);
  }
  const added = (after || []).filter((r) => keyFn(r) && !oldMap.has(keyFn(r)));
  const removed = (before || []).filter((r) => keyFn(r) && !newMap.has(keyFn(r)));
  const changed = [];
  let unchanged = 0;
  for (const r of after || []) {
    const old = oldMap.get(keyFn(r));
    if (!old) continue;
    const fields = ["quantity", "cost_paise", "value_paise", "purchase_date",
      "interest_date", "rating", "frequency", "yield_bps", "payout_paise"];
    const diffs = fields.filter((f) => (old[f] ?? null) !== (r[f] ?? null));
    if (diffs.length) changed.push({ before: old, after: r, fields: diffs });
    else unchanged++;
  }
  return { added, removed, changed, unchanged };
}
