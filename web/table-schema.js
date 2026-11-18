// Header-driven table reading for broker and depository files.
//
// A parser declares a schema: every field it needs, the spellings a report may
// print for that column, and whether the file is unreadable without it. This
// module finds the header row, resolves one column per field, ignores columns
// it does not know, and normalises values. A missing required column, two
// columns claiming one name, or a cell that cannot be read is a refusal that
// names the file, the sheet or table, the column and the row. Nothing is read
// by position and nothing is guessed.
//
// Dates: a numeric date whose first two parts both fit a month is read
// day-first, the Indian convention, and reported as ambiguous. A part above 12
// settles the order; a value that is not a real calendar day is refused.
// Two-digit years 00-79 are 2000-2079 and 80-99 are 1980-1999, the same rule
// bond labels already use.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
// A cell that says "no value" rather than holding an unreadable one. These are
// the markers a report prints for a closed position or an empty term.
const BLANK_VALUES = /^(?:[-–—]+|n\/?a|na|nil|none)$/i;
const CURRENCY_BETWEEN_DIGITS = /\d\s*(?:[₹₨$€£¥]|INR|Rs\.?|USD|EUR|GBP|JPY)\s*\d/i;
const HEADER_SCAN_LIMIT = 40;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** The one spelling rule every header and alias goes through. */
export function headerKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** A spreadsheets column letter, for a refusal a person can find on screen. */
export function columnLetter(index) {
  if (!Number.isInteger(index) || index < 0) return "?";
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const quote = (value) => `"${String(value ?? "").replace(/\s+/g, " ").trim()}"`;

/** Where a table lives, in the words a refusal needs. */
export function tableWhere({ file = "", sheet = "", table = "" } = {}) {
  const parts = [file || "this file"];
  if (sheet) parts.push(sheet);
  if (table && table !== sheet) parts.push(table);
  return parts.join(" \u2192 ");
}

// --- numbers ----------------------------------------------------------------

// True for both western 1,234,567 and Indian 1,23,456 grouping. The first
// group holds one to three digits; later groups are three digits (western) or
// two digits with a final three-digit group (Indian).
function groupedThousands(parts) {
  if (parts.length < 2 || !/^\d{1,3}$/.test(parts[0])) return false;
  const rest = parts.slice(1);
  if (!rest.every((p) => /^\d+$/.test(p))) return false;
  const western = rest.every((p) => p.length === 3);
  const indian = rest.every((p, i) =>
    i === rest.length - 1 ? p.length === 3 : p.length === 2);
  return western || indian;
}

// The integer half may still carry grouping separators after the decimal
// separator has been chosen. Reject mixed separators ("1.234,567.89").
function plainInteger(part) {
  if (/^\d+$/.test(part)) return part;
  const seps = part.match(/[.,]/g) || [];
  if (!seps.length) return null;
  const sep = seps[0];
  if (seps.some((c) => c !== sep)) return null;
  const parts = part.split(sep);
  return groupedThousands(parts) ? parts.join("") : null;
}

/**
 * A canonical "1234.56" string, or null when the separators do not describe
 * exactly one unambiguous number. "1,23,456.78", "1234,56" and "1234.56" are
 * accepted; "1.234,567.89" and "1,2,3" are not.
 */
export function normaliseNumber(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (!dots && !commas) return /^\d+$/.test(s) ? s : null;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const at = s.lastIndexOf(dec);
    const intPart = s.slice(0, at);
    const frac = s.slice(at + 1);
    if (!/^\d+$/.test(frac)) return null;
    const int = plainInteger(intPart);
    return int === null ? null : `${int}.${frac}`;
  }
  if (dots) {
    if (dots > 1) return null;
    const [int, frac] = s.split(".");
    return /^\d+$/.test(int) && /^\d+$/.test(frac) ? `${int}.${frac}` : null;
  }
  const parts = s.split(",");
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const last = parts[parts.length - 1];
  // A comma before one or two trailing digits is a decimal comma: "1234,56".
  if (parts.length === 2 && last.length <= 2) return `${parts[0]}.${last}`;
  return groupedThousands(parts) ? parts.join("") : null;
}

