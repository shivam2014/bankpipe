// Browser storage. SQLite via sql.js, persisted to IndexedDB as one blob.
// The dedupe and reconciliation rules come from ledger.js, so the browser and
// the Python reference agree on what a duplicate is.

import { dedupePlan, duplicateIds, reconcileChain, orderForChain, normNarration } from "./ledger.js";
import { isSealed, sealBytes, openBytes } from "./dbatrest.js";

const DB_KEY = "bankpipe.db.v1";

// The dashboard view should follow the data, not a stored preference. Any write
// marks this browser as holding real rows; a wipe clears it. index.html reads
// this before the first render, so "Use my data" never appears over real data.
function noteData(present) {
  try {
    if (typeof localStorage === "undefined") return;
    if (present) localStorage.setItem("bp.hasData", "1");
    else localStorage.removeItem("bp.hasData");
  } catch {}
}
let SQL = null;
let db = null;
let browserStore = null;
let dbPassphrase = null;
let dbSealed = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account(
  id TEXT PRIMARY KEY, label TEXT, bank TEXT, number TEXT, holder TEXT,
  city TEXT, type TEXT);
CREATE TABLE IF NOT EXISTS fact(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL, txn_date TEXT, amount_paise INTEGER,
  balance_paise INTEGER, narration TEXT, ref TEXT, source_row INTEGER,
  txn_key TEXT UNIQUE, run_id INTEGER);
