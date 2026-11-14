// The import inbox, as pure functions. A file is detected by its contents, its
// holdings rows are compared with what the ledger already holds, and every
// decision names the field group and the date it came from. Nothing is written
// here: the page owns the preview, the confirmation and the database.

import { boId } from "./bo-id.js";
import { accountFolios, normalizeFolio } from "./folio.js";
import { isDepositoryAccount, isImportAccount } from "./assets.js";
import { parseCsv } from "./digifinn.js";
import { parseDate, parseNumber, parseMoney } from "./holding-import.js";
import { bondMaturity, isDisposed } from "./bonds.js";

const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const upper = (value) => text(value).toUpperCase();
const ISIN_RE = /^IN[A-Z0-9]{10}$/;
const isIsin = (value) => ISIN_RE.test(upper(value));
const isoToday = (today) => parseDate(today || new Date()) || new Date().toISOString().slice(0, 10);

const asNumber = (value) => (value === null || value === undefined || value === ""
  ? null : parseNumber(value));
const asMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Math.round(value);
  const parsed = parseMoney(value);
  return parsed === null ? null : parsed;
};

// --- what a file is ---------------------------------------------------------

export const IMPORT_KINDS = {
  cas: { label: "Depository statement (CAS)", family: "cas", base: true,
    broker: "", where: "CDSL or NSDL → CAS / e-CAS statement" },
  motilal: { label: "Motilal Oswal holdings report", family: "motilal", base: true,
    broker: "motilal", where: "Motilal Oswal → Reports → Portfolio Holding Summary" },
  "zerodha-holdings": { label: "Zerodha holdings", family: "zerodha", base: true,
    broker: "zerodha", where: "Zerodha Console → Portfolio → Holdings → XLSX" },
  "zerodha-tradebook": { label: "Zerodha tradebook", family: "zerodha", base: false,
    broker: "zerodha", where: "Zerodha Console → Reports → Tradebook" },
  "digifinn-portfolio": { label: "DigiFInn holdings report", family: "digifinn", base: true,
    broker: "digifinn", where: "DigiFInn → Reports & Documents → Holdings Report" },
  "digifinn-investment": { label: "DigiFInn investment report", family: "digifinn", base: false,
    broker: "digifinn", where: "DigiFInn → Reports & Documents → Investment Report" },
  "digifinn-transactions": { label: "DigiFInn transactions report", family: "digifinn", base: false,
    broker: "digifinn", where: "DigiFInn → Reports & Documents → Transactions" },
  "digifinn-payouts": { label: "DigiFInn upcoming payouts", family: "digifinn", base: false,
    broker: "digifinn", where: "DigiFInn → Reports & Documents → Upcoming Payouts" },
  "digifinn-cashflow": { label: "DigiFInn cashflow", family: "digifinn", base: false,
    broker: "digifinn", where: "DigiFInn → Reports & Documents → Cashflow Future" },
  bank: { label: "Bank statement", family: "bank", base: true, broker: "",
    where: "Your bank → Statements" },
  unknown: { label: "Unrecognised file", family: "", base: false, broker: "", where: "" },
};

const KIND_RANK = {
  cas: 0, motilal: 0, "zerodha-holdings": 0, "digifinn-portfolio": 0,
  "digifinn-investment": 1, "zerodha-tradebook": 2,
  "digifinn-transactions": 3, "digifinn-payouts": 4, "digifinn-cashflow": 5,
};

const baseKind = (kind) => !!IMPORT_KINDS[kind]?.base;
export const isBaseImportKind = baseKind;

function dateInText(value) {
  const body = String(value || "");
  const patterns = [
    /as\s+(?:on|of)\s*[,:]?\s*(\d{1,2}[\s/-]+(?:\d{1,2}|[A-Za-z]{3,9})[\s/-]+\d{2,4})/i,
    /statement\s+for\s+the\s+period[\s\S]{0,120}?\bto\s+(\d{1,2}[\s/-]+(?:\d{1,2}|[A-Za-z]{3,9})[\s/-]+\d{2,4})/i,
    /since\s+inception\s+to\s+(\d{1,2}[\s/-]+(?:\d{1,2}|[A-Za-z]{3,9})[\s/-]+\d{2,4})/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      const date = parseDate(match[1]);
      if (date) return date;
    }
  }
  return "";
}

function matrixLooksLikeHoldings(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes("symbol") && cells.includes("isin")
      && (cells.includes("average price") || cells.includes("average cost")
        || cells.includes("buy avg"))) return true;
  }
  return false;
}

// A tradebook workbook uses the same first columns as a holdings export. Its
// header lives in the matrix because there is no text body to scan, and the four
// columns below are the ones parseTradebookRows needs.
function matrixLooksLikeTradebook(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes("trade date")
      && (cells.includes("trade type") || cells.includes("type"))
      && (cells.includes("quantity") || cells.includes("qty"))
      && (cells.includes("price") || cells.includes("trade price"))) return true;
  }
  return false;
}

function headerRow(textBody, required) {
  const rows = parseCsv(String(textBody || ""));
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] || []).map(norm);
    if (required.every((name) => cells.includes(name))) return cells;
  }
  return null;
}

/**
 * Read a file name and whatever text the caller managed to extract. Content
 * wins; a name is a last resort and says so in the confidence.
 * @param {{name?: string, text?: string, matrix?: Array<Array<unknown>>}} input
 * @returns {{kind: string, family: string, broker: string, label: string,
 *   confidence: "content"|"name"|"none", asOf: string}}
 */
export function detectImportFile({ name = "", text: body = "", matrix = null } = {}) {
  const info = (kind, confidence, asOf = "") => ({
    kind, family: IMPORT_KINDS[kind]?.family || "", broker: IMPORT_KINDS[kind]?.broker || "",
    label: IMPORT_KINDS[kind]?.label || "", confidence, asOf,
  });
  if (matrixLooksLikeHoldings(matrix)) return info("zerodha-holdings", "content", "");
  if (matrixLooksLikeTradebook(matrix)) return info("zerodha-tradebook", "content");

  const bodyText = String(body || "");
  const headers = (...required) => headerRow(bodyText, required);
  const date = dateInText(bodyText);

  const tradebook = headers("trade date", "type", "quantity", "price")
    || headers("trade date", "trade type", "quantity", "price");
  if (tradebook) return info("zerodha-tradebook", "content");

  // Cashflow exports also carry an ISIN table that looks like a holdings
  // report. The cashflow wording is the only reliable first signal.
  if (/portfolio\s*cash\s*flow|cash\s*flow\s+future|cashflow\s+future|total\s+futureexpected\s+interest/i.test(bodyText)) {
    return info("digifinn-cashflow", "content", date);
  }
  if (headers("transaction type", "isin")) return info("digifinn-transactions", "content", date);
  if (headers("isin", "units", "amount", "frequency")) {
    return info("digifinn-payouts", "content", date);
  }
  if (headers("bond name", "isin", "qty", "investment value")) {
    return info("digifinn-portfolio", "content", date);
  }
  if (headers("bond name", "issuer", "coupon", "yield")) {
    return info("digifinn-investment", "content", date);
  }
  if (/portfolio\s+holding\s+summary/i.test(bodyText)
    || (/\bCLIENT\s+UCID\b/i.test(bodyText) && /\bBONDS\b/i.test(bodyText))) {
    return info("motilal", "content", date);
  }
  if (/consolidated\s+account\s+statement/i.test(bodyText)
    || /national\s+securities\s+depository/i.test(bodyText)
    || /central\s+depository\s+services/i.test(bodyText)
    || /\be-?CAS\b/i.test(bodyText)) {
    return info("cas", "content", date);
  }
  if (/(withdrawal|deposit|debit|credit)/i.test(bodyText)
    && /(balance|closing\s*balance)/i.test(bodyText)
    && /(narration|description|particulars|remarks)/i.test(bodyText)) {
    return info("bank", "content", date);
  }

  const lower = String(name || "").toLowerCase();
  if (/consolidated|\bcas\b|e-?cas|nsdl|cdsl|_txn\b|aa\d{8}/.test(lower)) {
    return info("cas", "name");
  }
  if (/tradebook|contract/.test(lower)) return info("zerodha-tradebook", "name");
  if (/holdings?[-_ ]report/.test(lower)) return info("digifinn-portfolio", "name");
  if (/portfolio|holding/.test(lower)) return info("digifinn-portfolio", "name");
  if (/statement|stmt/.test(lower)) return info("bank", "name");
  return info("unknown", "none");
}

