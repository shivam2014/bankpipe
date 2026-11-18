// Motilal Oswal's Portfolio Holding Summary PDF. It is one report for the whole
// demat: BONDS, DIRECT EQUITY and MUTUAL FUND sections can all be present. The
// market price and market value columns are printed at par for bonds, so this
// parser returns them but the app never writes them: the CAS owns quantity and
// value. Cost, purchase date, coupon, frequency, maturity and face are the
// broker's facts.
//
// pdf.js gives text items with x/y geometry. Motilal wraps a row over several
// baselines (a long instrument name, a split date), so the parser finds the
// ISIN column, treats each ISIN as a row anchor, and collects every item in the
// band between two anchors. Header cells are stitched by x overlap, which keeps
// the parser working when a section prints a different set of columns.

import { parseDate as parseAnyDate, parseMoney, parseNumber } from "./holding-import.js";
import { tableWhere } from "./table-schema.js";
import { parseBondLabel, bondLabelName } from "./bonds.js";

const ISIN_RE = /^IN[A-Z0-9]{10}$/;
const ROW_GAP = 1.5;
const HEADER_ABOVE = 22;
const HEADER_BELOW = 14;

const SECTION_OF = {
  BONDS: "bond",
  "DIRECT EQUITY": "equity",
  "MUTUAL FUND": "mf",
};

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const compact = (v) => text(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
const plain = (v) => text(v).toUpperCase().replace(/\s+/g, " ");

function itemsOf(pages) {
  const out = [];
  (Array.isArray(pages) ? pages : []).forEach((page, pageIndex) => {
    for (const item of page?.items || []) {
      if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
      out.push({
        str: item.str,
        x: Number(item.x) || 0,
        y: Number(item.y) || 0,
        width: Number(item.width) || 0,
        page: pageIndex,
      });
    }
  });
  return out;
}

// Lines are only used for headings, the report date and the Total row. Rows
// themselves are read from the raw items, because a wrapped cell would split.
function buildLines(items) {
  const groups = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let group = groups.find((g) => g.page === item.page
      && Math.abs(g.y - item.y) <= ROW_GAP);
    if (!group) {
      group = { y: item.y, page: item.page, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.map((group) => {
    const line = group.items.sort((a, b) => a.x - b.x);
    return {
      y: group.y,
      page: group.page,
      text: line.map((item) => item.str.trim()).join(" ").replace(/\s+/g, " ").trim(),
      items: line,
    };
  }).sort((a, b) => a.page - b.page || b.y - a.y);
}

function reportAsOf(items) {
  for (const line of buildLines(items)) {
    const on = line.text.match(/as\s+on\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
    if (on) {
      const date = parseAnyDate(on[1]);
      if (date) return date;
    }
    const to = line.text.match(/since\s+inception\s+to\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
    if (to) {
      const date = parseAnyDate(to[1]);
      if (date) return date;
    }
  }
  return "";
}

// The report names the client account with a UCID, not a BO ID. It is the one
// identity a broker-only import can attach; the demat number is not printed.
function reportClientUcid(items) {
  for (const line of buildLines(items)) {
    const match = line.text.match(/\bCLIENT\s+UCID\b\s*[:#-]?\s*([A-Z0-9]{4,})/i)
      || line.text.match(/\bUCID\b\s*(?:NO\.?)?\s*[:#-]?\s*([A-Z0-9]{4,})/i);
    if (match) return match[1].toUpperCase();
  }
  return "";
}

// Every spelling Motilal has printed for a column, in the order a role wins.
// Matching is a plain substring on the compacted label, so "Investment Amount",
// "Amount Invested" and "Investment" all reach cost. A new spelling is one
// entry here plus the test that reads it.
export const MOTILAL_COLUMNS = [
  { role: "isin", aliases: ["isin"] },
  { role: "name", aliases: ["instrument", "scheme", "security", "scrip", "description",
    "company", "symbol"] },
  { role: "face", aliases: ["principle", "principal", "facevalue", "faceamount"] },
  { role: "maturity", aliases: ["maturity"] },
  { role: "coupon", aliases: ["coupon", "interestrate", "ratepercent", "rate"] },
  { role: "frequency", aliases: ["frequency"] },
  { role: "purchaseDate", aliases: ["investmentdate", "purchasedate", "buydate",
    "dateofinvestment", "dateofpurchase", "dateofbuy", "dateinvestment", "datepurchase",
    "datebuy"] },
  { role: "last", aliases: ["lastprice"] },
  { role: "marketValue", aliases: ["marketvalue", "currentvalue"] },
  { role: "marketPrice", aliases: ["marketprice", "marketnav", "currentprice",
    "currentnav", "navprice", "nav"] },
  { role: "rating", aliases: ["rating"] },
  { role: "qty", aliases: ["qty", "quantity", "units", "holding", "balance"] },
  { role: "avgPrice", aliases: ["avg", "average", "buyprice", "purchaseprice",
    "purchasecost", "costprice"] },
  { role: "cost", aliases: ["investmentamount", "investedamount", "amountinvested",
    "investmentvalue", "costvalue", "costamount", "totalcost", "buyvalue", "buyamount",
    "buycost", "investment", "invested", "amount", "cost"] },
];

const ROLE_LABEL = {
  isin: "ISIN", name: "Instrument", face: "Principle", maturity: "Maturity",
  coupon: "Coupon", frequency: "Frequency", purchaseDate: "Investment Date",
  last: "Last Price", marketValue: "Market Value", marketPrice: "Market Price",
  rating: "Rating", qty: "Qty", avgPrice: "Avg Price", cost: "Investment Amount",
};

function roleFor(label) {
  const key = compact(label);
  if (!key) return "";
  for (const { role, aliases } of MOTILAL_COLUMNS) {
    if (aliases.some((alias) => key.includes(alias))) return role;
  }
  return "";
}

// A header label can wrap over several lines ("Investment" / "Amount"), and a
// wide label ("Avg Price Per Bond") can overlap the next column's token. Cells
// are grouped inside one header line by a real horizontal gap, then stitched
// across lines when their x ranges overlap. That is safer than a nearest-centre
// guess: "Qty" and "Avg Price" do not overlap, but "Market" and "Value" do.
function headerCells(items) {
  const lines = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= ROW_GAP);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  const cells = [];
  for (const line of lines) {
    let cell = null;
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      if (cell && item.x - cell.right <= 6) {
        cell.items.push(item);
        cell.right = Math.max(cell.right, item.x + item.width);
        continue;
      }
      cell = { y: line.y, items: [item], left: item.x, right: item.x + item.width };
      cells.push(cell);
    }
  }
  for (const cell of cells) {
    cell.text = cell.items.sort((a, b) => a.x - b.x)
      .map((item) => item.str.trim()).join(" ");
    cell.width = cell.right - cell.left;
  }
  return cells;
}

function overlaps(a, b) {
  const shared = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (shared <= 0) return false;
  return shared >= Math.min(a.width, b.width) * 0.5;
}

function headerColumns(items) {
  const columns = [];
  for (const cell of headerCells(items)) {
    let best = null;
    let bestShared = 0;
    for (const column of columns) {
      if (column.lines.has(cell.y)) continue;
      if (!overlaps(column, cell)) continue;
      const shared = Math.min(column.right, cell.right) - Math.max(column.left, cell.left);
      if (shared > bestShared) { best = column; bestShared = shared; }
    }
    if (!best) {
      columns.push({ ...cell, lines: new Set([cell.y]), cells: [cell] });
      continue;
    }
    best.cells.push(cell);
    best.lines.add(cell.y);
    best.left = Math.min(best.left, cell.left);
    best.right = Math.max(best.right, cell.right);
    best.width = best.right - best.left;
    best.text = best.cells.sort((a, b) => b.y - a.y || a.left - b.left)
      .map((part) => part.text).join(" ");
  }
  const seen = new Set();
  return columns.map((column) => {
    const role = roleFor(column.text);
    if (role && seen.has(role)) return { label: column.text, role: "", x: (column.left + column.right) / 2 };
    if (role) seen.add(role);
    return { label: column.text, role, x: (column.left + column.right) / 2 };
  }).sort((a, b) => a.x - b.x);
}

function cellText(items) {
  return items
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((item) => item.str.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*%\s*/g, "%")
    .trim();
}

function frequencyOf(value) {
  const key = compact(value);
  if (!key) return "";
  if (/month/.test(key)) return "monthly";
  if (/quarter/.test(key)) return "quarterly";
  if (/half|semi/.test(key)) return "half-yearly";
  if (/annual|year/.test(key)) return "yearly";
  return text(value).toLowerCase();
}

function numberIn(value) {
  const match = String(value || "").match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? parseNumber(match[0]) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labelDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${match[3]} ${month} ${match[1]}` : "";
}

// What the report can add to a holding already in the ledger. Cost and purchase
// date apply to bonds, equities and funds. The bond terms are the only place
// the app keeps the coupon and maturity, because the holdings row has no
// separate columns for them. Quantity and market value are never proposed.
export function motilalHoldingPatch(row, holding) {
  const patch = {};
  const cost = Number(row?.cost_paise);
  if (Number.isFinite(cost) && cost > 0
      && Math.abs(Number(holding?.cost_paise || 0) - cost) > 1) {
    patch.cost_paise = cost;
  }
  if (row?.purchase_date
      && row.purchase_date !== String(holding?.purchase_date || "")) {
    patch.purchase_date = row.purchase_date;
  }
  if (row?.section !== "bond") return patch;
  if (row.frequency && !String(holding?.frequency || "").trim()) {
    patch.frequency = row.frequency;
  }
  if (Number(row.face_paise) > 0 && !(Number(holding?.face_paise) > 0)) {
    // The report prints the face for the whole lot; the row stores the face per
    // unit and multiplies by the CAS quantity when it renders.
    const qty = Number(row.quantity) || Number(holding?.quantity) || 1;
    patch.face_paise = Math.round(Number(row.face_paise) / qty);
  }
  // The label is the only place the app keeps the coupon and the maturity. A
  // term the name carries is a guess; the report prints its own coupon and
  // maturity columns, so a stated term wins and the label is rebuilt around it.
  const current = String(holding?.label || "").trim();
  let label = current || String(row.label || "").trim();
  const parsed = parseBondLabel(label);
  const statedCoupon = Number(row.coupon_pct) > 0 ? Number(row.coupon_pct) : null;
  const statedMaturity = labelDate(row.maturity_date);
  const couponWins = statedCoupon !== null && statedCoupon !== parsed?.couponPct;
  const maturityWins = !!statedMaturity && statedMaturity !== labelDate(parsed?.maturity);
  if (couponWins || maturityWins) {
    const coupon = statedCoupon ?? parsed?.couponPct ?? null;
    const maturity = statedMaturity || labelDate(parsed?.maturity);
    label = [coupon === null ? "" : `${coupon}%`, bondLabelName(label), maturity]
      .filter(Boolean).join(" ").trim();
  } else {
    if (!parsed?.couponPct && statedCoupon !== null) {
      label = `${statedCoupon}% ${label}`.trim();
    }
    // A parsed coupon does not mean the label already has a date: dashed names
    // can carry NAME-<rate>%- only. Fill the maturity the report states whenever
    // the label does not already carry one.
    if (!parsed?.maturity && statedMaturity) label = `${label} ${statedMaturity}`.trim();
  }
  if (label && label !== current) patch.label = label;
  return patch;
}

function rowFromBand(band, columns, section, sourceRow) {
  const byRole = new Map();
  for (const item of band) {
    const center = item.x + item.width / 2;
    let best = null;
    let distance = Infinity;
    for (const column of columns) {
      const next = Math.abs(center - column.x);
      if (next < distance) { distance = next; best = column; }
    }
    if (!best) continue;
    if (!byRole.has(best.role)) byRole.set(best.role, []);
    byRole.get(best.role).push(item);
  }
  const value = (role) => (byRole.has(role) ? cellText(byRole.get(role)) : "");
  const isin = value("isin").toUpperCase();
  if (!ISIN_RE.test(isin)) return null;
  // Two numbers in one column is a geometry error, not a value. Joining them
  // would fuse "10" and "1,00,000" into 10100000, so the row is refused.
  for (const role of ["qty", "cost", "face"]) {
    const items = byRole.get(role) || [];
    const numbered = items.filter((item) => /\d/.test(item.str));
    if (numbered.length > 1) {
      return { problem: { column: ROLE_LABEL[role], row: sourceRow,
        value: cellText(items),
        reason: "holds more than one number, so the column is ambiguous" } };
    }
  }
  const label = value("name").replace(/\s*-\s*/g, "-");
  const rawCost = value("cost");
  const rawFace = value("face");
  const rawQty = value("qty");
  const cost = parseMoney(rawCost);
  const face = parseMoney(rawFace);
  const quantity = parseNumber(rawQty);
  // A cell that holds digits and still does not parse is a broken column, not
  // a blank. Saying which column and which row is better than a holding with a
  // missing quantity or cost.
  for (const [role, raw, parsed] of [["cost", rawCost, cost], ["face", rawFace, face],
    ["qty", rawQty, quantity]]) {
    if (parsed === null && /\d/.test(raw)) {
      return { problem: { column: ROLE_LABEL[role], row: sourceRow, value: raw,
        reason: "is not a number" } };
    }
  }
  if (cost === null && !label && quantity === null) return null;
  return {
    isin,
    section,
    label,
    quantity,
    purchase_date: parseAnyDate(value("purchaseDate")),
    cost_paise: cost,
    coupon_pct: numberIn(value("coupon")),
    frequency: frequencyOf(value("frequency")),
    maturity_date: parseAnyDate(value("maturity")),
    face_paise: face,
    market_price: numberIn(value("marketPrice")),
    market_value_paise: parseMoney(value("marketValue")),
    source_row: sourceRow,
  };
}

function parseSection(items, heading, bottom, { first = false } = {}) {
  const section = SECTION_OF[plain(heading.str)];
  if (!section) return { rows: [], problem: null };
  const after = items.filter((item) => item.page === heading.page
    && item.y < heading.y && item.y > bottom);
  const header = after
    .filter((item) => compact(item.str) === "isin")
    .sort((a, b) => b.y - a.y)[0];
  // A section with no table is legitimate: it may be empty, or say so. A
  // section that holds ISIN rows but no readable header is a changed layout,
  // and that is the case worth refusing.
  const hasRows = after.some((item) => ISIN_RE.test(plain(item.str)));
  const saysEmpty = after.some((item) =>
    /no\s+records?\s+found|no\s+holdings?|nothing\s+to\s+report/i.test(item.str));
  if (!header) {
    return { rows: [], problem: first && hasRows && !saysEmpty
      ? { column: "ISIN", row: null,
        reason: "no table header under the section heading names an ISIN column" }
      : null };
  }
  const headerItems = after.filter((item) => item.y <= header.y + HEADER_ABOVE
    && item.y >= header.y - HEADER_BELOW);
  const columns = headerColumns(headerItems);
  const headerBottom = Math.min(...headerItems.map((item) => item.y));
  const anchors = after
    .filter((item) => item.y < header.y - 10 && ISIN_RE.test(plain(item.str)))
    .sort((a, b) => b.y - a.y);
  if (!anchors.length) return { rows: [], problem: null };
  if (!columns.some((column) => column.role === "isin")) {
    return { rows: [], problem: { column: "ISIN", row: null,
      reason: "the table header does not name an ISIN column" } };
  }
  if (!columns.some((column) => column.role === "qty")
      && !columns.some((column) => column.role === "cost")) {
    return { rows: [], problem: { column: "Qty or Investment Amount", row: null,
      reason: "the table header names neither a quantity nor an investment amount column" } };
  }
  const total = buildLines(after)
    .filter((line) => /^total\b/i.test(line.text) && line.y < anchors[anchors.length - 1].y)
    .sort((a, b) => b.y - a.y)[0];
  const rows = [];
  for (const [index, anchor] of anchors.entries()) {
    const top = index === 0
      ? (headerBottom + anchor.y) / 2
      : (anchors[index - 1].y + anchor.y) / 2;
    const next = anchors[index + 1];
    const bottomY = next ? (anchor.y + next.y) / 2
      : (total ? (anchor.y + total.y) / 2 : anchor.y - 15);
    const band = after.filter((item) => item.y <= top && item.y > bottomY);
    const row = rowFromBand(band, columns, section, index + 1);
    if (row?.problem) return { rows: [], problem: row.problem };
    if (row) rows.push(row);
  }
  return { rows, problem: null };
}

// `pages` is the shape returned by extractPdf: [{ items: [{ str, x, y, width }] }].
export function parseMotilalPages(pages, source = {}) {
  const items = itemsOf(pages);
  if (!items.length) {
    return { rows: [], sections: [], asOf: "", clientUcid: "",
      error: "This PDF has no text layer, so the holdings cannot be read." };
  }
  const headings = [];
  for (const line of buildLines(items)) {
    const title = plain(line.text);
    if (!SECTION_OF[title]) continue;
    const first = line.items[0];
    headings.push({ ...first, page: first.page, y: line.y, title });
  }
  if (!headings.length) {
    return { rows: [], sections: [], asOf: "", clientUcid: reportClientUcid(items),
      error: "This is not a Motilal Oswal Portfolio Holding Summary. The report has no BONDS, DIRECT EQUITY or MUTUAL FUND section." };
  }
  // A heading owns the page from its own line down to the next heading on the
  // same page. Motilal repeats the heading and the table header on every page,
  // so a table that spills over is read page by page.
  const rows = [];
  const sections = [];
  const seen = new Set();
  for (const heading of headings) {
    const section = SECTION_OF[heading.title];
    if (!sections.includes(section)) sections.push(section);
    const later = headings
      .filter((other) => other.page === heading.page && other.y < heading.y)
      .sort((a, b) => b.y - a.y)[0];
    const bottom = later ? later.y : -1;
    const first = !seen.has(section);
    seen.add(section);
    const parsed = parseSection(items, heading, bottom, { first });
    if (parsed.problem) {
      const at = tableWhere({ file: source.file || "", table: heading.title });
      const detail = parsed.problem.row === null || parsed.problem.row === undefined
        ? `${parsed.problem.column}: ${parsed.problem.reason}`
        : `${parsed.problem.column} ${parsed.problem.reason} on row ${parsed.problem.row} `
          + `(${JSON.stringify(parsed.problem.value)})`;
      return { rows: [], sections, asOf: reportAsOf(items),
        clientUcid: reportClientUcid(items),
        error: `${at}: ${detail}. The section cannot be read, so nothing was imported.` };
    }
    rows.push(...parsed.rows);
  }
  const byIsin = new Map();
  for (const row of rows) {
    const prior = byIsin.get(row.isin);
    if (!prior) { byIsin.set(row.isin, row); continue; }
    for (const key of Object.keys(row)) {
      if (row[key] !== null && row[key] !== undefined && row[key] !== ""
          && (prior[key] === null || prior[key] === undefined || prior[key] === "")) {
        prior[key] = row[key];
      }
    }
  }
  return {
    rows: [...byIsin.values()],
    sections,
    asOf: reportAsOf(items),
    clientUcid: reportClientUcid(items),
    error: null,
  };
}
