// DigiFInn monthly bond sync. The broker's Profile → Reports & Documents page
// gives three separate reports; none of them is a complete holding on its own.
// Portfolio Report: ISIN, quantity, cost, purchase date.
// Investment Report: issuer, coupon, maturity, purchase yield.
// Upcoming Payouts (or Cashflow Future): next payout date, amount, frequency.
// Everything above the table header is ignored, so PAN/name/phone/email never
// enter the parsed rows.

import { parseCsv, cleanCell, parseNumber, parseMoney, parseDate,
  parsePayouts, parseCashflow } from "./digifinn.js";
import { parseBondLabel, inferFace } from "./bonds.js";
import { parseDate as parseAnyDate } from "./holding-import.js";

const norm = (s) => cleanCell(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pct = (v) => {
  const n = parseNumber(cleanCell(v).replace("%", ""));
  return n === null ? null : n;
};
const int = (v) => {
  const n = parseNumber(v);
  return n === null ? null : Math.round(n);
};
const money = (v) => parseMoney(cleanCell(v));

function headerIndex(rows, required) {
  for (let i = 0; i < rows.length; i++) {
    const n = (rows[i] || []).map(norm);
    if (required.every((x) => n.includes(x))) return i;
  }
  return -1;
}

function dematFrom(rows, header) {
  for (let i = 0; i < header; i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      if (norm(row[c]) === "demat account no") {
        for (let k = c + 1; k < row.length; k++) {
          const v = cleanCell(row[k]);
          if (v) return v;
        }
      }
    }
  }
  return "";
}

const IDENTITY_LABELS = { "name": "name", "pan": "pan", "phone": "phone",
  "phone no": "phone", "email": "email", "demat account no": "demat" };
// The report preamble carries the holder's identity. It is kept in the encrypted
// database so the portfolio is complete, and never shown in logs or diagnostics.
function identityFrom(rows, header) {
  const out = {};
  for (let i = 0; i < header; i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      const key = IDENTITY_LABELS[norm(row[c])];
      if (!key || out[key]) continue;
      for (let k = c + 1; k < row.length; k++) {
        const v = cleanCell(row[k]);
        if (v) { out[key] = v; break; }
      }
    }
  }
  return out;
}

function metaDate(rows, header, label) {
  for (let i = 0; i < header; i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      if (norm(row[c]) !== label) continue;
      for (let k = c + 1; k < row.length; k++) {
        const d = parseAnyDate(row[k]);
        if (d) return d;
      }
    }
  }
  return "";
}

function asOfFrom(rows, header) {
  for (let i = 0; i < Math.min(header, 14); i++) {
    const text = (rows[i] || []).map(cleanCell).join(" ");
    const m = text.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    if (m) {
      const d = parseAnyDate(m[1]);
      if (d) return d;
    }
  }
  return "";
}

export function parsePortfolioReport(text, fileName = "") {
  const rows = parseCsv(text);
  const header = headerIndex(rows, ["isin", "bond name", "qty"]);
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
    const isin = cleanCell(col(row, "isin")).toUpperCase();
    const label = cleanCell(col(row, "bond name"));
    if (!isin && !label) { skipped++; continue; }
    if (!/^IN[A-Z0-9]{10}$/.test(isin)) { skipped++; continue; }
    out.push({
      isin,
      label,
      purchase_date: parseAnyDate(col(row, "purchase date")),
      quantity: parseNumber(col(row, "qty", "quantity")),
      cost_paise: money(col(row, "investment value", "investment value (₹)")),
      source_row: r + 1,
    });
  }
  return { kind: "portfolio", fileName, demat: dematFrom(rows, header),
    identity: identityFrom(rows, header),
    asOf: metaDate(rows, header, "as of"), generated: metaDate(rows, header, "report generation date"),
    rows: out, skipped };
}