/** True for an empty cell or an explicit no-value marker. */
export function isBlank(value) {
  if (value === null || value === undefined) return true;
  // A numeric cell is never blank: NaN and Infinity are unreadable, and the
  // number reader refuses them instead of treating them as zero.
  if (typeof value === "number") return false;
  const s = String(value).trim();
  return !s || BLANK_VALUES.test(s);
}

/**
 * One cell as a number: commas and Indian grouping, currency symbols and
 * codes, parentheses negatives, a leading or trailing minus, and a percent
 * sign. Returns null when the cell is not one number. A blank is null; the
 * reader decides whether a blank is a refusal.
 */
export function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (CURRENCY_BETWEEN_DIGITS.test(s)) return null;
  s = s.replace(/[₹₨$€£¥]/g, "")
    .replace(/(?<![A-Za-z])(?:INR|Rs\.?|USD|EUR|GBP|JPY)(?![A-Za-z])/gi, "")
    .replace(/%/g, "")
    .trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (/^[-−]/.test(s)) { negative = true; s = s.replace(/^[-−]\s*/, ""); }
  if (/[-−]$/.test(s)) { negative = true; s = s.replace(/\s*[-−]$/, ""); }
  if (!s) return null;
  // Grouping spaces and apostrophes count only between digits.
  s = s.replace(/(?<=\d)[\s\u00A0\u2007\u2009\u202F'’‘]+(?=\d)/g, "");
  const normal = normaliseNumber(s);
  if (normal === null) return null;
  const value2 = Number(normal);
  if (!Number.isFinite(value2)) return null;
  return negative ? -value2 : value2;
}

/** The same, in paise, for a field the database stores as money. */
export function parseMoney(value) {
  const amount = parseAmount(value);
  return amount === null ? null : Math.round(amount * 100);
}

// --- dates ------------------------------------------------------------------

function growYear(raw) {
  const s = String(raw ?? "");
  if (s.length === 3) return NaN;
  if (s.length === 4) return Number(s);
  if (s.length !== 2) return NaN;
  const n = Number(s);
  return n <= 79 ? 2000 + n : 1900 + n;
}

function saneDate(year, month, day) {
  const y = growYear(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || y < MIN_YEAR || y > MAX_YEAR) return "";
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1
    || date.getUTCDate() !== d) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const failed = () => ({ iso: "", ambiguous: false, order: "" });

/**
 * One date cell, with the reading it took.
 * @returns {{iso: string, ambiguous: boolean, order: "iso"|"day-first"|"month-first"|"named"|"serial"|""}}
 */
export function parseDateDetail(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? failed()
      : { iso: value.toISOString().slice(0, 10), ambiguous: false, order: "iso" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return failed();
    // Excel stores dates as days since 1899-12-30. A bare five-digit number in
    // a date column is almost always a serial, not a year or an amount.
    if (value >= 20000 && value <= 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return { iso: date.toISOString().slice(0, 10), ambiguous: false, order: "serial" };
    }
    return failed();
  }
  let s = text(value);
  if (!s) return failed();
  s = s.replace(/[.,;:]+$/, "").trim().replace(/[\[\]]/g, "").trim()
    .replace(/^[.\s]+/, "").replace(/\.\./g, ".");
  const tail = s.match(/^(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})-\d+$/);
  if (tail) s = tail[1];

  // A four-digit year cannot be a day, so ISO is read before anything else.
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s][\s\S]*)?$/);
  if (m) {
    const iso = saneDate(m[1], m[2], m[3]);
    return iso ? { iso, ambiguous: false, order: "iso" } : failed();
  }
  // 20240401, or the Indian 01042024 form.
  if (/^\d{8}$/.test(s)) {
    const iso = saneDate(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8));
    if (iso) return { iso, ambiguous: false, order: "iso" };
    const indian = saneDate(s.slice(4, 8), s.slice(2, 4), s.slice(0, 2));
    if (indian) return { iso: indian, ambiguous: false, order: "day-first" };
  }
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return { iso: date.toISOString().slice(0, 10), ambiguous: false, order: "serial" };
    }
  }
  if ((m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})$/))) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const iso = month ? saneDate(m[3], month, m[2]) : "";
    if (iso) return { iso, ambiguous: false, order: "named" };
    return failed();
  }
  if ((m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,})[\s\-/](\d{2,4})$/))) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const iso = month ? saneDate(m[3], month, m[1]) : "";
    if (iso) return { iso, ambiguous: false, order: "named" };
    return failed();
  }
  if ((m = s.match(/^(\d{1,2})[\/.\-,](\d{1,2})[\/.\-,](\d{2,4})$/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b > 12) return failed();
    // A part above 12 settles the order. When both fit a month, the Indian
    // day-first reading wins and the result says it was ambiguous.
    const dayFirst = a > 12 || b <= 12;
    const iso = dayFirst ? saneDate(m[3], b, a) : saneDate(m[3], a, b);
    if (!iso) return failed();
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    return { iso, ambiguous, order: dayFirst ? "day-first" : "month-first" };
  }
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{4})$/))) {
    const month = Number(m[1]);
    const iso = month >= 1 && month <= 12 ? saneDate(m[2], month, 1) : "";
    return iso ? { iso, ambiguous: false, order: "named" } : failed();
  }
  return failed();
}