CREATE INDEX IF NOT EXISTS fact_acct ON fact(account_id, txn_date);
CREATE TABLE IF NOT EXISTS holding(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL, security_id TEXT, label TEXT, category TEXT,
  rating TEXT, frequency TEXT, yield_bps INTEGER, payout_paise INTEGER,
  quantity REAL, cost_paise INTEGER, value_paise INTEGER,
  purchase_date TEXT, interest_date TEXT, source_row INTEGER,
  as_of TEXT, txn_key TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS holding_asset ON holding(asset_id);
CREATE TABLE IF NOT EXISTS import_run(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, file TEXT,
  started_at TEXT, rows_read INTEGER, rows_kept INTEGER);
CREATE TABLE IF NOT EXISTS issue(
  id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER, account_id TEXT,
  kind TEXT, detail TEXT, state TEXT DEFAULT 'open');
CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS locker(
  id TEXT PRIMARY KEY, account_id TEXT, number TEXT, branch TEXT,
  size TEXT, rent_paise INTEGER, renewal_date TEXT, notes TEXT, contents TEXT,
  value_paise INTEGER);
`;

// Older databases only have id/label/bank/number/holder/city/type. Add the
// asset columns in place; ALTER TABLE is cheap and keeps existing facts.
function migrate(conn) {
  const info = conn.exec("PRAGMA table_info(account)");
  const have = new Set(info.length ? info[0].values.map((v) => v[1]) : []);
  const add = [["category", "TEXT"], ["subtype", "TEXT"], ["value_paise", "INTEGER"],
    ["value_date", "TEXT"], ["notes", "TEXT"], ["principal_paise", "INTEGER"],
    ["rate_bps", "INTEGER"], ["start_date", "TEXT"], ["maturity_date", "TEXT"],
    ["interest_paid_paise", "INTEGER"], ["meta", "TEXT"],
    ["ifsc", "TEXT"], ["branch", "TEXT"], ["address", "TEXT"], ["state", "TEXT"],
    ["currency", "TEXT"]];
  for (const [name, type] of add) {
    if (!have.has(name)) conn.run(`ALTER TABLE account ADD COLUMN ${name} ${type}`);
  }
  conn.run(`UPDATE account SET category = CASE
      WHEN type IN ('savings','current') OR type IS NULL OR type = '' THEN 'bank'
      WHEN type = 'fd' THEN 'fd'
      WHEN type = 'demat' THEN 'demat'
      WHEN type = 'cash' THEN 'cash'
      WHEN type IN ('bond','bonds') THEN 'bonds'
      WHEN type = 'gold' THEN 'gold'
      WHEN type = 'property' THEN 'property'
      ELSE 'other' END
    WHERE category IS NULL OR category = ''`);
  conn.run(`UPDATE account SET subtype = type
    WHERE (subtype IS NULL OR subtype = '') AND type IS NOT NULL`);

  // Holdings gained rating, payout frequency and purchase yield so the bond
  // table can sort and explain the cashflow without a second lookup.
  const hinfo = conn.exec("PRAGMA table_info(holding)");
  const hhave = new Set(hinfo.length ? hinfo[0].values.map((v) => v[1]) : []);
  for (const [name, type] of [["rating", "TEXT"], ["frequency", "TEXT"],
    ["yield_bps", "INTEGER"], ["payout_paise", "INTEGER"], ["source", "TEXT"],
    ["rating_at_purchase", "TEXT"], ["future_interest_paise", "INTEGER"],
    ["future_principal_paise", "INTEGER"], ["principal_dates", "TEXT"],
    ["returned_paise", "INTEGER"]]) {
    if (!hhave.has(name)) conn.run(`ALTER TABLE holding ADD COLUMN ${name} ${type}`);
  }
  // The workbook put the credit rating in category. Move it to rating once;
  // category stays the instrument kind so "bond" is not shown as a rating.
  try {
    const rows = conn.exec("SELECT id, category FROM holding");
    const rating = /^(A|AA|AAA|B|BB|BBB|C|CC|CCC|D)([+-])?$/i;
    for (const [id, category] of (rows[0]?.values || [])) {
      if (rating.test(String(category || "").trim())) {
        conn.run("UPDATE holding SET rating=?, category='bond' WHERE id=?", [category, id]);
      }
    }
  } catch (e) {}

  // A locker can say what is inside it, as a memo. Never added to net worth:
  // the contents are either counted elsewhere (gold, jewellery) or are not
  // financial assets at all.
  const lkInfo = conn.exec("PRAGMA table_info(locker)");
  const lkHave = new Set(lkInfo.length ? lkInfo[0].values.map((v) => v[1]) : []);
  if (!lkHave.has("value_paise")) conn.run("ALTER TABLE locker ADD COLUMN value_paise INTEGER");

  // The rating a lot carried when it was first recorded is the baseline a later
  // upgrade or downgrade is measured against. Only empty baselines are filled,
  // so a change is never swallowed by the next launch.
  conn.run("UPDATE holding SET rating_at_purchase = rating"
    + " WHERE (rating_at_purchase IS NULL OR rating_at_purchase = '')"
    + " AND rating IS NOT NULL AND rating <> ''");
}

function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("bankpipe", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("blobs");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbGet(key) {
  const store = await idb();
  return new Promise((res, rej) => {
    const tx = store.transaction("blobs", "readonly").objectStore("blobs").get(key);
    tx.onsuccess = () => res(tx.result || null);
    tx.onerror = () => rej(tx.error);
  });
}

async function idbPut(key, value) {
  const store = await idb();
  return new Promise((res, rej) => {
    const tx = store.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

async function idbKeys() {
  const store = await idb();
  return new Promise((res, rej) => {
    const req = store.transaction("blobs", "readonly").objectStore("blobs").getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function idbDelete(key) {
  const store = await idb();
  return new Promise((res, rej) => {
    const tx = store.transaction("blobs", "readwrite");
    tx.objectStore("blobs").delete(key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

const SNAPSHOT_PREFIX = "snapshot.";
const SNAPSHOT_KEEP = 12;

// Listeners run after every successful save. They are best-effort: a failing
// listener must never break the write that triggered it.
const saveHooks = new Set();
export function onDbSaved(fn) {
  saveHooks.add(fn);
  return () => saveHooks.delete(fn);
}

export async function snapshotDb(label = "") {
  if (!db) await openDb();
  if (!dbPassphrase) throw new Error("unlock the database to save a version");
  await persist();
  const saved = await idbGet(DB_KEY);
  if (!saved) throw new Error("no database on this device");
  const at = new Date().toISOString();
  const key = `${SNAPSHOT_PREFIX}${at.replace(/[:.]/g, "-")}-${Math.random()
    .toString(36).slice(2, 6)}`;
  await idbPut(key, { at, label: String(label || ""), data: saved });
  const all = await listDbSnapshots();
  for (const old of all.slice(SNAPSHOT_KEEP)) await idbDelete(old.key);
  return { key, at, bytes: saved.byteLength };
}

export async function listDbSnapshots() {
  const keys = await idbKeys();
  const out = [];
  for (const key of keys) {
    if (!String(key).startsWith(SNAPSHOT_PREFIX)) continue;
    const v = await idbGet(key);
    if (!v || !v.data) continue;
    out.push({ key, at: v.at || "", label: v.label || "",
      bytes: v.data.byteLength || v.data.length || 0 });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function readDbSnapshot(key) {
  const v = await idbGet(key);
  if (!v || !v.data) throw new Error("that snapshot is no longer on this device");
  return { at: v.at || "", label: v.label || "", data: v.data };
}

export async function deleteDbSnapshot(key) {
  if (!String(key).startsWith(SNAPSHOT_PREFIX)) return false;
  await idbDelete(key);
  return true;
}

export async function restoreDbSnapshot(key) {
  if (!String(key).startsWith(SNAPSHOT_PREFIX)) throw new Error("not a version");
  const snap = await idbGet(key);
  if (!snap || !snap.data) throw new Error("version not found");
  await idbPut(DB_KEY, snap.data);
  lockDb();
  return true;
}

export function makeStore(SQLlib, save) {
  let conn = null;
  const store = {
    async open(bytes) {
      if (conn) return conn;
      conn = bytes ? new SQLlib.Database(new Uint8Array(bytes)) : new SQLlib.Database();
      conn.run(SCHEMA);
      migrate(conn);
      return conn;
    },
    raw: () => conn,
    exportBytes: () => (conn ? conn.export() : new Uint8Array()),
    async save() { if (save) await save(store.exportBytes()); },
    // Restore path. The caller has already verified the bytes; this only swaps
    // the connection and persists, so a failed restore leaves the old file in
    // place rather than half written.
    async replaceWith(bytes) {
      const next = new SQLlib.Database(new Uint8Array(bytes));
      next.run(SCHEMA);
      migrate(next);
      if (conn) conn.close();
      conn = next;
      await store.save();
      return conn;
    },
  };
  const all = (sql, params = []) => {
    const res = conn.exec(sql, params);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => Object.fromEntries(v.map((x, i) => [columns[i], x])));
  };
  store.query = all;
  // The bank's printed order is the truth. Runs are placed by their earliest
  // transaction date, so a back-dated second import sits before the run it
  // precedes. Within a run the file's own row order (source_row) is kept.
  // Display sorting is separate and unchanged.
  const printedRows = (accountId) => all(
    "SELECT f.id, f.txn_date AS date, f.amount_paise AS amount,"
    + " f.balance_paise AS balance, f.source_row, f.run_id, 0 AS excluded"
    + " FROM fact f LEFT JOIN (SELECT run_id, MIN(txn_date) AS first_date FROM fact"
    + "   WHERE account_id=? GROUP BY run_id) r ON r.run_id=f.run_id"
    + " WHERE f.account_id=?"
    + " ORDER BY (r.first_date IS NULL), r.first_date, (f.run_id IS NULL),"
    + " f.run_id, f.source_row, f.id", [accountId, accountId]);
  // A day printed newest-first inside an otherwise chronological file is the
  // one case the chain may flip. Everything else stays where the file put it.
  const chainRows = (accountId) => orderForChain(printedRows(accountId)).rows;
  // One derivation for import and Re-check: balance breaks come from the printed
  // chain; the file's own oddities are items. `factIds` limits the oddities to
  // the rows an import just landed without narrowing the chain, which must see
  // the whole account. `replace` clears this account's open items first.
  const syncReviewIssues = (accountId,
    { factIds = null, balanceBreaks = true, replace = false } = {}) => {
    let cleared = 0;
    if (replace) {
      cleared = all("SELECT COUNT(*) AS n FROM issue WHERE account_id=? AND state='open'"
        + " AND kind IN ('balance_break','no_date','out_of_order')", [accountId])[0]?.n || 0;
      conn.run("DELETE FROM issue WHERE account_id=? AND state='open'"
        + " AND kind IN ('balance_break','no_date','out_of_order')", [accountId]);
    }

    const rows = chainRows(accountId);
    const derived = [];
    if (balanceBreaks) {
      reconcileChain(rows).issues.forEach((is) => {
        derived.push({ factId: is.id, kind: "balance_break",
          detail: `balance ${is.actual} expected ${is.expected}` });
      });
    }
    const wanted = factIds ? new Set(factIds) : null;
    let previousDate = "";
    rows.forEach((row, index) => {
      const rowNo = row.source_row || index + 2;
      if (!row.date) {
        if (!wanted || wanted.has(row.id)) {
          derived.push({ factId: row.id, kind: "no_date",
            detail: `row ${rowNo} has no date; amount and balance imported as printed` });
        }
        return;
      }
      if (previousDate && row.date < previousDate && (!wanted || wanted.has(row.id))) {
        derived.push({ factId: row.id, kind: "out_of_order",
          detail: `printed after ${previousDate}, before ${row.date}, row ${rowNo}` });
      }
      previousDate = row.date;
    });

    // An accepted or ignored decision about the same fact and kind is a real
    // answer; Re-check must not reopen it as a second, open item.
    const held = new Set(all("SELECT fact_id, kind FROM issue WHERE account_id=?"
      + " AND kind IN ('balance_break','no_date','out_of_order')", [accountId])
      .map((r) => `${r.fact_id}:${r.kind}`));
    let added = 0;
    for (const issue of derived) {
      const key = `${issue.factId}:${issue.kind}`;
      if (held.has(key)) continue;
      held.add(key);
      conn.run("INSERT INTO issue(fact_id,account_id,kind,detail) VALUES(?,?,?,?)",
        [issue.factId, accountId, issue.kind, issue.detail]);
      added += 1;
    }
    return { cleared, added,
      breaks: derived.filter((issue) => issue.kind === "balance_break").length };
  };
  store.heldRows = (account) => all(
    "SELECT id, txn_date AS date, amount_paise AS amount, balance_paise AS balance, "
    + "narration FROM fact WHERE account_id=? ORDER BY id", [account]);
  // A manual account has no transactions yet. INSERT OR REPLACE keeps this
  // idempotent: adding the same account twice updates it instead of duplicating.
  store.createAccount = (a) => {
    conn.run("INSERT OR REPLACE INTO account(id,label,bank,number,holder,city,type,"
      + "category,subtype,value_paise,value_date,notes,principal_paise,rate_bps,"
      + "start_date,maturity_date,interest_paid_paise,meta,ifsc,branch,address,state,currency)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [a.id, a.label || a.bank || a.id, a.bank || "", a.number || "",
       a.holder || "", a.city || "", a.type || a.subtype || "",
       a.category || "other", a.subtype || a.type || "",
       a.value_paise === undefined ? null : a.value_paise,
       a.value_date || "", a.notes || "",
       a.principal_paise === undefined ? null : a.principal_paise,
       a.rate_bps === undefined ? null : a.rate_bps,
       a.start_date || "", a.maturity_date || "",
       a.interest_paid_paise === undefined ? null : a.interest_paid_paise,
       a.meta ? (typeof a.meta === "string" ? a.meta : JSON.stringify(a.meta)) : "",
       a.ifsc || "", a.branch || "", a.address || "", a.state || "",
       a.currency || "INR"]);
  };
  store.updateAccount = (id, fields) => {
    const allowed = ["label", "bank", "number", "holder", "city", "type", "category",
      "subtype", "value_paise", "value_date", "notes", "principal_paise", "rate_bps",
      "start_date", "maturity_date", "interest_paid_paise", "meta", "ifsc", "branch",
      "address", "state", "currency"];
    const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
    if (!keys.length) return false;
    conn.run(`UPDATE account SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      [...keys.map((k) => fields[k]), id]);
    return true;
  };
  // Holdings are a snapshot, not a ledger: a fresh import replaces the set for
  // that asset. Re-importing the same file therefore cannot duplicate lots.
  store.replaceHoldings = (assetId, rows, asOf) => {
    // Lots added by hand are not in any report, so a sync must not delete them.
    // A report row with the same ISIN wins, because the broker is authoritative
    // for a security it now reports.
    const reportIsins = new Set((rows || []).map((r) => String(r.security_id || "").toUpperCase())
      .filter(Boolean));
    const manual = all("SELECT id, security_id FROM holding"
      + " WHERE asset_id=? AND source='manual'", [assetId]);
    // A re-import must not reset the rating a lot was bought at, or a downgrade
    // would vanish on the next sync. Keep the baseline by ISIN.
    const priorRating = new Map(all("SELECT security_id, rating_at_purchase FROM holding"
      + " WHERE asset_id=?", [assetId]).map((r) => [String(r.security_id || "").toUpperCase(),
        r.rating_at_purchase || ""]));
    const superseded = manual.filter((m) => m.security_id
      && reportIsins.has(String(m.security_id).toUpperCase()));
    for (const m of superseded) conn.run("DELETE FROM holding WHERE id=?", [m.id]);
    conn.run("DELETE FROM holding WHERE asset_id=? AND (source IS NULL OR source<>'manual')",
      [assetId]);
    let inserted = 0;
    for (const r of rows || []) {
      const key = [assetId, r.security_id, r.label, r.category, r.rating, r.frequency,
        r.yield_bps, r.payout_paise, r.quantity, r.cost_paise, r.value_paise,
        r.source_row].join("|");
      conn.run("INSERT OR REPLACE INTO holding(asset_id,security_id,label,category,"
        + "rating,frequency,yield_bps,payout_paise,quantity,cost_paise,value_paise,purchase_date,"
        + "interest_date,rating_at_purchase,future_interest_paise,"
        + "future_principal_paise,principal_dates,returned_paise,source_row,as_of,txn_key,"
        + "source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [assetId, r.security_id || "", r.label || "", r.category || "",
         r.rating || "", r.frequency || "",
         r.yield_bps === undefined ? null : r.yield_bps,
         r.payout_paise === undefined ? null : r.payout_paise,
         r.quantity === undefined ? null : r.quantity,
         r.cost_paise === undefined ? null : r.cost_paise,
         r.value_paise === undefined ? null : r.value_paise,
         r.purchase_date || "", r.interest_date || "",
         r.rating_at_purchase
           || priorRating.get(String(r.security_id || "").toUpperCase()) || r.rating || "",
         r.future_interest_paise ?? null, r.future_principal_paise ?? null,
         r.principal_dates || "", r.returned_paise ?? null, r.source_row || 0,
         asOf || "", key, "report"]);
      inserted++;
    }
    return { inserted, manualKept: manual.length - superseded.length,
      manualSuperseded: superseded.length };
  };
  // Dry run: what would an import add, correct, and what is already held? No writes.
  store.planImport = (account, rows) => {
    const usable = (rows || []).filter((r) => r.date || r.amount !== null);
    const plan = dedupePlan(store.heldRows(account), usable);
    // A row can be a correction rather than a new transaction: the same event
    // is already held with a different running balance. The preview must count
    // it, or "nothing to add" hides a real change.
    const corrections = plan.updates ? plan.updates.filter(Boolean).length : 0;
    return { rows: usable.length, held: plan.duplicates, correct: corrections,
      missing: plan.insert.filter(Boolean).length,
      missingRows: usable.filter((_, i) => plan.insert[i])
        .map((r) => r.source_row || null).filter(Boolean),
      suspectRows: usable.filter((r) => !r.date || r.amount === null)
        .map((r) => r.source_row || null).filter(Boolean) };
  };
  store.searchFacts = (opts = {}) => {
    const f = factFilter(opts);
    let where = f.clauses.length ? " WHERE " + f.clauses.join(" AND ") : "";
    const params = f.params.slice();
    if (opts.account) {
      where = (where ? where + " AND" : " WHERE") + " f.account_id=?";
      params.push(opts.account);
    }
    const { limit, offset } = pageOf(opts);
    const order = factOrder(opts);
    const rows = all(
      "SELECT f.id, f.txn_date AS date, f.account_id AS account,"
      + " COALESCE(a.label, a.bank, f.account_id) AS account_label,"
      + " COALESCE(a.currency, 'INR') AS account_currency,"
      + " f.narration AS description, f.amount_paise AS amount, f.balance_paise AS balance"
      + " FROM fact f LEFT JOIN account a ON a.id=f.account_id" + where
      + ` ORDER BY ${order.col} ${order.dir}, f.id ${order.dir} LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    const totals = all(
      "SELECT COUNT(*) n, SUM(CASE WHEN f.amount_paise>0 THEN f.amount_paise ELSE 0 END) inn,"
      + " SUM(CASE WHEN f.amount_paise<0 THEN -f.amount_paise ELSE 0 END) out"
      + " FROM fact f" + where, params)[0] || {};
    return { rows, totals, limit, offset };
  };
  // Every id matching the same filters as searchFacts, with no page limit.
  // The account page's header checkbox means "select every matching row", not
  // just the rows currently rendered, so it needs the full id list.
  store.factIds = (opts = {}) => {
    const f = factFilter(opts);
    let where = f.clauses.length ? " WHERE " + f.clauses.join(" AND ") : "";
    const params = f.params.slice();
    if (opts.account) {
      where = (where ? where + " AND" : " WHERE") + " f.account_id=?";
      params.push(opts.account);
    }
    return all("SELECT f.id FROM fact f" + where + " ORDER BY f.id", params)
      .map((r) => r.id);
  };
  store.appAudit = () => {
    const accounts = all(
      "SELECT f.account_id, COALESCE(a.category,'bank') AS category, COUNT(*) AS n,"
      + " SUM(CASE WHEN f.amount_paise>0 THEN f.amount_paise ELSE 0 END) AS credits,"
      + " SUM(CASE WHEN f.amount_paise<0 THEN -f.amount_paise ELSE 0 END) AS debits,"
      + " MIN(f.txn_date) AS first_date, MAX(f.txn_date) AS last_date,"
      + " SUM(CASE WHEN f.txn_date IS NULL OR f.txn_date='' THEN 1 ELSE 0 END) AS missing_date,"
      + " SUM(CASE WHEN f.amount_paise IS NULL THEN 1 ELSE 0 END) AS missing_amount,"
      + " SUM(CASE WHEN f.balance_paise IS NULL THEN 1 ELSE 0 END) AS missing_balance,"
      + " (SELECT b.balance_paise - b.amount_paise FROM fact b"
      + "  WHERE b.account_id=f.account_id AND b.balance_paise IS NOT NULL"
      + "  ORDER BY b.txn_date ASC, b.id ASC LIMIT 1) AS opening,"
      + " (SELECT b.balance_paise FROM fact b WHERE b.account_id=f.account_id"
      + "  AND b.balance_paise IS NOT NULL ORDER BY b.txn_date DESC, b.id DESC LIMIT 1) AS closing"
      + " FROM fact f LEFT JOIN account a ON a.id=f.account_id"
      + " GROUP BY f.account_id ORDER BY f.account_id");
    const issues = new Map(all("SELECT account_id, COUNT(*) AS n FROM issue"
      + " WHERE state='open' AND kind='balance_break' GROUP BY account_id")
      .map((r) => [r.account_id, r.n]));
    const review = new Map(all("SELECT account_id, COUNT(*) AS n FROM issue"
      + " WHERE state='open' GROUP BY account_id").map((r) => [r.account_id, r.n]));
    for (const a of accounts) {
      a.breaks = issues.get(a.account_id) || 0;
      a.items = review.get(a.account_id) || 0;
    }
    const holdings = all("SELECT COUNT(*) AS lots, COUNT(DISTINCT asset_id) AS assets,"
      + " SUM(cost_paise) AS cost, SUM(value_paise) AS value,"
      + " SUM(CASE WHEN value_paise IS NULL THEN 1 ELSE 0 END) AS missing_value"
      + " FROM holding")[0] || {};
    const register = all("SELECT COUNT(*) AS assets, SUM(value_paise) AS value"
      + " FROM account WHERE id LIKE 'register-%'")[0] || {};
    const other = all("SELECT COUNT(*) AS n FROM account WHERE category='other'"
      + " AND id NOT LIKE 'register-%'")[0] || { n: 0 };
    const facts = all("SELECT COUNT(*) AS n,"
      + " SUM(CASE WHEN amount_paise>0 THEN amount_paise ELSE 0 END) AS credits,"
      + " SUM(CASE WHEN amount_paise<0 THEN -amount_paise ELSE 0 END) AS debits"
      + " FROM fact")[0] || {};
    return { accounts, holdings, register, other, facts };
  };
  store.validation = () => {
    const audit = store.appAudit();
    const labels = new Map(all("SELECT id, label, bank, number FROM account")
      .map((a) => [a.id, a]));
    for (const a of audit.accounts) {
      const meta = labels.get(a.account_id) || {};
      a.label = meta.label || meta.bank || a.account_id;
      a.number = meta.number || "";
      const net = (a.credits || 0) - (a.debits || 0);
      a.delta = a.opening === null || a.opening === undefined
        || a.closing === null || a.closing === undefined
        ? null : a.closing - a.opening - net;
    }
    const today = new Date().toISOString().slice(0, 10);
    const one = (sql, params = []) => all(sql, params)[0] || {};
    const importRun = one("SELECT MAX(started_at) AS last_at,"
      + " SUM(rows_read) AS rows_read, SUM(rows_kept) AS rows_kept FROM import_run");
    const duplicates = one("SELECT COUNT(*) AS n FROM (SELECT txn_key FROM fact"
      + " GROUP BY txn_key HAVING COUNT(*) > 1)")?.n || 0;
    const zeroAmounts = one("SELECT COUNT(*) AS n FROM fact WHERE amount_paise = 0")?.n || 0;
    const futureDates = one("SELECT COUNT(*) AS n FROM fact WHERE txn_date > ?", [today])?.n || 0;
    const range = one("SELECT MIN(txn_date) AS first_date, MAX(txn_date) AS last_date FROM fact");
    const register = all("SELECT category, COUNT(*) AS n,"
      + " SUM(CASE WHEN principal_paise IS NULL THEN 1 ELSE 0 END) AS no_principal,"
      + " SUM(CASE WHEN maturity_date IS NULL OR maturity_date='' THEN 1 ELSE 0 END) AS no_maturity,"
      + " SUM(CASE WHEN number IS NULL OR number='' THEN 1 ELSE 0 END) AS no_number,"
      + " SUM(CASE WHEN rate_bps IS NULL THEN 1 ELSE 0 END) AS no_rate"
      + " FROM account WHERE id LIKE 'register-%' GROUP BY category");
    const regRequired = all("SELECT COUNT(*) AS n,"
      + " SUM(CASE WHEN principal_paise IS NULL AND category IN ('fd','bonds') THEN 1 ELSE 0 END) AS no_principal,"
      + " SUM(CASE WHEN (maturity_date IS NULL OR maturity_date='') AND category IN ('fd','insurance','bonds') THEN 1 ELSE 0 END) AS no_maturity"
      + " FROM account WHERE id LIKE 'register-%'")[0] || {};
    const totals = {
      facts: audit.facts?.n || 0,
      credits: audit.facts?.credits || 0,
      debits: audit.facts?.debits || 0,
      accounts: (audit.accounts || []).length,
      holdings_lots: audit.holdings?.lots || 0,
      holdings_assets: audit.holdings?.assets || 0,
      register_assets: audit.register?.assets || 0,
      other_assets: audit.other?.n || 0,
      ...range,
    };
    return { generated: new Date().toISOString(), today,
      totals,
      duplicates, zero_amounts: zeroAmounts, future_dates: futureDates,
      accounts: audit.accounts, holdings: audit.holdings, register,
      register_required: regRequired, import: importRun };
  };
  store.auditAccounts = () => all(
    "SELECT f.account_id, COUNT(*) n,"
    + " SUM(CASE WHEN f.amount_paise>0 THEN f.amount_paise ELSE 0 END) credits,"
    + " SUM(CASE WHEN f.amount_paise<0 THEN -f.amount_paise ELSE 0 END) debits,"
    + " MIN(f.txn_date) first_date, MAX(f.txn_date) last_date,"
    + " (SELECT b.balance_paise - b.amount_paise FROM fact b"
    + "  WHERE b.account_id=f.account_id AND b.balance_paise IS NOT NULL"
    + "  ORDER BY b.txn_date ASC, b.id ASC LIMIT 1) opening,"
    + " (SELECT b.balance_paise FROM fact b WHERE b.account_id=f.account_id"
    + "  AND b.balance_paise IS NOT NULL ORDER BY b.txn_date DESC, b.id DESC LIMIT 1) closing"
    + " FROM fact f GROUP BY f.account_id ORDER BY f.account_id");
  store.listIssues = () => all(
    "SELECT i.id, i.kind, i.detail, i.state, i.account_id,"
    + " a.label AS account, f.txn_date AS date, f.amount_paise AS amount,"
    + " f.balance_paise AS balance"
    + " FROM issue i LEFT JOIN fact f ON f.id=i.fact_id"
    + " LEFT JOIN account a ON a.id=i.account_id"
    + " WHERE i.state='open' ORDER BY f.txn_date DESC, i.id DESC");
  store.resolveIssue = (id, state) => {
    conn.run("UPDATE issue SET state=? WHERE id=?", [state, id]);
  };
  store.resolveAllIssues = (state) => {
    conn.run("UPDATE issue SET state=? WHERE state='open'", [state]);
  };
  store.listHoldings = (assetId) => all(
    "SELECT id, security_id, label, category, rating, rating_at_purchase, frequency,"
    + " yield_bps, payout_paise, quantity, cost_paise, value_paise, purchase_date,"
    + " interest_date, future_interest_paise, future_principal_paise, principal_dates,"
    + " returned_paise,"
    + " source_row, source FROM holding WHERE asset_id=? ORDER BY label", [assetId]);
  store.upsertHolding = (assetId, h) => {
    // The rating at purchase is what a later upgrade or downgrade is measured
    // against, so an edit keeps the stored one and a new lot starts at today's.
    let baseline = h.rating_at_purchase;
    if (baseline === undefined) {
      const prior = h.id
        ? all("SELECT rating_at_purchase FROM holding WHERE id=?", [h.id])[0] : null;
      baseline = String(prior?.rating_at_purchase || "").trim() || String(h.rating || "").trim();
    }
    const fields = [h.security_id || "", h.label || "", h.category || "bond",
      h.rating || "", h.frequency || "", h.yield_bps ?? null, h.payout_paise ?? null,
      h.quantity ?? null, h.cost_paise ?? null, h.value_paise ?? null,
      h.purchase_date || "", h.interest_date || "", baseline || "",
      h.future_interest_paise ?? null, h.future_principal_paise ?? null,
      h.principal_dates || "", h.returned_paise ?? null];
    if (h.id) {
      conn.run("UPDATE holding SET security_id=?,label=?,category=?,rating=?,frequency=?,"
        + "yield_bps=?,payout_paise=?,quantity=?,cost_paise=?,value_paise=?,purchase_date=?,"
        + "interest_date=?,rating_at_purchase=?,future_interest_paise=?,"
        + "future_principal_paise=?,principal_dates=?,returned_paise=? WHERE id=?", [...fields, h.id]);
      return h.id;
    }
    const key = ["manual", assetId, Date.now(), Math.random().toString(36).slice(2)].join("|");
    conn.run("INSERT INTO holding(asset_id,security_id,label,category,rating,frequency,"
      + "yield_bps,payout_paise,quantity,cost_paise,value_paise,purchase_date,interest_date,"
      + "rating_at_purchase,future_interest_paise,future_principal_paise,principal_dates,"
      + "returned_paise,source_row,as_of,txn_key,source)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [assetId, ...fields, 0, "", key, "manual"]);
    return all("SELECT last_insert_rowid() AS id")[0].id;
  };
  // The same transaction can arrive twice from two sources (a workbook and the
  // bank's own export) with different running balances. Date, amount and
  // narration identify it; the extra copies are safe to drop.
  store.duplicateFacts = (accountId) => duplicateIds(all(
    "SELECT id, txn_date AS date, amount_paise AS amount, balance_paise AS balance,"
    + " narration FROM fact WHERE account_id=? ORDER BY id", [accountId]));
  // Live check: which rows do not follow from the row above them, in the order
  // the bank printed them.
  store.balanceBreaks = (accountId) => reconcileChain(chainRows(accountId)).issues;
  // Clear this account's stale open items and derive all three kinds again from
  // the rows already held. Accepted/ignored decisions and other kinds stay.
  store.recheckAccount = (accountId) => {
    const { cleared, added } = syncReviewIssues(accountId, { replace: true });
    return { cleared, added };
  };
  // One pass for the whole ledger: the same Re-check, once per account that
  // actually holds rows. A bare asset has nothing to derive from, so it is
  // skipped rather than counted as clean. The wrapper below saves once.
  store.recheckAll = () => {
    const accounts = all("SELECT DISTINCT account_id AS id FROM fact"
      + " WHERE account_id IS NOT NULL ORDER BY account_id").map((r) => r.id);
    let cleared = 0;
    let added = 0;
    for (const accountId of accounts) {
      const res = syncReviewIssues(accountId, { replace: true });
      cleared += res.cleared;
      added += res.added;
    }
    return { accounts: accounts.length, cleared, added };
  };
  // A statement exported newest-first puts a day's rows in reverse. The importer
  // reads the direction now, but rows imported before that stay reversed; this
  // rewrites one day in the order its own balances show. It refuses when
  // reversing does not settle the chain, so a real error is never hidden.
  store.reorderDay = (accountId, date) => {
    const rows = all("SELECT id, txn_date, amount_paise, balance_paise, narration, ref,"
      + " source_row, txn_key, run_id FROM fact WHERE account_id=? AND txn_date=?"
      + " ORDER BY id", [accountId, date]);
    if (rows.length < 2) return { fixed: false, reason: "only one row on this day" };
    const before = all("SELECT balance_paise FROM fact WHERE account_id=? AND txn_date<?"
      + " ORDER BY txn_date DESC, id DESC LIMIT 1", [accountId, date]);
    const previous = before.length ? before[0].balance_paise : null;
    const chains = (list) => {
      let bal = previous;
      for (const r of list) {
        if (r.amount_paise === null || r.balance_paise === null) continue;
        if (bal !== null && r.balance_paise !== bal + r.amount_paise) return false;
        bal = r.balance_paise;
      }
      return true;
    };
    if (chains(rows)) return { fixed: false, reason: "the day already chains" };
    const reversed = rows.slice().reverse();
    if (!chains(reversed)) {
      return { fixed: false, reason: "reversing does not settle this day; a row's balance is wrong" };
    }
    for (const r of rows) conn.run("DELETE FROM fact WHERE id=?", [r.id]);
    for (const r of reversed) {
      conn.run("INSERT INTO fact(account_id,txn_date,amount_paise,balance_paise,narration,ref,"
        + " source_row,txn_key,run_id) VALUES(?,?,?,?,?,?,?,?,?)",
        [accountId, r.txn_date, r.amount_paise, r.balance_paise, r.narration, r.ref,
         r.source_row, r.txn_key, r.run_id]);
    }
    return { fixed: true, rows: reversed.length };
  };
  store.duplicateGroups = (accountId) => {
    const rows = all("SELECT id, txn_date, amount_paise, balance_paise, narration"
      + " FROM fact WHERE account_id=? ORDER BY id", [accountId]);
    const groups = new Map();
    for (const r of rows) {
      const key = [r.txn_date || "", r.amount_paise, normNarration(r.narration)].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.values()].filter((g) => g.length > 1).map((g) => {
      // Same balance: the same event recorded twice. Different balances: a run
      // of real transactions (three ATM withdrawals of ₹3,500, say).
      const exact = g.every((r) => r.balance_paise === g[0].balance_paise);
      return { date: g[0].txn_date || "", description: g[0].narration || "",
        amount: g[0].amount_paise, rows: g, exact,
        keep: exact ? g[0] : null, drop: exact ? g.slice(1) : [] };
    });
  };
  store.mergeDuplicateFacts = (accountId) => {
    const drop = store.duplicateFacts(accountId);
    for (const id of drop) conn.run("DELETE FROM fact WHERE id=?", [id]);
    return drop.length;
  };
  // A row can be corrected from the ledger: the statement was misread, or a
  // balance was typed wrong. The chain is re-checked on the next render.
  store.updateFact = (id, fields) => {
    const keys = Object.keys(fields || {}).filter((k) =>
      ["txn_date", "narration", "amount_paise", "balance_paise"].includes(k));
    if (!keys.length) return false;
    conn.run(`UPDATE fact SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      [...keys.map((k) => fields[k]), id]);
    return true;
  };
  store.deleteFact = (id) => {
    conn.run("DELETE FROM issue WHERE fact_id=?", [id]);
    conn.run("DELETE FROM fact WHERE id=?", [id]);
    return true;
  };
  // Deleting a selection, or every row in an account. The account itself stays.
  // Review items that pointed at the deleted rows go with them; otherwise the
  // next import adds a second copy of the same break.
  store.deleteFacts = (ids) => {
    let n = 0;
    for (const id of ids || []) {
      conn.run("DELETE FROM issue WHERE fact_id=?", [id]);
      conn.run("DELETE FROM fact WHERE id=?", [id]);
      n += 1;
    }
    return n;
  };
  store.deleteAllFacts = (accountId) => {
    const rows = all("SELECT id FROM fact WHERE account_id=?", [accountId]);
    conn.run("DELETE FROM issue WHERE account_id=?", [accountId]);
    for (const r of rows) conn.run("DELETE FROM fact WHERE id=?", [r.id]);
    return rows.length;
  };
  store.deleteHolding = (id) => {
    conn.run("DELETE FROM holding WHERE id=?", [id]);
    return true;
  };
  store.updateHoldingValue = (id, valuePaise) => {
    conn.run("UPDATE holding SET value_paise=? WHERE id=?",
      [valuePaise === null || valuePaise === undefined ? null : valuePaise, id]);
    return true;
  };
  store.deleteAccount = (id) => {
    conn.run("DELETE FROM holding WHERE asset_id=?", [id]);
    conn.run("DELETE FROM issue WHERE account_id=?", [id]);
    conn.run("DELETE FROM fact WHERE account_id=?", [id]);
    conn.run("DELETE FROM import_run WHERE account_id=?", [id]);
    conn.run("DELETE FROM account WHERE id=?", [id]);
  };
  store.getSetting = (key) => all("SELECT value FROM setting WHERE key=?", [key])[0]?.value || null;
  store.setSetting = (key, value) => {
    conn.run("INSERT OR REPLACE INTO setting(key,value) VALUES(?,?)", [key, String(value)]);
  };
  store.monthFlow = (since) => all(
    "SELECT SUM(CASE WHEN amount_paise>0 THEN amount_paise ELSE 0 END) inn,"
    + " SUM(CASE WHEN amount_paise<0 THEN -amount_paise ELSE 0 END) out,"
    + " COUNT(*) n FROM fact WHERE txn_date >= ?", [since])[0]
    || { inn: 0, out: 0, n: 0 };
  store.monthlyFlows = (limit = 36) => all(
    "SELECT substr(txn_date,1,7) AS month,"
    + " SUM(CASE WHEN amount_paise>0 THEN amount_paise ELSE 0 END) inn,"
    + " SUM(CASE WHEN amount_paise<0 THEN -amount_paise ELSE 0 END) out,"
    + " COUNT(*) n FROM fact"
    + " WHERE txn_date IS NOT NULL AND txn_date<>'' AND length(txn_date)>=7"
    + " GROUP BY month ORDER BY month DESC LIMIT ?", [limit]);
  store.summary = () => ({
    facts: all("SELECT COUNT(*) n FROM fact")[0]?.n || 0,
    runs: all("SELECT COUNT(*) n FROM import_run")[0]?.n || 0,
    accounts: all("SELECT COUNT(*) n FROM account")[0]?.n || 0,
    issues: all("SELECT COUNT(*) n FROM issue WHERE state='open'")[0]?.n || 0,
  });
  store.importRows = (account, rows) => {
    const usable = rows.filter((r) => r.date || r.amount !== null);
    const existing = store.heldRows(account);
    const plan = dedupePlan(existing, usable);
    const now = new Date().toISOString();
    conn.run("INSERT OR IGNORE INTO account(id,label,category,type) VALUES(?,?,?,?)",
      [account, account, "bank", "savings"]);
    conn.run("INSERT INTO import_run(account_id,file,started_at,rows_read,rows_kept)"
      + " VALUES(?,?,?,?,0)", [account, account, now, usable.length]);
    const runId = all("SELECT last_insert_rowid() AS id")[0].id;
    let inserted = 0, corrected = 0;
    const occurrence = new Map();
    usable.forEach((r, i) => {
      const fix = plan.updates ? plan.updates[i] : null;
      if (fix) {
        // Replace the row rather than editing it in place: the statement's row
        // order is part of the truth, and a new id puts it back in file order
        // for same-day rows. An old review item about the replaced balance no
        // longer describes the row that is stored.
        conn.run("DELETE FROM issue WHERE fact_id=?", [fix.id]);
        conn.run("DELETE FROM fact WHERE id=?", [fix.id]);
        corrected++;
      } else if (!plan.insert[i]) {
        return;
      }
      const stem = [account, r.date, r.amount, r.balance, r.narration || ""].join("|");
      const n = (occurrence.get(stem) || 0) + 1;
      occurrence.set(stem, n);
      const key = `${stem}|${n}`;
      try {
        conn.run("INSERT INTO fact(account_id,txn_date,amount_paise,balance_paise,"
          + "narration,ref,source_row,txn_key,run_id) VALUES(?,?,?,?,?,?,?,?,?)",
          [account, r.date || null, r.amount, r.balance, r.description || r.narration || "",
           r.ref || "", r.source_row || 0, key, runId]);
        if (!fix) inserted++;
      } catch (e) {
        if (!/UNIQUE/.test(String(e))) throw e;
      }
    });
    conn.run("UPDATE import_run SET rows_kept=? WHERE id=?", [inserted, runId]);
    // Reconcile only when new rows landed. A re-import of held rows must not
    // add the same issues again or reopen ones the user already accepted.
    // Corrections still re-derive the file's oddities for the rows they replace.
    const landed = all("SELECT id FROM fact WHERE run_id=? ORDER BY source_row, id", [runId])
      .map((r) => r.id);
    let breaks = 0;
    if (inserted > 0 || landed.length) {
      const review = syncReviewIssues(account, {
        factIds: landed,
        balanceBreaks: inserted > 0,
      });
      breaks = review.breaks;
    }
    return { inserted, duplicates: plan.duplicates, corrected, runId, breaks };
  };
  store.listLockers = (accountId) => all(
    "SELECT * FROM locker WHERE account_id=? ORDER BY number", [accountId]);
  store.saveLocker = (locker) => {
    const id = locker.id || `locker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    conn.run("INSERT OR REPLACE INTO locker(id,account_id,number,branch,size,"
      + "rent_paise,renewal_date,notes,contents,value_paise) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [id, locker.account_id, locker.number || "", locker.branch || "",
       locker.size || "", locker.rent_paise === undefined ? null : locker.rent_paise,
       locker.renewal_date || "", locker.notes || "", locker.contents || "",
       locker.value_paise === undefined ? null : locker.value_paise]);
    return id;
  };
  store.deleteLocker = (id) => conn.run("DELETE FROM locker WHERE id=?", [id]);
  store.lockerPayments = (accountId) => all(
    "SELECT txn_date, amount_paise, narration FROM fact WHERE account_id=?"
    + " AND amount_paise < 0 AND (LOWER(narration) LIKE '%locker%'"
    + " OR LOWER(narration) LIKE '%safe deposit%') ORDER BY txn_date DESC", [accountId]);
  return store;
}

export async function exportSealedDb() {
  const saved = await idbGet(DB_KEY);
  if (!saved) throw new Error("no database on this device");
  const bytes = new Uint8Array(saved);
  if (!isSealed(bytes)) throw new Error("the database is not encrypted");
  return bytes;
}

export async function importSealedDb(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isSealed(b)) throw new Error("not a sealed BankPipe database");
  await idbPut(DB_KEY, b.buffer);
  noteData(true);
  lockDb();
  return true;
}

export async function dbStatus() {
  const saved = await idbGet(DB_KEY);
  if (!saved) return "empty";
  return isSealed(new Uint8Array(saved)) ? "sealed" : "plain";
}

export async function verifyDbPassphrase(passphrase) {
  const saved = await idbGet(DB_KEY);
  if (!saved) return false;
  try {
    await openBytes(new Uint8Array(saved), passphrase);
    return true;
  } catch (e) {
    return false;
  }
}

export async function openDb(passphrase) {
  if (db) return db;
  if (passphrase) dbPassphrase = passphrase;
  SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
  const saved = await idbGet(DB_KEY);
  let bytes = saved ? new Uint8Array(saved) : null;
  const sealed = bytes ? isSealed(bytes) : false;
  if (sealed) {
    if (!dbPassphrase) {
      const e = new Error("database is locked");
      e.code = "locked";
      throw e;
    }
    bytes = await openBytes(bytes, dbPassphrase);
  }
  dbSealed = sealed;
  browserStore = makeStore(SQL, async (out) => {
    const data = dbPassphrase
      ? await sealBytes(out, dbPassphrase)
      : new Uint8Array(out);
    await idbPut(DB_KEY, data.buffer);
    dbSealed = !!dbPassphrase;
    // Every mutation lands here. Automatic Drive backup listens instead of
    // wrapping each of the fifty callers.
    for (const fn of saveHooks) {
      try { fn(); } catch (e) {}
    }
  });
  await browserStore.open(bytes);
  db = browserStore.raw();
  // A legacy plaintext database is re-sealed as soon as a passphrase exists.
  if (!saved && dbPassphrase) await persist();
  if (bytes && !sealed && dbPassphrase) await persist();
  return db;
}

export async function sealDb(passphrase) {
  if (!db) await openDb();
  dbPassphrase = passphrase;
  await persist();
  dbSealed = true;
  return true;
}

export async function changeDbPassphrase(next) {
  if (!db) throw new Error("database is locked");
  dbPassphrase = next;
  await persist();
  return true;
}

export function lockDb() {
  if (db) db.close();
  db = null;
  browserStore = null;
  SQL = null;
  dbPassphrase = null;
  dbSealed = false;
}

export function isUnlocked() { return !!db; }
export function getDbPassphrase() { return dbPassphrase; }
export function isSealedAtRest() { return dbSealed; }

export async function persist() {
  if (!browserStore) return;
  await browserStore.save();
}

function all(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(v.map((x, i) => [columns[i], x])));
}

export async function heldRows(account) {
  if (!browserStore) await openDb();
  return browserStore.heldRows(account);
}

export async function summary() {
  if (!browserStore) await openDb();
  return browserStore.summary();
}

export async function listAccounts() {
  if (!browserStore) await openDb();
  return browserStore.query(
    "SELECT a.id, a.label, a.bank, a.number, a.city, a.holder, a.type,"
    + " a.category, a.subtype, a.value_paise, a.value_date, a.notes,"
    + " a.principal_paise, a.rate_bps, a.start_date, a.maturity_date,"
    + " a.interest_paid_paise, a.meta, a.ifsc, a.branch, a.address, a.state, a.currency,"
    + " (SELECT SUM(h.cost_paise) FROM holding h WHERE h.asset_id=a.id) AS holdings_cost,"
    + " (SELECT SUM(h.value_paise) FROM holding h WHERE h.asset_id=a.id) AS holdings_value,"
    + " (SELECT SUM(CASE WHEN h.value_paise IS NOT NULL AND h.cost_paise IS NOT NULL"
    + "   AND ABS(h.value_paise-h.cost_paise) >= 1 THEN h.value_paise END)"
    + "   FROM holding h WHERE h.asset_id=a.id) AS holdings_priced_value,"
    + " (SELECT SUM(CASE WHEN h.value_paise IS NOT NULL AND h.cost_paise IS NOT NULL"
    + "   AND ABS(h.value_paise-h.cost_paise) >= 1 THEN h.cost_paise END)"
    + "   FROM holding h WHERE h.asset_id=a.id) AS holdings_priced_cost,"
    + " (SELECT SUM(CASE WHEN h.value_paise IS NOT NULL AND h.cost_paise IS NOT NULL"
    + "   AND ABS(h.value_paise-h.cost_paise) >= 1 THEN 1 ELSE 0 END)"
    + "   FROM holding h WHERE h.asset_id=a.id) AS holdings_priced_count,"
    + " (SELECT COUNT(*) FROM holding h WHERE h.asset_id=a.id) AS holdings_count,"
    + " (SELECT COUNT(*) FROM fact f WHERE f.account_id=a.id) AS facts,"
    + " (SELECT f.balance_paise FROM fact f WHERE f.account_id=a.id AND f.balance_paise IS NOT NULL"
    + "  ORDER BY f.txn_date DESC, f.id DESC LIMIT 1) AS balance,"
    + " (SELECT MIN(f.txn_date) FROM fact f WHERE f.account_id=a.id) AS first_date,"
    + " (SELECT MAX(f.txn_date) FROM fact f WHERE f.account_id=a.id) AS last_date"
    + " FROM account a ORDER BY a.id");
}

const FACT_SORT = {
  date: "f.txn_date", amount: "f.amount_paise", balance: "f.balance_paise",
  description: "f.narration", account: "f.account_id",
};
function factOrder(opts = {}) {
  const col = FACT_SORT[opts.sort] || FACT_SORT.date;
  const dir = Number(opts.dir) === 1 ? "ASC" : "DESC";
  return { col, dir };
}

function factFilter(opts = {}) {
  const clauses = [], params = [];
  const q = String(opts.q || "").trim();
  if (q) { clauses.push("f.narration LIKE ?"); params.push(`%${q}%`); }
  if (opts.from) { clauses.push("f.txn_date >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("f.txn_date <= ?"); params.push(opts.to); }
  if (opts.min !== null && opts.min !== undefined && opts.min !== "") {
    clauses.push("f.amount_paise >= ?"); params.push(Number(opts.min));
  }
  if (opts.max !== null && opts.max !== undefined && opts.max !== "") {
    clauses.push("f.amount_paise <= ?"); params.push(Number(opts.max));
  }
  if (opts.gap === "date") clauses.push("(f.txn_date IS NULL OR f.txn_date='')");
  if (opts.gap === "balance") clauses.push("f.balance_paise IS NULL");
  if (opts.gap === "amount") clauses.push("f.amount_paise IS NULL");
  return { clauses, params };
}
function pageOf(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  return { limit, offset };
}

export async function accountDetail(id, opts = {}) {
  if (!browserStore) await openDb();
  const account = browserStore.query("SELECT * FROM account WHERE id=?", [id])[0] || null;
  const f = factFilter(opts);
  const where = ["f.account_id=?"].concat(f.clauses);
  const params = [id].concat(f.params);
  const { limit, offset } = pageOf(opts);
  const order = factOrder(opts);
  const facts = browserStore.query(
    "SELECT f.id, f.txn_date, f.amount_paise, f.balance_paise, f.narration, f.ref"
    + " FROM fact f WHERE " + where.join(" AND ")
    + ` ORDER BY ${order.col} ${order.dir}, f.id ${order.dir} LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  const totals = browserStore.query(
    "SELECT SUM(CASE WHEN f.amount_paise>0 THEN f.amount_paise ELSE 0 END) inn,"
    + " SUM(CASE WHEN f.amount_paise<0 THEN -f.amount_paise ELSE 0 END) out,"
    + " COUNT(*) n FROM fact f WHERE " + where.join(" AND "), params)[0] || {};
  return { account, facts, totals, limit, offset };
}

