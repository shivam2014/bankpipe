// DigiFinn monthly bond sync. The broker's Profile → Reports & Documents page
// gives three separate reports; none of them is a complete holding on its own.
// Portfolio Report: ISIN, quantity, cost, purchase date.
// Investment Report: issuer, coupon, maturity, purchase yield.
// Upcoming Payouts (or Cashflow Future): next payout date, amount, frequency.
// Everything above the table header is ignored, so PAN/name/phone/email never
// enter the parsed rows.

import { parseCsv, cleanCell, parsePayouts, parseCashflow } from "./digifinn.js";
import { parseBondLabel, inferFace } from "./bonds.js";
import { findHeaderRow, headerKey, headerMessage, cellText, readDate,
  readNumber, readMoney, refusalResult, tableWhere, parseDate } from "./table-schema.js";

const norm = (s) => cleanCell(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A report's header is found by its names, and every column is read through
// the schema beside it. `signature` names the two or three columns that make a
// file *this* report: when they are present and a required column is not, the
// file is refused with the missing name instead of falling through as unknown.
export const PORTFOLIO_SCHEMA = {
  isin: { label: "ISIN", aliases: ["ISIN", "ISIN Code"], required: true },
  label: { label: "Bond Name", required: true,
    aliases: ["Bond Name", "Security Name", "Instrument", "Security"] },
  quantity: { label: "Qty", required: true,
    aliases: ["Qty", "Quantity", "Units"] },
  purchase_date: { label: "Purchase date",
    aliases: ["Purchase date", "Purchase Date", "Date of Purchase", "Buy Date"] },
  cost: { label: "Investment Value",
    aliases: ["Investment Value", "Investment Value (₹)", "Invested Amount",
      "Amount Invested", "Cost"] },
};

// Detection asks for the canonical name, not the parser's wider aliases: a
// generic holdings sheet that happens to print "Security Name" must not become
// a DigiFinn bond report merely because it also has an ISIN and a quantity.
export const PORTFOLIO_DETECTION_SCHEMA = {
  isin: PORTFOLIO_SCHEMA.isin,
  label: { label: "Bond Name", required: true, aliases: ["Bond Name"] },
  quantity: PORTFOLIO_SCHEMA.quantity,
};

export const INVESTMENT_SCHEMA = {
  label: { label: "Bond Name", required: true,
    aliases: ["Bond Name", "Security Name", "Instrument", "Security"] },
  issuer: { label: "Issuer", required: true,
    aliases: ["Issuer", "Issuer Name"] },
  coupon_pct: { label: "Coupon", required: true,
    aliases: ["Coupon", "Coupon Rate", "Interest Rate"] },
  yield_pct: { label: "Yield", required: true,
    aliases: ["Yield", "Yield to Maturity", "YTM", "Purchase Yield"] },
  maturity: { label: "Maturity Date",
    aliases: ["Maturity Date", "Maturity", "Redemption Date"] },
  purchase_date: { label: "Purchase Date",
    aliases: ["Purchase Date", "Date of Purchase", "Buy Date"] },
  invested: { label: "Invested Amount",
    aliases: ["Invested Amount", "Investment Amount", "Amount Invested", "Cost"] },
};

export const TRANSACTIONS_SCHEMA = {
  isin: { label: "ISIN", aliases: ["ISIN", "ISIN No", "ISIN Code"], required: true },
  type: { label: "Transaction Type", required: true,
    aliases: ["Transaction Type", "Type"] },
  label: { label: "Bond Name",
    aliases: ["Bond Name", "Security Name", "Instrument", "Security"] },
  date: { label: "Date", aliases: ["Date", "Transaction Date", "Trade Date"] },
  quantity: { label: "Quantity",
    aliases: ["Quantity", "Quantity (Units)", "Units", "Qty"] },
  price: { label: "Price",
    aliases: ["Price", "Price / Unit", "Price / Unit (INR)", "Price per Unit"] },
  value: { label: "Total Value",
    aliases: ["Total Value", "Total Value (INR)", "Value", "Amount"] },
  face: { label: "Face Value",
    aliases: ["Face Value", "Face Value (INR)", "Face Amount"] },
  coupon_pct: { label: "Coupon Rate",
    aliases: ["Coupon Rate", "Coupon Rate (%)", "Coupon"] },
  maturity: { label: "Maturity Date",
    aliases: ["Maturity Date", "Maturity", "Redemption Date"] },
};

// Detection asks only for the canonical transaction name. A Kite tradebook
// prints a "Trade Type" and its own date, quantity and price, so a wider alias
// here would take a tradebook for a bond transactions report.
export const TRANSACTIONS_DETECTION_SCHEMA = {
  isin: TRANSACTIONS_SCHEMA.isin,
  type: { label: "Transaction Type", required: true, aliases: ["Transaction Type"] },
};

const hasKey = (keys, ...names) => names.some((name) =>
  keys.some((key) => key === name || key.startsWith(`${name} `)));

const portfolioSignature = (rows) => rows.some((row) => {
  const keys = (row || []).map(headerKey);
  return keys.includes("isin") && keys.includes("bond name")
    && !keys.includes("transaction type");
});
const investmentSignature = (rows) => rows.some((row) => {
  const keys = (row || []).map(headerKey);
  return keys.includes("bond name") && (keys.includes("issuer") || keys.includes("coupon"));
});
const transactionSignature = (rows) => rows.some((row) => {
  const keys = (row || []).map(headerKey);
  return keys.includes("isin") && (keys.includes("transaction type")
    || hasKey(keys, "total value") || hasKey(keys, "face value") || hasKey(keys, "price"));
});

// Values are read from the same cleaned cells the header was found in, so a
// spreadsheet's quoted field and a CSV's BOM behave alike.
const cleanRows = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => (row || []).map(cleanCell));

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
        const d = parseDate(row[k]);
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
      const d = parseDate(m[1]);
      if (d) return d;
    }
  }
  return "";
}

