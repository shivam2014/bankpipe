// A cost record is what was paid for lots that sit in a demat. It is not an
// account and not an asset, so it never becomes an asset row. The only thing
// the Assets page owes the reader is a task when the record is not attached to
// a live demat yet, and that task has to name the account it would join.
//
// Pure: the page passes the accounts and their rows; nothing here reads storage.

import { bondHomeOf, isLiveBondRow } from "./bonds.js";
import { categoryOf, isFundAccount } from "./assets.js";
import { boId } from "./bo-id.js";

export const NO_DEMAT_SENTENCE = "No demat account holds its bonds.";

function metaOf(asset) {
  if (asset?.meta && typeof asset.meta === "object") return asset.meta;
  try { return JSON.parse(asset?.meta || "{}") || {}; } catch { return {}; }
}

// The same test assetValue and assetSections use. A cost record is marked in
// meta, not by category, so every reader parses the column the same way.
export function isCostRecord(asset) {
  return !!metaOf(asset).cost_only;
}

// A fund folio is a demat-shaped account that holds units, never bonds. It can
// never be the account a bond cost record joins.
export function liveDemats(assets) {
  return (assets || []).filter((asset) => categoryOf(asset) === "demat"
    && !isFundAccount(asset) && !isCostRecord(asset));
}

// Attached means the stored link resolves to a current, non-fund demat. A
// linked_label is only prose: the label can outlive the account it named, so it
// is never evidence that the record is attached.
export function unattachedCostRecords(assets) {
  const live = new Set(liveDemats(assets).map((account) => account.id));
  return (assets || []).filter((asset) => isCostRecord(asset)
    && categoryOf(asset) === "bonds"
    && !(metaOf(asset).linked_asset && live.has(metaOf(asset).linked_asset)));
}

function rowsOf(source, id) {
  if (source instanceof Map) return source.get(id) || [];
  return source?.[id] || [];
}

/**
 * One task per unattached cost record, in the order the page lists them.
 * `target` is the live demat the record's bonds sit in, found the way the rest
 * of the app finds it: the stored link, then the demat number, then ISIN
 * overlap. It is null when no live demat holds a single lot.
 *
 * @param {{assets?: Array<object>,
 *   lots?: Map<string, Array<object>>|object,
 *   positions?: Map<string, Array<object>>|object}} input
 * @returns {Array<{record: object, target: object|null}>}
 */
export function costRecordTasks({ assets = [], lots = new Map(),
  positions = new Map() } = {}) {
  const demats = liveDemats(assets);
  if (!demats.length) return unattachedCostRecords(assets)
    .map((record) => ({ record, target: null }));
  const positionsOf = new Map();
  for (const demat of demats) {
    // The account page finds a home over live bond rows only. A disposed row
    // is history and must not pull a cost record back onto the account.
    const rows = (positions instanceof Map
      ? positions.get(demat.id) : positions?.[demat.id]) || [];
    positionsOf.set(demat.id, rows.filter(isLiveBondRow));
  }
  return unattachedCostRecords(assets).map((record) => {
    const home = bondHomeOf(rowsOf(lots, record.id), record, demats, positionsOf);
    return { record, target: demats.find((demat) => demat.id === home) || null };
  });
}

// The sentence the task block leads with. Singular when one record waits,
// plural when several do; both say what the record is in one line.
export function costRecordSentence(count) {
  if (Number(count) === 1) {
    return "A cost record has no account. It holds what you paid, so the gain can be shown.";
  }
  return `${Number(count) || 0} cost records have no account. `
    + "They hold what you paid, so the gain can be shown.";
}

// "Attach to Demat · Account Holder · …3122": the account's own label, with the
// account tail only when the label does not already carry it.
export function attachActionLabel(account) {
  const label = String(account?.label || "").trim() || "Demat";
  const id = boId(account?.number || "");
  const tail = id.kind === "bo" ? id.boId.slice(-4) : "";
  return `Attach to ${label}${tail && !label.includes(tail) ? ` · …${tail}` : ""}`;
}