// --- dates ------------------------------------------------------------------

/**
 * Normalise one snapshot date. An empty value is undated, a value that cannot
 * be read is invalid, and a day after today is future. The caller decides what
 * a flagged date means; this only names it.
 */
export function snapshotAsOf(value, { today = isoToday() } = {}) {
  const raw = String(value ?? "").trim();
  const day = parseDate(raw);
  const now = isoToday(today);
  if (!raw) return { raw, date: "", state: "undated", dated: false };
  if (!day) return { raw, date: "", state: "invalid", dated: false };
  if (day > now) return { raw, date: day, state: "future", dated: true };
  return { raw, date: day, state: "dated", dated: true };
}

/**
 * Which of two dated snapshots is newer. Undated never overrides dated, and an
 * equal date is a question rather than an order.
 * @returns {{relation: "newer"|"older"|"same"|"undated"|"invalid"|"future",
 *   left: object, right: object}}
 */
export function compareAsOf(left, right, { today = isoToday() } = {}) {
  const a = snapshotAsOf(left, { today });
  const b = snapshotAsOf(right, { today });
  if (a.state === "invalid" || b.state === "invalid") return { relation: "invalid", left: a, right: b };
  if (a.state === "future" || b.state === "future") return { relation: "future", left: a, right: b };
  if (a.state === "undated" && b.state === "undated") {
    return { relation: "undated", left: a, right: b };
  }
  if (a.state === "undated") return { relation: "older", left: a, right: b };
  if (b.state === "undated") return { relation: "newer", left: a, right: b };
  if (a.date === b.date) return { relation: "same", left: a, right: b };
  return { relation: a.date > b.date ? "newer" : "older", left: a, right: b };
}

// --- a broker tradebook -----------------------------------------------------

/**
 * Zerodha's tradebook. It carries trade_date, trade_type, quantity and price.
 * The quantity is never used to write a holding: the holdings snapshot owns
 * that. The first buy of each ISIN supplies a purchase date when the holdings
 * file has none.
 */
export function parseTradebook(body) {
  return parseTradebookRows(parseCsv(String(body || "")));
}

/**
 * The same tradebook, already a spreadsheet matrix. An XLSX has no text body,
 * so the inbox hands the sheet rows in directly.
 */
export function parseTradebookMatrix(matrix) {
  return parseTradebookRows(Array.isArray(matrix) ? matrix : []);
}

function parseTradebookRows(rows) {
  let header = -1;
  let cols = null;
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map(norm);
    const at = (names) => names.map((name) => cells.indexOf(name)).find((n) => n >= 0);
    const date = at(["trade date", "date"]);
    const type = at(["trade type", "type"]);
    const quantity = at(["quantity", "qty"]);
    const price = at(["price", "trade price"]);
    if (date !== undefined && type !== undefined && quantity !== undefined
      && price !== undefined) {
      header = i;
      cols = { date, type, quantity, price,
        isin: at(["isin"]), symbol: at(["symbol", "stock"]) };
      break;
    }
  }
  if (header < 0) {
    return { rows: [], firstBuyByIsin: {}, firstBuyBySymbol: {},
      error: "No tradebook header found in this file." };
  }
  const out = [];
  const firstBuyByIsin = {};
  const firstBuyBySymbol = {};
  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const date = parseDate(row[cols.date]);
    if (!date) continue;
    const type = norm(row[cols.type]);
    const quantity = asNumber(row[cols.quantity]);
    const pricePaise = asMoney(row[cols.price]);
    if (quantity === null || pricePaise === null) continue;
    const isin = cols.isin === undefined ? "" : upper(row[cols.isin]);
    const symbol = cols.symbol === undefined ? "" : text(row[cols.symbol]);
    const trade = { isin, symbol, date, type, quantity, pricePaise };
    out.push(trade);
    if (!/buy/.test(type)) continue;
    if (isIsin(isin) && (!firstBuyByIsin[isin] || date < firstBuyByIsin[isin])) {
      firstBuyByIsin[isin] = date;
    }
    if (symbol && (!firstBuyBySymbol[symbol] || date < firstBuyBySymbol[symbol])) {
      firstBuyBySymbol[symbol] = date;
    }
  }
  return { rows: out, firstBuyByIsin, firstBuyBySymbol,
    error: out.length ? null : "The tradebook has no readable trades." };
}

// --- bundles ----------------------------------------------------------------

const OPTIONAL_ADDS = {
  "digifinn-investment": "Adds coupon, maturity and yield",
  "digifinn-transactions": "Adds buy and sell history; fills a first purchase date",
  "digifinn-payouts": "Adds the next payout, frequency and part redemptions",
  "digifinn-cashflow": "Adds the full future payout and principal schedule",
  "zerodha-tradebook": "Fills first purchase dates; never changes quantity",
};

const rowIsin = (row) => upper(row?.isin || row?.security_id || "");
const rowKey = (row) => rowIsin(row) || norm(row?.label || row?.security_name || "");

function fillEmpty(row, key, value) {
  if (value === null || value === undefined || value === "") return;
  if (row[key] === null || row[key] === undefined || row[key] === "") row[key] = value;
}

function pickFields(target, source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== "") {
      target[key] = source[key];
    }
  }
}

function enrichRows(baseRows, optional) {
  const rows = (baseRows || []).map((row) => ({ ...row }));
  const byIsin = new Map();
  const byLabel = new Map();
  for (const row of rows) {
    if (rowIsin(row)) byIsin.set(rowIsin(row), row);
    if (row.label) byLabel.set(norm(row.label), row);
  }
  for (const file of optional) {
    for (const trade of Object.entries(file.firstBuyByIsin || {})) {
      const row = byIsin.get(trade[0]);
      if (row) fillEmpty(row, "purchaseDate", trade[1]);
    }
    for (const trade of Object.entries(file.firstBuyBySymbol || {})) {
      if (!rows.some((row) => norm(row.symbol) === trade[0])) continue;
      const row = rows.find((candidate) => norm(candidate.symbol) === trade[0]);
      if (row) fillEmpty(row, "purchaseDate", trade[1]);
    }
    for (const term of file.termsByLabel || []) {
      const row = byLabel.get(norm(term.label));
      if (!row) continue;
      fillEmpty(row, "couponPct", term.couponPct);
      fillEmpty(row, "maturity", term.maturity);
      fillEmpty(row, "issuer", term.issuer);
      fillEmpty(row, "yieldPct", term.yieldPct);
      fillEmpty(row, "purchaseDate", term.purchaseDate);
    }
    for (const term of file.termsByIsin || []) {
      const row = byIsin.get(upper(term.isin));
      if (!row) continue;
      fillEmpty(row, "frequency", term.frequency);
      fillEmpty(row, "interestDate", term.interestDate);
      fillEmpty(row, "payoutPaise", term.payoutPaise);
      fillEmpty(row, "futureInterestPaise", term.futureInterestPaise);
      fillEmpty(row, "futurePrincipalPaise", term.futurePrincipalPaise);
      fillEmpty(row, "yieldPct", term.yieldPct);
      fillEmpty(row, "investmentPaise", term.investmentPaise);
      fillEmpty(row, "investmentDate", term.investmentDate);
      fillEmpty(row, "costPaise", term.investmentPaise);
      fillEmpty(row, "purchaseDate", term.investmentDate);
    }
  }
  return rows;
}

/**
 * One bundle per account. The base holdings file decides the account; optional
 * reports ride along and only fill the facts they carry. Files are sorted by
 * kind before merging, so dropping the same set in another order gives the same
 * plan.
 */