export async function searchFacts(opts = {}) {
  if (!browserStore) await openDb();
  return browserStore.searchFacts(opts);
}

// The ledger is filtered and paginated, but Delete all removes the whole
// account. Offer it only when the selection is exactly that whole account:
// a partial page (200 of 1046) must never look like "all". An over-count
// (stale ids from another render) is refused too.
export function showDeleteAll(selected, total) {
  const n = Number(selected) || 0;
  const t = Number(total) || 0;
  return t > 0 && n === t;
}

export async function factIds(opts = {}) {
  if (!browserStore) await openDb();
  return browserStore.factIds(opts);
}

export async function recentTransactions(limit = 200) {
  if (!browserStore) await openDb();
  return browserStore.query(
    "SELECT f.txn_date AS date, f.account_id AS account, f.narration AS description,"
    + " f.amount_paise AS amount, f.balance_paise AS balance"
    + " FROM fact f ORDER BY f.txn_date DESC, f.id DESC LIMIT ?", [limit]);
}

export async function getSetting(key) {
  if (!browserStore) await openDb();
  return browserStore.getSetting(key);
}

export async function setSetting(key, value) {
  if (!browserStore) await openDb();
  browserStore.setSetting(key, value);
  await browserStore.save();
  return true;
}

export async function monthFlow(since) {
  if (!browserStore) await openDb();
  return browserStore.monthFlow(since);
}

