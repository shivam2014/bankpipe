// Decisions for the multi-file statement queue. Kept pure so the rules can be
// tested without a DOM: a PDF belongs to one account, a repeated file is
// skipped, and a destination reads the same way in every row.

// A PDF is one file, so it may carry one account's transactions. Blocks with
// no rows are summaries, not a second account, and are ignored. Two or more
// blocks with rows mean the file has to be split by hand: silently choosing one
// would lose the other account's rows.
export function choosePdfBlock(accounts) {
  const withRows = (accounts || []).filter((block) => block
    && Array.isArray(block.rows) && block.rows.length > 0);
  if (!withRows.length) return { error: "No transactions found in this PDF." };
  if (withRows.length > 1) {
    return { error: "This PDF has transactions for more than one account. "
      + "Split it per account and import one file per account." };
  }
  return { block: withRows[0] };
}

// Mark every entry after the first one with the same bytes. `duplicateOf` is
// the 1-based queue position of the first copy, so the row can say "Same file
// as #1". Entries without a hash never match: a failed digest proves nothing.
// The function clears old marks and returns the same array, so a queue can be
// rechecked after a row is removed.
export function duplicateFile(entries) {
  const seen = new Map();
  for (let i = 0; i < (entries || []).length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    entry.duplicateOf = 0;
    const hash = String(entry.sha256 || "");
    if (!hash) continue;
    if (seen.has(hash)) entry.duplicateOf = seen.get(hash);
    else seen.set(hash, i + 1);
  }
  return entries;
}

// "PNB savings · …7585". The account is the destination the row will use; a
// row waiting on "Create …" has no account yet, so the label is empty.
export function accountLabel(entry, accounts) {
  const wanted = entry?.accountId && entry.accountId !== "__new__"
    ? entry.accountId
    : entry?.guessId || entry?.guess?.id || "";
  const account = (accounts || []).find((a) => a && a.id === wanted);
  if (!account) return "";
  const name = String(account.label || account.bank || account.id || "").trim();
  const digits = String(account.number || "").replace(/\D/g, "");
  return digits ? `${name} · …${digits.slice(-4)}` : name;
}