export function groupBundles(files = []) {
  const list = (files || []).filter((file) => IMPORT_KINDS[file?.kind]?.family
    && IMPORT_KINDS[file.kind].family !== "bank");
  const bases = list.filter((file) => baseKind(file.kind));
  const optional = list.filter((file) => !baseKind(file.kind));
  const bundles = new Map();
  const ensure = (key, seed) => {
    if (!bundles.has(key)) {
      bundles.set(key, {
        key, family: seed.family, broker: seed.broker, accountKey: seed.accountKey || "",
        accountKind: seed.accountKind || "", files: [], base: null, optional: [], rows: [],
        warnings: [], ready: false,
      });
    }
    return bundles.get(key);
  };
  for (const file of [...bases].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))) {
    const family = IMPORT_KINDS[file.kind].family;
    const key = `${family}:${file.accountKey || "unknown"}`;
    const bundle = ensure(key, { ...file, family });
    bundle.files.push(file);
    bundle.accountKey = bundle.accountKey || file.accountKey || "";
    bundle.accountKind = bundle.accountKind || file.accountKind || "";
  }
  const sortedOptional = [...optional].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  for (const file of sortedOptional) {
    const family = IMPORT_KINDS[file.kind].family;
    const own = file.accountKey
      ? bundles.get(`${family}:${file.accountKey}`) : null;
    const sameFamily = [...bundles.values()].filter((bundle) => bundle.family === family);
    const target = own || (sameFamily.length === 1 ? sameFamily[0] : null);
    if (target) {
      target.files.push(file);
      target.optional.push(file);
      continue;
    }
    const key = `${family}:optional:${file.name || file.kind}`;
    const bundle = ensure(key, { ...file, family, accountKey: "" });
    bundle.files.push(file);
    bundle.optional.push(file);
    bundle.warnings.push(sameFamily.length > 1
      ? `This ${IMPORT_KINDS[file.kind].label.toLowerCase()} names no account and two accounts use ${IMPORT_KINDS[family]?.label || family} files. Add it to the right account.`
      : `Add the ${IMPORT_KINDS[family]?.label || family} holdings report first.`);
  }
  const out = [];
  for (const bundle of bundles.values()) {
    const filesInBundle = [...bundle.files].sort((a, b) =>
      (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
      || String(a.name || "").localeCompare(String(b.name || "")));
    const base = filesInBundle.find((file) => baseKind(file.kind)) || null;
    const optionals = filesInBundle.filter((file) => !baseKind(file.kind));
    const rows = base ? enrichRows(base.rows || [], optionals) : [];
    if (!base) bundle.warnings.push("No holdings report in this set, so there is nothing to import yet.");
    if (filesInBundle.filter((file) => baseKind(file.kind)).length > 1) {
      bundle.warnings.push("More than one holdings snapshot is in this set. The first file by name is used; remove the extra one if it is the wrong account.");
    }
    if (base && !base.asOf) {
      bundle.warnings.push("The holdings report has no date. It will fill empty fields but will not overwrite dated data.");
    }
    if (base && base.asOf && base.asOf !== base.asOf.slice(0, 10)) { /* already normalised */ }
    bundle.files = filesInBundle;
    bundle.base = base;
    bundle.optional = optionals;
    bundle.rows = rows;
    bundle.asOf = base?.asOf || "";
    // A CAS can carry only movements: a bond bought and sold inside the period
    // never prints in a holdings table. The sale is still the import.
    const hasMovements = base?.kind === "cas" && (base?.parsed?.transactions || []).length > 0;
    bundle.ready = !!(base && (rows.length || hasMovements));
    bundle.rowCount = rows.length;
    bundle.isinCount = new Set(rows.map(rowIsin).filter(Boolean)).size;
    bundle.accountKey = bundle.accountKey || base?.accountKey || "";
    bundle.accountKind = bundle.accountKind || base?.accountKind || "";
    if (optionals.length) {
      bundle.adds = optionals.map((file) => ({
        kind: file.kind, label: IMPORT_KINDS[file.kind]?.label || file.kind,
        adds: OPTIONAL_ADDS[file.kind] || "Adds detail",
        asOf: file.asOf || "",
      }));
    }
    out.push(bundle);
  }
  const familyRank = { cas: 0, motilal: 1, zerodha: 2, digifinn: 3 };
  return out.sort((a, b) => (familyRank[a.family] ?? 9) - (familyRank[b.family] ?? 9)
    || String(a.accountKey || a.key).localeCompare(String(b.accountKey || b.key)));
}

/**
 * One plan per resolved account, after resolution. Every bundle arrives with the
 * account ids its files resolved to: a broker file names one account, a CAS names
 * one per demat and per folio it carries. A bundle that shares an account with an
 * earlier plan joins it, so a CAS and a broker report for one demat are one plan
 * with one preview and one confirmation.
 *
 * A bundle that resolved to nothing keeps its own plan and is never attached to a
 * guess. A bundle that would join two unrelated plans starts its own instead,
 * because merging them would put two accounts into one confirmation. Callers pass
 * CAS bundles first: one CAS can name several accounts, and it has to claim them
 * before a broker file is grouped.
 *
 * A locked bundle never joins another plan and never claims its accounts for a
 * later bundle. The page locks a statement that records movements, because the
 * order that keeps a disposal's cost is the broker report first and the
 * statement second, and one card would hide that order behind a single accept.
 *
 * @param {Array<{key: string, family?: string, accounts?: Array<string>,
 *   locked?: boolean}>} bundles
 * @returns {Array<{key: string, family: string, members: Array<string>,
 *   accounts: Array<string>}>}
 */
export function groupResolvedPlans(bundles = []) {
  const plans = [];
  const byAccount = new Map();
  for (const bundle of bundles || []) {
    if (!bundle?.key) continue;
    const accounts = [...new Set((bundle.accounts || []).filter(Boolean))];
    const locked = !!bundle.locked;
    const homes = locked ? []
      : [...new Set(accounts.map((id) => byAccount.get(id)).filter(Boolean))];
    if (homes.length === 1) {
      const plan = homes[0];
      plan.members.push(bundle.key);
      for (const id of accounts) {
        if (byAccount.has(id)) continue;
        byAccount.set(id, plan);
        plan.accounts.push(id);
      }
      continue;
    }
    const plan = { key: bundle.key, family: bundle.family || "",
      members: [bundle.key], accounts };
    plans.push(plan);
    if (locked) continue;
    for (const id of accounts) if (!byAccount.has(id)) byAccount.set(id, plan);
  }
  return plans;
}

// --- accounts ---------------------------------------------------------------

function safeMeta(account) {
  try {
    return typeof account?.meta === "string" ? JSON.parse(account.meta) : (account?.meta || {});
  } catch (e) {
    return {};
  }
}

/** One account's identities and the ISINs it already holds. */
export function normalizeAccount(account, holdings = account?.holdings || []) {
  const meta = safeMeta(account);
  const raw = account?.bo_id || account?.number || meta.bo_id || meta.demat || "";
  const id = boId(raw);
  return {
    id: String(account?.id || ""),
    label: text(account?.label || account?.bank || account?.id || "Demat"),
    category: String(account?.category || account?.type || ""),
    subtype: String(account?.subtype || ""),
    boId: id.kind === "bo" ? id.boId : "",
    number: text(raw),
    clientId: upper(account?.client_id || meta.client_id || ""),
    ucid: upper(meta.ucid || account?.ucid || ""),
    depository: text(meta.depository || ""),
    dp: text(meta.dp || ""),
    amc: text(meta.amc || "").toLowerCase(),
    brokerOnly: meta.broker_only === "1" || meta.broker_only === true,
    folios: accountFolios(account),
    meta,
    holdings: holdings || [],
    isins: [...new Set((holdings || []).map(rowIsin).filter(Boolean))],
  };
}

function identityFor(file) {
  const value = upper(file?.accountKey || "");
  if (!value) return null;
  const kind = file.accountKind || (isIsin(value) || /^\d{16}$/.test(value) ? "bo" : "other");
  return { kind, value };
}

/**
 * Every account this file could belong to, best first. A BO ID, a broker UCID
 * and a client ID are identity hits; an ISIN is an overlap hit. An account with
 * no overlapping ISIN still appears when it is named by identity, because a
 * report for an empty demat is exactly the case that used to be invisible.
 *
 * A broker holding can land on any securities account. A CAS is a depository
 * statement, so with `forCas` it can only land on a demat or a fund folio: a
 * bond portfolio that holds the same ISIN is a cost record, not a custody
 * account, and must not receive a depository snapshot.
 */
