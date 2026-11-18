// Zerodha Console's holdings exports. A file is a point-in-time snapshot: it
// carries ISIN, quantity and average price, but no purchase date. The app keeps
// quantity and value from the CAS and uses this file only for cost.
//
// Kite prints three sheets: Equity, Mutual Funds and a Combined duplicate. A
// sheet is holdings only when its header row carries ISIN and Quantity
// Available; everything above it is preamble. Columns are found by name, so a
// shifted Combined sheet and a renamed sheet still read.

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(n) ? n : null;
};
const key = (v) => text(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const ISIN = /^IN[A-Z0-9]{10}$/;
const FUND_ISIN = /^INF/i;

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

function asOfFrom(rows, header) {
  const cell = rows.slice(0, header).flat().map(text)
    .find((line) => /statement\s+as\s+on/i.test(line));
  return (cell?.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || "";
}

// One header row to column positions. Two names are enough to call it a
// holdings table; every other column is optional and read only when present.
function holdingsColumns(cells) {
  const map = {};
  for (const [c, cell] of (cells || []).entries()) {
    const k = key(cell);
    if (!k) continue;
    if (k === "symbol") map.symbol = c;
    else if (k === "isin") map.isin = c;
    else if (k === "sector") map.sector = c;
    else if (k === "instrumenttype" && map.sector === undefined) map.sector = c;
    else if (k === "quantityavailable") map.qty = c;
    else if (k === "quantitylongterm") map.longTerm = c;
    else if (k === "averageprice" || k === "buyavg" || k === "averagecost") map.avg = c;
    else if (k === "previousclosingprice" || k === "ltp" || k === "lastprice") map.close = c;
    else if (k === "unrealizedpl" || k === "unrealisedpl" || k === "pnl") map.pnl = c;
    else if (k === "quantitypledgedmargin") map.pledgeMargin = c;
    else if (k === "quantitypledgedloan") map.pledgeLoan = c;
  }
  return map;
}

export function parseZerodhaHoldings(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let header = -1;
  let cols = {};
  for (let r = 0; r < rows.length; r++) {
    const map = holdingsColumns(rows[r]);
    if (map.isin !== undefined && map.qty !== undefined) {
      header = r;
      cols = map;
      break;
    }
  }
  if (header < 0) {
    return { rows: [], asOf: "", clientId: "", error: "No holdings header found in this file." };
  }
  const out = [];
  for (let r = header + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const isin = text(cells[cols.isin]).toUpperCase();
    if (!ISIN.test(isin)) continue;
    const available = num(cells[cols.qty]) || 0;
    const pledged = (num(cells[cols.pledgeMargin]) || 0)
      + (num(cells[cols.pledgeLoan]) || 0);
    // Kite's Quantity Available already excludes shares pledged for margin or
    // a loan. Those shares are still owned, so the holding is available plus
    // pledged, and pledged stays on the row for display. Subtracting it again
    // would drop it from net worth.
    const quantity = available + pledged;
    const averagePrice = num(cells[cols.avg]);
    if (!quantity || averagePrice === null || averagePrice <= 0) continue;
    const row = {
      symbol: cols.symbol === undefined ? "" : text(cells[cols.symbol]),
      isin,
      sector: cols.sector === undefined ? "" : text(cells[cols.sector]),
      quantity,
      pledged,
      averagePrice,
      previousClose: cols.close === undefined ? null : num(cells[cols.close]),
      pnl: cols.pnl === undefined ? null : num(cells[cols.pnl]),
    };
    // Long term is a subset of the quantity already counted, never extra units.
    if (cols.longTerm !== undefined) row.longTerm = num(cells[cols.longTerm]) || 0;
    out.push(row);
  }
  return { rows: out, asOf: asOfFrom(rows, header), clientId: clientIdFrom(rows, header),
    error: out.length ? null : "No holdings rows found in this file." };
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
export function parseZerodhaHoldingsSheets(sheets, names = []) {
  const list = Array.isArray(sheets) ? sheets : [];
  const sheetNames = Array.isArray(names) ? names : [];
  const entries = list.map((item, index) => sheetEntry(item, index, sheetNames))
    .filter(Boolean);
  const parsed = entries.map((entry) => {
    const role = sheetRole(entry.name);
    return { ...entry, role, parsed: parseZerodhaHoldings(entry.rows) };
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
