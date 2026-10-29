// DigiFInn bond portfolio imports. The portal exports two different CSVs:
//   upcoming-payouts.csv  one row per payout, with ISIN, units and dates
//   portfolio-cashflow-all.csv  a wide sheet, one column group per bond, with
//                                yield, frequency, maturity, invested value/date
// Neither file is a complete holding on its own. This module joins them and
// upserts by ISIN so a repeated download updates quantities and dates instead
// of appending a second copy.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const STOP = new Set(["LTD", "LIMITED", "PVT", "PRIVATE", "FINANCE", "FINANCIAL",
  "INDIA", "NCD", "BOND", "BONDS", "SERIES", "TRANCHE", "PAYOUT"]);

export function cleanCell(value) {
  let s = String(value ?? "").replace(/\uFEFF/g, "").trim();
  const excel = s.match(/^="?([\s\S]*?)"?$/);
  if (excel && s.startsWith("=\"")) s = excel[1];
  return s.replace(/^"(.*)"$/s, "$1").trim();
}

// RFC 4180-ish reader. Quoted fields may contain commas and newlines.
export function parseCsv(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = cleanCell(raw).replace(/[,\s₹$]/g, "");
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return negative ? -v : v;
}

export function parseMoney(raw) {
  const v = parseNumber(raw);
  return v === null ? null : Math.round(v * 100);
}