export function parsePortfolioReport(text, fileName = "") {
  const rows = cleanRows(parseCsv(text));
  const where = { file: fileName, table: "Portfolio Report" };
  const header = findHeaderRow(rows, PORTFOLIO_SCHEMA);
  if (header.index < 0) {
    if (!portfolioSignature(rows)) return null;
    return { kind: "portfolio", fileName, rows: [], skipped: 0,
      error: headerMessage(where, PORTFOLIO_SCHEMA, header) };
  }
  const cols = header.columns;
  const out = [];
  let skipped = 0;
  let unidentified = 0;
  let ambiguousDates = 0;
  try {
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const isin = cellText(row, cols, "isin").toUpperCase();
      const label = cellText(row, cols, "label");
      if (!isin && !label) { skipped++; continue; }
      if (!/^IN[A-Z0-9]{10}$/.test(isin)) { skipped++; unidentified++; continue; }
      const purchase = readDate(row, cols, "purchase_date",
        { where, schema: PORTFOLIO_SCHEMA, rowNumber: r + 1 });
      if (purchase.ambiguous) ambiguousDates++;
      out.push({
        isin,
        label,
        purchase_date: purchase.iso,
        quantity: readNumber(row, cols, "quantity",
          { where, schema: PORTFOLIO_SCHEMA, rowNumber: r + 1, required: true }),
        cost_paise: readMoney(row, cols, "cost",
          { where, schema: PORTFOLIO_SCHEMA, rowNumber: r + 1 }),
        source_row: r + 1,
      });
    }
  } catch (error) {
    return { kind: "portfolio", fileName, rows: [], skipped, ...refusalResult(error) };
  }
  if (!out.length && unidentified) {
    return { kind: "portfolio", fileName, rows: [], skipped, ambiguousDates,
      error: `${tableWhere(where)}: ${unidentified} row${unidentified === 1 ? " has" : "s have"} `
        + "no readable ISIN. The ISIN column may have been renamed." };
  }
  return { kind: "portfolio", fileName, demat: dematFrom(rows, header.index),
    identity: identityFrom(rows, header.index),
    asOf: metaDate(rows, header.index, "as of"),
    generated: metaDate(rows, header.index, "report generation date"),
    rows: out, skipped, ambiguousDates, error: null };
}

