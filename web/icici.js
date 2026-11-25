// ICICI Direct's demat holdings export. It is one CSV table with no date, no
// cost and no asset-class column. Market Value is the only money the file
// carries, so it becomes the value and cost stays empty for the tradebook to
// fill later.
//
// The ISIN decides the class. Its eighth and ninth characters are the Indian
// security-type code: 01 is an equity share, while 05, 06, 07, 08, 09, 10, 11
// and 24 are debt. Anything else is refused by name, never guessed.
//
// Every column is resolved through ICICI_HOLDINGS_SCHEMA. A missing required
// column, an unreadable cell, an ISIN that is not a company security or an
// unknown type is a refusal naming the file, the column and the row.

import { findHeaderRow, headerMessage, cellText, readNumber, readMoney,
  refusalResult, refuse, tableWhere, parseDate } from "./table-schema.js";

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const ISIN = /^IN[A-Z0-9]{10}$/;
// Company ISINs start INE (the old series) or IN9 (the newer one). Government
// and fund issuers print different prefixes and do not belong in this reader.
const COMPANY_ISIN = /^IN[E9]/;
const isoToday = () => new Date().toISOString().slice(0, 10);

// The Indian security-type table. The same code can mean something else under
// another issuer prefix, which is why the prefix is checked first.
export const ICICI_SECURITY_TYPES = {
  "01": { category: "equity", name: "equity shares" },
  "05": { category: "bond", name: "deep discount bond" },
  "06": { category: "bond", name: "floating rate bond" },
  "07": { category: "bond", name: "bond or debenture" },
  "08": { category: "bond", name: "bond or debenture" },
  "09": { category: "bond", name: "bond or debenture" },
  "10": { category: "bond", name: "floating rate bond" },
  "11": { category: "bond", name: "bond" },
  "24": { category: "bond", name: "municipal bond" },
};

// Only used to make a refusal read like the security it names. A code outside
// this table is still refused, just without a description.
const SECURITY_TYPE_NAMES = {
  "02": "Postal Savings Scheme",
  "03": "preference shares",
  "04": "preference shares",
  "13": "warrants",
  "14": "commercial paper",
  "15": "securitised instrument",
  "16": "certificate of deposit",
  "18": "securitised instrument",
  "20": "rights entitlement",
  "21": "Indian depository receipt",
  "22": "alternative investment fund",
  "23": "infrastructure investment trust",
  "25": "real estate investment trust",
};

// Every spelling ICICI Direct has printed for a holdings column. Only the four
// columns a holding cannot exist without are required.
export const ICICI_HOLDINGS_SCHEMA = {
  label: { label: "Stock Name", required: true,
    aliases: ["Stock Name", "Security Name", "Scrip Name", "Instrument"] },
  symbol: { label: "Stock",
    aliases: ["Stock", "Symbol", "Scrip", "Trading Symbol"] },
  isin: { label: "ISIN", required: true, aliases: ["ISIN", "ISIN Code"] },
  qty: { label: "Allocated Quantity", required: true,
    aliases: ["Allocated Quantity", "Quantity", "Qty", "Units"] },
  blockedTrade: { label: "Blocked for Trade",
    aliases: ["Blocked for Trade", "Blocked Quantity"] },
  blockedMargin: { label: "Block For Margin",
    aliases: ["Block For Margin", "Blocked For Margin", "Blocked for Margin"] },
  price: { label: "Current Market Price",
    aliases: ["Current Market Price", "Market Price", "LTP", "Last Price"] },
  change: { label: "% Change",
    aliases: ["% Change", "Change", "Change %"] },
  value: { label: "Market Value", required: true,
    aliases: ["Market Value", "Current Value", "Value"] },
  mandate: { label: "Mandate Quantity", aliases: ["Mandate Quantity"] },
};

// Detection asks for the three names no other importer prints. Zerodha and
// DigiFinn both fail this signature even when their own quantity aliases are
// wide, and an ICICI file cannot satisfy either holdings schema.
export const ICICI_DETECTION_SCHEMA = {
  qty: { label: "Allocated Quantity", required: true,
    aliases: ["Allocated Quantity"] },
  value: { label: "Market Value", required: true, aliases: ["Market Value"] },
  mandate: { label: "Mandate Quantity", required: true,
    aliases: ["Mandate Quantity"] },
};

