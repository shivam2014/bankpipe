// The sheet prefix on the source-reconciliation line. An older receipt has no
// account list at all, so it keeps the bare index. A new receipt with no
// account says so instead of leaving a gap. The JSON keeps every identity; the
// line shows the first and counts the rest.
export function sheetAccountLabel(sheet, accounts) {
  if (!Array.isArray(accounts)) return `Sheet ${sheet}`;
  if (!accounts.length) return `Sheet ${sheet} · no account`;
  const more = accounts.length > 1 ? ` +${accounts.length - 1} more` : "";
  return `Sheet ${sheet} · ${accounts[0]}${more}`;
}
