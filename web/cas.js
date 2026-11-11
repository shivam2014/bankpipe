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
const LABEL = /isin|security|scheme|company|folio|arn|distributor|value|valuation|quantity|current|frozen|pledge|balance|op\.?\s*bal|cl\.?\s*bal|transaction|description|date|amount|nav|price|maturity|coupon|face|profit|loss|stamp|credit|debit|units|cost|invest/i;

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// A fund scheme name shares its band with the expense-ratio paragraph in some
// statements, and a PDF line break can duplicate "Fund" or leave a stray ")".
// Keep the name; drop the boilerplate.
export function cleanFundLabel(value) {
  let s = String(value ?? "");
  s = s.split(/\bGrand Total\b|\bTotal Expense Ratio\b|\bAnnuali[sz]ed\b|\bExpense Ratio\b/i)[0];
  s = s.replace(/\bFund\s+Fund\b/gi, "Fund");
  s = s.replace(/\(formerly.*$/i, " ");
  s = s.replace(/\s*\)\s*[-–]\s*/g, " - ");
  s = s.replace(/\s*\)\s*$/g, "");
  s = s.replace(/\s*[-–]\s*$/g, "");
  return tidy(s);
}

// The first word of a scheme is the fund house only by luck ("Mirae",
// "Aditya"). The AMC name is the prefix before the first scheme word:
// "Mirae Asset | Large and Midcap Fund" names Mirae Asset Mutual Fund.
const SCHEME_WORD = /\b(Large|Mid|Small|Multi|Flexi|ELSS|Liquid|Cash|Overnight|Money|Ultra|Short|Long|Gilt|Credit|Corporate|Banking|Infrastructure|Tax|Savings|Dynamic|Balanced|Hybrid|Index|Equity|Debt|Value|Growth|Dividend|Monthly|Income|Arbitrage|Bluechip|Emerging|Focused|Contra|Children|Retirement|Conservative|Aggressive|Frontline)\b/i;
export function fundHouseFromLabel(value) {
  const text = String(value || "").replace(/\(formerly[^)]*\)/gi, " ")
    .replace(/\s+/g, " ").trim();
  const hit = text.match(SCHEME_WORD);
  let prefix = hit ? text.slice(0, hit.index) : text;
  prefix = prefix.replace(/[-–]\s*$/, "").replace(/\s+/g, " ").trim();
  if (!prefix) return "";
  return /mutual fund$/i.test(prefix) ? prefix : `${prefix} Mutual Fund`;
}
export function fullAmcName(value) {
  const s = tidy(value);
  if (!s) return "";
  return /mutual$/i.test(s) ? `${s} Fund` : s;
}
export function shortAmcName(value) {
  return tidy(String(value || "").replace(/\s+mutual(?:\s+fund)?\s*$/i, ""));
}

// The AMC line sits above a CDSL folio table. NSDL prints it in the holder
// details beside the folio number instead, so both are read.
function amcFor(table, items) {
  const hit = items.filter((i) => i.page === table.page && i.y > table.y
    && /^AMC\s*Name\s*:/i.test(i.str))
    .sort((a, b) => a.y - b.y)[0];
  return hit ? tidy(String(hit.str).replace(/^AMC\s*Name\s*:\s*/i, "")) : "";
}
function amcByFolio(items) {
  const out = new Map();
  const folios = items.filter((i) => /^\d{6,}(?:\/\d+)?$/.test(i.str));
  for (const amc of items) {
    if (!/mutual(?:\s+fund)?\s*$/i.test(amc.str || "") || String(amc.str).length > 60) continue;
    const near = folios.filter((f) => f.page === amc.page && Math.abs(f.y - amc.y) < 40)
      .sort((a, b) => Math.abs(a.y - amc.y) - Math.abs(b.y - amc.y))[0];
    if (near) out.set(near.str, tidy(amc.str));
  }
  return out;
}

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
function fundParts(cells) {
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
      // A factor of exactly 1 turns any number into its own product; that is the
      // stray "1" trap, not a real units x NAV relation.
      if (!(u > 0) || Math.abs(u - 1) < 1e-9) continue;
      for (const nav of cells) {
        if (nav === units) continue;
        const n = amount(nav);
        if (!(n > 0) || Math.abs(n - 1) < 1e-9) continue;
        if (Math.abs(u * n - target) <= Math.max(1, target * 0.005)) {
          return { value: candidate, units, nav };
        }
      }
    }
  }
  return null;
}