/** The stored form of one date cell, or "" when it cannot be read. */
export function parseDate(value) {
  return parseDateDetail(value).iso;
}

// --- header resolution ------------------------------------------------------

const specOf = (entry) => (Array.isArray(entry) ? { aliases: entry } : entry || {});
const aliasesOf = (entry) => (specOf(entry).aliases || []).map(headerKey).filter(Boolean);
const labelOf = (field, entry) => specOf(entry).label || field;
const requiredOf = (entry) => specOf(entry).required === true;
// A loose field also accepts a header that starts or ends with the alias, so
// "Quantity (Units)" and "Holding Quantity" reach "quantity". It is opt-in: a
// strict field must not let "Quantity Discrepant" stand in for "Quantity".
const looseOf = (entry) => specOf(entry).loose === true;

function matchesAlias(key, alias, loose) {
  if (key === alias) return true;
  return loose && (key.startsWith(`${alias} `) || key.endsWith(` ${alias}`));
}

/**
 * One row to a column map. Each field resolves through its aliases in order,
 * so the first spelling a report uses wins. A column no field names is
 * ignored. A name printed twice is reported, not guessed between.
 * @param {Array<unknown>} cells
 * @param {Record<string, {label?: string, aliases: string[], required?: boolean}>} schema
 */
export function resolveColumns(cells, schema) {
  const keys = (Array.isArray(cells) ? cells : []).map(headerKey);
  const columns = {};
  const labels = {};
  const used = {};
  const missing = [];
  for (const [field, entry] of Object.entries(schema || {})) {
    const aliases = aliasesOf(entry);
    const loose = looseOf(entry);
    let ambiguous = null;
    for (const alias of aliases) {
      const hits = [];
      keys.forEach((key, index) => { if (matchesAlias(key, alias, loose)) hits.push(index); });
      if (hits.length === 1) {
        columns[field] = hits[0];
        labels[field] = text(cells[hits[0]]);
        used[field] = alias;
        ambiguous = null;
        break;
      }
      if (hits.length > 1 && !ambiguous) ambiguous = { field, columns: hits };
    }
    if (columns[field] === undefined && requiredOf(entry)) {
      missing.push({ field, label: labelOf(field, entry), aliases: aliasesOf(entry),
        reason: ambiguous ? "ambiguous" : "absent", columns: ambiguous?.columns || [] });
    }
  }
  return { columns, labels, aliases: used, missing };
}

/**
 * The first row whose names satisfy every required field. A row that matches
 * more fields wins over one that matches fewer, so a summary line that happens
 * to carry one column name cannot shadow the real header.
 * @returns {{index: number, columns: object, labels: object, aliases: object,
 *   missing: Array<object>, nearest: object|null}}
 */
export function findHeaderRow(rows, schema, { maxScan = HEADER_SCAN_LIMIT } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let nearest = null;
  for (let i = 0; i < Math.min(list.length, maxScan); i++) {
    const resolved = resolveColumns(list[i], schema);
    const score = Object.keys(resolved.columns).length;
    if (!score) continue;
    if (!nearest || score > nearest.score) {
      nearest = { index: i, score, ...resolved, cells: list[i] };
    }
    if (!resolved.missing.length) return { index: i, ...resolved, nearest: null };
  }
  return { index: -1, columns: {}, labels: {}, aliases: {}, missing: [],
    nearest: nearest ? { ...nearest } : null };
}

