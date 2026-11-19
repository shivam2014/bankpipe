// The Assets screen lets the owner tick several assets and delete them in one
// action. This module owns the arithmetic, the words the confirm uses, and the
// one-snapshot-then-loop. The page owns the ticks and the rendering.

import { assetValue, categoryOf } from "./assets.js";

function metaOf(asset) {
  if (asset?.meta && typeof asset.meta === "object") return asset.meta;
  try { return JSON.parse(asset?.meta || "{}") || {}; } catch { return {}; }
}

// A ticked id is only a request. An asset that vanished between the render and
// the press is dropped, and a demat that appears in more than one class row is
// still one asset.
export function selectedAssets(assets, selected) {
  const wanted = new Set(selected || []);
  const seen = new Set();
  const out = [];
  for (const asset of assets || []) {
    if (!asset || !wanted.has(asset.id) || seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push(asset);
  }
  return out;
}

// The bar prints the count and the sum of the ticked assets' own values, never
// the rolled-up bank row, because a linked FD stays behind when its account goes.
export function selectionSummary(assets, selected) {
  const picked = selectedAssets(assets, selected);
  let valuePaise = 0;
  let valued = 0;
  let noValue = 0;
  for (const asset of picked) {
    const value = assetValue(asset).paise;
    if (value === null || value === undefined) {
      noValue += 1;
      continue;
    }
    valuePaise += value;
    valued += 1;
  }
  return { ids: picked.map((asset) => asset.id), count: picked.length,
    valued, noValue, valuePaise };
}

export function bulkDeleteBarText(count, valuePaise, formatMoney = String) {
  if (!count) return "Delete";
  return `Delete ${count} · ${formatMoney(valuePaise)}`;
}

// What the confirm must settle before anything goes: how many assets, the
// holdings and imported transactions that go with them, and the linked FDs
// that will not go. The snapshot sentence matches the single-asset delete.
export function bulkDeleteConfirmText({ count = 0, holdings = 0, transactions = 0,
  linkedFds = 0, linkedFdNames = [] } = {}) {
  const assets = `${count} asset${count === 1 ? "" : "s"}`;
  const extras = [];
  if (holdings) extras.push(`${holdings} holding${holdings === 1 ? "" : "s"}`);
  if (transactions) {
    extras.push(`${transactions} imported transaction${transactions === 1 ? "" : "s"}`);
  }
  let text = `Delete ${assets}`;
  if (extras.length) {
    text += ` and ${count === 1 ? "its" : "their"} ${extras.join(" and ")}`;
  }
  text += "?";
  if (linkedFds) {
    const named = (linkedFdNames || []).filter(Boolean);
    const which = named.length && named.length <= 3 ? ` (${named.join(", ")})` : "";
    text += `\n\n${linkedFds} linked fixed deposit${linkedFds === 1 ? "" : "s"}${which} `
      + "will stay and become unlinked.";
  }
  text += "\n\nA snapshot of the database is taken first, "
    + "so this can be restored from Settings.";
  return text;
}

// Read everything the confirm needs before it is shown. A selected FD is not a
// linked FD that stays: it goes with the rest.
export async function bulkDeleteFacts(store, ids) {
  const accounts = await store.listAccounts();
  const picked = selectedAssets(accounts, ids);
  const chosen = new Set(picked.map((asset) => asset.id));
  const rows = await Promise.all(picked.map(async (asset) => {
    const [detail, holdings] = await Promise.all([
      store.accountDetail(asset.id), store.listHoldings(asset.id),
    ]);
    return { asset, holdings: (holdings || []).length,
      transactions: Number(detail?.totals?.n) || 0 };
  }));
  const linked = accounts.filter((asset) => categoryOf(asset) === "fd"
    && !chosen.has(asset.id)
    && chosen.has(metaOf(asset).linked_account_id));
  return {
    accounts: picked,
    rows,
    holdings: rows.reduce((sum, row) => sum + row.holdings, 0),
    transactions: rows.reduce((sum, row) => sum + row.transactions, 0),
    linkedFds: linked.length,
    linkedFdNames: linked.map((asset) => asset.label || asset.id),
  };
}

// One snapshot, then one deleteAccount per ticked id, in the order the page
// lists them. A failure stops the loop and names the id so the receipt can say
// which asset is still there and which ones were never touched.
export async function bulkDeleteAssets({ store, ids, label = "" }) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  const before = await store.listAccounts();
  const present = selectedAssets(before, wanted).map((asset) => asset.id);
  const missing = wanted.filter((id) => !present.includes(id));
  if (!present.length) {
    return { deleted: [], missing, failed: null, remaining: [],
      snapshot: null, snapshotError: "" };
  }
  const snapshotLabel = label || `Before deleting ${present.length} `
    + `asset${present.length === 1 ? "" : "s"}`;
  let snapshot = null;
  let snapshotError = "";
  try {
    snapshot = await store.snapshotDb(snapshotLabel);
  } catch (error) {
    snapshotError = String(error?.message || error);
  }
  const deleted = [];
  for (let index = 0; index < present.length; index += 1) {
    const id = present[index];
    try {
      await store.deleteAccount(id);
      deleted.push(id);
    } catch (error) {
      return { deleted, missing, failed: id, error: String(error?.message || error),
        remaining: present.slice(index + 1), snapshot, snapshotError };
    }
  }
  return { deleted, missing, failed: null, remaining: [],
    snapshot, snapshotError };
}
