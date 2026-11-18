// Zerodha Console's holdings exports. A file is a point-in-time snapshot: it
// carries ISIN, quantity and average price, but no purchase date. The app keeps
// quantity and value from the CAS and uses this file only for cost.
//
// Kite prints three sheets: Equity, Mutual Funds and a Combined duplicate. A
// sheet is holdings only when a row carries ISIN and a quantity name; the
// header is found by those names, so a shifted Combined sheet, a preamble of
// any length and a renamed sheet still read. Every column is resolved through
// ZERODHA_HOLDINGS_SCHEMA: a spelling the table does not list is a named
// refusal, never a silently empty import.

import { findHeaderRow, headerMessage, cellText, readNumber,
  refusalResult, parseDate, tableWhere } from "./table-schema.js";

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const ISIN = /^IN[A-Z0-9]{10}$/;
const FUND_ISIN = /^INF/i;

// Every spelling Kite has printed for a holdings column. Only ISIN, quantity
// and average price are required: without any one of them a row cannot become
// a holding, and the refusal names the one that is missing.
export const ZERODHA_HOLDINGS_SCHEMA = {
  isin: { label: "ISIN", aliases: ["ISIN", "ISIN Code"], required: true },
  qty: { label: "Quantity Available", required: true,
    aliases: ["Quantity Available", "Quantity", "Qty", "Units",
      "Quantity Available for Trading"] },
  avg: { label: "Average Price", required: true,
    aliases: ["Average Price", "Avg Price", "Average Cost", "Avg Cost",
      "Buy Avg", "Average Buy Price", "Buy Average"] },
  symbol: { label: "Symbol",
    aliases: ["Symbol", "Trading Symbol", "Scrip", "Instrument"] },
  sector: { label: "Sector",
    aliases: ["Sector", "Instrument Type", "Asset Type"] },
  longTerm: { label: "Quantity Long Term",
    aliases: ["Quantity Long Term", "Long Term Quantity", "Qty Long Term"] },
  pledgeMargin: { label: "Quantity Pledged (Margin)",
    aliases: ["Quantity Pledged (Margin)", "Pledged Margin", "Quantity Pledged for Margin"] },
  pledgeLoan: { label: "Quantity Pledged (Loan)",
    aliases: ["Quantity Pledged (Loan)", "Pledged Loan", "Quantity Pledged for Loan"] },
  close: { label: "Previous Closing Price",
    aliases: ["Previous Closing Price", "Previous Close", "Closing Price", "LTP",
      "Last Price", "Last Traded Price"] },
  pnl: { label: "Unrealised P&L",
    aliases: ["Unrealized P&L", "Unrealised P&L", "Unrealized PNL", "Unrealised PNL",
      "P&L", "PNL"] },
};

// Detection asks only for the two names that make a sheet a holdings table, so
// a workbook is not rejected because one optional column moved.
export const ZERODHA_DETECTION_SCHEMA = {
  isin: ZERODHA_HOLDINGS_SCHEMA.isin,
  qty: ZERODHA_HOLDINGS_SCHEMA.qty,
};

export function looksLikeZerodhaHoldings(matrix) {
  return Array.isArray(matrix) && findHeaderRow(matrix, ZERODHA_DETECTION_SCHEMA).index >= 0;
}