export function accountMatches(file, accounts = [], { forCas = false } = {}) {
  const identity = identityFor(file);
  const wanted = [...new Set((file?.rows || []).map(rowIsin).filter(Boolean))];
  const wantedSet = new Set(wanted);
  const wantedAmc = String(file?.amc || "").trim().toLowerCase();
  const matches = [];
  for (const raw of accounts) {
    // The import list and the matcher share one rule: a demat, a fund folio or
    // a bond portfolio can receive a holdings report. A bank or FD cannot, and
    // a cost-only bond record is bookkeeping rather than a target.
    if (!isImportAccount(raw)) continue;
    if (forCas && !isDepositoryAccount(raw)) continue;
    const account = normalizeAccount(raw, raw?.holdings || []);
    let identityKind = "";
    if (identity) {
      // A folio is identity. It matches only an account that answers to that
      // folio; ISIN overlap must not attach it to a different folio of the same
      // AMC, so a non-match drops the account instead of falling through.
      if (identity.kind === "folio") {
        if (!account.folios.includes(normalizeFolio(identity.value))) continue;
        identityKind = "folio";
      } else if ((identity.kind === "bo" || identity.kind === "demat")
        && account.boId && boId(identity.value).boId === account.boId) identityKind = "BO ID";
      else if (identity.kind === "ucid" && account.ucid === identity.value) identityKind = "UCID";
      else if (identity.kind === "client" && account.clientId === identity.value) identityKind = "client ID";
      else if (identity.kind === "client" && upper(account.number) === identity.value) identityKind = "client ID";
    }
    let hits = 0;
    for (const isin of account.isins) if (wantedSet.has(isin)) hits += 1;
    if (!identityKind && !hits) continue;
    matches.push({
      id: account.id, label: account.label, identity: !!identityKind, identityKind,
      amcMatch: !!wantedAmc && account.amc === wantedAmc,
      hits, of: wanted.length, isins: account.isins, brokerOnly: account.brokerOnly,
      boId: account.boId, clientId: account.clientId, ucid: account.ucid,
      account,
    });
  }
  matches.sort((a, b) => Number(b.identity) - Number(a.identity)
    || Number(b.amcMatch) - Number(a.amcMatch)
    || b.hits - a.hits || a.label.localeCompare(b.label));
  const tie = matches.length > 1 && !matches[0].identity && !matches[1].identity
    && matches[0].hits === matches[1].hits;
  const top = matches[0] || null;
  const share = top && top.of ? top.hits / top.of : 0;
  // One attach rule for both report families. A file's BO ID, UCID or client ID
  // names the account. Without one, an ISIN overlap has to explain most of the
  // file; one match out of five hundred does not buy a whole snapshot a home.
  const attachId = !tie && top && (top.identity || (top.hits > 0 && share >= 0.8))
    ? top.id : "";
  return {
    matches, total: wanted.length, tie,
    bestId: !tie && top ? top.id : "",
    attachId,
    identityId: top && top.identity ? top.id : "",
  };
}

/** The key an account was identified by, from the fields already on it. */
function storedIdentityValue(account, source, meta) {
  if (source === "cas") {
    const raw = account?.bo_id || account?.number || meta.bo_id || meta.demat || "";
    return boId(raw).boId || upper(raw);
  }
  // A broker stores its own key under the family's field. Legacy accounts may
  // carry one without a family, so fall back to whichever key is present.
  return upper(meta.ucid || meta.client_id || meta.demat
    || account?.ucid || account?.client_id || "");
}

/** The dates the fields on one account were last written, and by what. */
export function accountFieldState(account, holdings = []) {
  const meta = safeMeta(account);
  const rowDates = (holdings || []).map((row) => parseDate(row.as_of || "")).filter(Boolean).sort();
  const snapshotAsOf = parseDate(meta.holdings_as_of || "") || rowDates[rowDates.length - 1] || "";
  const snapshotSource = meta.holdings_source || (snapshotAsOf ? "report" : "");
  const identitySource = meta.identity_source || (snapshotSource === "cas" ? "cas" : "");
  const identityAsOf = parseDate(meta.identity_as_of || "")
    || (identitySource === "cas" ? snapshotAsOf : "");
  return {
    identity: { source: identitySource, asOf: identityAsOf,
      value: storedIdentityValue(account, identitySource, meta) },
    snapshot: { source: snapshotSource, asOf: snapshotAsOf },
    cost: {
      source: meta.cost_source || meta.broker_source || "",
      asOf: parseDate(meta.cost_as_of || ""),
      manual: meta.cost_manual === "1" || meta.cost_manual === true,
    },
    manualAsOf: parseDate(meta.manual_as_of || ""),
  };
}

// A stored holding row has no maturity column: a bond's date is in its label.
// Read the explicit field first, then derive it only for a bond so a stray date
// in a fund or share name cannot mark that row matured.
function holdingMaturity(row) {
  return bondMaturity(row).maturity;
}

/**
 * One account's status line: the label, the active holding count and the
 * newest statement dates. Pure, so the page can render it and a test can read
 * it without a DOM; the caller supplies the date formatter it already uses.
 *
 * A matured bond or a zero-quantity history row is not a current position. It
 * is counted separately and named in `countText` so a portfolio does not brag
 * about holdings it no longer has.
 */
export function importAccountSummary(account, holdings = [],
  formatDate = (value) => String(value || ""),
  today = new Date().toISOString().slice(0, 10)) {
  const meta = safeMeta(account);
  const rows = holdings || [];
  const state = accountFieldState(account, rows);
  const brokerOnly = meta.broker_only === "1" || meta.broker_only === true
    || (!state.identity.source && !!state.snapshot.source);
  const brokerAsOf = state.cost.asOf || String(meta.broker_as_of || "").slice(0, 10)
    || (state.identity.source && state.identity.source !== "cas" ? state.identity.asOf : "");
  const casAsOf = state.identity.source === "cas" ? state.identity.asOf : "";
  const positions = rows.map((row) => {
    const quantity = asNumber(row?.quantity);
    const disposed = isDisposed(row);
    const maturity = holdingMaturity(row);
    const matured = !disposed && !!(maturity && maturity < today);
    return { matured, disposed,
      active: !disposed && !matured && quantity !== null && quantity > 0 };
  });
  const count = positions.filter((position) => position.active).length;
  const matured = positions.filter((position) => position.matured).length;
  // "No holdings yet" means the account has no rows at all. An account holding
  // only history has positions, just none of them current.
  let label = count > 0 ? "Holdings" : rows.length ? "No current holdings" : "No holdings yet";
  let kind = "";
  if (brokerOnly) { label = "Broker-only"; kind = "warn"; }
  else if (casAsOf) { label = "CAS verified"; kind = "good"; }
  if (brokerAsOf && casAsOf && brokerAsOf > casAsOf) { label = "Newer broker data"; kind = "warn"; }
  const countText = [count > 0 ? `${count} holding${count === 1 ? "" : "s"}` : "",
    matured > 0 ? `${matured} matured` : ""].filter(Boolean).join(" · ");
  return { label, kind, brokerOnly, brokerAsOf, casAsOf, count, matured, countText,
    dates: [casAsOf ? `CAS ${formatDate(casAsOf)}` : "",
      brokerAsOf ? `Broker ${formatDate(brokerAsOf)}` : ""].filter(Boolean).join(" · ") };
}

// --- the merge plan ---------------------------------------------------------

function normalizeHolding(row) {
  return {
    ...row,
    isin: rowIsin(row),
    label: text(row.label || row.security_name || ""),
    category: String(row.category || "").toLowerCase(),
    quantity: asNumber(row.quantity),
    valuePaise: asMoney(row.valuePaise ?? row.value_paise),
    costPaise: asMoney(row.costPaise ?? row.cost_paise),
    facePaise: asMoney(row.facePaise ?? row.face_paise),
    purchaseDate: parseDate(row.purchaseDate ?? row.purchase_date ?? ""),
    asOf: parseDate(row.asOf ?? row.as_of ?? ""),
    source: String(row.source || ""),
    valueSource: String(row.valueSource ?? row.value_source ?? ""),
    couponPct: asNumber(row.couponPct),
    frequency: text(row.frequency),
    // A stored holding has no maturity column: the label carries it. Derive it
    // for the old row too, or every re-import sees a maturity it cannot store
    // as a new field and rewrites the same rows.
    maturity: parseDate(row.maturity ?? row.maturity_date ?? "") || bondMaturity(row).maturity,
    interestDate: parseDate(row.interestDate ?? row.interest_date ?? ""),
    payoutPaise: asMoney(row.payoutPaise ?? row.payout_paise),
    futureInterestPaise: asMoney(row.futureInterestPaise ?? row.future_interest_paise),
    futurePrincipalPaise: asMoney(row.futurePrincipalPaise ?? row.future_principal_paise),
    issuer: text(row.issuer),
    yieldPct: asNumber(row.yieldPct ?? row.yield_pct),
  };
}

function normalizeIncoming(row) {
  const out = normalizeHolding(row);
  out.isin = rowIsin(row);
  out.maturity = bondMaturity(out).maturity;
  return out;
}

function moneyDifferent(a, b) {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(Number(a) - Number(b)) > 1;
}

function fieldChange(group, field, from, to, source, asOf, extra = {}) {
  return { group, field, from, to, source, asOf, requiresConfirm: false, ...extra };
}