export async function monthlyFlows(limit) {
  if (!browserStore) await openDb();
  return browserStore.monthlyFlows(limit);
}

export async function createAccount(a) {
  if (!browserStore) await openDb();
  browserStore.createAccount(a);
  await browserStore.save();
  return a.id;
}

export async function updateAccount(id, fields) {
  if (!browserStore) await openDb();
  const ok = browserStore.updateAccount(id, fields);
  if (ok) await browserStore.save();
  return ok;
}

export async function appAudit() {
  if (!browserStore) await openDb();
  return browserStore.appAudit();
}

export async function validation() {
  if (!browserStore) await openDb();
  return browserStore.validation();
}

export async function auditAccounts() {
  if (!browserStore) await openDb();
  return browserStore.auditAccounts();
}

export async function listIssues() {
  if (!browserStore) await openDb();
  return browserStore.listIssues();
}
export async function listLockers(accountId) {
  if (!browserStore) await openDb();
  return browserStore.listLockers(accountId);
}
export async function saveLocker(locker) {
  if (!browserStore) await openDb();
  const id = browserStore.saveLocker(locker);
  await browserStore.save();
  return id;
}
export async function deleteLocker(id) {
  if (!browserStore) await openDb();
  browserStore.deleteLocker(id);
  await browserStore.save();
  return true;
}
export async function lockerPayments(accountId) {
  if (!browserStore) await openDb();
  return browserStore.lockerPayments(accountId);
}

