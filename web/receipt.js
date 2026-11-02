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
export function receiptFrom(rows, { sheet = 0, read = null } = {}) {
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
  const sourceRows = read === null || read === undefined
    ? accepted.length : Math.max(0, number(read));
  return {
    sheet: number(sheet),
    read: sourceRows,
    parsed: accepted.length,
    rejected: Math.max(0, sourceRows - accepted.length),
    noDate,
    debit,
    credit,
    first,
    last,
  };
}

// The totals the Data health card shows. Kept to the counts on that card so a
// caller cannot mistake the receipt for a ledger.
export function receiptTotals(rows) {
  const out = { read: 0, parsed: 0, rejected: 0, noDate: 0 };
  for (const row of rows || []) {
    if (!row) continue;
    out.read += number(row.read);
    out.parsed += number(row.parsed);
    out.rejected += number(row.rejected);
    out.noDate += number(row.noDate);
  }
  return out;
}
