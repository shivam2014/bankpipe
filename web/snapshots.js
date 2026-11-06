// How many local snapshots a browser keeps, and which ones a bulk delete should
// remove. Snapshots are sealed copies of the whole database, so a dozen of them
// is tens of megabytes of storage on a phone: the limit is a setting, not a
// constant, and the default is unchanged at twelve.
//
// Pure: the caller passes the stored value and the list, so this is testable
// without a browser.

export const KEEP_DEFAULT = 12;
export const KEEP_OPTIONS = [3, 4, 6, 12, 24];
export const KEEP_KEY = "bp.snapshots.keep";

/** A stored limit, or the default when the value is missing or not offered. */
export function clampKeep(value) {
  const n = Number(value);
  return KEEP_OPTIONS.includes(n) ? n : KEEP_DEFAULT;
}

/** Read the limit from a Storage object. A blocked storage reads as the default. */
export function readKeep(storage) {
  try {
    return clampKeep(storage?.getItem(KEEP_KEY));
  } catch { return KEEP_DEFAULT; }
}

/** Keys past the limit, newest first, ready to delete. */
export function keysToPrune(list, keep) {
  const n = clampKeep(keep);
  return (list || []).slice(n).map((x) => x?.key).filter(Boolean);
}

/** Every key in a selection that still exists. A stale key must not be deleted. */
export function selectedKeys(list, selected) {
  const have = new Set((list || []).map((x) => x?.key).filter(Boolean));
  return [...(selected || [])].filter((key) => have.has(key));
}

/** Are all of these rows selected? An empty list is not "all". */
export function allSelected(list, selected) {
  const keys = (list || []).map((x) => x?.key).filter(Boolean);
  if (!keys.length) return false;
  const sel = new Set(selected || []);
  return keys.every((key) => sel.has(key));
}

/** Add or remove one key, returning a new set. */
export function toggleKey(selected, key) {
  const next = new Set(selected || []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