// The Client ID is a label, not a demat number, but it is the only identity a
// holdings export carries. Keep it so a file with no CAS can become a
// broker-only account.
function clientIdFrom(rows, header) {
  for (let r = 0; r < header; r++) {
    const cells = rows[r] || [];
    for (let c = 0; c < cells.length; c++) {
      const cell = text(cells[c]);
      if (!/client\s*id/i.test(cell)) continue;
      const inline = cell.match(/client\s*id\s*[:#-]?\s*([A-Z0-9]+)/i);
      if (inline) return inline[1].toUpperCase();
      for (let k = c + 1; k < cells.length; k++) {
        const value = text(cells[k]);
        if (value) return value.toUpperCase();
      }
    }
  }
  return "";
}

// A date printed in prose above the table. The label decides where to look;
// the shared date reader decides what the text means.
function dateIn(line) {
  const match = String(line || "").match(
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-]\d{2,4}\b/);
  return match ? parseDate(match[0]) : "";
}

function asOfFrom(rows, header) {
  const line = rows.slice(0, header).flat().map(text)
    .find((cell) => /statement\s+as\s+on|as\s+on/i.test(cell));
  return line ? dateIn(line) : "";
}

/**
 * Read one sheet of Kite holdings.
 * @param {Array<Array<unknown>>} matrix
 * @param {{file?: string, sheet?: string}} [source] where the sheet came from,
 *   for a refusal a person can act on.
 */
export function parseZerodhaHoldings(matrix, source = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const where = { file: source.file || "", sheet: source.sheet || "" };
  const header = findHeaderRow(rows, ZERODHA_HOLDINGS_SCHEMA);
  if (header.index < 0) {
    const detail = headerMessage(where, ZERODHA_HOLDINGS_SCHEMA, header);
    // Keep the file name's own case; only the generic "this file" opener needs
    // a capital after the sentence before it.
    const tail = detail.startsWith("this file")
      ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : detail;
    return { rows: [], asOf: "", clientId: "", skipped: 0,
      error: `No holdings header found. ${tail}` };
  }
  const cols = header.columns;
  const out = [];
  let skipped = 0;
  let unidentified = 0;
  try {
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const isin = cellText(row, cols, "isin").toUpperCase();
      if (!ISIN.test(isin)) {
        // A total, a subtitle or a blank line is not a holding. A row that
        // carries numbers but no readable ISIN is a changed column, and the
        // empty result at the end names that instead of importing nothing.
        if (row.some((cell) => text(cell))) unidentified++;
        else skipped++;
        continue;
      }
      const available = readNumber(row, cols, "qty",
        { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1, required: true });
      const averagePrice = readNumber(row, cols, "avg",
        { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1, required: true });
      if (averagePrice < 0) {
        return { rows: [], asOf: "", clientId: "", skipped,
          error: `${tableWhere(where)}, row ${r + 1}: "Average Price" is negative (${averagePrice}), `
            + "so the cost cannot be read." };
      }
      const pledged = (readNumber(row, cols, "pledgeMargin",
        { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1 }) || 0)
        + (readNumber(row, cols, "pledgeLoan",
          { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1 }) || 0);
      // Kite's Quantity Available already excludes shares pledged for margin or
      // a loan. Those shares are still owned, so the holding is available plus
      // pledged, and pledged stays on the row for display. Subtracting it again
      // would drop it from net worth.
      const quantity = available + pledged;
      // A zero-quantity line is a closed position, not a holding. It is
      // counted, so the drop is visible even though it is not a failure.
      if (!quantity) { skipped++; continue; }
      const row_ = {
        symbol: cols.symbol === undefined ? "" : cellText(row, cols, "symbol"),
        isin,
        sector: cols.sector === undefined ? "" : cellText(row, cols, "sector"),
        quantity,
        pledged,
        averagePrice,
        previousClose: cols.close === undefined ? null
          : readNumber(row, cols, "close",
            { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1 }),
        pnl: cols.pnl === undefined ? null
          : readNumber(row, cols, "pnl",
            { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1 }),
      };
      // Long term is a subset of the quantity already counted, never extra units.
      if (cols.longTerm !== undefined) {
        row_.longTerm = readNumber(row, cols, "longTerm",
          { where, schema: ZERODHA_HOLDINGS_SCHEMA, rowNumber: r + 1 }) || 0;
      }
      out.push(row_);
    }
  } catch (error) {
    return { rows: [], asOf: "", clientId: "", skipped, ...refusalResult(error) };
  }
  const asOf = asOfFrom(rows, header.index);
  const clientId = clientIdFrom(rows, header.index);
  if (!out.length) {
    const error = unidentified
      ? `${tableWhere(where)}: ${unidentified} data row${unidentified === 1 ? " has" : "s have"} `
        + "no readable ISIN, so no holding could be identified. The ISIN column may have been renamed."
      : "No holdings rows found in this file.";
    return { rows: [], asOf, clientId, skipped, headerRow: header.index, error };
  }
  return { rows: out, asOf, clientId, skipped, headerRow: header.index, error: null };
}