export function parseDate(raw) {
  const s = cleanCell(raw);
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\s/-]+([A-Za-z]{3,9})[\s/-]+(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toUpperCase()];
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    if (month) return `${year}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

const norm = (s) => cleanCell(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function nameTokens(label) {
  let s = cleanCell(label);
  s = s.replace(/\d+(?:\.\d+)?\s*%/g, " ");
  s = s.replace(/\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}/g, " ");
  return new Set(s.toUpperCase().split(/[^A-Z0-9]+/)
    .filter((t) => t && !STOP.has(t)));
}

export function nameScore(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

export function labelMaturity(label) {
  const dates = String(label || "").match(/\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}/g) || [];
  return dates.length ? parseDate(dates[dates.length - 1]) : "";
}

export function isPayouts(row) {
  const n = row.map(norm);
  return n.includes("isin") && n.includes("units");
}

export function parsePayouts(text, fileName = "") {
  const rows = parseCsv(text);
  const header = rows.findIndex(isPayouts);
  if (header < 0) return null;
  const map = {};
  rows[header].forEach((cell, i) => { const k = norm(cell); if (k) map[k] = i; });
  const col = (row, ...names) => {
    for (const n of names) if (map[n] !== undefined) return row[map[n]];
    return "";
  };
  const out = [];
  let skipped = 0;
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const isin = cleanCell(col(row, "isin", "isin code")).toUpperCase();
    const issuer = cleanCell(col(row, "issuer", "security name", "security"));
    if (!isin && !issuer) { skipped++; continue; }
    out.push({
      date: parseDate(col(row, "date", "payout date")),
      issuer,
      isin,
      amount_paise: parseMoney(col(row, "amount", "payout amount")),
      frequency: cleanCell(col(row, "frequency", "payout frequency")),
      units: parseNumber(col(row, "units", "quantity")),
      source_row: r + 1,
    });
  }
  return { kind: "payouts", fileName, rows: out.filter((x) => x.isin), skipped };
}

export function parseCashflow(text, fileName = "", today = new Date().toISOString().slice(0, 10)) {
  const rows = parseCsv(text);
  const header = rows.findIndex((row) => {
    const n = row.map(norm);
    return n.filter((x) => x === "yield").length >= 1
      && n.includes("frequency") && n.includes("maturity");
  });
  if (header < 1) return null;
  const names = rows[header - 1] || [];
  const values = rows[header + 1] || [];
  const invest = rows[header + 2] || [];
  const starts = [];
  rows[header].forEach((cell, i) => {
    if (norm(cell) === "yield" && cleanCell(names[i])) starts.push(i);
  });
  if (!starts.length) return null;
  const groups = starts.map((c, i) => {
    const name = cleanCell(names[c]);
    const isin = (name.match(/\b(IN[A-Z0-9]{10})\b/) || [])[1] || "";
    return {
      index: i,
      name,
      isin: isin.toUpperCase(),
      yieldPct: (() => {
        const v = parseNumber(values[c]);
        return v === null ? null : Math.round(v * 10000) / 100;
      })(),
      frequency: cleanCell(values[c + 1]),
      maturity: parseDate(values[c + 2]),
      investment_paise: parseMoney(invest[c + 1]),
      investment_date: parseDate(invest[c + 3]),
      source_col: c + 1,
    };
  });
  // The future-cashflow export starts its table at a "Month" column; the
  // older cashflow file has no header row and puts the date in column 2.
  let dateCol = -1;
  for (let r = header + 2; r < Math.min(rows.length, header + 5); r++) {
    const idx = (rows[r] || []).findIndex((cell) => /^(month|date)$/i.test(cleanCell(cell)));
    if (idx >= 0) { dateCol = idx; break; }
  }
  let dataStart = header + 3;
  while (dataStart < rows.length) {
    const row = rows[dataStart] || [];
    if (dateCol >= 0 && parseDate(row[dateCol])) break;
    if (dateCol < 0 && row.some((cell) => parseDate(cell))) break;
    dataStart++;
  }
  for (const g of groups) {
    const totalCol = starts[g.index] + 3;
    const interestCol = starts[g.index];
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r] || [];
      const total = parseMoney(row[totalCol]);
      if (total === null || total <= 0) continue;
      const dcol = dateCol >= 0 ? dateCol : row.findIndex((cell) => parseDate(cell));
      g.next_payout_date = dcol >= 0 ? parseDate(row[dcol]) : "";
      // The Total column is post-TDS. This app keeps every bond figure gross, so
      // the gross interest wins; a redemption month with no interest uses Total.
      const gross = parseMoney(row[interestCol]);
      g.next_payout_paise = gross !== null && gross > 0 ? gross : total;
      break;
    }
    // The rest of the sheet is the whole future schedule, one row per payment.
    // Interest here is gross: tax is deliberately out of scope in this app.
    // `today` is a parameter so a stale export cannot promise past money.
    let interest = 0, principal = 0, seen = 0;
    const principalDates = [];
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r] || [];
      const dcol = dateCol >= 0 ? dateCol : row.findIndex((cell) => parseDate(cell));
      const when = dcol >= 0 ? parseDate(row[dcol]) : "";
      if (!when || when < today) continue;
      const i = parseMoney(row[starts[g.index]]);
      const p = parseMoney(row[starts[g.index] + 2]);
      if (i === null && p === null) continue;
      seen++;
      if (i && i > 0) interest += i;
      if (p && p > 0) { principal += p; principalDates.push(when); }
    }
    g.future_interest_paise = seen ? interest : null;
    g.future_principal_paise = seen ? principal : null;
    g.principal_dates = principalDates;
  }
  return { kind: "cashflow", fileName, groups, rows: groups.length };
}

export function parseDigiFinnFile(text, fileName = "") {
  return parsePayouts(text, fileName) || parseCashflow(text, fileName)
    || { kind: "unknown", fileName, rows: [] };
}

function payoutGroups(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r.isin) continue;
    // The portal lists each purchase lot as its own unit series. Keep them
    // apart: collapsing 20 + 10 BNAL units into one row loses a cost basis.
    const isin = r.isin.toUpperCase();
    const key = `${isin}|${r.units === null || r.units === undefined ? "" : r.units}|${r.frequency || ""}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...r, key, isin, rows: [r] });
    } else {
      cur.rows.push(r);
      if (r.issuer) cur.issuer = r.issuer;
      if (r.frequency) cur.frequency = r.frequency;
      if (r.units !== null && r.units !== undefined) cur.units = r.units;
    }
  }
  for (const g of map.values()) {
    g.rows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    g.dates = [...new Set(g.rows.map((r) => r.date).filter(Boolean))].sort();
    g.interest_date = g.dates[0] || "";
    const at = g.rows.find((r) => r.date === g.interest_date) || g.rows[0];
    g.amount_paise = at?.amount_paise ?? null;
    g.label = g.issuer || "";
  }
  return [...map.values()];
}

