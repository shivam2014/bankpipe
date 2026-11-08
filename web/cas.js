// The CAS reader. A CDSL or NSDL consolidated statement lists what the
// depository actually holds, which is the only quantity a bond portfolio can be
// audited against: a seller report knows what was paid, never what is still
// there.
//
// A CAS is not one table. It prints a *transactions* table (ISIN, date, opening
// balance, credit, debit, closing balance, stamp duty) and then a *holdings*
// table (ISIN, quantity, price, value), often several of each on the same page.
// Both contain ISINs, so anchoring on an ISIN alone reads a trade as a holding —
// which is how a real CDSL statement produced 50 rows, 18 of them with no value
// and every one of them a transaction line.
//
// So the row unit here is the *table*: a header line is found by its labels
// (ISIN, quantity, value), each ISIN is assigned to the nearest header above it,
// and only holdings tables are read. A statement that carries no recognisable
// header falls back to the older band rule, which serves layouts where a holding
// is a block of lines around one ISIN.
//
// Numbers in these PDFs are right-aligned, so a column is keyed by the right
// edge of its text, not the left. Reading by left edge is what made wide amounts
// land in the price column.
//
// Pure: it reads text items (str, x, y, width) from pdf.js and returns data. No
// DOM, no storage, no network.

import { boId } from "./bo-id.js";

const ISIN = /^IN[A-Z0-9]{10}$/;
const DATE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const NUMERIC_DATE = /^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/;
const NUMBER = /^\d[\d,]*(\.\d+)?$/;