// The invested amount is the nearest money to the left of the value, skipping
// the units and NAV that produced the value. That pair is known from the
// units x NAV identity; a column heading ("Total Cost", "Cumulative Amount
// Invested") is split across items and cannot be trusted as a key.
function fundCostCell(cells, valueCell, parts) {
  if (!valueCell) return null;
  const skip = new Set([parts?.units, parts?.nav].filter(Boolean));
  return cells.filter((c) => c !== valueCell && !skip.has(c)
    && c.right < valueCell.right - 0.5)
    .sort((a, b) => b.right - a.right)[0] || null;
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
  const amcMap = amcByFolio(items);
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
      // can print across three lines (scheme name, then units and NAV). The
      // header itself is excluded, or its labels are read as the scheme name.
      // The header block can print across several lines; the first row starts
      // below the lowest of them, or the labels are read as the row's values.
      const headerBottom = table.cols.length
        ? Math.min(...table.cols.map((c) => c.y)) : table.y - 1;
      const high = index === 0 ? headerBottom - 1 : (rows[index - 1].y + anchor.y) / 2;
      // A table ends with a Sub Total line. The last row must stop above it, or
      // the total is read as that row's value.
      const totalLine = items.filter((i) => i.page === anchor.page && i.y < anchor.y
        && i.y > anchor.y - 90 && /^(sub\s*total|total)$/i.test(i.str))
        .sort((a, b) => b.y - a.y)[0];
      const low = index === rows.length - 1
        ? (totalLine ? totalLine.y + 2 : anchor.y - 42)
        : (anchor.y + rows[index + 1].y) / 2;
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
        // The header is bilingual: a Hindi fragment sits next to the English
        // label and takes the cell. Fall back to the span between this label and
        // the next real column, which is where the number actually prints.
        const label = table.cols.find((c) => re.test(c.str));
        if (!label) return null;
        const ROLE = /^isin|value|invested|total\s*cost|cost\s*per|nav|^no\.\s*of|^quantity$|^current$|^bal$|maturity|coupon|face\s*value|market\s*price|^folio|profit/i;
        const next = table.cols.filter((c) => c.x > label.x + 1 && ROLE.test(c.str))
          .sort((a, b) => a.x - b.x)[0];
        const limit = next ? next.x : Infinity;
        return cells.filter((c) => c.right >= label.x - 2 && c.right < limit)
          .sort((a, b) => b.right - a.right)[0] || null;
      };
      const qtyCell = find(QUANTITY_LABEL);
      // A folio table prints "Current" for the value and "Bal" for the units,
      // beside a profit column. Two of those columns can share a heading in the
      // bilingual header, so a fund's value is settled by the identity the
      // statement itself uses: units x NAV is the value it prints. Whichever
      // cell satisfies that is the value, whatever the heading says.
      const fund = table.kind === "mf" ? fundParts(cells) : null;
      // Funds: the cell that satisfies units x NAV. Bonds and equities: the last
      // money column is the value, whatever the header calls it, which survives a
      // renamed or inserted column better than matching a label.
      const valueCell = table.kind === "mf"
        ? (fund?.value
          || find(VALUE_LABEL)
          || [...perColumn.values()].sort((a, b) => b.right - a.right)[0]
          || null)
        : [...perColumn.values()].sort((a, b) => b.right - a.right)[0] || null;
      if (!valueCell && !qtyCell) return;
      // A date is text, not a number, so it is not in the column map.
      const maturityCol = table.cols.find((c) => /maturity/i.test(c.str));
      const dateCell = band.find((i) => isoAny(i.str)
        && (!maturityCol || Math.abs(i.x - maturityCol.x) < 120))
        || band.find((i) => isoAny(i.str)) || null;
      const couponCell = find(/^coupon/i);
      const couponCol = table.cols.find((c) => /^coupon/i.test(c.str));
      const qtyCol = table.cols.find((c) => QUANTITY_LABEL.test(c.str));
      const faceCell = find(/face\s*value/i);
      // A folio prints its number and what was invested in it, beside the
      // valuation. The number is text, and the cost is the "Invested" cell.
      const folioCol = table.kind === "mf"
        ? table.cols.find((c) => /^folio/i.test(c.str)) : null;
      const folioCell = folioCol
        ? band.filter((i) => colAt(i.right) === folioCol)
          .sort((a, b) => b.str.length - a.str.length)[0] || null
        : null;
      const costCell = table.kind === "mf"
        ? fundCostCell(cells, valueCell, fund) : null;
      // The scheme name is every text line in the band; "CFGP - Mirae Asset
      // Liquid Fund" names Mirae, whatever column the statement puts it in.
      const nameCells = table.kind === "mf"
        ? band.filter((i) => /[A-Za-z]{2}/.test(i.str) && !NUMBER.test(i.str)
          && !i.str.startsWith("(")
          && !/^(value|units?|unit in|in|of|total|cost|invested|nav|scheme|name|folio|arn|balance|distributors?|profit|loss|current|regular|direct|amount|terms)\b/i.test(i.str))
          .sort((a, b) => b.y - a.y || a.x - b.x)
        : [];
      // A bond or share row prints its name in the column just right of the
      // ISIN, before the coupon/quantity columns. Funds keep their scheme-name
      // rule; everything else was leaving the label empty and showing an ISIN.
      const nameLimit = couponCol?.x || qtyCol?.x || Infinity;
      const rawName = tidy(band.filter((i) =>
        /[A-Za-z]{2}/.test(i.str) && !NUMBER.test(i.str) && !DATE.test(i.str)
        && !isoAny(i.str) && !isIsin(i.str)
        && i.x > (isinCol?.x || 0) + 2 && i.x < nameLimit
        && !/^(value|units?|unit in|in|of|total|cost|invested|nav|scheme|name|folio|arn|balance|distributors?|profit|loss|current|regular|direct|amount|terms|quantity|face|market|coupon|maturity)\b/i.test(i.str)
        && !/fixed interest|corporate bonds|equity shares|debentures?|tax free|government securities|treasury/i.test(i.str)
        && !/^(quarterly|monthly|annual|annually|half[- ]yearly|twelve times|four times|two times|once a year|twice a year|year|times)\b/i.test(i.str))
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((i) => i.str).join(" "));
      const rawNameClean = tidy(rawName.replace(/\s*#.*$/, ""));
      const name = table.kind === "bond"
        ? tidy(rawNameClean
          .replace(/\b\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}\b/g, " ")
          .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, " ")
          .replace(/\b\d{6,8}\b/g, " ")
          .replace(/\b(?:19|20)\d{2}\b/g, " ")
          .replace(/\b\d{1,2}(?:\.\d+)?%?\b/g, " ")
          .replace(/[\s\-–]+$/g, ""))
        : rawNameClean;
      const label = table.kind === "mf"
        ? cleanFundLabel(tidy(nameCells.map((i) => i.str).join(" ")))
        : name;
      const couponText = couponCell ? String(couponCell.str).replace(/,/g, "").trim() : "";
      const couponNumber = Number(couponText);
      const nameCoupon = Number((rawNameClean.match(/\b\d{1,2}\.\d+\b/) || [])[0]);
      const couponPct = Number.isFinite(couponNumber) && couponNumber > 0 && couponNumber < 100
        ? couponNumber
        : (Number.isFinite(nameCoupon) && nameCoupon > 0 ? nameCoupon : null);
      const freqText = band.map((i) => i.str).join(" ");
      const frequency = table.kind !== "bond" ? ""
        : /quarterly|four times a year|4 times/i.test(freqText) ? "Quarterly"
          : /monthly|twelve times a year|12 times/i.test(freqText) ? "Monthly"
            : /half[- ]yearly|twice a year|two times/i.test(freqText) ? "Half-yearly"
              : /annual|annually|once a year|yearly/i.test(freqText) ? "Annual" : "";
      const folio = folioCell ? tidy(folioCell.str) : "";
      const fullAmc = table.kind === "mf"
        ? fullAmcName(amcFor(table, items) || amcMap.get(folio) || fundHouseFromLabel(label))
        : "";
      const amc = table.kind === "mf"
        ? (fullAmc ? shortAmcName(fullAmc)
          : (label.match(/[A-Za-z]{3,}/g) || []).find((w) =>
            !/^(cfgp|fund|plan|direct|regular|growth|scheme|name|asset|equity|liquid|cash|formerly|the|and)$/i.test(w)) || "")
        : "";
      const isin = anchor.str.toUpperCase();
      out.push({
        isin,
        label,
        kind: table.kind,
        account: owner?.boId || "",
        dpName: owner?.dpName || "",
        folio,
        amc,
        amcFull: fullAmc,
        quantity: qtyCell ? quantity(qtyCell.str) : null,
        faceValuePaise: faceCell ? rupees(faceCell.str) : null,
        pricePaise: null,
        costPaise: costCell ? rupees(costCell.str) : null,
        valuePaise: valueCell ? rupees(valueCell.str) : null,
        maturity: dateCell ? isoAny(dateCell.str) : "",
        couponPct,
        frequency,
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
      const names = near.match(/[A-Z][A-Za-z&.,()'-]*(?:\s+[A-Z][A-Za-z&.,()'-]*){1,6}\s+(?:LIMITED|LTD)/g) || [];
      const rawName = names.sort((a, b) => b.length - a.length)[0] || "";
      // The DP name can repeat across two adjacent summary lines; keep one copy.
      const dpName = rawName.replace(/^(.+?)\s+\1$/, "$1");
      out.push({ page, y: line.y, boId: id.boId, dpName });
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

// The account holder a statement names. It is printed above the summary table,
// in the same block as the PAN, and it is the one field the file can default for
// the person importing.
function holderName(items) {
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b).slice(0, 6);
  let best = null;
  for (const page of pages) {
    for (const line of linesOf(items.filter((i) => i.page === page), 3)) {
      const text = line.items.map((i) => i.str).join(" ");
      if (!/\bPAN\b/i.test(text)) continue;
      const before = text.split(/\bPAN\b/i)[0]
        .replace(/DP\s*(?:ID|Name)\s*:?\s*\S+/gi, " ")
        .replace(/Client\s*ID\s*:?\s*\S+/gi, " ")
        .replace(/BO\s*ID\s*:?\s*\S+/gi, " ")
        .replace(/[()[\]{}:]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const words = before.match(/[A-Z][A-Za-z]+/g) || [];
      if (words.length < 2 || words.length > 3) continue;
      // A name is two or three capitalised words. "LIMITED", "Demat Account" and
      // the depository names are labels that happen to look like names.
      if (words.some((w) => /^(Limited|Ltd|Bank|Demat|Account|Portfolio|Cdsl|Nsdl|India|Services|Client|Name)$/i.test(w))) continue;
      const accountBlock = /DP\s*(?:ID|Name)|BO\s*ID|Client\s*ID/i.test(text);
      const score = (accountBlock ? 2 : 0) + (words.length === 2 ? 1 : 0);
      if (!best || score > best.score) best = { name: words.join(" "), score };
    }
  }
  return best ? best.name : "";
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
    holder: holderName(items),
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
  // A folio is identified by its AMC and folio number, never by a BO ID. Its
  // account is the one named after the AMC.
  const folioHome = (holding) => {
    const amc = String(holding.amc || "").toLowerCase();
    if (!amc) return null;
    return (assets || []).find((a) => /mutual\s*fund|^mf$/i.test(String(a.subtype || ""))
      && String(a.label || "").toLowerCase().includes(amc)) || null;
  };
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
      // Route a folio only when the row is complete enough to stand alone: a
      // folio number and units. An NSDL row whose units did not parse stays in
      // the demat, where its value still sums to the account's total, instead of
      // being written into a folio account with a value picked from the wrong cell.
      const isFolio = holding.kind === "mf" && !!holding.folio
        && Number(holding.quantity) > 0;
      const target = isFolio ? folioHome(holding) : asset;
      const bucket = target ? groups : homeless;
      const bucketKey = target
        ? `${holding.kind}|${target.id}`
        : (isFolio ? `mf|folio:${holding.amc || "unknown"}` : `${holding.kind}|${key || "folio"}`);
      if (!bucket.has(bucketKey)) {
        bucket.set(bucketKey, { kind: holding.kind, assetId: target?.id || "",
          assetLabel: target?.label || "", boId: isFolio ? "" : key,
          amc: isFolio ? holding.amc || "" : "", folio: isFolio,
          amcFull: isFolio ? holding.amcFull || "" : "",
          folioNo: isFolio ? String(holding.folio || "") : "",
          dpName: account.dpName || "", count: 0, valuePaise: 0 });
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
