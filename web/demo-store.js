// The sample portfolio, written into the real schema.
//
// Every page reads this through db.js exactly as it reads an imported ledger,
// so the demo is the app itself with fake rows instead of a second renderer.
// The caller supplies an in-memory store whose save hook is null, which is what
// keeps the demo off bankpipe.db.v1.

const asNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const slug = (value) => String(value || "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const rowId = (cls, row) => `sample-${cls}-${row.id}`;

// "7.15% IRFC 15 May 2031" is the issuer and its terms in one line. The card
// prints the issuer next to the ISIN, so split it the same way the card does.
const issuerOf = (label) => String(label || "")
  .replace(/^\s*\d+(?:\.\d+)?\s*%\s*/, "")
  .replace(/\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s*$/, "").trim();

function securityRows(data) {
  const out = [];
  for (const [cls, group] of Object.entries(data?.holdings || {})) {
    for (const row of group.rows || []) out.push({ cls, row });
  }
  return out;
}

// One demat per holder, because that is what the accounts in the sample are.
// A CDSL BO ID is IN plus fourteen digits; the last four name the account.
function dematAccounts(rows) {
  const holders = [...new Set(rows
    .filter(({ cls }) => ["bonds", "equity", "mf"].includes(cls))
    .map(({ row }) => row.holder).filter(Boolean))];
  return holders.map((holder, index) => {
    const number = `IN300476${String(12345678 + index).slice(-8)}`;
    return {
      id: `demat-${slug(holder)}`,
      label: `Demat · ${holder} · …${number.slice(-4)}`,
      bank: "Sample Securities",
      number,
      holder,
      city: "Bengaluru",
      type: "equity",
      category: "demat",
      subtype: "equity",
      meta: JSON.stringify({ source: "import", holdings_as_of: "2026-10-31" }),
      notes: "Sample demat account. Bonds, shares and fund units sit here.",
    };
  });
}

function bankAccounts(data) {
  return (data?.accounts || []).map((a) => ({
    id: a.id,
    label: a.label || a.bank || a.id,
    bank: a.bank || "",
    number: a.number || "",
    holder: a.holder || "",
    city: a.city || "",
    type: a.acct_type || "savings",
    category: "bank",
    subtype: a.acct_type || "savings",
    // A statement's last balance wins once its rows are stored. This value is
    // the account's own number for the two banks the sample has no statement
    // for, and the form's fallback for the rest.
    value_paise: asNumber(a.balance),
    value_date: a.last || "",
  }));
}

// An FD's "HDFC" is the bank whose row says HDFC Bank; SBI and PNB are
// spelled out in the account label. A link here is the same one the FD view
// writes when it matches a deposit to its account, so the sample nests the
// deposits under the bank that holds them.
const BANK_ALIAS = { SBI: /state bank|\bsbi\b/i, PNB: /punjab national|\bpnb\b/i };
function bankForDeposit(name, banks) {
  const text = String(name || "");
  if (!text) return null;
  const re = BANK_ALIAS[text]
    || new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return (banks || []).find((a) => re.test(String(a.bank || a.label || ""))) || null;
}

function depositAccounts(data, banks) {
  const out = [];
  for (const r of data?.holdings?.fd?.rows || []) {
    const d = r.details || {};
    const bank = bankForDeposit(d.bank, banks);
    out.push({
      // The bank's own spelling keeps bankKeyFor() on the account's group; the
      // sample writes "HDFC" for the bank and "HDFC Bank" for the account.
      id: rowId("fd", r), label: r.label, bank: bank?.bank || d.bank || "",
      number: d.fd_no || "",
      holder: r.holder || "", type: "fd", category: "fd", subtype: "fd",
      principal_paise: asNumber(r.value), value_paise: asNumber(r.value),
      rate_bps: asNumber(d.rate), start_date: d.started || "",
      maturity_date: d.matures || "",
      meta: bank
        ? JSON.stringify({ linked_account_id: bank.id, linked_why: "matched in the FD view" })
        : "",
    });
  }
  // PPF has no category of its own in the app; it is a deposit-like asset the
  // person values by hand, so it sits under Other with its real dates.
  for (const r of data?.holdings?.ppf?.rows || []) {
    const d = r.details || {};
    out.push({
      id: rowId("ppf", r), label: r.label, bank: d.bank || "",
      holder: r.holder || "", type: "ppf", category: "other", subtype: "ppf",
      value_paise: asNumber(r.value), value_date: d.started || "",
      start_date: d.started || "", maturity_date: d.matures || "",
      notes: "Public provident fund",
    });
  }
  return out;
}

function goldAccounts(data) {
  return (data?.holdings?.gold?.rows || []).map((r) => {
    const d = r.details || {};
    return {
      id: rowId("gold", r), label: r.label, holder: r.holder || "",
      type: "physical", category: "gold", subtype: "physical",
      value_paise: asNumber(r.value), value_date: "",
      meta: JSON.stringify({
        purity: d.purity || "", grams: asNumber(d.grams),
        buy_per_gram_paise: asNumber(d.rate),
        current_per_gram_paise: asNumber(d.rate),
      }),
      notes: [d.purity, d.grams ? `${d.grams} g` : ""].filter(Boolean).join(" · "),
    };
  });
}

function policyAccounts(data) {
  return (data?.holdings?.insurance?.rows || []).map((r) => {
    const d = r.details || {};
    return {
      id: rowId("insurance", r), label: r.label, bank: d.insurer || "",
      number: d.policy_no || "", holder: r.holder || "",
      type: d.cover_type || "term", category: "insurance",
      subtype: d.cover_type || "term",
      value_paise: asNumber(r.value), value_date: "",
      start_date: d.started || "", maturity_date: d.matures || "",
      meta: JSON.stringify({
        insurer: d.insurer || "", premium_paise: asNumber(r.value),
        sum_assured_paise: asNumber(d.sum_assured), frequency: "yearly",
        policy_no: d.policy_no || "",
      }),
      notes: [d.insurer, d.cover_type].filter(Boolean).join(" · "),
    };
  });
}

function holdingRow(cls, row, asOf) {
  const d = row.details || {};
  const value = asNumber(row.value) ?? asNumber(d.value);
  const units = asNumber(d.qty ?? d.units);
  const unitCost = asNumber(d.buy);
  const cost = cls === "bonds"
    ? (asNumber(d.invested) ?? value)
    : (unitCost !== null && units !== null ? Math.round(units * unitCost) : value);
  const common = {
    security_id: d.isin || "",
    label: row.label || "",
    quantity: units,
    cost_paise: cost,
    value_paise: value,
    purchase_date: d.bought || "",
    as_of: d.as_of || asOf,
    value_source: cls === "bonds" ? "BSE" : "CAS",
  };
  if (cls === "bonds") {
    return {
      ...common, issuer: issuerOf(row.label), category: "bond",
      face_paise: asNumber(d.face), interest_date: d.interest || "",
      frequency: d.frequency || "", rating: d.rating || "",
      rating_at_purchase: d.rating_at_purchase || d.rating || "",
      yield_bps: asNumber(d.yield_bps), payout_paise: null,
      future_interest_paise: asNumber(d.future_interest),
      future_principal_paise: asNumber(d.future_principal),
      principal_dates: d.principal_dates || "",
      redemption_dates: d.redemption_date || "",
      returned_paise: asNumber(d.returned), returned_at: d.returned_at || "",
      returned_source: d.returned ? "bank" : "",
    };
  }
  if (cls === "mf") {
    return { ...common, category: "mf", issuer: "", face_paise: null };
  }
  return { ...common, category: "equity", issuer: "", face_paise: null };
}

// Oldest first: importRows stores the list in the order it is handed, and the
// balance chain is read in that order. The sample file is newest first.
function factRows(list) {
  return list.slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
    .map((t, index) => ({
      date: t.date || "",
      amount: asNumber(t.amount),
      balance: asNumber(t.balance),
      description: t.description || t.narration || "",
      ref: "",
      source_row: index + 2,
    }));
}

function transactionsByAccount(transactions) {
  const groups = new Map();
  for (const t of transactions || []) {
    if (!t || !t.account) continue;
    if (!groups.has(t.account)) groups.set(t.account, []);
    groups.get(t.account).push(t);
  }
  return groups;
}

/**
 * Write the sample portfolio into a fresh store.
 *
 * @param {object} store a store from db.js `makeStore`, already open
 * @param {object} data parsed data.json
 * @param {Array} transactions parsed demo-transactions.json
 * @returns {{seeded:boolean, accounts:number, holdings:number, facts:number}}
 */
export function seedDemoDb(store, data, transactions = []) {
  const already = store.query("SELECT COUNT(*) AS n FROM account")[0]?.n || 0;
  if (already) return { seeded: false, accounts: already, holdings: 0, facts: 0 };

  const rows = securityRows(data);
  const demats = dematAccounts(rows);
  const dematOf = new Map(demats.map((d) => [d.holder, d.id]));
  const banks = bankAccounts(data);
  const accounts = [
    ...banks, ...demats, ...depositAccounts(data, banks),
    ...goldAccounts(data), ...policyAccounts(data),
  ];
  for (const account of accounts) store.createAccount(account);

  // One statement per demat: replaceHoldings is the path an import uses, so the
  // sample rows come back with the same source and dates a real report has.
  const byDemat = new Map();
  for (const { cls, row } of rows) {
    if (!["bonds", "equity", "mf"].includes(cls)) continue;
    const assetId = dematOf.get(row.holder) || demats[0]?.id;
    if (!assetId) continue;
    if (!byDemat.has(assetId)) byDemat.set(assetId, []);
    byDemat.get(assetId).push(holdingRow(cls, row, "2026-10-31"));
  }
  let holdings = 0;
  for (const [assetId, lots] of byDemat) {
    holdings += store.replaceHoldings(assetId, lots, "2026-10-31").inserted;
  }

  let facts = 0;
  for (const [accountId, list] of transactionsByAccount(transactions)) {
    const res = store.importRows(accountId, factRows(list));
    facts += res.inserted;
  }
  return { seeded: true, accounts: accounts.length, holdings, facts };
}