export async function resolveAllIssues(state) {
  if (!browserStore) await openDb();
  browserStore.resolveAllIssues(state);
  await browserStore.save();
  return true;
}

export async function resolveIssue(id, state) {
  if (!browserStore) await openDb();
  browserStore.resolveIssue(id, state);
  await browserStore.save();
  return true;
}

export async function query(sql, params = []) {
  if (!browserStore) await openDb();
  return browserStore.query(sql, params);
}

export async function planImport(account, rows) {
  if (!browserStore) await openDb();
  return browserStore.planImport(account, rows);
}

export async function replaceHoldings(assetId, rows, asOf) {
  if (!browserStore) await openDb();
  const res = browserStore.replaceHoldings(assetId, rows, asOf);
  await browserStore.save();
  return res;
}

export async function listHoldings(assetId) {
  if (!browserStore) await openDb();
  return browserStore.listHoldings(assetId);
}

export async function upsertHolding(assetId, holding) {
  if (!browserStore) await openDb();
  const id = browserStore.upsertHolding(assetId, holding);
  await browserStore.save();
  return id;
}

export async function duplicateFacts(accountId) {
  if (!browserStore) await openDb();
  return browserStore.duplicateFacts(accountId);
}

export async function deleteFact(id) {
  if (!browserStore) await openDb();
  const ok = browserStore.deleteFact(id);
  await browserStore.save();
  return ok;
}

