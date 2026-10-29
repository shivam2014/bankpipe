// Shape-only diagnostics. Built so a real statement can be debugged without
// sending a single value, account number, name or narration.
//
// Rule: counts, column mappings, formats and character shapes travel. Values never do.
// A "shape" replaces every letter with A and every digit with 9, and collapses runs
// of four or more into 9{n} / A{n}. So "01/04/2024" becomes "99/99/9{4}" and
// "1250.00" becomes "9{4}.99": the format survives, the content does not.
import { mapHeader, parseDate } from "./parse.js";

export function shape(value) {
  const out = [];
  let prev = null, run = 0;
  const flush = () => {
    if (prev === null) return;
    if ((prev === "9" || prev === "A") && run >= 4) out.push(`${prev}{${run}}`);
    else out.push(prev.repeat(run));
    run = 0;
  };
  for (const ch of String(value ?? "")) {
    const c = /\d/.test(ch) ? "9" : /[A-Za-z]/.test(ch) ? "A"
      : /\s/.test(ch) ? " " : ch;
    if (c === prev) run++;
    else { flush(); prev = c; run = 1; }
  }
  flush();
  return out.join("");
}

// Sheet names are allowed to keep words ("HDFC", "Salary") but never a long digit run.
export function maskLabel(text) {
  return String(text ?? "").replace(/\d{3,}/g, (m) => "#".repeat(Math.min(m.length, 8)));
}

export function dateFormat(value) {
  const s = String(value ?? "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return "dd/mm/yyyy";
  if (/^\d{2}\/\d{2}\/\d{2}$/.test(s)) return "dd/mm/yy";
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return "dd.mm.yyyy";
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(s)) return "dd.mm.yy";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "iso";
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s)) return "other-numeric";
  return s ? "text" : "empty";
}

// One sheet, described only by counts, formats and shapes.
export function sheetReport(name, rows, parsed, extra = {}) {
  const headerRow = parsed.header || null;
  const headerCells = headerRow ? (rows[headerRow - 1] || []) : [];
  const map = mapHeader(headerCells);
  const dateCol = map.date;

  const formats = {};
  let rawDates = 0, unparsedDates = 0;
  if (headerRow && dateCol !== undefined) {
    for (let i = headerRow; i < rows.length; i++) {
      const raw = String((rows[i] || [])[dateCol] ?? "").trim();
      if (!raw) continue;
      rawDates++;
      const f = dateFormat(raw);
      formats[f] = (formats[f] || 0) + 1;
      if (!parseDate(raw)) unparsedDates++;
    }
  }

  const parsedRows = parsed.rows || [];
  const dated = parsedRows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")).length;
  const amounts = parsedRows.filter((r) => r.amount !== null && r.amount !== undefined).length;

  return {
    sheet: shape(name),
    headerRow,
    error: parsed.error || null,
    columns: headerCells.filter((c) => String(c ?? "").trim()).slice(0, 20).map(shape),
    mapping: Object.entries(map).map(([k, i]) => `${k}@${i}`),
    rawRows: rows.length,
    rows: rowsAfterHeader(rows, headerRow),
    parsed: parsedRows.length,
    skipped: parsed.skipped || 0,
    dated,
    amounts,
    missingAmount: parsedRows.length - amounts,
    rawDates,
    dateFormats: formats,
    unparsedDates,
    samples: parsedRows.slice(0, 3).map((r) => [
      shape(r.date), shape(String(r.description || "").slice(0, 24)),
      shape(r.amount), shape(r.balance),
    ]),
    ...extra,
  };
}

function rowsAfterHeader(rows, headerRow) {
  if (!headerRow) return 0;
  let n = 0;
  for (let i = headerRow; i < rows.length; i++) {
    if ((rows[i] || []).some((c) => String(c ?? "").trim())) n++;
  }
  return n;
}

export function buildReport(meta, sheets) {
  const lines = [
    "BANKPIPE DIAGNOSTICS",
    "====================",
    "format: 1 (shape-only; no values)",
    `file: *${meta.ext || ""}  bytes: ${meta.bytes || 0}`,
    `sha256_16: ${String(meta.sha256 || "").slice(0, 16)}`,
    `generated: ${new Date().toISOString()}`,
  ];
  (sheets || []).forEach((s, i) => {
    lines.push("", `SHEET ${i + 1} (${s.sheet})`);
    lines.push(`  header_row=${s.headerRow ?? "none"} error=${s.error || "none"}`);
    lines.push(`  columns: ${(s.columns || []).join(" | ") || "none"}`);
    lines.push(`  mapping: ${(s.mapping || []).join(", ") || "none"}`);
    lines.push(`  raw_rows=${s.rawRows} rows=${s.rows} parsed=${s.parsed} skipped=${s.skipped}`
      + ` dated=${s.dated} amounts=${s.amounts} missing_amount=${s.missingAmount}`);
    lines.push(`  raw_dates=${s.rawDates} date_formats=${JSON.stringify(s.dateFormats)}`
      + ` unparsed_dates=${s.unparsedDates}`);
    if (s.note) lines.push(`  note: ${s.note}`);
    if (s.inserted !== undefined) {
      lines.push(`  imported=${s.inserted} already_held=${s.duplicates}`
        + ` match=${maskLabel(s.match || "")}`);
    }
    for (const smp of s.samples || []) lines.push(`  sample: ${smp.join("  |  ")}`);
  });
  return lines.join("\n");
}

export function diagnosticsFileName(date = new Date()) {
  return `bankpipe-diagnostics-${date.toISOString().slice(0, 10)}.txt`;
}