const VALUE_LABEL = /^value\b|value\s*in|valuation/i;
const QUANTITY_LABEL = /no\.\s*of\s*(shares|bonds|units)|^quantity$|^current$|^bal$|^balance$|\(units\)/i;
const ISIN_LABEL = /^isin\b/i;
const LABEL = /isin|security|scheme|company|folio|arn|distributor|value|valuation|quantity|current|frozen|pledge|balance|op\.?\s*bal|cl\.?\s*bal|transaction|description|date|amount|nav|price|maturity|coupon|face|profit|loss|stamp|credit|debit|units/i;

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function rupees(text) {
  const n = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function quantity(text) {
  const n = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isoDate(text) {
  const m = String(text).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return "";
  const months = ["jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return "";
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

// Some depositories print "29-11-2028" instead of "29-Nov-2028".
function isoNumericDate(text) {
  const m = String(text).match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

// A date cell can be split into its digits by the PDF's text layer.
function isoAny(text) {
  const s = String(text).replace(/\s+/g, "");
  const direct = isoDate(s) || isoNumericDate(s);
  if (direct) return direct;
  const digits = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  return digits ? `${digits[3]}-${digits[2]}-${digits[1]}` : "";
}

const isIsin = (s) => ISIN.test(String(s).toUpperCase().replace(/\s+/g, ""));

// A statement is a snapshot, and its own date is the one that decides which
// snapshot is newer. "as on 30-09-2026" is printed beside the total.
function asOfDate(text) {
  const numeric = String(text).match(/\bas on\s+(\d{1,2})[-/](\d{1,2})[-/](\d{4})/i);
  if (numeric) {
    return `${numeric[3]}-${String(numeric[2]).padStart(2, "0")}-${String(numeric[1]).padStart(2, "0")}`;
  }
  const named = String(text).match(/\bas on\s+(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})/i);
  return named ? isoDate(`${named[1]}-${named[2]}-${named[3]}`) : "";
}

/** Flatten every page's text items, keeping the page and the right edge. */
function itemsOf(pdf) {
  const items = [];
  for (const [page, p] of (pdf?.pages || []).entries()) {
    for (const item of p.items || []) {
      const str = tidy(item.str);
      if (!str) continue;
      const x = Number(item.x) || 0;
      const w = Number(item.width) || 0;
      items.push({ str, x, right: x + w, w, y: Number(item.y) || 0, page });
    }
  }
  return items;
}

// A fund row prints units and NAV beside its value, and the statement computes
// that value as units x NAV. Finding the cell that satisfies the product is
// independent of the bilingual headings, which print two labels per column.
function fundValue(cells) {
  // Fewer than four numbers is a plain row, not a fund row (units, NAV, value
  // and at least one more); the identity is too easy to satisfy by accident.
  if (cells.length < 4) return null;
  const amount = (c) => Number(String(c.str).replace(/,/g, ""));
  const ordered = cells.slice().sort((a, b) => (amount(b) || 0) - (amount(a) || 0));
  for (const candidate of ordered) {
    const target = amount(candidate);
    if (!(target > 0) || target > 1e12) continue;
    for (const units of cells) {
      const u = amount(units);
      if (!(u > 1) || u >= target) continue;
      for (const nav of cells) {
        if (nav === units) continue;
        const n = amount(nav);
        if (!(n > 1) || n >= target) continue;
        if (Math.abs(u * n - target) <= Math.max(1, target * 0.005)) return candidate;
      }
    }
  }
  return null;
}

function linesOf(pageItems, tolerance) {
  const out = [];
  for (const item of pageItems.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - item.y) <= tolerance) last.items.push(item);
    else out.push({ y: item.y, items: [item] });
  }
  return out;
}

/**
 * Every table header in the document. A header prints across up to three lines
 * ("Value in (₹)" above "Current"), 12-20 apart, so label-only neighbours are
 * merged before the columns are read.
 * @param {Array<object>} items
 * @returns {Array<{page: number, y: number, cols: Array<object>,
 *   holdings: boolean, kind: string}>}
 */
function detectTables(items) {
  const tables = [];
  for (const page of new Set(items.map((i) => i.page))) {
    const merged = [];
    for (const line of linesOf(items.filter((i) => i.page === page), 10)) {
      const hasIsin = line.items.some((i) => isIsin(i.str));
      const labels = line.items.filter((i) => LABEL.test(i.str)).length;
      const prev = merged[merged.length - 1];
      if (prev && !prev.hasIsin && !hasIsin && Math.abs(prev.y - line.y) <= 20
        && (labels >= 2 || prev.labels >= 2)) {
        prev.items.push(...line.items);
        prev.y = Math.min(prev.y, line.y);
        prev.labels += labels;
        continue;
      }
      merged.push({ y: line.y, items: line.items.slice(), hasIsin, labels });
    }
    for (const line of merged) {
      if (line.hasIsin || line.labels < 2) continue;
      const cols = line.items.filter((i) => /[A-Za-z\u0900-\u097F]/.test(i.str))
        .sort((a, b) => a.x - b.x);
      const holdings = cols.some((c) => ISIN_LABEL.test(c.str))
        && cols.some((c) => VALUE_LABEL.test(c.str))
        && cols.some((c) => QUANTITY_LABEL.test(c.str));
      const kind = !holdings ? ""
        : cols.some((c) => /^folio/i.test(c.str)) ? "mf"
          : cols.some((c) => /^maturity/i.test(c.str) || /^coupon/i.test(c.str)) ? "bond"
            : "equity";
      tables.push({ page, y: line.y, cols, holdings, kind });
    }
  }
  return tables;
}

/** Read every ISIN that sits under a holdings header. */
function readTables(items, tables, headers = []) {
  const headerFor = (anchor) => tables
    .filter((t) => t.page === anchor.page && t.y > anchor.y)
    .sort((a, b) => a.y - b.y)[0]
    || tables.filter((t) => t.page < anchor.page)
      .sort((a, b) => b.page - a.page || b.y - a.y)[0]
    || null;

  const groups = new Map();
  for (const anchor of items.filter((i) => isIsin(i.str))) {
    const table = headerFor(anchor);
    if (!table || !table.holdings) continue;
    const key = `${table.page}:${Math.round(table.y)}`;
    if (!groups.has(key)) groups.set(key, { table, rows: [] });
    groups.get(key).rows.push(anchor);
  }

  const out = [];
  for (const { table, rows } of groups.values()) {
    rows.sort((a, b) => b.y - a.y);
    const isinCol = table.cols.find((c) => ISIN_LABEL.test(c.str));
    const owner = accountFor(table, headers);
    const colAt = (right) => {
      let best = null;
      for (const col of table.cols) if (col.x <= right + 1) best = col;
      return best;
    };
    rows.forEach((anchor, index) => {
      // A row is the band down to the next ISIN in the same table. One holding
      // can print across three lines (scheme name, then units and NAV).
      const high = index === 0 ? table.y + 4 : (rows[index - 1].y + anchor.y) / 2;
      const low = index === rows.length - 1 ? anchor.y - 42 : (anchor.y + rows[index + 1].y) / 2;
      const band = items.filter((i) => i.page === anchor.page && i.y <= high && i.y > low
        && i !== anchor && i.x > 20);
      const cells = band.filter((i) => NUMBER.test(i.str));
      const perColumn = new Map();
      for (const cell of cells) {
        const col = colAt(cell.right);
        // A BO ID line has a 16-digit number under the ISIN column; it is an
        // account, not an amount, and must never become a value.
        if (!col || col === isinCol) continue;
        const prev = perColumn.get(col);
        if (!prev || cell.right > prev.right) perColumn.set(col, cell);
      }
      const find = (re) => {
        for (const [col, cell] of perColumn) if (re.test(col.str)) return cell;
        return null;
      };
      const qtyCell = find(QUANTITY_LABEL);
      // A folio table prints "Current" for the value and "Bal" for the units,
      // beside a profit column. Two of those columns can share a heading in the
      // bilingual header, so a fund's value is settled by the identity the
      // statement itself uses: units x NAV is the value it prints. Whichever
      // cell satisfies that is the value, whatever the heading says.
      const fundCell = table.kind === "mf" ? fundValue(cells) : null;
      const valueCell = find(VALUE_LABEL)
        || fundCell
        || [...perColumn.values()].sort((a, b) => b.right - a.right)[0]
        || null;
      if (!valueCell && !qtyCell) return;
      // A date is text, not a number, so it is not in the column map.
      const maturityCol = table.cols.find((c) => /maturity/i.test(c.str));
      const dateCell = band.find((i) => isoAny(i.str)
        && (!maturityCol || Math.abs(i.x - maturityCol.x) < 120))
        || band.find((i) => isoAny(i.str)) || null;
      const couponCell = find(/^coupon/i);
      const faceCell = find(/face\s*value/i);
      const isin = anchor.str.toUpperCase();
      out.push({
        isin,
        label: "",
        kind: table.kind,
        account: owner?.boId || "",
        dpName: owner?.dpName || "",
        quantity: qtyCell ? quantity(qtyCell.str) : null,
        faceValuePaise: faceCell ? rupees(faceCell.str) : null,
        pricePaise: null,
        valuePaise: valueCell ? rupees(valueCell.str) : null,
        maturity: dateCell ? isoAny(dateCell.str) : "",
        couponPct: couponCell ? Number(couponCell.str.replace(/,/g, "")) : null,
      });
    });
  }
  return out;
}

/**
 * The older rule: every holding is a band of items around one ISIN, between its
 * neighbours. Kept for statements whose tables carry no usable header.
 */
function readBands(items) {
  const ordered = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const isins = ordered.filter((i) => isIsin(i.str));
  // The numeric columns of this document, learned from where its numbers sit.
  // A CAS is a fixed template, so one pass is enough to place every cell.
  const numericItems = items.filter((i) => NUMBER.test(i.str));
  const columnXs = [];
  for (const item of numericItems.slice().sort((a, b) => a.x - b.x)) {
    const near = columnXs.find((x) => Math.abs(x - item.x) <= 18);
    if (near === undefined) columnXs.push(item.x);
  }
  columnXs.sort((a, b) => a - b);
  const nearestColumn = (xs, x) => {
    let best = 0;
    for (let i = 0; i < xs.length; i++) {
      if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    }
    return best;
  };
  if (!isins.length) return { holdings: [], warnings: [], quarantined: 0 };

  // Band boundaries sit halfway between neighbouring ISINs, so a field printed
  // a line above or below its ISIN still lands in the right holding. The band is
  // per page: every page reuses the same y coordinates, and a band that ignores
  // the page pulls another page's numbers into the row.
  const byPage = new Map();
  for (const anchor of isins) {
    if (!byPage.has(anchor.page)) byPage.set(anchor.page, []);
    byPage.get(anchor.page).push(anchor);
  }
  const holdings = [];
  const warnings = [];
  let quarantined = 0;

  for (const pageAnchors of byPage.values()) {
    pageAnchors.sort((a, b) => b.y - a.y);
    const ys = pageAnchors.map((i) => i.y);
    pageAnchors.forEach((anchor, index) => {
      const high = index === 0 ? ys[0] + (ys[0] - ys[1] || 40) / 2 : (ys[index - 1] + ys[index]) / 2;
      const low = index === pageAnchors.length - 1
        ? ys[index] - (ys[index - 1] - ys[index] || 40) / 2
        : (ys[index] + ys[index + 1]) / 2;
      const band = ordered.filter((i) => i.page === anchor.page && i.y <= high && i.y > low);
      const isin = anchor.str.toUpperCase().replace(/\s+/g, "");
      const numbers = band.filter((i) => NUMBER.test(i.str))
        .sort((a, b) => a.x - b.x);
      const date = band.find((i) => DATE.test(i.str));
      const name = band.filter((i) => /[A-Za-z]{3}/.test(i.str)
        && !isIsin(i.str) && !DATE.test(i.str))
        .sort((a, b) => b.str.length - a.str.length)[0];

      // Numbers belong to the document's columns, not to the row. A cell that wraps
      // into two text items ("1,00,752." + "60") would otherwise shift every field
      // to its left, which is how 21 of 50 rows read with no value at all.
      const perColumn = new Map();
      for (const n of numbers) {
        const key = nearestColumn(columnXs, n.x);
        if (!perColumn.has(key)) perColumn.set(key, n);
      }
      const cells = [...perColumn.values()].sort((a, b) => a.x - b.x);
      if (cells.length < 2) {
        quarantined += 1;
        warnings.push({ code: "short_row", count: 1, isin: "redacted" });
        return;
      }
      // The coupon sits left of the maturity date; the four fields sit right of it.
      // Leaving the coupon in the tail made a 10.32% bond read as 10.32 units.
      const couponCell = date
        ? cells.filter((i) => i.x < date.x).slice(-1)[0] : null;
      const fields = couponCell ? cells.filter((i) => i !== couponCell) : cells;
      const tail = fields.slice(-4).map((i) => i.str);
      const quantityText = tail[0];
      const faceText = tail.length >= 4 ? tail[1] : "";
      const priceText = tail.length >= 2 ? tail[tail.length - 2] : "";
      const valueText = tail[tail.length - 1];
      // The row's own shape decides the class. A printed maturity date means a
      // bond; a fund ISIN starts with INF; anything else is a share. Headings are
      // bilingual and split across cells, and trusting them filed all seventeen
      // holdings in a real statement as funds.
      const kind = date ? "bond" : isin.startsWith("INF") ? "mf" : "equity";
      holdings.push({
        isin,
        label: name ? tidy(name.str) : "",
        kind,
        quantity: quantity(quantityText),
        faceValuePaise: faceText ? rupees(faceText) : null,
        pricePaise: priceText ? rupees(priceText) : null,
        valuePaise: rupees(valueText),
        maturity: date ? isoDate(date.str) : "",
        couponPct: couponCell ? Number(couponCell.str.replace(/,/g, "")) : null,
      });
    });
  }
  return { holdings, warnings, quarantined };
}

/**
 * The demat accounts a CAS prints. One consolidated statement covers every
 * account held for the PAN, so a CDSL file can carry a Zerodha account and a
 * Motilal Oswal account side by side; reading them as one put the bonds in the
 * broker that only held the shares.
 * @param {Array<object>} items
 * @returns {Array<{page: number, y: number, boId: string, dpName: string}>}
 */
function accountHeaders(items) {
  const out = [];
  for (const page of new Set(items.map((i) => i.page))) {
    const lines = [];
    for (const item of items.filter((i) => i.page === page).sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - item.y) <= 3) last.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    }
    for (const line of lines) {
      line.text = line.items.slice().sort((a, b) => a.x - b.x).map((i) => i.str).join(" ");
    }
    lines.forEach((line, index) => {
      if (!/DP\s*(?:ID|Id|Name)|Client\s*Id|BO\s*ID/i.test(line.text)) return;
      // The DP ID and Client ID can print on the next line, so a small window is
      // read as well; the BO ID itself is always on the line that names it.
      const near = [line.text, ...lines.slice(Math.max(0, index - 3), index)
        .concat(lines.slice(index + 1, index + 4)).map((l) => l.text)].join(" ");
      const packed = near.replace(/\s+/g, "");
      const own = line.text.replace(/\s+/g, "");
      const direct = own.match(/IN\d{14}|\d{16}/) || packed.match(/IN\d{14}|\d{16}/);
      const dp = packed.match(/DP(?:ID|Id):?([A-Z]{0,2}\d{6,8})/i);
      const client = packed.match(/Client(?:ID|Id):?(\d{6,8})/i);
      let raw = /BO\s*ID/i.test(line.text) && direct ? direct[0] : "";
      if (!raw && dp && client) raw = `${dp[1]}${client[1]}`;
      const id = raw ? boId(raw) : null;
      if (!id || id.kind !== "bo") return;
      if (out.some((h) => h.boId === id.boId && h.page === page && Math.abs(h.y - line.y) < 3)) return;
      const names = line.text.match(/[A-Z][A-Za-z&.,()'-]*(?:\s+[A-Z][A-Za-z&.,()'-]*){1,6}\s+(?:LIMITED|LTD)/g) || [];
      out.push({ page, y: line.y, boId: id.boId,
        dpName: names.sort((a, b) => b.length - a.length)[0] || "" });
    });
  }
  return out;
}

