// Profile-driven workbook parsing. A layout profile says which sheet is a
// transaction table or a holdings register, which columns matter, and which
// traps to expect. It contains no cell values and no header text.
//
// Header words are read locally, from the workbook in this browser, only to
// tell a debit column from a credit or balance column. They never leave.

import { parseDate, parseDateInText, parseMoney } from "./parse.js";

export function colIndex(letter) {
  const s = String(letter || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function classifyAmountHeader(text) {
  const s = String(text || "").toLowerCase();
  if (/balance/.test(s)) return "balance";
  if (/debit|withdrawal|paid\s*out|\bdr\b/.test(s)) return "debit";
  if (/credit|deposit|paid\s*in|\bcr\b/.test(s)) return "credit";
  if (/amount|value/.test(s)) return "amount";
  return "";
}

const cell = (row, i) => (i >= 0 && row && row[i] !== undefined && row[i] !== null)
  ? row[i] : "";

function amountColumns(sheet, matrix) {
  const headerRow = Math.max(0, (sheet.header_row || 1) - 1);
  const cols = (sheet.columns || []).filter((c) =>
    c.role !== "ignore" && c.kind === "amount");
  const out = cols.map((c) => ({
    index: colIndex(c.col),
    use: c.use || classifyAmountHeader(cell(matrix[headerRow], colIndex(c.col))),
  }));
  if (out.some((c) => c.use)) return out;
  if (out.length === 1) out[0].use = "amount";
  else if (out.length === 2) { out[0].use = "debit"; out[1].use = "credit"; }
  else if (out.length >= 3) {
    out[0].use = "debit"; out[1].use = "credit"; out[2].use = "balance";
  }
  return out;
}

function firstColumn(sheet, kind, role) {
  const c = (sheet.columns || []).find((x) => x.kind === kind && x.role === role);
  return c ? colIndex(c.col) : -1;
}

const TOTAL_ROW = /^(total|grand total|b\/f|brought forward|carried forward|opening balance|closing balance)\b/i;

export function parseTransactions(matrix, sheet) {
  const headerRow = Math.max(1, sheet.header_row || 1);
  const dateCol = firstColumn(sheet, "date", "value");
  const descCol = firstColumn(sheet, "free_text", "label");
  const amountCols = amountColumns(sheet, matrix);
  const rows = [];
  let skipped = 0;
  let lastDate = "";

  for (let r = headerRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const rawDate = cell(row, dateCol);
    let date = parseDate(rawDate) || parseDateInText(rawDate);
    const desc = String(cell(row, descCol) || "").trim();
    const money = {};
    for (const c of amountCols) {
      if (c.index < 0) continue;
      money[c.use] = parseMoney(cell(row, c.index));
    }
    let amount = null;
    const hasDC = (money.debit !== null && money.debit !== undefined)
      || (money.credit !== null && money.credit !== undefined);
    if (hasDC) amount = (money.credit || 0) - (money.debit || 0);
    else if (money.amount !== null && money.amount !== undefined) amount = money.amount;
    const balance = money.balance === undefined ? null : money.balance;
    if (!String(rawDate || "").trim() && TOTAL_ROW.test(desc)) {
      skipped++; continue;
    }
    let carried = false;
    if (!date && amount !== null) {
      const raw = String(rawDate || "").trim();
      if (!raw || /^\d{1,2}$/.test(raw)) { date = lastDate; carried = !!date; }
    }
    if (date) lastDate = date;
    const blank = !rawDate && amount === null && !desc;
    if (blank) { skipped++; continue; }
    // A stray date in a formatting row carries no transaction. Keep the row
    // only if it has an amount, a balance or a description.
    if (amount === null && balance === null && !desc) { skipped++; continue; }
    if (!date && amount === null) { skipped++; continue; }
    rows.push({
      date, description: desc, amount, balance,
      source_row: r + 1,
      raw_date: String(rawDate || ""),
      date_carried: carried,
    });
  }
  return { rows, skipped, headerRow, dateCol, descCol, amountCols };
}

export function parseHoldings(matrix, sheet) {
  const headerRow = Math.max(1, sheet.header_row || 1);
  const keyCol = firstColumn(sheet, "security_id", "key");
  const labelCol = firstColumn(sheet, "security_name", "label");
  const categoryCol = firstColumn(sheet, "category", "grouping");
  const quantityCol = firstColumn(sheet, "quantity", "value");
  const dateCols = (sheet.columns || []).filter((c) =>
    c.kind === "date" && c.role === "value").map((c) => colIndex(c.col));
  const amountCols = (sheet.columns || []).filter((c) =>
    c.kind === "amount" && c.role === "value").map((c) => colIndex(c.col));
  const rows = [];
  let skipped = 0;

  for (let r = headerRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const securityId = String(cell(row, keyCol) || "").trim();
    const label = String(cell(row, labelCol) || "").trim();
    if (!securityId && !label) { skipped++; continue; }
    const qtyRaw = String(cell(row, quantityCol) || "").replace(/,/g, "").trim();
    const quantity = qtyRaw && /^-?\d+(\.\d+)?$/.test(qtyRaw) ? Number(qtyRaw) : null;
    const cost = amountCols[0] === undefined ? null : parseMoney(cell(row, amountCols[0]));
    const value = amountCols[1] === undefined ? null : parseMoney(cell(row, amountCols[1]));
    rows.push({
      security_id: securityId,
      label,
      category: String(cell(row, categoryCol) || "").trim(),
      quantity,
      cost_paise: cost,
      value_paise: value,
      purchase_date: dateCols[0] === undefined ? "" : parseDate(cell(row, dateCols[0])),
      interest_date: dateCols[1] === undefined ? "" : parseDate(cell(row, dateCols[1])),
      source_row: r + 1,
    });
  }
  return { rows, skipped, headerRow };
}

export function classifyRegisterCategory(text) {
  const s = String(text || "").toLowerCase();
  if (/mutual\s*fund|asset\s*management|cash\s*ma|motilal|mirae/.test(s)) return "demat";
  if (/gold|sgb|sovereign/.test(s)) return "gold";
  if (/insurance|policy|\blic\b|prulife|metlife|premium|sum\s*assured/.test(s)) return "insurance";
  if (/bond|debenture|\bncd\b/.test(s)) return "bonds";
  if (/ppf|provident|\bepf\b/.test(s)) return "fd";
  if (/fixed\s*deposit|\bfd\b|deposit/.test(s)) return "fd";
  return "other";
}

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const digits = (v) => String(v ?? "").replace(/\D/g, "");
const looksLikeNumber = (v) => {
  const s = clean(v);
  if (s.length < 4 || s.length > 40) return false;
  if (parseDateInText(s)) return false;
  const d = digits(s);
  return d.length >= 4 && d.length <= 24;
};
const compactRef = (v) => /^[A-Z]{1,6}\d{2,10}$/i.test(clean(v));
function extractNumber(...parts) {
  for (const part of parts) {
    if (compactRef(part)) return clean(part);
  }
  for (const part of parts) {
    const s = clean(part);
    const m = s.match(/(?:fd|policy|a\/c|account|acct|no\.?|number)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\/\-]{5,})/i);
    if (m && looksLikeNumber(m[1])) return m[1];
  }
  for (const part of parts) {
    const s = clean(part);
    if (looksLikeNumber(s)) return s;
  }
  return "";
}
function extractRate(...parts) {
  for (const part of parts) {
    const s = clean(part);
    const m = s.match(/(\d+(?:\.\d+)?)\s*%/) || s.match(/@\s*(\d+(?:\.\d+)?)/);
    if (m) {
      const v = Number(m[1]);
      if (v > 0 && v <= 100) return Math.round(v * 100);
    }
  }
  return null;
}
function inferInstitution(text) {
  const s = String(text || "").toLowerCase();
  const names = [
    ["standard chartered", "Standard Chartered"], ["scb", "Standard Chartered"],
    ["punjab national", "PNB"], ["pnb", "PNB"],
    ["bank of baroda", "Bank of Baroda"], ["baroda", "Bank of Baroda"], ["vijaya", "Bank of Baroda"],
    ["state bank", "SBI"], ["sbi", "SBI"], ["icici", "ICICI"], ["hdfc", "HDFC"],
    ["axis", "Axis"], ["kotak", "Kotak"], ["mirae", "Mirae"], ["motilal", "Motilal Oswal"],
    ["lic", "LIC"], ["prulife", "ICICI Prudential"], ["metlife", "PNB MetLife"],
  ];
  for (const [needle, name] of names) if (s.includes(needle)) return name;
  return "";
}
function registerLabel(desc, number, institution, category) {
  let label = clean(desc);
  // Labels come from free-text cells that often contain a URL, an email, a
  // person's name and a policy document number. Keep a short product name.
  label = label.replace(/https?:\/\/\S+/gi, " ").replace(/\S+@\S+/g, " ").trim();
  const policyName = label.match(/policy\s*name\s*:?\s*([^|;]+)/i);
  const tail = String(number || "").replace(/\D/g, "").slice(-4);
  if (category === "insurance") {
    const product = policyName ? policyName[1].trim() : "";
    const name = product || "policy";
    const prefix = product && institution
      && product.toLowerCase().startsWith(institution.toLowerCase()) ? "" : institution;
    return [prefix, name, tail].filter(Boolean).join(" ").slice(0, 70);
  }
  if (category === "fd") {
    if (institution || tail) return [institution, "FD", tail].filter(Boolean).join(" ").slice(0, 70);
  }
  if (category === "demat") {
    return [institution, "mutual fund"].filter(Boolean).join(" ").slice(0, 70);
  }
  if (category === "gold") {
    return ["Gold", institution].filter(Boolean).join(" · ").slice(0, 70);
  }
  if (!label && number) label = number;
  if (/^[\d\/\-]+$/.test(label)) {
    label = `${institution || "FD"} ${label.slice(-4)}`;
  }
  if (label.length > 70) label = label.slice(0, 68).trim() + "…";
  return label;
}
function parseRegisterRow(row, cols, sectionInstitution, rawRow) {
  const get = (i) => (i >= 0 ? cell(row, i) : "");
  const desc = clean(get(cols.label));
  // A date number format on an Amount cell makes the formatted value look
  // like a date ("30-May-11"). The raw cell still holds the amount, so use
  // that when the caller provides a raw matrix.
  const amountRaw = rawRow ? cell(rawRow, cols.amount) : get(cols.amount);
  const amount = parseMoney(amountRaw);
  const paid = [cols.paid, cols.paid2, cols.paid3]
    .map((i) => parseMoney(get(i))).find((v) => v !== null && v > 0) ?? null;
  const value = amount !== null ? amount : paid;
  const number = extractNumber(get(cols.number), desc, get(cols.notes),
    get(cols.bank), get(cols.contact));
  const text = [desc, get(cols.notes), get(cols.bank), get(cols.contact), number].join(" ");
  let category = classifyRegisterCategory(text);
  let start = parseDateInText(get(cols.start));
  if (!start && category === "insurance") {
    // Insurance rows often put the policy start in the notes, not the date
    // column: "Nov 6, 2011 Policy No: ...". Take the first date before the
    // maturity date.
    for (const part of [get(cols.notes), get(cols.recurring), get(cols.bank), get(cols.contact)]) {
      const d = parseDateInText(part);
      if (d) { start = d; break; }
    }
  }
  const dateParts = [get(cols.bank), get(cols.contact), get(cols.last), get(cols.notes),
    get(cols.recurring), get(cols.paid), get(cols.paid2)];
  const pickMaturity = (parts) => {
    // Take the date directly after the word "maturity", not the first date in
    // a cell that also mentions a last-payment date.
    const hint = /(?:maturity|\bmat\b|matures|upto|due)/i;
    for (const part of parts) {
      const t = clean(part);
      const at = t.search(hint);
      if (at >= 0) {
        const d = parseDateInText(t.slice(at, at + 60));
        if (d) return d;
      }
    }
    for (const part of parts) {
      const t = clean(part);
      // A cell that is just a date, in any format the parser knows. This
      // includes "5-Dec-26", which the old numeric-only check missed.
      const direct = parseDate(t);
      if (direct) return direct;
    }
    // If the same date appears in two free-text cells, it is the maturity even
    // when neither cell says "maturity". One date in one cell is not enough.
    const seen = new Map();
    for (const part of parts) {
      const d = parseDateInText(part);
      if (d) seen.set(d, (seen.get(d) || 0) + 1);
    }
    for (const [d, n] of seen) if (n >= 2) return d;
    return "";
  };
  const maturity = pickMaturity(dateParts);
  const rate = extractRate(get(cols.notes), get(cols.bank), get(cols.contact));
  let institution = inferInstitution(text)
    || (["fd", "insurance", "bonds"].includes(category) ? sectionInstitution : "");
  let label = registerLabel(desc, number, institution, category);
  // A bank FD block often has no word "FD" in the row: the number, maturity
  // date and the bank section heading are the evidence. Treat that structure
  // as a fixed deposit instead of dropping the row as "other".
  if (category === "other" && sectionInstitution && number && maturity) {
    category = "fd";
    institution = institution || sectionInstitution;
    label = registerLabel(desc, number, institution, category);
  }
  const notes = clean([get(cols.notes), get(cols.bank), get(cols.contact)]
    .filter(Boolean).join(" · ")).slice(0, 260);
  const dated = category === "fd" || category === "insurance" || category === "bonds";
  return { label, number, institution, category, notes, start_date: start,
    maturity_date: dated ? maturity : "", rate_bps: rate, amount_paise: value,
    sum_assured_paise: category === "insurance" ? value : null,
    premium_paise: category === "insurance" ? parseMoney(get(cols.recurring)) : null,
    source_row: 0 };
}
export function parseRegister(matrix, sheet, rawMatrix) {
  const headerRow = Math.max(0, (sheet.header_row || 1) - 1);
  const header = (matrix[headerRow] || []).map((v) => clean(v).toLowerCase());
  const find = (re, fallback) => {
    const i = header.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  const cols = {
    label: find(/description|particular|asset|name/, colIndex("A")),
    amount: find(/^amount$|principal|sum\s*assured|invested/, colIndex("B")),
    start: find(/commence|start|issue/, colIndex("C")),
    number: find(/policy|fd\s*(no|number)|reference|number/, colIndex("D")),
    notes: find(/extras|notes|remark/, colIndex("E")),
    bank: find(/bank|institution/, colIndex("F")),
    contact: find(/contact|maturity|status/, colIndex("G")),
    recurring: find(/recurring|premium/, colIndex("H")),
    last: find(/last|payment/, colIndex("K")),
    paid: find(/amt\s*paid|amount\s*paid|current\s*value/, colIndex("J")),
    paid2: colIndex("I"),
    paid3: colIndex("L"),
  };
  const rows = [];
  let skipped = 0;
  let section = "";
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    if (!row.some((v) => clean(v))) { skipped++; continue; }
    const parsed = parseRegisterRow(row, cols, section,
      rawMatrix ? (rawMatrix[r] || []) : null);
    parsed.source_row = r + 1;
    const text = `${parsed.label} ${parsed.notes}`;
    if (!parsed.label || /^total\b/i.test(parsed.label)) { skipped++; continue; }
    if (parsed.category === "other") {
      const heading = inferInstitution(text);
      if (heading && !parsed.number && parsed.amount_paise === null) section = heading;
      skipped++; continue;
    }
    // A section title with no amount is not an asset. An FD with a number but
    // no principal is kept, so the user can fill the missing value later.
    if (parsed.amount_paise === null && !parsed.number) { skipped++; continue; }
    if (parsed.category === "insurance" && /^paid$/i.test(parsed.label)) { skipped++; continue; }
    rows.push(parsed);
  }
  return { rows, skipped, headerRow: headerRow + 1, cols };
}