export function parseInvestmentReport(text, fileName = "") {
  const rows = parseCsv(text);
  const header = headerIndex(rows, ["bond name", "issuer", "coupon", "yield"]);
  if (header < 0) return null;
  const map = {};
  rows[header].forEach((cell, i) => { const k = norm(cell); if (k) map[k] = i; });
  const col = (row, ...names) => {
    for (const n of names) if (map[n] !== undefined) return row[map[n]];
    return "";
  };
  const out = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const label = cleanCell(col(row, "bond name"));
    if (!label || norm(label) === "total") continue;
    const parsed = parseBondLabel(label);
    out.push({
      label,
      issuer: cleanCell(col(row, "issuer")),
      coupon_pct: pct(col(row, "coupon")),
      maturity: parsed ? parsed.maturity : "",
      purchase_date: parseAnyDate(col(row, "purchase date")),
      yield_pct: pct(col(row, "yield")),
      invested_paise: money(col(row, "invested amount")),
      source_row: r + 1,
    });
  }
  return { kind: "investment", fileName, asOf: asOfFrom(rows, header), rows: out };
}

export function parsePayoutReport(text, fileName = "") {
  const payouts = parsePayouts(text, fileName);
  if (!payouts) return null;
  const groups = new Map();
  for (const row of payouts.rows) {
    if (!row.isin) continue;
    const key = `${row.isin}|${row.units ?? ""}`;
    const cur = groups.get(key);
    if (!cur) groups.set(key, { ...row, rows: [row] });
    else cur.rows.push(row);
  }
  const out = [...groups.values()].map((g) => {
    g.rows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const first = g.rows.find((r) => r.date) || g.rows[0] || {};
    return { ...g,
      date: first.date || "", interest_date: first.date || "",
      amount_paise: first.amount_paise ?? g.amount_paise,
      frequency: first.frequency || g.frequency };
  });
  return { kind: "payouts", fileName, source: "payouts", groups: out };
}

export function parseCashflowReport(text, fileName = "") {
  const flow = parseCashflow(text, fileName);
  if (!flow) return null;
  const groups = flow.groups.map((g) => ({
    isin: g.isin,
    units: null,
    date: g.next_payout_date || "",
    interest_date: g.next_payout_date || "",
    amount_paise: g.next_payout_paise ?? null,
    frequency: g.frequency || "",
    issuer: g.name,
    yield_pct: g.yieldPct,
    investment_paise: g.investment_paise,
    investment_date: g.investment_date,
    // The whole future schedule, gross of tax: what is still to come, and how
    // many times the principal comes back.
    future_interest_paise: g.future_interest_paise ?? null,
    future_principal_paise: g.future_principal_paise ?? null,
    principal_dates: g.principal_dates || [],
  }));
  return { kind: "payouts", fileName, source: "cashflow", groups };
}

export function parseTransactionReport(text, fileName = "") {
  const rows = parseCsv(text);
  const header = headerIndex(rows, ["isin", "transaction type"]);
  if (header < 0) return null;
  const head = rows[header].map(norm);
  const at = (re) => head.findIndex((c) => re.test(c));
  const cols = {
    isin: at(/^isin/), name: at(/^bond name/), date: at(/^date$/),
    type: at(/^transaction type/), qty: at(/^quantity/), price: at(/^price/),
    value: at(/^total value/), face: at(/^face value/), coupon: at(/^coupon/),
    maturity: at(/^maturity/),
  };
  const cell = (row, i) => (i >= 0 ? row[i] : "");
  const out = [];
  let skipped = 0;
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const isin = cleanCell(cell(row, cols.isin)).toUpperCase();
    const type = cleanCell(cell(row, cols.type)).toUpperCase();
    if (!/^IN[A-Z0-9]{10}$/.test(isin) || !type) { skipped++; continue; }
    out.push({
      isin,
      label: cleanCell(cell(row, cols.name)),
      date: parseAnyDate(cell(row, cols.date)),
      type,
      quantity: parseNumber(cell(row, cols.qty)),
      price_paise: money(cell(row, cols.price)),
      value_paise: money(cell(row, cols.value)),
      face_paise: money(cell(row, cols.face)),
      coupon_pct: parseNumber(cell(row, cols.coupon)),
      maturity: parseAnyDate(cell(row, cols.maturity)),
      source_row: r + 1,
    });
  }
  return { kind: "transactions", fileName, rows: out, skipped };
}