export function parseInvestmentReport(text, fileName = "") {
  const rows = cleanRows(parseCsv(text));
  const where = { file: fileName, table: "Investment Report" };
  const header = findHeaderRow(rows, INVESTMENT_SCHEMA);
  if (header.index < 0) {
    if (!investmentSignature(rows)) return null;
    return { kind: "investment", fileName, rows: [],
      error: headerMessage(where, INVESTMENT_SCHEMA, header) };
  }
  const cols = header.columns;
  const out = [];
  let ambiguousDates = 0;
  try {
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const label = cellText(row, cols, "label");
      if (!label || norm(label) === "total") continue;
      const parsed = parseBondLabel(label);
      const purchase = readDate(row, cols, "purchase_date",
        { where, schema: INVESTMENT_SCHEMA, rowNumber: r + 1 });
      if (purchase.ambiguous) ambiguousDates++;
      const stated = readDate(row, cols, "maturity",
        { where, schema: INVESTMENT_SCHEMA, rowNumber: r + 1 });
      out.push({
        label,
        issuer: cellText(row, cols, "issuer"),
        coupon_pct: readNumber(row, cols, "coupon_pct",
          { where, schema: INVESTMENT_SCHEMA, rowNumber: r + 1 }),
        // The name is the broker's own label; a printed date column is the
        // fallback when the name does not carry one.
        maturity: parsed?.maturity || stated.iso,
        purchase_date: purchase.iso,
        yield_pct: readNumber(row, cols, "yield_pct",
          { where, schema: INVESTMENT_SCHEMA, rowNumber: r + 1 }),
        invested_paise: readMoney(row, cols, "invested",
          { where, schema: INVESTMENT_SCHEMA, rowNumber: r + 1 }),
        source_row: r + 1,
      });
    }
  } catch (error) {
    return { kind: "investment", fileName, rows: [], ...refusalResult(error) };
  }
  return { kind: "investment", fileName, asOf: asOfFrom(rows, header.index),
    rows: out, ambiguousDates, error: null };
}

export function parsePayoutReport(text, fileName = "") {
  const payouts = parsePayouts(text, fileName);
  if (!payouts) return null;
  if (payouts.error) {
    return { kind: "payouts", fileName, source: "payouts", groups: [], error: payouts.error };
  }
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
  if (flow.error) {
    return { kind: "payouts", fileName, source: "cashflow", groups: [],
      error: flow.error, refusal: flow.refusal };
  }
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
  const rows = cleanRows(parseCsv(text));
  const where = { file: fileName, table: "Transactions Report" };
  const header = findHeaderRow(rows, TRANSACTIONS_SCHEMA);
  if (header.index < 0) {
    if (!transactionSignature(rows)) return null;
    return { kind: "transactions", fileName, rows: [], skipped: 0,
      error: headerMessage(where, TRANSACTIONS_SCHEMA, header) };
  }
  const cols = header.columns;
  const out = [];
  let skipped = 0;
  let unidentified = 0;
  let cancelled = 0;
  let ambiguousDates = 0;
  // The report stacks sections: ORDER SETTLED, then ORDER CANCELLED, each with
  // its own header row. A cancelled order is not a trade, so its rows are
  // counted and left out instead of becoming a purchase.
  let inCancelled = false;
  try {
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const rowText = row.map(cleanCell).filter(Boolean).join(" ");
      const carriesIsin = row.some((cell) => /^IN[A-Z0-9]{10}$/.test(cleanCell(cell).toUpperCase()));
      if (!carriesIsin && /^[A-Z][A-Z /]+$/.test(cleanCell(row[0] || ""))
        && /\b(settled|cancell?ed)\b/i.test(rowText)) {
        inCancelled = /\bcancell?ed\b/i.test(rowText);
        skipped++;
        continue;
      }
      // A second section repeats the column header before its rows start.
      if (row.some((cell) => headerKey(cell) === "transaction type")) {
        skipped++;
        continue;
      }
      if (inCancelled) { cancelled++; skipped++; continue; }
      const isin = cellText(row, cols, "isin").toUpperCase();
      const type = cellText(row, cols, "type").toUpperCase();
      if (!/^IN[A-Z0-9]{10}$/.test(isin) || !type) { skipped++; unidentified++; continue; }
      const date = readDate(row, cols, "date",
        { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 });
      if (date.ambiguous) ambiguousDates++;
      out.push({
        isin,
        label: cellText(row, cols, "label"),
        date: date.iso,
        type,
        quantity: readNumber(row, cols, "quantity",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }),
        price_paise: readMoney(row, cols, "price",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }),
        value_paise: readMoney(row, cols, "value",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }),
        face_paise: readMoney(row, cols, "face",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }),
        coupon_pct: readNumber(row, cols, "coupon_pct",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }),
        maturity: readDate(row, cols, "maturity",
          { where, schema: TRANSACTIONS_SCHEMA, rowNumber: r + 1 }).iso,
        source_row: r + 1,
      });
    }
  } catch (error) {
    return { kind: "transactions", fileName, rows: [], skipped, cancelled,
      ...refusalResult(error) };
  }
  if (!out.length && unidentified) {
    return { kind: "transactions", fileName, rows: [], skipped, cancelled, ambiguousDates,
      error: `${tableWhere(where)}: ${unidentified} row${unidentified === 1 ? " has" : "s have"} `
        + "no readable ISIN or transaction type, so no trade could be identified." };
  }
  return { kind: "transactions", fileName, rows: out, skipped, cancelled,
    ambiguousDates, error: null };
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