export async function deleteFacts(ids) {
  if (!browserStore) await openDb();
  const n = browserStore.deleteFacts(ids);
  await browserStore.save();
  return n;
}

export async function deleteAllFacts(accountId) {
  if (!browserStore) await openDb();
  const n = browserStore.deleteAllFacts(accountId);
  await browserStore.save();
  return n;
}

export async function reorderDay(accountId, date) {
  if (!browserStore) await openDb();
  const res = browserStore.reorderDay(accountId, date);
  if (res.fixed) await browserStore.save();
  return res;
}

export async function updateFact(id, fields) {
  if (!browserStore) await openDb();
  const ok = browserStore.updateFact(id, fields);
  await browserStore.save();
  return ok;
}

export async function balanceBreaks(accountId) {
  if (!browserStore) await openDb();
  return browserStore.balanceBreaks(accountId);
}

export async function recheckAccount(accountId) {
  if (!browserStore) await openDb();
  const res = browserStore.recheckAccount(accountId);
  await browserStore.save();
  return res;
}

export async function recheckAll() {
  if (!browserStore) await openDb();
  const res = browserStore.recheckAll();
  await browserStore.save();
  return res;
}

export async function duplicateGroups(accountId) {
  if (!browserStore) await openDb();
  return browserStore.duplicateGroups(accountId);
}

