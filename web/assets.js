// Asset categories and value rules. An "account" row is any asset container:
// a bank account, a fixed deposit, a demat account, a bond, gold, cash.
// The category is stable; the subtype is free enough to hold "savings",
// "physical", "sgb" and similar without a migration each time.

import { assetMetrics, fdMatured } from "./finance.js";

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

const FUND_WORDS = /mutual\s*fund|^mf$/i;

// The meta column is JSON text in the database and an object in tests, so every
// reader parses it the same way and a malformed row never breaks a page.
function assetMeta(asset) {
  if (asset?.meta && typeof asset.meta === "object") return asset.meta;
  try { return JSON.parse(asset?.meta || "{}") || {}; } catch (e) { return {}; }
}

// A folio is a demat-shaped account that holds one AMC's fund units. It is not
// a custody account, so it may hold fund rows but never bond or share positions.
export function isFundAccount(asset) {
  return categoryOf(asset) === "demat"
    && FUND_WORDS.test(String(asset?.subtype || ""));
}

// A securities account holds market positions: a demat, a fund folio (a demat
// subtype) or a bond portfolio. A bank account and an FD hold money, not
// securities, and follow the bank statement flow instead.
export function isSecuritiesAccount(asset) {
  const cat = categoryOf(asset);
  return cat === "demat" || cat === "bonds";
}

// A cost record only says what was paid for lots that sit on a demat. It holds
// nothing itself, so no statement can be imported into it.
export function isImportAccount(asset) {
  if (!isSecuritiesAccount(asset)) return false;
  return !assetMeta(asset).cost_only;
}

// Only a depository account can receive a CAS snapshot. A bond portfolio is a
// cost record even when it holds the same ISIN, so a CAS must not attach there.
export function isDepositoryAccount(asset) {
  return isImportAccount(asset) && categoryOf(asset) === "demat";
}

// One class per holding row, shared by the account page and the class pages.
// A bond is bond first; a fund by its category, its legacy category or an INF
// ISIN; everything else is a share. The SQL totals in db.js mirror this rule.
export function holdingClass(row) {
  const cat = String(row?.category || "").trim().toLowerCase();
  if (cat === "bond") return "bond";
  if (["mf", "mutual fund", "mutualfund", "fund"].includes(cat)) return "mf";
  if (/^INF/i.test(String(row?.security_id || "").trim())) return "mf";
  return "equity";
}

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
  // A cost record is not a holding: after its lots are attached to the demat
  // account, counting it again would put the same bond in net worth twice.
  const meta = assetMeta(asset);
  if (meta.cost_only) {
    // A cost record says where its lots went, so the portfolio page answers
    // "which demat is this?" without the reader opening another screen.
    return { paise: null, source: meta.linked_label
      ? `cost record · linked to ${meta.linked_label} · not counted`
      : "cost record · not counted" };
  }
  // A class row is one part of a demat account, not the whole account.
  if (asset?.classPart) {
    const part = Number(asset[`class_${asset.classPart}_value`]) || 0;
    return { paise: part || null, source: "from the depository" };
  }
  const cat = categoryOf(asset);
  const m = assetMetrics(asset, cat);
  if (m.excluded) return { paise: null, source: "cover, not net worth" };
  // A matured FD is still a bank liability until a credit is matched. It stays
  // in net worth and says so; the page labels it awaiting payment.
  if (cat === "fd" && fdMatured(asset)) {
    const note = m.note || "no value yet";
    return { paise: m.value, source: `${note} · matured · awaiting payment` };
  }
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

// The Assets page groups by class, because that is the question a person asks:
// how much is in bonds, in shares, in funds. The account is the row's identity,
// not its group — a demat that holds bonds and shares appears under both, named
// on each row, so the split is visible instead of hidden behind "Demat".
const CLASS_LABELS = { bond: "Bonds", equity: "Equities", mf: "Mutual funds" };
// The order a person reads a balance sheet in: cash first, then everything a
// demat holds grouped together, then the things held outside one.
const CLASS_ORDER = { bank: 0, fd: 1, bond: 2, mf: 3, equity: 4, gold: 5,
  insurance: 6, cash: 7, property: 8, other: 9 };