function fieldsWouldChange(oldRow, nextRow, keys) {
  return keys.filter((key) => {
    const a = oldRow[key], b = nextRow[key];
    if (typeof a === "number" || typeof b === "number") return moneyDifferent(a, b);
    return String(a ?? "") !== String(b ?? "");
  });
}

function snapshotDecision({ relation, incomingState, existing }) {
  if (incomingState === "invalid") return { take: false, flag: "invalid-date" };
  if (incomingState === "future") return { take: false, flag: "future-date", requiresConfirm: true };
  if (incomingState === "undated") {
    return existing?.asOf ? { take: false, fillEmpty: true, flag: "undated" }
      : { take: true, fillEmpty: true, flag: "undated" };
  }
  if (!existing?.asOf) return { take: true };
  if (relation === "newer") return { take: true };
  if (relation === "same") return { take: false, ask: true };
  return { take: false, fillEmpty: true };
}

/**
 * What one incoming holdings file does to one account, field group by field
 * group. The result is data, not a write: the page renders it and the apply
 * step follows it.
 */
export function planMerge({ incoming, existing = {}, today = isoToday() } = {}) {
  const now = isoToday(today);
  const incomingState = snapshotAsOf(incoming?.asOf, { today: now });
  const oldRows = (existing.holdings || []).map(normalizeHolding);
  const inRows = (incoming?.rows || []).map(normalizeIncoming).filter((row) => row.isin || row.label);
  const oldByIsin = new Map();
  const oldByLabel = new Map();
  const soldByIsin = new Map();
  for (const row of oldRows) {
    // A disposal is history, not a holding the next report can revive. A report
    // that names it again is a re-purchase or a disagreement, and both are a
    // question rather than a silent overwrite of the recorded sale.
    if (row.disposed_at) {
      if (row.isin) {
        const prior = soldByIsin.get(row.isin);
        if (!prior || String(row.disposed_at) > String(prior.disposed_at)) {
          soldByIsin.set(row.isin, row);
        }
      }
      continue;
    }
    if (row.isin) oldByIsin.set(row.isin, row);
    if (row.label) oldByLabel.set(norm(row.label), row);
  }
  const incomingIsins = new Set(inRows.map((row) => row.isin).filter(Boolean));
  const categories = new Set(incoming?.categories?.length
    ? incoming.categories.map((category) => String(category).toLowerCase())
    : inRows.map((row) => row.category).filter(Boolean));
  const cmp = compareAsOf(incomingState.raw, existing.snapshot?.asOf || "", { today: now });
  const relation = cmp.relation;
  const unsafeDate = incomingState.state === "invalid" || incomingState.state === "future";
  const existingSource = String(existing.snapshot?.source || "");
  const hasExistingSnapshot = !!(existing.snapshot?.asOf);
  // A manual snapshot is the person's own record, so an older CAS still only
  // attaches identity there. A broker snapshot is different: the depository is
  // the authority for what is still held, even when its statement is older.
  const manualSnapshot = existingSource === "manual" || !!existing.cost?.manual;
  const olderCas = incoming?.kind === "cas" && hasExistingSnapshot
    && existingSource !== "cas" && oldRows.length > 0 && relation === "older";
  // An older CAS that would move a live quantity or value is a source change.
  // One that would only add history or fill an empty field stays identity-only.
  const casLiveChange = olderCas && inRows.some((row) => {
    const old = oldByIsin.get(row.isin)
      || (!row.isin ? oldByLabel.get(norm(row.label)) : null);
    if (!old) return false;
    return (row.quantity !== null && moneyDifferent(old.quantity, row.quantity))
      || (row.valuePaise !== null && moneyDifferent(old.valuePaise, row.valuePaise));
  });
  const identityOnly = olderCas && (manualSnapshot || !casLiveChange);
  const olderWithData = hasExistingSnapshot && relation === "older" && oldRows.length > 0;
  const undatedWithData = hasExistingSnapshot && relation === "undated" && oldRows.length > 0;
  // The one exception to "older snapshots do not overwrite": a dated, safe CAS
  // owns quantity and value. The latest broker still owns cost and terms.
  const casQuantityTake = incoming?.kind === "cas" && !unsafeDate
    && incomingState.state === "dated" && relation === "older"
    && hasExistingSnapshot && oldRows.length > 0 && !identityOnly;
  const canTakeSnapshot = !unsafeDate && !identityOnly && !olderWithData && !undatedWithData
    && snapshotDecision({ relation, incomingState: incomingState.state, existing: existing.snapshot }).take;
  const canAdd = !unsafeDate && !identityOnly && !olderWithData && !undatedWithData;
  const snapshotTake = snapshotDecision({
    relation, incomingState: incomingState.state, existing: existing.snapshot,
  });
  const snapshotChangeAllowed = snapshotTake.take;
  const sameDate = relation === "same";
  const flags = [];
  const warnings = [];
  if (incomingState.state === "invalid") {
    warnings.push("The report's date cannot be read. It will not overwrite dated data.");
  } else if (incomingState.state === "future") {
    warnings.push(`The report is dated ${incomingState.date}, which is in the future. Check the file before importing.`);
  } else if (incomingState.state === "undated") {
    warnings.push("The report has no date. It will fill empty fields and add new rows, but it will not overwrite dated data.");
  }
  if (casQuantityTake) {
    warnings.push("This CAS is older than the broker data on file. Its quantity and value replace the broker's; cost and terms stay from the newer broker report.");
  } else if (identityOnly) {
    warnings.push("This CAS is older than the broker data on file. Its identity will attach; the newer holdings stay.");
  } else if (olderWithData) {
    warnings.push("This snapshot is older than the data on file. It will only fill empty fields.");
  }
  if (sameDate) warnings.push("This report has the same date as the data on file. Review each difference before importing.");

  // The cost group: broker terms belong to the latest broker report. Manual
  // cost is never overwritten silently.
  const costExisting = existing.cost || {};
  const costDate = costExisting.asOf || (costExisting.manual ? existing.manualAsOf || "" : "");
  const incomingCarriesCost = inRows.some((row) => row.costPaise !== null
    || row.purchaseDate || row.couponPct !== null || row.maturity || row.frequency
    || row.facePaise !== null);
  const costIsCas = incoming?.kind === "cas";
  const manualExisting = costExisting.manual || oldRows.some((row) => row.source === "manual");
  let costMode = "keep";
  if (incomingCarriesCost && !identityOnly && !unsafeDate) {
    if (incoming?.manual?.asOf) {
      if (!costDate) costMode = "take";
      else {
        const manualCmp = compareAsOf(incoming.manual.asOf, costDate, { today: now });
        if (manualCmp.relation === "newer") costMode = "take";
        else costMode = "ask";
      }
    } else if (manualExisting) {
      costMode = "ask";
    } else if (costIsCas) {
      costMode = "fill-empty";
    } else if (!costDate) {
      costMode = "take";
    } else if (incomingState.state === "undated" || incomingState.state === "invalid") {
      costMode = "fill-empty";
    } else {
      const costCmp = compareAsOf(incomingState.raw, costDate, { today: now });
      if (costCmp.relation === "newer") costMode = "take";
      else if (costCmp.relation === "same") costMode = "ask";
      else costMode = "fill-empty";
    }
  }

  const decisions = [];
  let added = 0, updated = 0, kept = 0, ask = 0, flagged = 0, skipped = 0, manualOnly = 0;
  let costCarried = 0;
  for (const row of inRows) {
    const old = oldByIsin.get(row.isin) || (!row.isin ? oldByLabel.get(norm(row.label)) : null);
    if (!old) {
      const sold = row.isin ? soldByIsin.get(row.isin) : null;
      if (sold) {
        const soldDate = String(sold.disposed_at || "").slice(0, 10);
        const reportAfter = !!incomingState.date && !!soldDate
          && incomingState.date >= soldDate;
        const showsUnits = row.quantity !== null && Number(row.quantity) > 0;
        const noUnits = row.quantity !== null && Number(row.quantity) <= 0;
        if (noUnits) {
          kept += 1;
          decisions.push({ isin: row.isin, label: row.label, action: "keep",
            existing: sold, next: sold, changes: [], flags: ["sold"],
            reason: "matches the recorded disposal" });
          continue;
        }
        if (!showsUnits) {
          skipped += 1;
          decisions.push({ isin: row.isin, label: row.label, action: "skip",
            existing: sold, next: null, changes: [], flags: ["sold-conflict"],
            reason: "the report carries no quantity for a bond already recorded as sold" });
          continue;
        }
        if (!reportAfter || !canAdd) {
          skipped += 1;
          decisions.push({ isin: row.isin, label: row.label, action: "skip",
            existing: sold, next: null, changes: [], flags: ["sold-conflict"],
            reason: reportAfter ? "a recorded sale leaves no live row to update"
              : "older than the recorded sale" });
          continue;
        }
        ask += 1;
        const next = { ...row };
        if (!next.asOf) next.asOf = incomingState.date || "";
        decisions.push({
          isin: row.isin, label: row.label, action: "ask", existing: sold, next,
          changes: [{ ...fieldChange("snapshot", "quantity", 0, row.quantity,
            incoming?.label || incoming?.kind, incomingState.date), requiresConfirm: true,
          soldConflict: true }],
          flags: ["sold-conflict"],
          reason: `the CAS records ${sold.disposed_quantity ?? 0} sold on ${soldDate}; `
            + `this report still shows ${row.quantity}`,
        });
        continue;
      }
      const maturity = bondMaturity(row).maturity;
      // A matured bond is history, not a live holding. An older CAS still brings
      // it across, so the final set does not depend on which file arrived first.
      if (!canAdd && (identityOnly || casQuantityTake) && maturity && maturity < now) {
        decisions.push({ isin: row.isin, label: row.label, action: "history", existing: null,
          next: { ...row, quantity: 0, valuePaise: 0, asOf: incomingState.date || "" },
          changes: [fieldChange("snapshot", "quantity", row.quantity, 0, "maturity", maturity)],
          flags: ["matured"], reason: `matured ${maturity}` });
        continue;
      }
      if (canAdd) {
        added += 1;
        const next = { ...row };
        if (!next.asOf) next.asOf = incomingState.date || "";
        if (incoming?.kind === "cas" && next.valuePaise !== null
          && !next.valueSource) next.valueSource = "CAS";
        decisions.push({ isin: row.isin, label: row.label, action: "add", existing: null,
          next, changes: [], flags: [], reason: "new holding" });
      } else {
        skipped += 1;
        decisions.push({ isin: row.isin, label: row.label, action: "skip", existing: null,
          next: null, changes: [], flags: ["older-snapshot"],
          reason: identityOnly ? "older CAS: identity only"
            : casQuantityTake ? "older CAS: no live row is added" : "older than the data on file" });
      }
      continue;
    }
    const next = { ...old };
    const changes = [];
    const rowFlags = [];
    const quantityDiffers = row.quantity !== null && moneyDifferent(old.quantity, row.quantity);
    const valueDiffers = row.valuePaise !== null && moneyDifferent(old.valuePaise, row.valuePaise);
    // A sale recorded from a CAS is a fact. A newer report that shows more units
    // than the sale left behind is a disagreement to surface, not a quantity to
    // take silently.
    const sold = row.isin ? soldByIsin.get(row.isin) : null;
    const soldConflict = !!sold && !!incomingState.date
      && incomingState.date >= String(sold.disposed_at || "").slice(0, 10)
      && row.quantity !== null && old.quantity !== null
      && Number(row.quantity) > Number(old.quantity) + 1e-9;
    const incomingName = incoming?.kind === "cas" ? "CAS" : (incoming?.label || incoming?.kind);
    // A broker report newer than the last CAS disagrees with the depository for
    // quantity or value. That is a question, not a silent overwrite. A cost-only
    // difference is still the broker's to take.
    const brokerAfterCas = incoming?.kind !== "cas" && hasExistingSnapshot
      && existingSource === "cas" && relation === "newer" && !unsafeDate;
    const quantityConflict = brokerAfterCas && quantityDiffers;
    const valueConflict = brokerAfterCas && valueDiffers;
    if (casQuantityTake) {
      if (quantityDiffers) {
        next.quantity = row.quantity;
        changes.push(fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incomingName, incomingState.date, {
            fromSource: existingSource || "broker",
            fromAsOf: existing.snapshot?.asOf || "",
          }));
      }
      if (valueDiffers) {
        next.valuePaise = row.valuePaise;
        next.valueSource = "CAS";
        changes.push(fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          "CAS", incomingState.date, {
            fromSource: existingSource || "broker",
            fromAsOf: existing.snapshot?.asOf || "",
          }));
      }
      if (quantityDiffers || valueDiffers) next.asOf = incomingState.date || old.asOf;
    } else if (quantityConflict || valueConflict) {
      const from = { fromSource: existingSource || "broker",
        fromAsOf: existing.snapshot?.asOf || "" };
      if (quantityConflict) {
        next.quantity = row.quantity;
        changes.push({ ...fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incomingName, incomingState.date, from), requiresConfirm: true });
      }
      if (valueConflict) {
        next.valuePaise = row.valuePaise;
        next.valueSource = incomingName;
        changes.push({ ...fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incomingName, incomingState.date, from), requiresConfirm: true });
      }
      if (quantityConflict || valueConflict) next.asOf = incomingState.date || old.asOf;
    } else if (snapshotChangeAllowed && !sameDate) {
      if (quantityDiffers) {
        next.quantity = row.quantity;
        changes.push(fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incomingName, incomingState.date));
      }
      if (valueDiffers) {
        next.valuePaise = row.valuePaise;
        next.valueSource = incomingName;
        changes.push(fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incomingName, incomingState.date));
      }
      if (quantityDiffers || valueDiffers) next.asOf = incomingState.date || old.asOf;
    } else if (sameDate) {
      if (quantityDiffers) {
        next.quantity = row.quantity;
        changes.push({ ...fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incomingName, incomingState.date), requiresConfirm: true });
      }
      if (valueDiffers) {
        next.valuePaise = row.valuePaise;
        next.valueSource = incomingName;
        changes.push({ ...fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incomingName, incomingState.date), requiresConfirm: true });
      }
    } else if (olderWithData || undatedWithData) {
      if (old.quantity === null && row.quantity !== null) {
        next.quantity = row.quantity;
        changes.push(fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incomingName, incomingState.date));
      }
      // A value belongs to the quantity it was struck at. An older or undated
      // report cannot put its value on a different, newer quantity.
      const valueQuantityMatches = old.quantity === null || row.quantity === null
        || !moneyDifferent(old.quantity, row.quantity);
      if (old.valuePaise === null && row.valuePaise !== null && valueQuantityMatches) {
        next.valuePaise = row.valuePaise;
        next.valueSource = incomingName;
        changes.push(fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incomingName, incomingState.date));
      } else if (old.valuePaise === null && row.valuePaise !== null) {
        rowFlags.push("value-quantity-mismatch");
      }
    }
    if (identityOnly) {
      // The CAS still owns the account's identity; no holding field moves.
    }
    if (soldConflict) {
      rowFlags.push("sold-conflict");
      for (const change of changes) {
        if (change.group === "snapshot" && change.field === "quantity") {
          change.requiresConfirm = true;
          change.soldConflict = true;
        }
      }
    }

    if (costMode !== "keep") {
      const immutableManual = costMode === "fill-empty" && manualExisting && old.costPaise !== null;
      const fill = (field, oldValue, newValue) => {
        if (newValue === null || newValue === undefined || newValue === "") return;
        if (costMode === "ask") {
          if (moneyDifferent(oldValue, newValue) || (typeof oldValue === "string" && oldValue !== newValue)) {
            changes.push({ ...fieldChange("cost", field, oldValue, newValue,
              incoming?.label || incoming?.kind, incomingState.date), requiresConfirm: true });
          }
          return;
        }
        if (costMode === "fill-empty") {
          if (oldValue !== null && oldValue !== undefined && oldValue !== "") return;
        }
        if (immutableManual && field === "cost") return;
        if (moneyDifferent(oldValue, newValue) || (typeof oldValue === "string" && oldValue !== newValue)) {
          next[field === "cost" ? "costPaise" : field === "purchase" ? "purchaseDate" : field] = newValue;
          changes.push(fieldChange("cost", field, oldValue, newValue,
            incoming?.label || incoming?.kind, incomingState.date));
        }
      };
      fill("cost", old.costPaise, row.costPaise);
      fill("purchase", old.purchaseDate, row.purchaseDate || "");
      fill("couponPct", old.couponPct, row.couponPct);
      fill("frequency", old.frequency, row.frequency);
      fill("facePaise", old.facePaise, row.facePaise);
      fill("maturity", old.maturity, row.maturity);
      fill("yieldPct", old.yieldPct, row.yieldPct);
      fill("interestDate", old.interestDate, row.interestDate);
      fill("payoutPaise", old.payoutPaise, row.payoutPaise);
      fill("futureInterestPaise", old.futureInterestPaise, row.futureInterestPaise);
      fill("futurePrincipalPaise", old.futurePrincipalPaise, row.futurePrincipalPaise);
    }

    // A CAS label carries the coupon and the maturity; a broker label can add
    // the part the statement leaves out. Quantity and value never come from the
    // label.
    let labelChanged = false;
    if (!unsafeDate && row.label && row.label !== old.label) {
      const oldHasTerms = /\d+(?:\.\d+)?%/.test(old.label || "");
      const newHasTerms = /\d+(?:\.\d+)?%/.test(row.label || "");
      const takeLabel = !old.label || (snapshotChangeAllowed && (!oldHasTerms || newHasTerms));
      if (takeLabel) {
        next.label = row.label;
        labelChanged = true;
      }
    }
    const changedFields = fieldsWouldChange(old, next,
      ["quantity", "valuePaise", "valueSource", "costPaise", "purchaseDate", "couponPct",
        "frequency", "facePaise", "maturity", "asOf", "label", "yieldPct", "interestDate",
        "payoutPaise", "futureInterestPaise", "futurePrincipalPaise"]);
    if (labelChanged) changes.push(fieldChange("label", "label", old.label, row.label,
      incoming?.label || incoming?.kind, incomingState.date));
    // A quantity that moves while the file carries no cost keeps the stored
    // cost. Mark the change so the preview says the units moved and the money
    // did not, instead of leaving the person to infer it from a blank field.
    if (changes.some((change) => change.group === "snapshot" && change.field === "quantity")
      && row.costPaise === null && old.costPaise !== null) {
      for (const change of changes) {
        if (change.group === "snapshot" && change.field === "quantity") change.costCarried = true;
      }
      costCarried += 1;
    }
    const needsConfirm = changes.some((change) => change.requiresConfirm);
    if (needsConfirm) {
      ask += 1;
      decisions.push({ isin: row.isin || old.isin, label: row.label || old.label, action: "ask",
        existing: old, next, changes, flags: rowFlags, reason: soldConflict
          ? "the report shows more units than a recorded sale left"
          : "same date or manual cost" });
    } else if (changedFields.length || changes.length) {
      updated += 1;
      decisions.push({ isin: row.isin || old.isin, label: row.label || old.label, action: "update",
        existing: old, next, changes, flags: rowFlags, reason: "newer snapshot or empty field" });
    } else {
      kept += 1;
      decisions.push({ isin: row.isin || old.isin, label: row.label || old.label, action: "keep",
        existing: old, next, changes: [], flags: rowFlags, reason: "already matches" });
    }
  }

  // A row missing from a newer report is not a deletion. It stays, flagged, and
  // a bond whose maturity has passed is history rather than a difference.
  const absent = [];
  for (const old of oldRows) {
    if (old.isin && incomingIsins.has(old.isin)) continue;
    if (old.disposed_at) continue;
    if (!old.isin) continue;
    if (categories.size && old.category && !categories.has(old.category)) continue;
    if (old.source === "manual") {
      manualOnly += 1;
      absent.push({ isin: old.isin, label: old.label, action: "manual",
        reason: "entered by hand, not in any file", next: old });
      continue;
    }
    const maturity = bondMaturity(old).maturity;
    if (maturity && maturity < now) {
      const next = { ...old, quantity: 0, valuePaise: 0 };
      decisions.push({ isin: old.isin, label: old.label, action: "history", existing: old, next,
        changes: [fieldChange("snapshot", "quantity", old.quantity, 0, "maturity", maturity)],
        flags: ["matured"], reason: `matured ${maturity}` });
      continue;
    }
    if (canTakeSnapshot && (relation === "newer" || relation === "same")) {
      flagged += 1;
      absent.push({ isin: old.isin, label: old.label, action: "flag",
        reason: "not in the newer report; kept", next: old });
    }
  }

  if (identityOnly) {
    warnings.push("No newer quantity, value, cost or date is overwritten. The identity attaches and only empty fields are filled from this older statement.");
  }
  if (manualOnly) {
    warnings.push(`${manualOnly} holding${manualOnly === 1 ? "" : "s"} entered by hand ${manualOnly === 1 ? "is" : "are"} not in this file and stay on the account.`);
  }
  if (costCarried) {
    warnings.push(`${costCarried} holding${costCarried === 1 ? "" : "s"} changed quantity without a cost in the file. The last known cost is kept.`);
  }
  if (flagged) warnings.push(`${flagged} holding${flagged === 1 ? "" : "s"} not in the newer report ${flagged === 1 ? "was" : "were"} kept and flagged.`);

  return {
    incomingAsOf: incomingState.date, incomingDateState: incomingState.state,
    relation, identityOnly, sameDate,
    identityChange: (() => {
      const identity = incoming?.identity;
      if (!identity?.value) return null;
      const current = existing.identity || {};
      const from = String(current.value || "");
      const to = String(identity.value || "");
      // The stored key is the evidence. An unchanged key is not an alias, even
      // when the family's spelling of it differs in case or spacing.
      const same = upper(from) === upper(to);
      if (!current.source) return { action: "attach", value: identity.value, kind: identity.kind };
      if (incoming.kind === "cas" && current.source !== "cas") {
        return { action: "replace", from, value: identity.value, kind: identity.kind };
      }
      if (incoming.kind === "cas" && current.source === "cas" && !same) {
        return { action: "replace", from, value: identity.value, kind: identity.kind };
      }
      if (current.source !== "cas" && incoming.kind !== "cas" && !same) {
        return { action: "alias", from, value: identity.value, kind: identity.kind };
      }
      return null;
    })(),
    decisions, absent,
    summary: { added, updated, kept, ask, flagged, skipped, manualOnly,
      history: decisions.filter((decision) => decision.action === "history").length },
    warnings, flags,
    blocking: incomingState.state === "invalid" || incomingState.state === "future" || ask > 0,
  };
}