export async function mergeDuplicateFacts(accountId) {
  if (!browserStore) await openDb();
  const removed = browserStore.mergeDuplicateFacts(accountId);
  await browserStore.save();
  return removed;
}

export async function deleteHolding(id) {
  if (!browserStore) await openDb();
  const ok = browserStore.deleteHolding(id);
  await browserStore.save();
  return ok;
}

export async function updateHoldingValue(id, valuePaise) {
  if (!browserStore) await openDb();
  const ok = browserStore.updateHoldingValue(id, valuePaise);
  await browserStore.save();
  return ok;
}

export async function deleteAccount(id) {
  if (!browserStore) await openDb();
  browserStore.deleteAccount(id);
  await browserStore.save();
  return true;
}

export async function clearAll() {
  if (!browserStore) await openDb();
  const con = browserStore.raw();
  con.run("DELETE FROM fact; DELETE FROM import_run; DELETE FROM issue;"
    + " DELETE FROM holding; DELETE FROM account;");
  await browserStore.save();
  noteData(false);
  return true;
}

export async function importRows(account, rows) {
  if (!browserStore) await openDb();
  const res = await browserStore.importRows(account, rows);
  await browserStore.save();
  if (res && (res.inserted > 0 || res.corrected > 0)) noteData(true);
  return res;
}

export async function resetDb() {
  if (!browserStore) await openDb();
  browserStore.raw().run("DELETE FROM fact; DELETE FROM import_run; DELETE FROM issue;"
    + " DELETE FROM holding; DELETE FROM account;");
  await browserStore.save();
}

export function currentStore() { return browserStore; }

export async function importBytes(bytes) {
  if (!browserStore) await openDb();
  browserStore.raw().close();
  browserStore = makeStore(SQL, (b) => idbPut(DB_KEY, b.buffer));
  await browserStore.open(bytes);
  db = browserStore.raw();
  await browserStore.save();
  return browserStore.summary();
}

export function exportBytes() {
  return browserStore ? browserStore.exportBytes() : new Uint8Array();
}