/** The account named nearest above a table: later page first, then smallest y. */
function accountFor(table, headers) {
  let best = null;
  for (const h of headers) {
    if (h.page > table.page) continue;
    if (h.page === table.page && h.y <= table.y) continue;
    if (!best || h.page > best.page || (h.page === best.page && h.y < best.y)) best = h;
  }
  return best;
}

/**
 * Read a CAS. Holdings tables are read by their own columns; a statement with no
 * usable header falls back to the band rule.
 * @param {{pages: Array<{items: Array<{str: string, x: number, y: number,
 *   width?: number}>}>}} pdf
 * @returns {{depository: string, holdings: Array<object>, sections: object,
 *   warnings: Array<object>, counts: object}}
 */
export function parseCas(pdf) {
  const items = itemsOf(pdf);
  const text = items.map((i) => i.str).join(" ");
  const depository = /central depository/i.test(text) ? "CDSL"
    : /national securities depository/i.test(text) ? "NSDL" : "";
  // A statement prints the account across cells as often as in one run, so the
  // spaces come out before the number is looked for. Without this an NSDL CAS
  // reads as "no account number", which is the wrong answer for a file that
  // names its account on page one.
  const packed = text.replace(/\s+/g, "");
  const bo = (packed.match(/IN\d{14}/g) || [])
    .concat(packed.match(/\d{16}/g) || [])
    .map((raw) => boId(raw))
    .find((id) => id.kind === "bo") || null;

  const tables = detectTables(items);
  const headers = accountHeaders(items);
  let result = tables.some((t) => t.holdings)
    ? { holdings: readTables(items, tables, headers), warnings: [], quarantined: 0 }
    : { holdings: [], warnings: [], quarantined: 0 };
  if (!result.holdings.length) result = readBands(items);

  // The same ISIN can appear in a transaction table and again in the holdings
  // table, and a page break can repeat a row. One holding, one entry.
  const byIsin = new Map();
  for (const holding of result.holdings) {
    const prev = byIsin.get(holding.isin);
    if (!prev || (holding.valuePaise || 0) > (prev.valuePaise || 0)) {
      byIsin.set(holding.isin, holding);
    }
  }
  const holdings = [...byIsin.values()];
  // One statement can hold several demat accounts; each keeps its own.
  const byAccount = new Map();
  for (const holding of holdings) {
    const id = holding.account || "";
    if (!id) continue;
    if (!byAccount.has(id)) {
      byAccount.set(id, { boId: id, depository, dpName: holding.dpName || "",
        holdings: [] });
    }
    byAccount.get(id).holdings.push(holding);
  }
  const accounts = [...byAccount.values()];
  const sections = {};
  for (const h of holdings) sections[h.kind] = (sections[h.kind] || 0) + 1;
  return {
    depository,
    demat: accounts[0]?.boId || (bo ? bo.boId : ""),
    asOf: asOfDate(text),
    holdings,
    accounts,
    sections,
    warnings: result.warnings,
    counts: { rows: holdings.length, quarantined: result.quarantined },
  };
}