const RATING = /^(A|AA|AAA|B|BB|BBB|C|CC|CCC|D)([+-])?$/i;

function ratingOf(row) {
  const explicit = cleanCell(row?.rating);
  if (explicit) return explicit;
  const cat = cleanCell(row?.category);
  return RATING.test(cat) ? cat : "";
}

function existingKey(r) {
  const isin = cleanCell(r.security_id).toUpperCase();
  if (isin) return `isin:${isin}|qty:${r.quantity ?? ""}`;
  return `label:${norm(r.label)}|${labelMaturity(r.label)}`;
}

function rowKey(r) {
  const isin = cleanCell(r.security_id).toUpperCase();
  if (isin) return `isin:${isin}|qty:${r.quantity ?? ""}|${norm(r.label)}`;
  return `label:${norm(r.label)}|${labelMaturity(r.label)}`;
}

// Match cashflow groups to payout lots. The portal embeds the ISIN in the
// cashflow name, so ISIN is the primary key; maturity/name is only a fallback.
// Multiple purchase lots for one ISIN are paired by cost and units, largest
// first, so BNAL's 20-unit and 10-unit lots keep their own costs.
function assignCashflow(payouts, groups) {
  const used = new Set();
  const byPayout = new Map();
  const payByIsin = new Map();
  for (const p of payouts) {
    if (!p.isin) continue;
    if (!payByIsin.has(p.isin)) payByIsin.set(p.isin, []);
    payByIsin.get(p.isin).push(p);
  }
  const cfByIsin = new Map();
  for (const g of groups || []) {
    if (!g.isin) continue;
    if (!cfByIsin.has(g.isin)) cfByIsin.set(g.isin, []);
    cfByIsin.get(g.isin).push(g);
  }
  for (const [isin, pays] of payByIsin) {
    const cfs = (cfByIsin.get(isin) || []).filter((g) => !used.has(g.index));
    if (!cfs.length) continue;
    const ps = pays.slice().sort((a, b) => (Number(b.units) || 0) - (Number(a.units) || 0));
    const cs = cfs.slice().sort((a, b) => (b.investment_paise || 0) - (a.investment_paise || 0));
    if (ps.length === 1) {
      const total = cs.reduce((t, g) => t + (g.investment_paise || 0), 0);
      const weightedYield = total
        ? cs.reduce((t, g) => t + (g.yieldPct || 0) * (g.investment_paise || 0), 0) / total
        : null;
      byPayout.set(ps[0].key, {
        ...cs[0],
        investment_paise: total,
        investment_date: cs.map((g) => g.investment_date).filter(Boolean).sort()[0] || "",
        yieldPct: weightedYield === null ? null : Math.round(weightedYield * 100) / 100,
      });
      cs.forEach((g) => used.add(g.index));
    } else {
      ps.forEach((p, i) => {
        const g = cs[i];
        if (!g) return;
        byPayout.set(p.key, g);
        used.add(g.index);
      });
    }
  }
  // Fallback for a cashflow file without ISINs in the names.
  for (const p of payouts) {
    if (byPayout.has(p.key)) continue;
    const mat = labelMaturity(p.label);
    const same = (groups || []).filter((g) => !used.has(g.index)
      && (labelMaturity(g.name) === mat || g.maturity === mat));
    const scored = same.map((g) => ({ g, score: nameScore(g.name, p.label) }))
      .sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    const best = scored[0];
    const second = scored[1];
    if (best.score < 0.34) continue;
    if (second && second.score > 0 && best.score - second.score < 0.15) continue;
    byPayout.set(p.key, best.g);
    used.add(best.g.index);
  }
  return { byPayout, used };
}