// Insurance policies are counted at the premiums actually paid, not at the
// cover or the recurring premium. The sheet puts the paid amount in I, J or L
// depending on the policy, so take the largest recorded payment.
function insurancePaid(get) {
  const paid = ["I", "J", "L"]
    .map((col) => parseMoney(get(col)))
    .filter((v) => v !== null && v > 0);
  return paid.length ? Math.max(...paid) : null;
}

// Apply a Bonsai section plan to the register sheet. Bonsai decides which row
// blocks are insurance, FD, mutual fund or gold; this function reads the cells
// of each block with the columns Bonsai chose. It never invents a value.
export function applyAssetPlan(matrix, plan, rawMatrix) {
  const rows = [];
  let skipped = 0;
  for (const section of (plan?.sections || [])) {
    const kind = String(section.kind || "").toLowerCase();
    if (!["fd", "insurance", "demat", "gold", "bonds"].includes(kind)) continue;
    for (let r = Math.max(0, section.first_row - 1);
         r <= Math.min(matrix.length - 1, section.last_row - 1); r++) {
      const row = matrix[r] || [];
      const rawRow = rawMatrix ? (rawMatrix[r] || []) : null;
      const get = (letter) => letter ? cell(row, colIndex(letter)) : "";
      const getRaw = (letter) => (rawRow && letter) ? cell(rawRow, colIndex(letter)) : "";
      const desc = clean(get("A"));
      if (!desc && !get("B") && !get("D")) { skipped++; continue; }
      if (/^total\b/i.test(desc)
          || /salary|gratuity|\bhra\b|\blta\b|cab service|password|login/i.test(desc)) {
        skipped++; continue;
      }
      const rawNumber = get(section.number_col);
      const number = looksLikeNumber(rawNumber) ? clean(rawNumber)
        : extractNumber(rawNumber, desc, get("D"), get("E"), get("A"));
      let principal = parseMoney(getRaw(section.principal_col));
      if (principal === null) principal = parseMoney(get(section.principal_col));
      if (principal === null) {
        for (const col of ["I", "J", "B"]) {
          const v = parseMoney(get(col));
          if (v !== null) { principal = v; break; }
        }
      }
      let start = parseDateInText(get(section.start_col)) || parseDateInText(get("C"));
      if (!start && kind === "insurance") {
        start = parseDateInText(get("E")) || parseDateInText(get("K"));
      }
      let maturity = "";
      if (kind !== "demat" && kind !== "gold") {
        maturity = parseDateInText(get(section.maturity_col));
        if (!maturity) {
          const parts = [get("F"), get("G"), get("H"), get("K"), get("E")];
          const hint = /(?:maturity|\bmat\b|matures|upto|due)/i;
          for (const part of parts) {
            const t = clean(part);
            const at = t.search(hint);
            if (at >= 0) { const d = parseDateInText(t.slice(at, at + 60)); if (d) { maturity = d; break; } }
          }
          if (!maturity) {
            for (const part of parts) {
              const d = parseDate(clean(part));
              if (d) { maturity = d; break; }
            }
          }
          if (!maturity) {
            const seen = new Map();
            for (const part of parts) {
              const d = parseDateInText(part);
              if (d) seen.set(d, (seen.get(d) || 0) + 1);
            }
            for (const [d, n] of seen) if (n >= 2) { maturity = d; break; }
          }
        }
      }
      const rate = extractRate(get(section.rate_col), get("E"), get("F"), get("G"));
      const text = [desc, get("E"), get("F"), get("G"), number].join(" ");
      const institution = inferInstitution(text)
        || clean(section.institution).split("/")[0].trim();
      const label = registerLabel(desc, number, institution, kind);
      const notes = clean([get(section.notes_col), get("F"), get("G")]
        .filter(Boolean).join(" · ")).slice(0, 260);
      if (principal === null && !number && !maturity) { skipped++; continue; }
      const premium = kind === "insurance" ? insurancePaid(get) : null;
      // B is the sheet's "Amount". For insurance it is only a plausible cover
      // when it is larger than everything paid; otherwise it is the annual
      // premium and must not be shown as the sum assured.
      const cover = kind === "insurance" && principal !== null && premium !== null
        && principal > premium ? principal : null;
      rows.push({
        label, number, institution, category: kind, notes,
        start_date: start, maturity_date: maturity, rate_bps: rate,
        amount_paise: principal,
        sum_assured_paise: cover,
        premium_paise: premium,
        source_row: r + 1,
      });
    }
  }
  return { rows, skipped, headerRow: 1 };
}