// --- one account's files, in write order ------------------------------------

/** One holding row as it is stored, from one merge decision. */
function importHoldingRow(next, source = {}, manual) {
  const category = next.category || "bond";
  const cost = next.costPaise ?? (manual?.cost_paise ?? null);
  const purchase = next.purchaseDate || manual?.purchase_date || "";
  return {
    security_id: next.isin || next.security_id || "",
    label: next.label || "",
    issuer: next.issuer || "",
    category,
    rating: next.rating || "",
    frequency: next.frequency || "",
    yield_bps: next.yieldPct !== null && next.yieldPct !== undefined
      ? Math.round(Number(next.yieldPct) * 100) : (next.yield_bps ?? null),
    payout_paise: next.payoutPaise ?? next.payout_paise ?? null,
    quantity: next.quantity ?? null,
    cost_paise: cost,
    value_paise: next.valuePaise ?? next.value_paise ?? null,
    face_paise: next.facePaise ?? next.face_paise ?? null,
    purchase_date: purchase,
    interest_date: next.interestDate || next.interest_date || "",
    future_interest_paise: next.futureInterestPaise ?? next.future_interest_paise ?? null,
    future_principal_paise: next.futurePrincipalPaise ?? next.future_principal_paise ?? null,
    principal_dates: next.principal_dates || "",
    redemption_dates: next.redemption_dates || "",
    value_source: next.valueSource || next.value_source
      || (source.family === "cas" ? "CAS" : (source.label || source.family || "")),
    returned_paise: next.returned_paise ?? null,
    returned_at: next.returned_at || "",
    returned_record_date: next.returned_record_date || "",
    returned_source: next.returned_source || "",
    disposed_at: next.disposed_at || "",
    disposed_quantity: next.disposed_quantity ?? null,
    disposed_type: next.disposed_type || "",
    disposed_source: next.disposed_source || "",
    disposed_reason: next.disposed_reason || "",
    disposed_cost_paise: next.disposed_cost_paise ?? null,
    txn_key: next.txn_key || "",
    source_row: next.sourceRow || next.source_row || 0,
    as_of: next.asOf || source.asOf || "",
    rating_at_purchase: next.rating_at_purchase || "",
  };
}