/**
 * Where each holding belongs. A CAS covers one demat but several classes, and
 * this app keeps bonds and equities in separate accounts, so one target would
 * either overwrite a class or force the person to import the same file twice.
 * @param {{holdings: Array<object>, demat?: string}} parsed
 * @param {Array<{id: string, label?: string, category?: string, number?: string}>} assets
 * @returns {{demat: string, accounts: Array<object>, groups: Array<object>,
 *   homeless: Array<object>}}
 */
export function casRoute(parsed, assets = []) {
  const list = parsed?.accounts?.length
    ? parsed.accounts
    : [{ boId: parsed?.demat || "", dpName: "", holdings: parsed?.holdings || [] }];
  const groups = new Map();
  const homeless = new Map();
  const homes = [];
  for (const account of list) {
    const id = boId(account.boId || "");
    const key = id.kind === "bo" ? id.boId : "";
    const asset = key
      ? (assets || []).find((a) => String(a.category || "") === "demat"
        && !/mutual\s*fund|^mf$/i.test(String(a.subtype || ""))
        && boId(a.number).boId === key) || null
      : null;
    if (key) {
      homes.push({ boId: key, dpName: account.dpName || "", assetId: asset?.id || "",
        assetLabel: asset?.label || "", count: account.holdings.length });
    }
    for (const holding of account.holdings) {
      const bucket = asset ? groups : homeless;
      const bucketKey = asset ? `${holding.kind}|${asset.id}` : `${holding.kind}|${key || "folio"}`;
      if (!bucket.has(bucketKey)) {
        bucket.set(bucketKey, { kind: holding.kind, assetId: asset?.id || "",
          assetLabel: asset?.label || "", boId: key, dpName: account.dpName || "",
          count: 0, valuePaise: 0 });
      }
      const row = bucket.get(bucketKey);
      row.count += 1;
      row.valuePaise += Number(holding.valuePaise) || 0;
    }
  }
  return {
    demat: homes[0]?.boId || "",
    accounts: homes,
    groups: [...groups.values()],
    homeless: [...homeless.values()],
  };
}

/**
 * A CAS is only worth writing when it agrees with itself: the sum of the rows
 * must equal the total the statement prints. The caller passes both, and a
 * mismatch is a refusal, not an exception to review.
 * @param {{holdings: Array<object>}} parsed
 * @param {number|null} statedTotalPaise
 * @returns {{ok: boolean, sumPaise: number, statedTotalPaise: number|null, diffPaise: number|null}}
 */
export function casTotals(parsed, statedTotalPaise) {
  const sumPaise = (parsed?.holdings || [])
    .reduce((t, h) => t + (Number(h.valuePaise) || 0), 0);
  if (statedTotalPaise === null || statedTotalPaise === undefined) {
    return { ok: true, sumPaise, statedTotalPaise: null, diffPaise: null };
  }
  const diffPaise = sumPaise - Number(statedTotalPaise);
  return { ok: diffPaise === 0, sumPaise, statedTotalPaise: Number(statedTotalPaise),
    diffPaise };
}
