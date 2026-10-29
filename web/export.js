// Plaintext export. The "leave" path.
//
// If a user cannot take their data out in a format anything else can read, it
// was never really theirs. This is deliberately boring: a CSV with a header row
// and a JSON with the same facts.

const CSV_COLUMNS = [
  "account", "date", "amount", "balance", "narration", "ref", "source_row",
];

// RFC 4180 quoting: double the quotes, wrap anything containing a delimiter,
// a quote or a newline. A text cell that begins with a spreadsheet formula
// trigger gets an apostrophe; actual numbers are left numeric so a negative
// amount is not turned into text. Exported because every CSV writer in the app
// must apply the same formula guard.
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = CSV_COLUMNS) {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  // A trailing newline is what every spreadsheet and POSIX tool expects.
  return lines.join("\n") + "\n";
}

export function toJson(rows) {
  return JSON.stringify({ exported_at: new Date().toISOString(), count: rows.length, rows }, null, 2);
}

// Amounts stay integer paise in the export, because converting to a float on
// the way out is how rounding errors get baked into someone's records.
export function snapshotRows(store) {
  const db = store.raw();
  const res = db.exec(`
    SELECT f.account_id AS account, f.txn_date AS date, f.amount_paise AS amount,
           f.balance_paise AS balance, f.narration AS narration, f.ref AS ref,
           f.source_row AS source_row
    FROM fact f
    ORDER BY f.account_id, f.txn_date, f.id`);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(v.map((x, i) => [columns[i], x])));
}
