// Holdings file import. Broker and depository exports vary, so this reads the
// header row it finds and maps the usual aliases. Pure functions: the caller
// owns the file, the preview and the database write.

const FIELDS = [
  ["security_id", ["isin", "isin code", "security id", "scrip code", "symbol", "ticker"]],
  ["label", ["security name", "security", "instrument", "scrip", "company", "scheme",
    "description", "name"]],
  ["quantity", ["quantity", "qty", "units", "holding qty", "balance"]],
  ["cost", ["buy value", "cost value", "amount invested", "total cost", "acquisition cost",
    "purchase value", "invested", "cost"]],
  ["value", ["current value", "market value", "present value", "current amount",
    "valuation", "value"]],
  ["purchase_date", ["purchase date", "date of purchase", "buy date", "acquisition date"]],
  ["interest_date", ["next payout date", "interest date", "coupon date"]],
  ["rating", ["rating", "credit rating"]],
  ["frequency", ["frequency", "payout frequency", "interest frequency",
    "coupon frequency", "payment frequency"]],
  ["yield_pct", ["yield", "ytm", "yield to maturity", "purchase yield"]],
  ["payout", ["next payout amount", "payout amount", "coupon amount", "payout"]],
];

const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function fieldForHeader(text) {
  const n = norm(text);
  if (!n) return null;
  for (const [field, names] of FIELDS) {
    if (names.includes(n)) return field;
  }
  for (const [field, names] of FIELDS) {
    if (names.some((x) => n === x || n.startsWith(x + " ") || n.endsWith(" " + x))) {
      return field;
    }
  }
  return null;
}

export function parseHoldingsMatrix(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const map = {};
    let hits = 0;
    (rows[r] || []).forEach((cell, c) => {
      const field = fieldForHeader(cell);
      if (field && map[field] === undefined) { map[field] = c; hits++; }
    });
    const usable = hits >= 3 && (map.label !== undefined || map.security_id !== undefined);
    if (usable && (!best || hits > best.hits)) best = { row: r, map, hits };
  }
  if (!best) {
    return { rows: [], headerRow: -1, columns: {}, skipped: 0,
      error: "No holdings header found. Expected columns like ISIN, Security, Quantity, "
        + "Buy Value, Current Value." };
  }
  const out = [];
  let skipped = 0;
  for (let r = best.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (field) => best.map[field] === undefined ? "" : row[best.map[field]];
    const label = String(cell("label") || "").replace(/\s+/g, " ").trim();
    const securityId = String(cell("security_id") || "").replace(/\s+/g, " ").trim();
    if (!label && !securityId) { skipped++; continue; }
    if (/^(grand\s*)?total$/i.test(label) || /^(grand\s*)?total$/i.test(securityId)) {
      skipped++;
      continue;
    }
    const quantity = parseNumber(cell("quantity"));
    const cost = parseMoney(cell("cost"));
    const value = parseMoney(cell("value"));
    const yieldPct = parseNumber(cell("yield_pct"));
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
      cost_paise: cost,
      value_paise: value,
      purchase_date: parseDate(cell("purchase_date")),
      interest_date: parseDate(cell("interest_date")),
      source_row: r + 1,
    });
  }
  return { rows: out, headerRow: best.row, columns: best.map, skipped };
}

export function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).replace(/[,\s]/g, "").replace(/[₹$]/g, "");
  if (!/^\(?-?\d+(\.\d+)?\)?$/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);
  const v = Number(s.replace(/[()]/g, ""));
  if (!Number.isFinite(v)) return null;
  return negative ? -v : v;
}

export function parseMoney(raw) {
  const v = parseNumber(raw);
  return v === null ? null : Math.round(v * 100);
}

export function parseDate(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw instanceof Date && !isNaN(raw)) return raw.toISOString().slice(0, 10);
  if (typeof raw === "number" && raw > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    // Indian files are day-first unless the first number cannot be a day.
    let day = Number(m[1]), month = Number(m[2]);
    if (day > 12 && month <= 12) { /* day-first */ }
    else if (month > 12) { [day, month] = [month, day]; }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})$/);
  if (m) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (month) return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
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