export function parseReportFile(text, fileName = "") {
  // The transactions report also carries ISIN, bond name and quantity, so it is
  // matched first: its `Transaction Type` column is the giveaway.
  return parseTransactionReport(text, fileName)
    || parsePortfolioReport(text, fileName)
    || parseInvestmentReport(text, fileName)
    || parsePayoutReport(text, fileName)
    || parseCashflowReport(text, fileName)
    || { kind: "unknown", fileName };
}

function existingLookup(rows, isin, quantity, purchaseDate) {
  const byIsinQtyDate = new Map();
  const byIsinQty = new Map();
  const byIsin = new Map();
  for (const r of rows || []) {
    const id = cleanCell(r.security_id).toUpperCase();
    if (!id) continue;
    const k1 = `${id}|${r.quantity ?? ""}|${r.purchase_date || ""}`;
    const k2 = `${id}|${r.quantity ?? ""}`;
    byIsinQtyDate.set(k1, r);
    byIsinQty.set(k2, r);
    if (!byIsin.has(id)) byIsin.set(id, r);
  }
  return byIsinQtyDate.get(`${isin}|${quantity ?? ""}|${purchaseDate || ""}`)
    || byIsinQty.get(`${isin}|${quantity ?? ""}`)
    || byIsin.get(isin) || null;
}