export function assetSections(assets) {
  const list = assets || [];
  const groups = new Map();
  const add = (key, label, row, total) => {
    if (!groups.has(key)) groups.set(key, { id: key, label, rows: [], total: 0 });
    const group = groups.get(key);
    group.rows.push(row);
    group.total += Number(total) || 0;
  };
  for (const asset of list) {
    // A cost record is the price paid for bonds that sit in a demat. It holds
    // nothing and is worth nothing, so it is not an asset row; the Assets page
    // lists these separately, below everything else.
    const meta = assetMeta(asset);
    if (meta.cost_only) continue;
    const cat = categoryOf(asset);
    if (cat === "demat") {
      // A folio is a fund account. Even a stray bond row written into it must
      // not turn the Assets page into a second place for that bond.
      if (isFundAccount(asset)) {
        add("mf", CLASS_LABELS.mf, asset, assetValue(asset).paise);
        continue;
      }
      const parts = [
        ["bond", Number(asset.class_bond_value) || 0],
        ["equity", Number(asset.class_equity_value) || 0],
        ["mf", Number(asset.class_mf_value) || 0],
      ].filter(([, value]) => value > 0);
      if (parts.length) {
        for (const [part, value] of parts) {
          add(part, CLASS_LABELS[part], { ...asset, classPart: part }, value);
        }
        continue;
      }
      // No holdings, or holdings with no value: keep it where its subtype says.
      const fund = /mutual\s*fund|^mf$/i.test(String(asset.subtype || ""));
      add(fund ? "mf" : "equity", CLASS_LABELS[fund ? "mf" : "equity"],
        { ...asset, classPart: fund ? "mf" : "equity" }, assetValue(asset).paise);
      continue;
    }
    // A bond portfolio and a bond inside a demat are the same class. Without
    // this the two keys ("bonds" and "bond") became two sections, and the one
    // carrying the portfolios sorted to the bottom of the page.
    const key = cat === "bonds" ? "bond" : cat;
    add(key, key === "bond" ? CLASS_LABELS.bond : categoryLabel(cat), asset,
      assetValue(asset).paise);
  }
  return [...groups.values()]
    .sort((a, b) => (CLASS_ORDER[a.id] ?? 99) - (CLASS_ORDER[b.id] ?? 99));
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
const CLASS_KEYS = ["bond", "equity", "mf"];

export function assetClassParts(asset, fromRows = null) {
  const worth = assetValue(asset).paise || 0;
  // A folio is a fund account even if a stray bond or share row was written into
  // it. Its whole value belongs to the funds class, and the row itself is not a
  // bond position on the folio page or in the reconcile.
  if (isFundAccount(asset)) return { bond: 0, equity: 0, mf: worth };
  const raw = fromRows || {
    bond: asset?.class_bond_value, equity: asset?.class_equity_value,
    mf: asset?.class_mf_value,
  };
  const bond = Number(raw.bond) || 0;
  const equity = Number(raw.equity) || 0;
  const mf = Number(raw.mf) || 0;
  const rawSum = bond + equity + mf;
  if (rawSum) {
    const scale = worth / rawSum;
    return { bond: bond * scale, equity: equity * scale, mf: mf * scale };
  }
  if (categoryOf(asset) === "bonds") return { bond: worth, equity: 0, mf: 0 };
  return { bond: 0, equity: worth, mf: 0 };
}

export function allocationByClass(assets, byClass) {
  const base = allocationGroups(assets);
  const out = [];
  for (const group of base) {
    if (group.id !== "bonds" && group.id !== "demat") { out.push(group); continue; }
    const parts = { bond: { total: 0, rows: [] }, equity: { total: 0, rows: [] },
      mf: { total: 0, rows: [] } };
    for (const asset of group.rows) {
      const share = assetClassParts(asset, byClass?.[asset.id]);
      for (const key of CLASS_KEYS) {
        if (!share[key]) continue;
        parts[key].total += share[key];
        if (!parts[key].rows.includes(asset)) parts[key].rows.push(asset);
      }
    }
    const labels = { bond: "Bonds", equity: "Equities", mf: "Mutual funds" };
    for (const key of CLASS_KEYS) {
      if (!parts[key].total) continue;
      out.push({ id: key, label: labels[key], total: Math.round(parts[key].total),
        rows: parts[key].rows });
    }
  }
  return out;
}

// One class page, built from the same parts as the allocation ring so the ring's
// legend and the page can never disagree. An account whose value lives on the
// account rather than on a holding row gets one synthetic row. A valued holding
// row is never joined by an account total that already includes it.
export function classPage(accounts, holdingsByAccount, kind) {
  const groups = [];
  for (const asset of accounts || []) {
    const cat = categoryOf(asset);
    if (cat !== "demat" && cat !== "bonds") continue;
    if (isFundAccount(asset) && kind !== "mf") continue;
    const part = Math.round(assetClassParts(asset)[kind] || 0);
    const holdings = (holdingsByAccount?.[asset.id] || [])
      .filter((h) => holdingClass(h) === kind);
    const held = holdings.reduce((t, h) => t + (Number(h.value_paise) || 0), 0);
    if (!holdings.length && !part) continue;
    const rows = holdings.map((h) => ({ ...h }));
    const gap = part - held;
    if (gap !== 0) {
      const accountName = String(asset.label || asset.bank || asset.id || "Account");
      rows.push({
        label: holdings.length ? `${accountName} · value not in a row` : accountName,
        security_id: "",
        category: kind,
        quantity: null,
        cost_paise: null,
        value_paise: gap,
        as_of: String(asset.value_date || ""),
        accountValue: true,
      });
    }
    if (!rows.length) continue;
    groups.push({ asset, rows, total: part });
  }
  const rows = groups.flatMap((group) => group.rows.map((h) => ({ ...h, _asset: group.asset })));
  return {
    id: kind,
    total: rows.reduce((t, h) => t + (Number(h.value_paise) || 0), 0),
    groups,
    rows,
    holdingsCount: rows.filter((h) => !h.accountValue).length,
    accountValues: rows.filter((h) => h.accountValue).length,
  };
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