export function looksLikeIciciHoldings(matrix) {
  return Array.isArray(matrix)
    && findHeaderRow(matrix, ICICI_DETECTION_SCHEMA).index >= 0;
}

/** The class the ISIN's security-type digits describe, or null. */
export function iciciCategory(isin) {
  const value = String(isin ?? "").toUpperCase();
  if (!ISIN.test(value) || !COMPANY_ISIN.test(value)) return null;
  return ICICI_SECURITY_TYPES[value.slice(7, 9)]?.category || null;
}

/**
 * Read one ICICI Direct holdings CSV matrix.
 * @param {Array<Array<unknown>>} matrix
 * @param {{file?: string, asOf?: string}} [source] `asOf` is the download day;
 *   the file prints no date of its own.
 */
export function parseIciciHoldings(matrix, source = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const where = { file: source.file || "", table: "Holdings" };
  const asOf = parseDate(source.asOf || "") || isoToday();
  const result = { rows: [], asOf, asOfSource: "download", skipped: 0,
    headerRow: -1, error: null, refusal: null };
  const header = findHeaderRow(rows, ICICI_HOLDINGS_SCHEMA);
  if (header.index < 0) {
    const detail = headerMessage(where, ICICI_HOLDINGS_SCHEMA, header);
    // Keep the file name's own case; only the generic "this file" opener needs
    // a capital after the sentence before it.
    const tail = detail.startsWith("this file")
      ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : detail;
    return { ...result, error: `No ICICI holdings header found. ${tail}` };
  }
  const cols = header.columns;
  const out = [];
  let skipped = 0;
  try {
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (row.every((cell) => !text(cell))) { skipped++; continue; }
      const label = cellText(row, cols, "label");
      const isin = cellText(row, cols, "isin").toUpperCase();
      // A total line is not a holding. Any other row that carries content but
      // no readable ISIN is a changed column, and the refusal names the cell.
      if (!ISIN.test(isin)) {
        if (/^(?:grand\s+)?total\b/i.test(label)) { skipped++; continue; }
        refuse(where, { column: "ISIN", row: r + 1, value: isin,
          reason: "is not a readable ISIN" });
      }
      if (!COMPANY_ISIN.test(isin)) {
        refuse(where, { column: "ISIN", row: r + 1, value: isin,
          reason: "is not a company security ISIN this importer reads" });
      }
      const type = isin.slice(7, 9);
      const security = ICICI_SECURITY_TYPES[type];
      if (!security) {
        const name = SECURITY_TYPE_NAMES[type] ? ` (${SECURITY_TYPE_NAMES[type]})` : "";
        refuse(where, { column: "ISIN", row: r + 1, value: isin,
          reason: `has security type "${type}"${name}, which this importer does not `
            + "classify as an equity (01) or a bond (05 to 11, 24)" });
      }
      const quantity = readNumber(row, cols, "qty",
        { where, schema: ICICI_HOLDINGS_SCHEMA, rowNumber: r + 1, required: true });
      const valuePaise = readMoney(row, cols, "value",
        { where, schema: ICICI_HOLDINGS_SCHEMA, rowNumber: r + 1, required: true });
      // A closed position is not a holding. It is counted so the drop is
      // visible, exactly as the Zerodha reader counts a zero-quantity row.
      if (!quantity) { skipped++; continue; }
      out.push({
        label: label || cellText(row, cols, "symbol") || isin,
        symbol: cols.symbol === undefined ? "" : cellText(row, cols, "symbol"),
        isin,
        category: security.category,
        quantity,
        valuePaise,
        costPaise: null,
        sourceRow: r + 1,
      });
    }
  } catch (error) {
    return { ...result, skipped, headerRow: header.index, ...refusalResult(error) };
  }
  return { ...result, rows: out, skipped, headerRow: header.index,
    error: out.length ? null : "No holdings rows found in this file." };
}