export function mergeDigiFinn({ payouts = [], cashflow = [], existing = [], mode = "merge" } = {}) {
  const pGroups = payoutGroups(payouts);
  const groups = cashflow || [];
  const { byPayout, used } = assignCashflow(pGroups, groups);
  const oldByKey = new Map();
  for (const r of existing || []) oldByKey.set(existingKey(r), r);

  const ratingByIsin = new Map();
  for (const r of existing || []) {
    const isin = cleanCell(r.security_id).toUpperCase();
    if (isin && ratingOf(r)) ratingByIsin.set(isin, ratingOf(r));
  }
  const lotCounts = new Map();
  for (const p of pGroups) lotCounts.set(p.isin, (lotCounts.get(p.isin) || 0) + 1);
  const lotSeen = new Map();

  const imported = [];
  const importedOld = [];
  const usedExisting = new Set();
  const findExisting = (p, cf) => {
    const qtyKey = `isin:${p.isin}|qty:${p.units ?? ""}`;
    const exact = oldByKey.get(qtyKey);
    if (exact && !usedExisting.has(qtyKey)) return exact;
    const same = [...oldByKey.entries()].filter(([k, r]) => !usedExisting.has(k)
      && cleanCell(r.security_id).toUpperCase() === p.isin);
    if (same.length === 1) return same[0][1];
    if (same.length > 1) {
      const qty = Number(p.units) || 0;
      same.sort((a, b) => Math.abs((Number(a[1].quantity) || 0) - qty)
        - Math.abs((Number(b[1].quantity) || 0) - qty));
      return same[0][1];
    }
    const label = p.label || cf?.name || "";
    const mat = labelMaturity(label) || cf?.maturity || "";
    for (const [k, r] of oldByKey) {
      if (usedExisting.has(k) || cleanCell(r.security_id)) continue;
      if (norm(r.label).includes(norm(label)) || nameScore(r.label, label) >= 0.8) {
        if (!mat || labelMaturity(r.label) === mat) return r;
      }
    }
    return null;
  };

  for (const p of pGroups) {
    const cf = byPayout.get(p.key) || null;
    const old = findExisting(p, cf);
    if (old) usedExisting.add(existingKey(old));
    const lotTotal = lotCounts.get(p.isin) || 1;
    const lotNo = (lotSeen.get(p.isin) || 0) + 1;
    lotSeen.set(p.isin, lotNo);
    const base = p.label || cf?.name || old?.label || p.isin;
    const label = lotTotal > 1 ? `${base} · lot ${lotNo}` : base;
    const cost = cf?.investment_paise ?? old?.cost_paise ?? null;
    importedOld.push(old);
    imported.push({
      security_id: p.isin,
      label,
      category: "bond",
      rating: ratingOf(old) || ratingByIsin.get(p.isin) || "",
      frequency: p.frequency || cf?.frequency || old?.frequency || "",
      yield_bps: cf?.yieldPct !== null && cf?.yieldPct !== undefined
        ? Math.round(cf.yieldPct * 100) : (old?.yield_bps ?? null),
      payout_paise: p.amount_paise ?? old?.payout_paise ?? null,
      quantity: p.units ?? old?.quantity ?? null,
      cost_paise: cost,
      value_paise: old?.value_paise ?? null,
      purchase_date: cf?.investment_date || old?.purchase_date || "",
      interest_date: p.interest_date || old?.interest_date || "",
      source_row: p.source_row || 0,
    });
  }

  // A cashflow-only file can enrich an existing holding but cannot add one:
  // it carries no ISIN and no units.
  const cashflowUnmatched = [];
  for (const g of groups) {
    if (used.has(g.index)) continue;
    let match = null;
    if (g.isin) {
      match = [...oldByKey.entries()].find(([k, r]) => !usedExisting.has(k)
        && cleanCell(r.security_id).toUpperCase() === g.isin)?.[1] || null;
    }
    if (!match) {
      for (const [k, r] of oldByKey) {
        if (usedExisting.has(k)) continue;
        const mat = labelMaturity(r.label);
        if (g.maturity && mat && mat !== g.maturity) continue;
        if (nameScore(g.name, r.label) >= 0.5) { match = r; break; }
      }
    }
    if (!match) { cashflowUnmatched.push(g); continue; }
    usedExisting.add(existingKey(match));
    importedOld.push(match);
    imported.push({
      security_id: match.security_id || "",
      label: match.label || g.name,
      category: "bond",
      rating: ratingOf(match),
      frequency: g.frequency || match.frequency || "",
      yield_bps: g.yieldPct !== null && g.yieldPct !== undefined
        ? Math.round(g.yieldPct * 100) : (match.yield_bps ?? null),
      payout_paise: match.payout_paise ?? null,
      quantity: match.quantity ?? null,
      cost_paise: g.investment_paise ?? match.cost_paise ?? null,
      value_paise: match.value_paise ?? null,
      purchase_date: g.investment_date || match.purchase_date || "",
      interest_date: match.interest_date || "",
      source_row: match.source_row || 0,
    });
  }

  // Number lots by purchase date, not by the order the payout rows happened to
  // arrive. BNAL's 2025 lot is lot 1 even though the portal lists its 2026 lot
  // first.
  const lotsByIsin = new Map();
  for (const r of imported) {
    if (!r.security_id) continue;
    if (!lotsByIsin.has(r.security_id)) lotsByIsin.set(r.security_id, []);
    lotsByIsin.get(r.security_id).push(r);
  }
  for (const lots of lotsByIsin.values()) {
    if (lots.length < 2) continue;
    lots.sort((a, b) => String(a.purchase_date || "9999-99-99")
      .localeCompare(String(b.purchase_date || "9999-99-99")));
    lots.forEach((r, i) => {
      r.label = `${r.label.replace(/ · lot \d+$/, "")} · lot ${i + 1}`;
    });
  }

  const kept = [];
  const removed = [];
  for (const [k, r] of oldByKey) {
    if (usedExisting.has(k)) continue;
    if (mode === "replace") removed.push(r);
    else kept.push(r);
  }

  const holdings = [...imported, ...kept];
  const seen = new Set();
  const deduped = [];
  for (const r of holdings) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  let updated = 0;
  for (let i = 0; i < imported.length; i++) {
    const old = importedOld[i];
    if (!old) continue;
    if (["quantity", "cost_paise", "value_paise", "purchase_date", "interest_date",
      "rating", "frequency", "yield_bps", "payout_paise"]
      .some((f) => (old[f] ?? null) !== (imported[i][f] ?? null))) updated++;
  }

  return {
    holdings: deduped,
    added: imported.filter((_, i) => !importedOld[i]).length,
    updated,
    kept: kept.length,
    removed: removed.length,
    removedRows: removed,
    cashflowGroups: groups.length,
    cashflowMatched: used.size,
    cashflowUnmatched: cashflowUnmatched.map((g) => ({ name: g.name, maturity: g.maturity,
      yieldPct: g.yieldPct })),
    costMissing: deduped.filter((r) => r.cost_paise === null || r.cost_paise === undefined).length,
  };
}

export function scorePortfolio(assetHoldings, files) {
  const pay = files?.payouts?.rows || [];
  const isins = new Set(pay.map((r) => r.isin).filter(Boolean));
  if (isins.size) {
    const hit = new Set();
    for (const h of assetHoldings || []) {
      const isin = cleanCell(h.security_id).toUpperCase();
      if (isins.has(isin)) hit.add(isin);
    }
    return { score: hit.size, basis: "ISIN", matched: hit.size, of: isins.size };
  }
  const groups = files?.cashflow?.groups || [];
  let hit = 0;
  for (const g of groups) {
    if ((assetHoldings || []).some((h) => nameScore(g.name, h.label) >= 0.6)) hit++;
  }
  return { score: hit, basis: "name", matched: hit, of: groups.length };
}