export function buildBondSync({ portfolio, investment, payouts, existing = [],
  today = new Date().toISOString().slice(0, 10), mode = "replace" } = {}) {
  if (!portfolio || !portfolio.rows.length) {
    return { holdings: [], matured: [], added: 0, updated: 0, removed: 0,
      current: 0, total: 0, matched: 0, demat: portfolio?.demat || "",
      warnings: ["The Portfolio Report has no bond rows."] };
  }
  const invByKey = new Map();
  const invByLabel = new Map();
  for (const r of investment?.rows || []) {
    const key = `${norm(r.label)}|${r.invested_paise ?? ""}`;
    invByKey.set(key, r);
    if (!invByLabel.has(norm(r.label))) invByLabel.set(norm(r.label), r);
  }
  const payByIsin = new Map();
  for (const g of payouts?.groups || []) {
    if (!g.isin) continue;
    if (!payByIsin.has(g.isin)) payByIsin.set(g.isin, []);
    payByIsin.get(g.isin).push(g);
  }
  const holdings = [];
  const matured = [];
  const warnings = [];
  // The broker can list one ISIN more than once (separate lots). Keep them all
  // but say so, so a repeated row is not mistaken for a sync error.
  const isinCounts = new Map();
  for (const h of portfolio.rows) {
    if (!h.isin) continue;
    isinCounts.set(h.isin, (isinCounts.get(h.isin) || 0) + 1);
  }
  const repeated = [...isinCounts.values()].filter((n) => n > 1).length;
  if (repeated) {
    warnings.push(`${repeated} ISIN${repeated === 1 ? " appears" : "s appear"} more than once in the Portfolio Report; each row is kept as a separate lot.`);
  }
  for (const h of portfolio.rows) {
    const label = h.label || "";
    const inv = invByKey.get(`${norm(label)}|${h.cost_paise ?? ""}`)
      || invByLabel.get(norm(label)) || null;
    const maturity = (parseBondLabel(label) || {}).maturity || inv?.maturity || "";
    if (maturity && maturity < today) {
      matured.push({ ...h, maturity });
      continue;
    }
    const candidates = payByIsin.get(h.isin) || [];
    const old = existingLookup(existing, h.isin, h.quantity, h.purchase_date);
    const lotCost = h.cost_paise ?? old?.cost_paise ?? null;
    // Two lots of one ISIN can appear as two blocks in the cashflow sheet, each
    // with its own units and therefore its own money. Match the block to the lot
    // by what was invested (the two exports differ by a fraction of a percent),
    // and refuse the block when nothing matches: a schedule for somebody else's
    // lot is worse than no schedule at all.
    const costed = candidates.filter((g) => g.investment_paise !== null
      && g.investment_paise !== undefined);
    const pay = costed.length
      ? (lotCost === null ? null : costed.find((g) =>
        Math.abs(Number(g.investment_paise) - Number(lotCost))
          <= Math.max(100, Number(lotCost) * 0.05)) || null)
      : (candidates.find((g) => g.units !== null && g.units !== undefined
        && Number(g.units) === Number(h.quantity)) || candidates[0] || null);
    const yieldPct = inv?.yield_pct ?? pay?.yield_pct ?? null;
    const cost = h.cost_paise ?? old?.cost_paise ?? null;
    const priced = old?.value_paise !== null && old?.value_paise !== undefined
      && old?.cost_paise !== null && old?.cost_paise !== undefined
      && Math.abs(old.value_paise - old.cost_paise) >= 1;
    holdings.push({
      security_id: h.isin,
      label,
      category: "bond",
      rating: old?.rating || "",
      frequency: pay?.frequency || old?.frequency || "",
      yield_bps: yieldPct === null || yieldPct === undefined
        ? (old?.yield_bps ?? null) : Math.round(yieldPct * 100),
      payout_paise: pay?.amount_paise ?? old?.payout_paise ?? null,
      quantity: h.quantity,
      cost_paise: cost,
      value_paise: priced ? old.value_paise : null,
      purchase_date: h.purchase_date || old?.purchase_date || "",
      interest_date: pay?.interest_date || old?.interest_date || "",
      // A cashflow export knows the whole future schedule; the older payouts
      // export does not, so these stay empty and the card falls back to the
      // face-value estimate.
      future_interest_paise: pay?.future_interest_paise ?? old?.future_interest_paise ?? null,
      future_principal_paise: pay?.future_principal_paise ?? old?.future_principal_paise ?? null,
      // Face at purchase minus face still to come: money already handed back.
      returned_paise: (() => {
        const face = inferFace(cost, h.quantity);
        const left = pay?.future_principal_paise ?? old?.future_principal_paise;
        if (!face || !h.quantity || left === null || left === undefined) return null;
        const back = face * h.quantity * 100 - Number(left);
        return back > 0 ? back : 0;
      })(),
      principal_dates: (pay?.principal_dates || []).length
        ? pay.principal_dates.join(",") : (old?.principal_dates || ""),
      source_row: h.source_row || 0,
    });
  }
  const seen = new Set();
  const deduped = [];
  for (const h of holdings) {
    const k = `${h.security_id}|${h.quantity ?? ""}|${h.purchase_date || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(h);
  }
  let matched = 0;
  let updated = 0;
  let added = 0;
  const matchedKeys = new Set();
  for (const h of deduped) {
    const old = existingLookup(existing, h.security_id, h.quantity, h.purchase_date);
    if (!old) { added++; continue; }
    matched++;
    matchedKeys.add(old);
    if (["quantity", "cost_paise", "value_paise", "purchase_date", "interest_date",
      "rating", "frequency", "yield_bps", "payout_paise"]
      .some((f) => (old[f] ?? null) !== (h[f] ?? null))) updated++;
  }
  const removed = (existing || []).filter((r) => !matchedKeys.has(r)).length;
  if (!investment?.rows?.length) warnings.push("Investment Report missing: yield and issuer stay as stored.");
  if (!payouts?.groups?.length) warnings.push("Upcoming Payouts missing: payout dates and amounts stay as stored.");
  return { holdings: deduped, matured, added, updated, removed,
    current: deduped.length, total: portfolio.rows.length, matched,
    demat: portfolio.demat || "", warnings };
}

export function scorePortfolio(rows, portfolio) {
  const isins = new Set((portfolio?.rows || []).map((r) => r.isin).filter(Boolean));
  if (!isins.size) return { score: 0, matched: 0, of: 0 };
  const hit = new Set();
  for (const r of rows || []) {
    const id = cleanCell(r.security_id).toUpperCase();
    if (isins.has(id)) hit.add(id);
  }
  return { score: hit.size, matched: hit.size, of: isins.size };
}
