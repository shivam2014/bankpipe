// Zerodha Console's equity holdings export. The file is a point-in-time
// snapshot: it carries ISIN, quantity and average price, but no purchase date.
// The app keeps quantity and value from the CAS and uses this file only for cost.

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(n) ? n : null;
};
const key = (v) => text(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const ISIN = /^IN[A-Z0-9]{10}$/;

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

export function parseZerodhaHoldings(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let header = -1;
  let cols = {};
  for (let r = 0; r < rows.length; r++) {
    const map = {};
    for (const [c, cell] of (rows[r] || []).entries()) {
      const k = key(cell);
      if (!k) continue;
      if (k === "symbol") map.symbol = c;
      else if (k === "isin") map.isin = c;
      else if (k === "sector") map.sector = c;
      else if (k === "quantityavailable") map.qty = c;
      else if (k === "averageprice" || k === "buyavg" || k === "averagecost") map.avg = c;
      else if (k === "previousclosingprice" || k === "ltp" || k === "lastprice") map.close = c;
      else if (k === "unrealizedpl" || k === "unrealisedpl" || k === "pnl") map.pnl = c;
      else if (k === "quantitypledgedmargin") map.pledgeMargin = c;
      else if (k === "quantitypledgedloan") map.pledgeLoan = c;
    }
    if (map.symbol !== undefined && map.isin !== undefined && map.avg !== undefined) {
      header = r;
      cols = map;
      break;
    }
  }
  if (header < 0) {
    return { rows: [], asOf: "", clientId: "", error: "No holdings header found in this file." };
  }
  const asOfCell = rows.slice(0, header).flat().map(text)
    .find((line) => /holdings statement as on/i.test(line));
  const asOf = (asOfCell?.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || "";
  const out = [];
  for (let r = header + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const isin = text(cells[cols.isin]).toUpperCase();
    if (!ISIN.test(isin)) continue;
    const quantity = num(cells[cols.qty]) || 0;
    const averagePrice = num(cells[cols.avg]);
    if (!quantity || averagePrice === null || averagePrice <= 0) continue;
    const pledged = (num(cells[cols.pledgeMargin]) || 0)
      + (num(cells[cols.pledgeLoan]) || 0);
    out.push({
      symbol: text(cells[cols.symbol]),
      isin,
      sector: cols.sector === undefined ? "" : text(cells[cols.sector]),
      quantity,
      pledged,
      averagePrice,
      previousClose: cols.close === undefined ? null : num(cells[cols.close]),
      pnl: cols.pnl === undefined ? null : num(cells[cols.pnl]),
    });
  }
  return { rows: out, asOf, clientId: clientIdFrom(rows, header),
    error: out.length ? null : "No holdings rows found in this file." };
}

// The browser reads the XLSX into matrices; the Equity sheet is the one that
// carries the holdings table. A CSV or a renamed sheet still works because the
// header is found by its cells, not by the sheet name.
export function parseZerodhaHoldingsSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  for (const sheet of list) {
    const parsed = parseZerodhaHoldings(sheet);
    if (!parsed.error) return parsed;
  }
  return { rows: [], asOf: "", clientId: "", error: "No equity holdings sheet found in this file." };
}
