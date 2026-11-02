// Copy and severity for the DigiFInn bond sync preview. Two things here are
// destructive: moving a Demat to another portfolio, and replacing holdings that
// the report does not cover. The card renders these before the numbers, and
// Apply repeats them in its confirm, so neither is one click away.
//
// Pure strings only. No file name, Demat number, holder or lot identity.

// `sync` is the buildBondSync result: `removed` is a count and `warnings` are
// informational sentences (duplicate ISIN, missing report, as-of mismatch).
export function bondSyncNotices(sync, {
  target = "", mapped = "", mappedLabel = "", mismatch = false, mismatchLine = "",
} = {}) {
  const dangers = [];
  if (mismatch && mismatchLine) dangers.push(mismatchLine);
  if (target === "__new__" && mapped) {
    dangers.push(`This Demat is already mapped to ${mappedLabel || mapped}.`
      + " Creating a new portfolio may duplicate it.");
  } else if (target !== "__new__" && mapped && mapped !== target) {
    dangers.push(`This Demat is mapped to ${mappedLabel || mapped}.`
      + " Applying here will move the mapping to this portfolio.");
  }
  const removed = Number(sync?.removed || 0);
  if (removed > 0) {
    dangers.push(`Applying here removes ${removed} existing`
      + ` lot${removed === 1 ? "" : "s"} from this portfolio.`);
  }
  const notes = (sync?.warnings || []).filter((w) => typeof w === "string" && w);
  return { dangers, notes };
}

// The Apply confirmation. Dangers come first, then the informational notes the
// old confirm already carried, so the destructive part is read before the rest.
export function bondSyncConfirmText({ target = "", name = "", current = 0,
  dangers = [], notes = [] } = {}) {
  const action = target === "__new__"
    ? `Create “${name}” and import ${current} current lots?`
    : `Replace the holdings on this portfolio with ${current} current lots?`;
  return [action, ...dangers, ...notes].filter(Boolean).join("\n\n");
}
