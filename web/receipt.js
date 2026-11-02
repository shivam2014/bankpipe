// Per-import source receipt. Counts only: no narration, account number, holder,
// bank, file name or sheet name. The workbook and statement paths both build
// this shape so Health can compare what the source held with what was stored.

const number = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Non-empty rows after a 1-based header row. A row counts when any cell has a
// non-blank value; formatting-only rows that carry nothing are not real rows.
export function countRows(matrix, headerRow) {
  const start = Math.max(0, number(headerRow));
  let n = 0;
  for (let r = start; r < (matrix?.length || 0); r++) {
    if ((matrix[r] || []).some((value) => String(value ?? "").trim())) n++;
  }
  return n;
}

// Build the receipt from accepted rows. `read` is the source row count after
// the header; `parsed` is what the parser accepted. A row with an amount but
// no date is still accepted, and is counted separately so it is visible.
export function receiptFrom(rows, {
  sheet = 0, read = null, reasons = null, strayRows = [], orphanRows = [], opening = null,
} = {}) {
  const accepted = (rows || []).filter(Boolean);
  let noDate = 0, debit = 0, credit = 0, first = "", last = "";
  for (const row of accepted) {
    const amount = row.amount === null || row.amount === undefined ? null : row.amount;
    const date = row.date === null || row.date === undefined ? "" : String(row.date).trim();
    if (!date && amount !== null) noDate++;
    if (amount !== null) {
      if (amount < 0) debit += -amount;
      else if (amount > 0) credit += amount;
    }
    if (date) {
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
    }
  }
  const counts = reasons && typeof reasons === "object"
    ? {
      total: number(reasons.total), blank: number(reasons.blank),
      stray: number(reasons.stray), orphan: number(reasons.orphan),
    } : null;
  const rejected = counts
    ? counts.total + counts.blank + counts.stray + counts.orphan
    : Math.max(0, number(read) - accepted.length);
  const sourceRows = read === null || read === undefined
    ? accepted.length + rejected : Math.max(0, number(read));
  // What the first stored row implies the account opened at. The printed B/F
  // line is compared with this, so a row lost at the head cannot hide behind a
  // matching delta.
  const dated = accepted.filter((row) => row.date
    && row.amount !== null && row.amount !== undefined
    && row.balance !== null && row.balance !== undefined)
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const openingFromRows = dated.length ? dated[0].balance - dated[0].amount : null;
  return {
    sheet: number(sheet),
    read: sourceRows,
    parsed: accepted.length,
    rejected,
    reasons: counts,
    stray: (strayRows || []).slice(0, 50),
    orphan: (orphanRows || []).slice(0, 50),
    noDate,
    debit,
    credit,
    first,
    last,
    opening: opening === null || opening === undefined ? null : number(opening),
    openingFromRows,
  };
}

// The totals the Data health card shows. Kept to the counts on that card so a
// caller cannot mistake the receipt for a ledger.
export function receiptTotals(rows) {
  const out = { read: 0, parsed: 0, rejected: 0, noDate: 0,
    reasons: { total: 0, blank: 0, stray: 0, orphan: 0 },
    head: { match: 0, mismatch: 0, unknown: 0 } };
  for (const row of rows || []) {
    if (!row) continue;
    out.read += number(row.read);
    out.parsed += number(row.parsed);
    out.rejected += number(row.rejected);
    out.noDate += number(row.noDate);
    out.reasons.total += number(row.reasons?.total);
    out.reasons.blank += number(row.reasons?.blank);
    out.reasons.stray += number(row.reasons?.stray);
    out.reasons.orphan += number(row.reasons?.orphan);
    const opening = row.opening === null || row.opening === undefined
      ? null : number(row.opening);
    const implied = row.openingFromRows === null || row.openingFromRows === undefined
      ? null : number(row.openingFromRows);
    if (opening === null || implied === null) out.head.unknown++;
    else if (Math.abs(opening - implied) <= 1) out.head.match++;
    else out.head.mismatch++;
  }
  return out;
}
