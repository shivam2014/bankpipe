// Values that must live in the sealed database, never in a served JSON file or
// in localStorage. The migration helpers only move user-editable fields; an
// import's own new values are kept unless the old field was explicitly set.

export const SSOT_KEYS = {
  workbookTotals: "workbook.totals",
  workbookTotal: "workbook.total",
  accountMeta: "import.accountMeta",
  owners: "import.owners",
  totalSupplement: "import.totalSupplement",
};

export const MANUAL_ACCOUNT_FIELDS = [
  "label", "holder", "ifsc", "branch", "city", "state", "address", "notes", "start_date",
];

export const MANUAL_META_KEYS = [
  "grams", "buy_per_gram_paise", "buy_date", "current_per_gram_paise", "price_date",
  "realised_gain_paise", "premium_paise", "sum_assured_paise", "frequency", "nominee",
  "buy_value_paise", "current_value_paise", "as_of",
];

export function accountKey(asset) {
  const category = String(asset?.category || asset?.type || "").toLowerCase();
  const number = String(asset?.number || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (number) return `${category}:n:${number}`;
  return `${category}:l:${String(asset?.bank || "").toLowerCase()}|${String(asset?.label || "").toLowerCase()}`;
}

function metaObject(meta) {
  if (!meta) return {};
  if (typeof meta === "object") return meta;
  try { return JSON.parse(meta) || {}; } catch { return {}; }
}

export function manualSnapshot(accounts) {
  return (accounts || []).map((asset) => {
    const fields = {};
    for (const key of MANUAL_ACCOUNT_FIELDS) {
      const value = asset?.[key];
      if (value !== null && value !== undefined && String(value).trim() !== "") fields[key] = value;
    }
    const meta = metaObject(asset?.meta);
    const keptMeta = {};
    for (const key of MANUAL_META_KEYS) {
      if (meta[key] !== null && meta[key] !== undefined) keptMeta[key] = meta[key];
    }
    return { key: accountKey(asset), fields, meta: keptMeta };
  });
}

export function manualFor(asset, snapshot) {
  const saved = (snapshot || []).find((x) => x.key === accountKey(asset));
  if (!saved) return null;
  return {
    fields: Object.fromEntries(Object.entries(saved.fields || {})
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")),
    meta: { ...(saved.meta || {}) },
  };
}

export function manualUpdates(accounts, snapshot) {
  const out = [];
  for (const asset of accounts || []) {
    const saved = manualFor(asset, snapshot);
    if (!saved) continue;
    const update = { ...saved.fields };
    if (Object.keys(saved.meta).length) {
      update.meta = JSON.stringify({ ...metaObject(asset.meta), ...saved.meta });
    }
    if (Object.keys(update).length) out.push({ id: asset.id, update });
  }
  return out;
}