/**
 * The rows a merge plan writes, without touching the store. This is the broker
 * writer's row builder and the preview's projection of it, so one function
 * answers both "what will the page show" and "what will it store".
 *
 * A row with no decision is kept. A disposal record is history and always
 * survives. An ask the person has not accepted keeps the row already on file.
 * @param {Array<object>} holdings
 * @param {object} plan a planMerge result
 * @param {{family?: string, label?: string, asOf?: string}} source
 * @param {boolean} acceptAsk
 * @returns {Array<object>}
 */
export function mergeRowsFromPlan(holdings, plan, source = {}, acceptAsk = false) {
  const decisions = new Map(((plan?.decisions) || []).map((decision) =>
    [String(decision.isin || "").toUpperCase(), decision]));
  const manual = new Map((holdings || []).filter((holding) => holding.source === "manual"
    && holding.security_id).map((holding) =>
    [String(holding.security_id).toUpperCase(), holding]));
  const out = [];
  const seen = new Set();
  const push = (row) => {
    const key = [row.security_id, row.label, row.quantity, row.purchase_date, row.as_of].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  for (const holding of holdings || []) {
    if (holding.source === "manual") continue;
    if (holding.disposed_at) { push(holding); continue; }
    const key = String(holding.security_id || "").toUpperCase();
    const decision = decisions.get(key);
    if (!decision || decision.action === "keep" || decision.action === "skip"
      || decision.action === "manual") {
      push(holding);
      continue;
    }
    if (decision.action === "ask" && !acceptAsk) { push(holding); continue; }
    push(importHoldingRow(decision.next, source, manual.get(key)));
  }
  for (const decision of plan?.decisions || []) {
    if (decision.action === "add"
      || (decision.action === "ask" && acceptAsk
        && (decision.flags || []).includes("sold-conflict"))) {
      push(importHoldingRow(decision.next, source,
        manual.get(String(decision.isin || "").toUpperCase())));
    }
    if (decision.action === "history" && !decision.existing) {
      push(importHoldingRow(decision.next, source,
        manual.get(String(decision.isin || "").toUpperCase())));
    }
  }
  return out;
}

/**
 * The field state one receipt leaves for the next file in the same plan. It is
 * the page's account metadata update, without the write: a CAS owns the snapshot
 * and the identity; a broker owns the snapshot only when it changed one, and the
 * cost only when it changed one. The next file's date and source rules read this,
 * so a broker older than the CAS that came first is not a same-date question.
 */
export function planStateAfter(state = {}, receipt = null, source = {}) {
  const family = String(source.family || "");
  const asOf = String(source.asOf || receipt?.incomingAsOf || "");
  const cas = family === "cas";
  const next = {
    identity: { ...(state.identity || {}) },
    snapshot: { ...(state.snapshot || {}) },
    cost: { ...(state.cost || {}) },
    manualAsOf: state.manualAsOf || "",
    holdings: state.holdings || [],
  };
  const changes = (receipt?.decisions || []).flatMap((decision) => decision.changes || []);
  const snapshotChanged = cas || !next.snapshot.asOf
    || (receipt?.summary?.added || 0) > 0
    || (receipt?.summary?.history || 0) > 0
    || changes.some((change) => change.group === "snapshot");
  // The CAS writer records the snapshot and the identity, never a cost source.
  // A maturity or coupon it fills is a field, not a claim on the broker's cost.
  const costChanged = !cas && changes.some((change) => change.group === "cost");
  if (snapshotChanged) next.snapshot = { source: cas ? "cas" : family, asOf };
  if (costChanged) next.cost = { ...next.cost, source: family, asOf };
  if (cas) {
    next.identity = { source: "cas", asOf: asOf || next.identity.asOf || "",
      value: source.accountKey || next.identity.value || "" };
  } else if (source.accountKey
    && (!next.identity.source || next.identity.source === family)) {
    next.identity = { source: family, asOf: asOf || next.identity.asOf || "",
      value: source.accountKey };
  }
  return next;
}

const EMPTY_FIELD_STATE = {
  identity: { source: "", asOf: "", value: "" },
  snapshot: { source: "", asOf: "" },
  cost: { source: "", asOf: "", manual: false },
  manualAsOf: "",
  holdings: [],
};

function aggregateReceipts(receipts) {
  const summary = { added: 0, updated: 0, kept: 0, ask: 0, flagged: 0,
    skipped: 0, manualOnly: 0, history: 0 };
  const warnings = [];
  let blocking = false;
  for (const receipt of receipts || []) {
    const plan = receipt?.plan || {};
    blocking = blocking || !!plan.blocking;
    for (const key of Object.keys(summary)) summary[key] += plan.summary?.[key] || 0;
    for (const warning of plan.warnings || []) {
      warnings.push(receipt.attributed ? `${receipt.label}: ${warning}` : warning);
    }
  }
  return { summary, warnings: [...new Set(warnings)], blocking };
}

const NET_FIELDS = ["label", "category", "quantity", "cost_paise", "value_paise",
  "face_paise", "purchase_date", "interest_date", "frequency", "yield_bps",
  "payout_paise", "future_interest_paise", "future_principal_paise", "value_source",
  "as_of", "disposed_at", "disposed_quantity", "disposed_type", "disposed_source",
  "disposed_reason", "disposed_cost_paise", "txn_key"];

const holdingKey = (row) => String(row?.security_id || row?.isin || "").toUpperCase()
  || `label:${norm(row?.label || "")}`;

/**
 * What one plan changes in one account, read from the rows before and after.
 * The receipts say what each file did, and a row that one file adds and another
 * fills cost on is one added holding, not an add plus an update. A matured row
 * moved to zero is history, not an update.
 */
function netChange(before = [], after = []) {
  const old = new Map((before || []).map((row) => [holdingKey(row), row]));
  const seen = new Set();
  const net = { added: 0, updated: 0, kept: 0, history: 0, removed: 0 };
  for (const row of after || []) {
    const key = holdingKey(row);
    seen.add(key);
    const prior = old.get(key);
    const matured = Number(row.quantity) === 0 && !row.disposed_at
      && (!prior || Number(prior.quantity) > 0);
    if (!prior) {
      if (matured) net.history += 1;
      else net.added += 1;
      continue;
    }
    if (matured) {
      net.history += 1;
      continue;
    }
    if (fieldsWouldChange(prior, row, NET_FIELDS).length) net.updated += 1;
    else net.kept += 1;
  }
  for (const key of old.keys()) if (!seen.has(key)) net.removed += 1;
  return net;
}

/**
 * One account's files, planned in the order they will be written. Each receipt
 * is planned against the state the previous receipt leaves, so a broker that
 * follows a CAS sees the CAS rows and fills their cost instead of adding them a
 * second time. A CAS target arrives with its receipt already built by the
 * resolver; the chain only projects its rows forward.
 *
 * @param {{chains?: Array<{accountId?: string, account?: object|null,
 *   holdings?: Array<object>, contributions?: Array<object>}>,
 *   today?: string, acceptAsk?: boolean}} input
 * @returns {{chains: Array<object>, net: object, summary: object,
 *   warnings: Array<string>, blocking: boolean}}
 */
export function planImportChains({ chains = [], today = isoToday(), acceptAsk = false } = {}) {
  const out = (chains || []).map((chain) => {
    let state = chain.account
      ? { ...accountFieldState(chain.account, chain.holdings || []),
          holdings: chain.holdings || [] }
      : { ...EMPTY_FIELD_STATE, identity: { ...EMPTY_FIELD_STATE.identity },
          snapshot: { ...EMPTY_FIELD_STATE.snapshot }, cost: { ...EMPTY_FIELD_STATE.cost } };
    const receipts = [];
    for (const contribution of chain.contributions || []) {
      const plan = contribution.plan || planMerge({
        incoming: {
          kind: contribution.family || "",
          label: contribution.label || "",
          asOf: contribution.asOf || "",
          identity: contribution.identity || null,
          categories: [...new Set((contribution.rows || [])
            .map((row) => row.category).filter(Boolean))],
          rows: contribution.rows || [],
        },
        existing: state,
        today,
      });
      const rows = mergeRowsFromPlan(state.holdings || [], plan, contribution, acceptAsk);
      receipts.push({ ...contribution, plan, rows });
      state = planStateAfter({ ...state, holdings: rows }, plan, contribution);
    }
    return { accountId: chain.accountId || "", account: chain.account || null,
      receipts, rows: state.holdings || [], net: netChange(chain.holdings || [], state.holdings || []),
      ...aggregateReceipts(receipts) };
  });
  const net = out.reduce((total, chain) => {
    for (const key of Object.keys(total)) total[key] += chain.net[key] || 0;
    return total;
  }, { added: 0, updated: 0, kept: 0, history: 0, removed: 0 });
  return { chains: out, net,
    ...aggregateReceipts(out.flatMap((chain) => chain.receipts)) };
}