export function parseSheet(matrix, sheet, rawMatrix) {
  if (!sheet || sheet.importable === false) {
    return { kind: sheet?.purpose || "unknown", rows: [], skipped: 0,
      error: sheet ? "not importable" : "no profile for this sheet" };
  }
  if (sheet.purpose === "transactions") {
    const p = parseTransactions(matrix, sheet);
    return { kind: "transactions", ...p, error: null };
  }
  if (sheet.purpose === "holdings") {
    const p = parseHoldings(matrix, sheet);
    return { kind: "holdings", ...p, error: null };
  }
  if (sheet.purpose === "register") {
    const p = parseRegister(matrix, sheet, rawMatrix);
    return { kind: "register", ...p, error: null };
  }
  return { kind: sheet.purpose || "other", rows: [], skipped: 0,
    error: `sheet purpose "${sheet.purpose}" is not imported` };
}

export function profileFor(profile, sheetIndex) {
  return (profile?.sheets || []).find((s) => Number(s.i) === Number(sheetIndex)) || null;
}

// A profile is a file the user chooses, and its asset_id/account_id become an
// account id, a DOM id and a quoted argument in generated HTML. Accept only the
// shape this app creates; anything else is skipped so the caller can fall back
// to a generated id or the account guess.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function safeId(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const s = String(value);
  return SAFE_ID.test(s) ? s : fallback;
}