/** Every required field's human name, for a refusal that lists what it wanted. */
export function requiredLabels(schema) {
  return Object.entries(schema || {})
    .filter(([, entry]) => requiredOf(entry))
    .map(([field, entry]) => labelOf(field, entry));
}

/** Why a header could not be read, naming what the schema wanted. */
export function headerMessage(where, schema, header) {
  const at = tableWhere(where);
  const nearest = header?.nearest;
  if (!nearest) {
    return `${at}: no row looks like the table header. Expected ${requiredLabels(schema)
      .map(quote).join(", ")}.`;
  }
  const details = nearest.missing.map((item) => item.reason === "ambiguous"
    ? `${quote(item.label)} is printed twice (columns ${item.columns.map(columnLetter).join(" and ")})`
    : `no ${quote(item.label)} column`);
  return `${at}: row ${nearest.index + 1} is the closest header, but ${details.join("; ")}. `
    + `The file cannot be read without it.`;
}

// --- refusals ---------------------------------------------------------------

/** A refusal a screen can print: where, what, and which row. */
export function refusalOf(where, { column = "", row = null, value = null, reason }) {
  const at = tableWhere(where);
  const place = row === null || row === undefined ? at : `${at}, row ${row}`;
  const cell = value === null || value === undefined ? ""
    : ` (${quote(value)})`;
  const message = `${place}: ${column ? `${quote(column)} ` : ""}${reason}${cell}.`;
  return { ...where, where: at, column, row: row ?? null, value: value ?? null,
    reason, message };
}

export class RefusalError extends Error {
  constructor(refusal) {
    super(refusal.message);
    this.name = "RefusalError";
    this.refusal = refusal;
  }
}

export function refuse(where, detail) {
  throw new RefusalError(refusalOf(where, detail));
}

// --- cell readers -----------------------------------------------------------

export const cellAt = (row, columns, field) => {
  const index = columns?.[field];
  return index === undefined ? "" : row?.[index];
};

export const cellText = (row, columns, field) => text(cellAt(row, columns, field));

const nameOf = (schema, field) => labelOf(field, specOf(schema?.[field]));

/**
 * A numeric cell, or a refusal that names the column and the row. A blank cell
 * is null unless the caller says a number is required; a cell that holds
 * something and cannot be read is always a refusal, never a dropped row.
 */
export function readNumber(row, columns, field, { where, schema, rowNumber, required = false } = {}) {
  const raw = cellAt(row, columns, field);
  const column = nameOf(schema, field);
  if (isBlank(raw)) {
    if (required) refuse(where, { column, row: rowNumber,
      reason: "is empty, and a number is required" });
    return null;
  }
  const value = parseAmount(raw);
  if (value === null) {
    refuse(where, { column, row: rowNumber, value: raw,
      reason: "is not a number" });
  }
  return value;
}

/** The same rule for money, returned in paise. */
export function readMoney(row, columns, field, options = {}) {
  const value = readNumber(row, columns, field, options);
  return value === null ? null : Math.round(value * 100);
}

/**
 * A date cell, or a refusal. The ambiguity flag rides along so a caller can
 * report a day-first reading it had to choose; the stored value is still a
 * string and cannot carry it.
 */
export function readDate(row, columns, field, { where, schema, rowNumber, required = false } = {}) {
  const raw = cellAt(row, columns, field);
  const column = nameOf(schema, field);
  if (isBlank(raw)) {
    if (required) refuse(where, { column, row: rowNumber,
      reason: "is empty, and a date is required" });
    return { iso: "", ambiguous: false };
  }
  const parsed = parseDateDetail(raw);
  if (!parsed.iso) {
    refuse(where, { column, row: rowNumber, value: raw,
      reason: "is not a readable date" });
  }
  return parsed;
}

/** Turn a thrown refusal into the `{ error, refusal }` shape a parser returns. */
export function refusalResult(error) {
  if (error instanceof RefusalError) {
    return { error: error.refusal.message, refusal: error.refusal };
  }
  throw error;
}
