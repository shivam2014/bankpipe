const SYN = [
  ["value_date", /value\s*date|value\s*dt/i],
  ["date", /txn\s*date|tran\s*date|transaction\s*date|post(ing)?\s*date|^date$|date$/i],
  ["ref", /chq|cheque|ref(erence)?\s*(no|num|number)?$|instrument|utr/i],
  // "Dr Amount" / "Cr Amount" are two words, and some exports print only the
  // bare "Dr" / "Cr". The word boundary keeps "Address" and "Dr Name" out of
  // the debit column.
  ["debit", /debit|withdrawal|paid\s*out|\bdr\.?(?:\s*(?:amount|amt))?$/i],
  ["credit", /credit|deposit|paid\s*in|\bcr\.?(?:\s*(?:amount|amt))?$/i],
  ["balance", /balance/i],
  ["amount", /^amount$|transaction\s*amount/i],
  ["description", /description|narration|particulars|details|remarks|transaction(?!\s*date)/i],
];
export function mapHeader(cells) {
  const m = {}; const taken = new Set();
  cells.forEach((c, i) => {
    const t = String(c || "").trim();
    for (const [k, re] of SYN) { if (!taken.has(k) && re.test(t)) { m[k] = i; taken.add(k); break; } }
  });
  return m;
}
export function headerScore(cells) { return Object.keys(mapHeader(cells)).length; }
export function findHeader(rows) {
  let best = -1, map = {}, score = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const s = headerScore(rows[i]);
    if (s > score) { score = s; best = i; map = mapHeader(rows[i]); }
  }
  if (score >= 3) return { idx: best, map };
  // A hand-kept passbook sheet labels only the money columns — "Debits" and
  // "Credits" — and leaves date, particulars and balance unlabelled. Read the
  // columns around them rather than refusing the file.
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const m = mapHeader(rows[i]);
    if (m.debit !== undefined && m.credit !== undefined && m.date === undefined) {
      return { idx: i, map: {
        date: Math.max(0, m.debit - 2),
        description: Math.max(0, m.debit - 1),
        debit: m.debit, credit: m.credit, balance: m.credit + 1,
      } };
    }
  }
  return { idx: -1, map: {} };
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// A spreadsheet cell can contain a year that is really a serial number or a
// typo. Fail closed: a date outside 1900..2100 is not a date we will store.
const MIN_YEAR = 1900, MAX_YEAR = 2100;
function normYear(raw) {
  let y = String(raw || "");
  if (y.length === 3) return "";
  if (y.length === 2) {
    const n = Number(y);
    y = n >= 50 ? String(1900 + n) : String(2000 + n);
  }
  if (y.length !== 4) return "";
  const n = Number(y);
  return n >= MIN_YEAR && n <= MAX_YEAR ? y : "";
}
function saneDate(y, mo, d) {
  const yy = normYear(y);
  const m = Number(mo), dd = Number(d);
  if (!yy || !(m >= 1 && m <= 12) || !(dd >= 1 && dd <= 31)) return "";
  const dt = new Date(Date.UTC(Number(yy), m - 1, dd));
  if (dt.getUTCFullYear() !== Number(yy) || dt.getUTCMonth() !== m - 1
      || dt.getUTCDate() !== dd) return "";
  return `${yy}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export function parseDate(v) {
  let s = String(v || "").trim(); if (!s) return "";
  s = s.replace(/[.,;:]+$/, "").trim();
  s = s.replace(/[\[\]]/g, "").trim();
  s = s.replace(/^[.\s]+/, "");
  s = s.replace(/\.\./g, ".");
  const tail = s.match(/^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})-\d+$/);
  if (tail) s = tail[1];
  // 20240401, or the Indian 01042024 form
  if (/^\d{8}$/.test(s)) {
    let iso = saneDate(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8));
    if (iso) return iso;
    iso = saneDate(s.slice(4, 8), s.slice(2, 4), s.slice(0, 2));
    if (iso) return iso;
  }
  // Excel stores dates as days since 1899-12-30. A bare 5-digit number in a
  // date column is almost always a serial, not a year or an amount.
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return d.toISOString().slice(0, 10);
    }
  }
  let m;
  if ((m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return saneDate(m[3], mo, m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,})[\s\-/](\d{2,4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) {
      return saneDate(m[3], mo, m[1]);
    }
  }
  if ((m = s.match(/^(\d{1,2})[\/.\-,](\d{1,2})[\/.\-,](\d{2,4})$/))) {
    const a = Number(m[1]), b = Number(m[2]);
    // 5/18/04 can only be May 18; 18/05/04 can only be 18 May. When both
    // numbers fit a month, keep the Indian day-first reading.
    return a <= 12 && b > 12 ? saneDate(m[3], m[1], m[2]) : saneDate(m[3], m[2], m[1]);
  }
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{4})$/))) {
    const mo = Number(m[1]);
    const y = normYear(m[2]);
    if (mo >= 1 && mo <= 12 && y) return `${y}-${String(mo).padStart(2, "0")}-01`;
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/))) return saneDate(m[1], m[2], m[3]);
  return "";
}

// Register rows put the date in prose: "Issue 22/11/2025", "Maturity:
// 27/11/2026", "Policy upto July 2042". Take the first complete date in the
// text and ignore anything that fails the sanity check.
export function parseDateInText(v) {
  const s = String(v || "");
  if (!s.trim()) return "";
  let m = s.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (m) { const d = saneDate(m[1], m[2], m[3]); if (d) return d; }
  m = s.match(/(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?!\d)/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const d = a <= 12 && b > 12 ? saneDate(m[3], m[1], m[2])
      : saneDate(m[3], m[2], m[1]);
    if (d) return d;
  }
  m = s.match(/(?<!\d)(\d{1,2})[\s\-/]+([A-Za-z]{3,})[\s\-/]+(\d{2,4})(?!\d)/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) { const d = saneDate(m[3], mo, m[1]); if (d) return d; }
  }
  m = s.match(/(?<![A-Za-z])([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})(?!\d)/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) { const d = saneDate(m[3], mo, m[2]); if (d) return d; }
  }
  m = s.match(/(?<![A-Za-z])([A-Za-z]{3,})\s+(\d{4})(?!\d)/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return saneDate(m[2], mo, 1);
  }
  return "";
}
// A currency token between two digits is not a prefix or a suffix: removing it
// would fuse two numbers, so "1INR234" is refused rather than read as 1234.
const CURRENCY_BETWEEN_DIGITS = /\d\s*(?:[₹₨$€£¥]|INR|Rs\.?|USD|EUR|GBP|JPY)\s*\d/i;

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

// Return a canonical "1234.56" string, or null when the separators do not
// describe exactly one unambiguous number.
function normaliseNumber(s) {
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (!dots && !commas) return /^\d+$/.test(s) ? s : null;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const at = s.lastIndexOf(dec);
    const intPart = s.slice(0, at), frac = s.slice(at + 1);
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

function toPaise(num) {
  const [int, frac = ""] = num.split(".");
  if (!/^\d+$/.test(int) || (frac && !/^\d+$/.test(frac))) return null;
  let paise = BigInt(int) * 100n + BigInt((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) paise += 1n;
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
}

export function parseMoney(v) {
  let s = String(v ?? "").trim();
  if (!s || /^(?:nil|n\/?a|-{1,2}|[—–])$/i.test(s)) return null;
  if (CURRENCY_BETWEEN_DIGITS.test(s)) return null;

  // Dr/Cr may lead or trail, with an optional dot, spaces or parentheses:
  // "Dr. 1,234", "1,234Cr." and "1,000.00 (Dr)" all occur. Two different
  // markers on one cell contradict each other.
  let marker = "";
  const lead = s.match(/^(?:\(\s*)?(dr|cr)\.?(?![a-z])(?:\s*\))?\s*/i);
  if (lead) { marker = lead[1].toLowerCase(); s = s.slice(lead[0].length); }
  const tail = s.match(/(?<![a-z])(?:\(\s*)?(dr|cr)\.?(?:\s*\))?\s*$/i);
  if (tail) {
    const m = tail[1].toLowerCase();
    if (marker && marker !== m) return null;
    marker = m;
    s = s.slice(0, tail.index);
  }
  let neg = marker === "dr";
  const positiveMarker = marker === "cr";

  s = s.replace(/[₹₨$€£¥]/g, "")
    .replace(/(?<![A-Za-z])(?:INR|Rs\.?|USD|EUR|GBP|JPY)(?![A-Za-z])/gi, "")
    .replace(/\s*\/-\s*$/, "")
    .trim();
  if (!s) return null;

  // Parentheses around the value mean negative, even with a symbol inside.
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  // The sign may lead or trail; banks print both "-" and the unicode minus.
  if (/^[-−]/.test(s)) { neg = true; s = s.replace(/^[-−]\s*/, ""); }
  if (/[-−]$/.test(s)) { neg = true; s = s.replace(/\s*[-−]$/, ""); }
  if (!s) return null;

  // Grouping spaces and apostrophes count only between digits.
  s = s.replace(/(?<=\d)[\s\u00A0\u2007\u2009\u202F'’‘]+(?=\d)/g, "");

  const num = normaliseNumber(s);
  if (num === null || !/^\d+(\.\d+)?$/.test(num)) return null;
  if (positiveMarker && neg) return null;
  const paise = toPaise(num);
  if (paise === null) return null;
  return paise === 0 ? 0 : (neg ? -paise : paise);
}
export function stripRows(rows) {
  return rows.map(r => (r || []).map(v => (v === null || v === undefined) ? "" : String(v)));
}
export function rowsFromCsv(text) {
  return text.split(/\r?\n/).filter(l => l.trim()).map(line => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  });
}
// A statement can end with a summary block after the transactions: a
// "Statement Summary" line, a column of totals labels, then the totals row.
// The totals carry printable numbers, so the money test alone keeps them as a
// transaction. Only a row that has no date *and* says it is a summary is a
// footer; a narration that mentions "closing balance" still has its date.
const FOOTER_MARKER = /statement summary|summary of|brought forward|opening balance|closing balance|grand total/i;

export function parseStatement(rows) {
  rows = stripRows(rows);
  const { idx, map } = findHeader(rows);
  if (idx < 0) return { rows: [], error: "no recognisable header row" };
  // A statement whose header names a balance but no money column would import
  // every row with amount null and still look successful. Refuse the file
  // instead: no amount column means the money columns were not recognised.
  if (map.balance !== undefined
      && map.debit === undefined && map.credit === undefined && map.amount === undefined) {
    return { rows: [], error: "no amount column" };
  }
  const out = []; let skipped = 0; let footerRow = null;
  for (let r = idx + 1; r < rows.length; r++) {
    const row = rows[r];
    const get = k => (map[k] !== undefined && row[map[k]] !== undefined) ? row[map[k]] : "";
    const date = parseDate(get("date"));
    // The "one row already read" guard keeps a leading opening-balance row
    // from ending the file before it starts, and the date-column guard keeps a
    // headerless sheet (no date column at all) on the normal path.
    if (!date && map.date !== undefined && out.length
        && FOOTER_MARKER.test(row.join(" ").replace(/\s+/g, " "))) {
      footerRow = r + 1;
      break;
    }
    const debit = parseMoney(get("debit")), credit = parseMoney(get("credit"));
    const single = parseMoney(get("amount"));
    let amount = null;
    if (single !== null) amount = single;
    else if (debit !== null && credit !== null) amount = credit - Math.abs(debit);
    else if (debit !== null) amount = -Math.abs(debit);
    else if (credit !== null) amount = credit;
    const balance = parseMoney(get("balance"));
    const desc = String(get("description") || "").trim();
    if (!date && amount === null && !desc) { skipped++; continue; }
    out.push({ date, description: desc, ref: String(get("ref") || "").trim(),
               amount, balance, source_row: r + 1 });
  }
  // A row that has a date and a balance was clearly a transaction; an amount of
  // null means the money column was empty or unreadable. Importing the file
  // anyway would store the balance trail with no money in it, so refuse all of
  // it rather than land a partial ledger. Footers have no date and do not count.
  const noAmount = out.filter((r) => r.date && r.balance !== null && r.amount === null).length;
  if (noAmount) return { rows: [], error: `${noAmount} rows have no amount` };
  // Statement exports arrive either oldest-first or newest-first. The order
  // decides which row holds the closing balance, so report it and let the
  // import put rows in date order.
  const datedRows = out.filter((r) => r.date);
  let order = "";
  if (datedRows.length > 1) {
    const first = datedRows[0].date, last = datedRows[datedRows.length - 1].date;
    if (first > last) order = "desc";
    else if (first < last) order = "asc";
  }
  // A day's worth of rows all carry the same date, so the dates cannot say which
  // end is the newest. The running balance can: in a newest-first file each row's
  // balance is the next row's balance minus that row's amount.
  if (!order && datedRows.length > 1
      && datedRows.every((r) => r.balance !== null && r.amount !== null)) {
    const newestFirst = datedRows.slice(0, -1).every((r, i) =>
      Math.abs(datedRows[i + 1].balance - (r.balance - r.amount)) <= 1);
    if (newestFirst) order = "desc";
  }
  return { rows: out, skipped, header: idx + 1, mapping: Object.keys(map), order,
           footer_row: footerRow };
}

export function chronological(parsed) {
  if (parsed?.order !== "desc") return parsed?.rows || [];
  return parsed.rows.slice().reverse();
}

// What the import preview can tell before anything is written: the row-to-row
// balance chain, and whether the last row equals the closing balance printed
// in the statement's preamble. Kept here, next to chronological(), so the
// preview and its tests read the same rows in the same order.
export function auditStatement(cells, parsed) {
  const chrono = chronological(parsed).filter((r) => r.date && r.amount !== null
    && r.balance !== null && r.balance !== undefined);
  const breaks = [];
  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1], cur = chrono[i];
    const expected = prev.balance + cur.amount;
    if (Math.abs(expected - cur.balance) > 1) {
      breaks.push({ date: cur.date, expected, actual: cur.balance });
    }
  }
  // Banks print the closing balance above the table, often as "1,65,070.92 CR".
  let closing = null;
  for (let i = 0; i < Math.min(4, cells.length) && closing === null; i++) {
    for (const cell of cells[i] || []) {
      const m = String(cell).match(/([\d,]+\.\d{2})\s*(CR|DR)/i);
      if (m) {
        closing = Math.round(Number(m[1].replace(/,/g, "")) * 100)
          * (/CR/i.test(m[2]) ? 1 : -1);
        break;
      }
    }
  }
  const latest = chrono[chrono.length - 1] || null;
  return { rows: chrono.length, breaks, closing,
    latestBalance: latest ? latest.balance : null,
    closingMatches: closing !== null && latest?.balance != null
      && Math.abs(closing - latest.balance) <= 1 };
}

// Preamble scan. Bank files put the account identity above the header: account
// number, IFSC, and often the holder name. We only extract machine-matchable
// fields, never free text.
const IFSC_RE = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
const DIGITS_RE = /\d[\d\s-]{6,}\d/g;

export function scanPreamble(rows, headerIdx) {
  const limit = headerIdx > 0 ? headerIdx : Math.min(rows.length, 20);
  const text = rows.slice(0, limit).map((r) => r.join(" ")).join(" ");
  const numbers = [];
  for (const m of text.matchAll(DIGITS_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 18) continue;
    // "helpline 18001802222", "Phone No: 26454620" and "Toll Free ..." are
    // phone numbers, not an account. Allow the label's own words ("No",
    // "Free") between the label and the number.
    const before = text.slice(Math.max(0, m.index - 32), m.index);
    if (/(helpline|phone|mobile|toll|fax|contact|telephone|tel)\b[\s\w:.\/-]{0,24}$/i.test(before)) continue;
    numbers.push(digits);
  }
  const ifsc = (text.match(IFSC_RE) || [])[1] || "";
  // Prefer the labelled account number over the first long number in the
  // preamble, which is often a statement date or a customer ID.
  const labelled = text.match(/account\s*(?:number|no\.?)\s*[:#\-]?\s*([0-9][0-9\s\-]{6,18})/i);
  // No labelled number means the first long number in the preamble, but the
  // phone filter above has already removed helplines, and an empty list stays
  // empty: no guess beats a wrong account number.
  const accountNumber = labelled ? labelled[1].replace(/\D/g, "") : (numbers[0] || "");
  return { numbers: [...new Set(numbers)], accountNumber, ifsc, text };
}

const digitsOf = (s) => String(s || "").replace(/\D/g, "");

// Two account numbers are the same when their digits are, so a spaced or
// dashed number matches the same digits with the separators removed. No digits
// on either side is not a match: an empty number proves nothing about the
// account.
export function sameAccountNumber(a, b) {
  const x = digitsOf(a), y = digitsOf(b);
  return Boolean(x) && Boolean(y) && x === y;
}

export function guessAccount(preamble, accounts) {
  const found = preamble.numbers.map(digitsOf).filter(Boolean);
  for (const acc of accounts) {
    const accDigits = digitsOf(acc.number);
    if (accDigits.length < 4) continue;
    for (const n of found) {
      if (n.endsWith(accDigits.slice(-6)) || accDigits.endsWith(n.slice(-6))) {
        return { id: acc.id, why: "account number", confidence: "high" };
      }
      if (accDigits.length >= 4 && n.endsWith(accDigits.slice(-4))) {
        return { id: acc.id, why: "last four digits", confidence: "medium" };
      }
    }
  }
  const bankWords = ["hdfc", "icici", "sbi", "state bank", "standard chartered",
    "pnb", "punjab national", "baroda", "axis", "kotak"];
  for (const acc of accounts) {
    const hay = `${acc.bank || ""} ${acc.label || ""}`.toLowerCase();
    const hit = bankWords.find((w) => hay.includes(w));
    if (hit && preamble.text && preamble.text.toLowerCase().includes(hit)) {
      return { id: acc.id, why: `bank name (${hit})`, confidence: "low" };
    }
  }
  return null;
}
