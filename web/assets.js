// Asset categories and value rules. An "account" row is any asset container:
// a bank account, a fixed deposit, a demat account, a bond, gold, cash.
// The category is stable; the subtype is free enough to hold "savings",
// "physical", "sgb" and similar without a migration each time.

import { assetMetrics } from "./finance.js";

export const CATEGORIES = [
  { id: "bank", label: "Bank accounts", types: ["savings", "current"] },
  { id: "fd", label: "Fixed deposits", types: ["fd"] },
  { id: "demat", label: "Demat", types: ["equity", "mutual fund"] },
  { id: "bonds", label: "Bonds", types: ["bond"] },
  { id: "gold", label: "Gold", types: ["physical", "etf", "sgb"] },
  { id: "cash", label: "Cash", types: ["cash"] },
  { id: "insurance", label: "Insurance", types: ["term", "endowment", "ulip", "health"] },
  { id: "property", label: "Property", types: ["property"] },
  { id: "other", label: "Other", types: ["other"] },
];

const LEGACY = {
  savings: "bank", current: "bank", demat: "demat", fd: "fd", cash: "cash",
  bond: "bonds", bonds: "bonds", gold: "gold", property: "property",
  insurance: "insurance", policy: "insurance",
};

export function categoryOf(asset) {
  const direct = String(asset?.category || "").toLowerCase();
  if (CATEGORIES.some((c) => c.id === direct)) return direct;
  const legacy = String(asset?.type || asset?.acct_type || "").toLowerCase();
  return LEGACY[legacy] || "other";
}

export function categoryLabel(id) {
  return (CATEGORIES.find((c) => c.id === id) || { label: "Other" }).label;
}

export function typesFor(id) {
  return (CATEGORIES.find((c) => c.id === id) || { types: ["other"] }).types;
}

// The page asks one function for a value, so FD accrual, gold PnL and bank
// balances cannot drift apart between screens.
export function assetValue(asset) {
  const cat = categoryOf(asset);
  // A matured FD is history, not a current holding. Its money has either been
  // credited or is waiting to be reinvested; it must not inflate net worth.
  if (cat === "fd" && asset?.maturity_date
    && asset.maturity_date < new Date().toISOString().slice(0, 10)) {
    return { paise: null, source: "matured · history" };
  }
  const m = assetMetrics(asset, cat);
  if (m.excluded) return { paise: null, source: "cover, not net worth" };
  return { paise: m.value, source: m.note || "no value yet" };
}

export function totalAssets(assets) {
  return (assets || []).reduce((sum, a) => {
    const v = assetValue(a).paise;
    return sum + (v === null ? 0 : v);
  }, 0);
}

export function groupAssets(assets) {
  const list = assets || [];
  return CATEGORIES.map((c) => {
    const rows = list.filter((a) => categoryOf(a) === c.id);
    return { ...c, rows, total: totalAssets(rows) };
  }).filter((g) => g.rows.length);
}

// The allocation card is about where the money sits, so fixed deposits are
// shown under the bank that holds them. They remain separate assets for
// maturity and interest calculations, and the Assets page nests them under
// the account that funded them.
export function allocationGroups(assets) {
  const list = assets || [];
  const bank = list.filter((a) => categoryOf(a) === "bank");
  const fd = list.filter((a) => categoryOf(a) === "fd");
  const groups = groupAssets(list.filter((a) =>
    !["bank", "fd"].includes(categoryOf(a)))).filter((g) => g.total > 0);
  if (bank.length || fd.length) {
    const bankTotal = totalAssets(bank);
    const fdTotal = totalAssets(fd);
    groups.unshift({
      id: "bank",
      label: "Bank accounts & FDs",
      total: bankTotal + fdTotal,
      rows: [...bank, ...fd],
      children: [
        { id: "bank", label: "Savings", total: bankTotal, count: bank.length },
        { id: "fd", label: "Fixed deposits", total: fdTotal, count: fd.length },
      ].filter((c) => c.count > 0),
    });
  }
  return groups;
}

// The allocation chart is about what the money is invested in, not about which
// container holds it. Bonds inside a demat are still bonds, and fund units are
// neither shares nor bonds, so `demat` and `bonds` containers are split by the
// class of the holdings inside them.
//
// Each asset's parts are scaled to the value the rest of the app already shows
// for it. A holding with no price must not make the ring disagree with the total
// printed beside it, and a class with no recorded value falls back to the
// container's own subtype rather than being dropped.
export function allocationByClass(assets, byClass) {
  const classOf = (a) => {
    const id = a?.id;
    const fromRows = byClass?.[id];
    if (fromRows) return fromRows;
    const bond = Number(a?.class_bond_value) || 0;
    const equity = Number(a?.class_equity_value) || 0;
    const mf = Number(a?.class_mf_value) || 0;
    return { bond, equity, mf };
  };
  const base = allocationGroups(assets);
  const out = [];
  for (const group of base) {
    if (group.id !== "bonds" && group.id !== "demat") { out.push(group); continue; }
    const parts = { bond: { total: 0, rows: [] }, equity: { total: 0, rows: [] },
      mf: { total: 0, rows: [] } };
    for (const asset of group.rows) {
      const worth = assetValue(asset).paise || 0;
      const raw = classOf(asset);
      const rawSum = raw.bond + raw.equity + raw.mf;
      let share = raw;
      if (!rawSum) {
        const subtype = String(asset.subtype || "");
        share = /mutual\s*fund/i.test(subtype) ? { bond: 0, equity: 0, mf: worth }
          : group.id === "bonds" ? { bond: worth, equity: 0, mf: 0 }
            : { bond: 0, equity: worth, mf: 0 };
      }
      const scale = rawSum ? worth / rawSum : 1;
      for (const key of ["bond", "equity", "mf"]) {
        if (!share[key]) continue;
        parts[key].total += share[key] * scale;
        if (!parts[key].rows.includes(asset)) parts[key].rows.push(asset);
      }
    }
    const labels = { bond: "Bonds", equity: "Equities", mf: "Mutual funds" };
    for (const key of ["bond", "equity", "mf"]) {
      if (!parts[key].total) continue;
      out.push({ id: key, label: labels[key], total: Math.round(parts[key].total),
        rows: parts[key].rows });
    }
  }
  return out;
}

// What a broker's import can fill on an account without touching what the user
// typed. A demat number is the account's identity, so it only goes in when the
// field is empty; the same for the holder and the broker name.
export function importFillPlan(account, { demat, holder, broker } = {}) {
  const blank = (v) => !String(v ?? "").trim();
  const patch = {};
  if (demat && blank(account?.number)) patch.number = demat;
  if (holder && blank(account?.holder)) patch.holder = holder;
  if (broker && blank(account?.bank)) patch.bank = broker;
  return patch;
}