function sheetRole(name) {
  const value = text(name).toLowerCase();
  if (/mutual\s*funds?|\bmf\b/.test(value)) return "fund";
  if (/\bequity\b/.test(value)) return "equity";
  if (/\bcombined\b|\bconsolidated\b/.test(value)) return "combined";
  return "";
}

function sheetEntry(item, index, names) {
  if (Array.isArray(item)) return { name: text(names[index]), rows: item, index };
  if (item && Array.isArray(item.rows)) return { name: text(item.name), rows: item.rows, index };
  if (item && Array.isArray(item.matrix)) return { name: text(item.name), rows: item.matrix, index };
  return null;
}

// The browser reads the XLSX into matrices; the sheet names say which table is
// which. Combined repeats Equity and Mutual Funds, so it is read only when
// neither of those produced a row. It never adds a second copy of an ISIN.
export function parseZerodhaHoldingsSheets(sheets, names = [], source = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const sheetNames = Array.isArray(names) ? names : [];
  const entries = list.map((item, index) => sheetEntry(item, index, sheetNames))
    .filter(Boolean);
  const parsed = entries.map((entry) => {
    const role = sheetRole(entry.name);
    return { ...entry, role,
      parsed: parseZerodhaHoldings(entry.rows,
        { file: source.file || "", sheet: entry.name }) };
  });
  const usable = parsed.filter((entry) => !entry.parsed.error);
  const primary = usable.filter((entry) => entry.role === "equity" || entry.role === "fund");
  const combined = usable.filter((entry) => entry.role === "combined");
  // A sheet whose name says nothing about its role keeps the old behaviour:
  // the first readable table wins.
  const unnamed = usable.filter((entry) => !entry.role);
  const chosen = primary.length ? primary : combined.length ? combined : unnamed.slice(0, 1);
  if (!chosen.length) {
    const sawHeader = parsed.some((entry) =>
      entry.parsed.error === "No holdings rows found in this file.");
    // A sheet that has the names but a broken cell says so; the first refusal
    // is the most specific explanation and is better than a generic one.
    const refusal = parsed.find((entry) => entry.parsed.refusal);
    if (refusal) return { rows: [], asOf: "", clientId: "", error: refusal.parsed.error,
      refusal: refusal.parsed.refusal };
    return { rows: [], asOf: "", clientId: "",
      error: sawHeader ? "No holdings rows found in this file."
        : "No equity holdings sheet found in this file." };
  }
  const rows = [];
  const seen = new Set();
  for (const entry of chosen) {
    const here = [];
    for (const row of entry.parsed.rows) {
      const isin = row.isin.toUpperCase();
      // A row repeated inside one sheet is the sheet's own business. A security
      // already read from an earlier sheet is the duplicate to drop.
      if (seen.has(isin)) continue;
      here.push({ ...row, category: entry.role === "combined"
        ? (FUND_ISIN.test(isin) ? "mf" : "equity")
        : entry.role === "fund" ? "mf" : "equity" });
    }
    for (const row of here) seen.add(row.isin);
    rows.push(...here);
  }
  if (!rows.length) {
    return { rows: [], asOf: "", clientId: "", error: "No holdings rows found in this file." };
  }
  return {
    rows,
    asOf: chosen.map((entry) => entry.parsed.asOf).find(Boolean) || "",
    clientId: chosen.map((entry) => entry.parsed.clientId).find(Boolean) || "",
    error: null,
  };
}
