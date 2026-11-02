const count = (n) => Number(n || 0).toLocaleString("en-IN");

// One capped row list, shared by stray, orphan and no-date rows. `rows` is the
// display slice; `total` is the full count, so the overflow is explicit.
export function rowList(label, rows, total) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const n = Number(total || rows.length);
  const more = n > rows.length ? ` (+${count(n - rows.length)} more)` : "";
  return `${label}: ${rows.join(", ")}${more}`;
}
