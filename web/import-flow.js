// The import inbox, as pure functions. A file is detected by its contents, its
// holdings rows are compared with what the ledger already holds, and every
// decision names the field group and the date it came from. Nothing is written
// here: the page owns the preview, the confirmation and the database.

import { boId } from "./bo-id.js";
import { parseCsv } from "./digifinn.js";
import { parseDate, parseNumber, parseMoney } from "./holding-import.js";
import { parseBondLabel } from "./bonds.js";

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
    bundle.ready = !!(base && rows.length);
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
    brokerOnly: meta.broker_only === "1" || meta.broker_only === true,
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
 */
export function accountMatches(file, accounts = []) {
  const identity = identityFor(file);
  const wanted = [...new Set((file?.rows || []).map(rowIsin).filter(Boolean))];
  const wantedSet = new Set(wanted);
  const matches = [];
  for (const raw of accounts) {
    const account = normalizeAccount(raw, raw?.holdings || []);
    if (account.category && account.category !== "demat") continue;
    let identityKind = "";
    if (identity) {
      if ((identity.kind === "bo" || identity.kind === "demat")
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
      hits, of: wanted.length, isins: account.isins, brokerOnly: account.brokerOnly,
      boId: account.boId, clientId: account.clientId, ucid: account.ucid,
      account,
    });
  }
  matches.sort((a, b) => Number(b.identity) - Number(a.identity)
    || b.hits - a.hits || a.label.localeCompare(b.label));
  const tie = matches.length > 1 && !matches[0].identity && !matches[1].identity
    && matches[0].hits === matches[1].hits;
  return {
    matches, total: wanted.length, tie,
    bestId: !tie && matches.length ? matches[0].id : "",
    identityId: matches.length && matches[0].identity ? matches[0].id : "",
  };
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
    identity: { source: identitySource, asOf: identityAsOf },
    snapshot: { source: snapshotSource, asOf: snapshotAsOf },
    cost: {
      source: meta.cost_source || meta.broker_source || "",
      asOf: parseDate(meta.cost_as_of || ""),
      manual: meta.cost_manual === "1" || meta.cost_manual === true,
    },
    manualAsOf: parseDate(meta.manual_as_of || ""),
  };
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
    maturity: parseDate(row.maturity ?? ""),
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
  out.maturity = out.maturity || parseBondLabel(out.label)?.maturity || "";
  return out;
}

function moneyDifferent(a, b) {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(Number(a) - Number(b)) > 1;
}

function fieldChange(group, field, from, to, source, asOf) {
  return { group, field, from, to, source, asOf, requiresConfirm: false };
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
  for (const row of oldRows) {
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
  const identityOnly = incoming?.kind === "cas" && hasExistingSnapshot
    && existingSource !== "cas" && oldRows.length > 0 && relation === "older";
  const olderWithData = hasExistingSnapshot && relation === "older" && oldRows.length > 0;
  const undatedWithData = hasExistingSnapshot && relation === "undated" && oldRows.length > 0;
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
  if (identityOnly) {
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
  for (const row of inRows) {
    const old = oldByIsin.get(row.isin) || (!row.isin ? oldByLabel.get(norm(row.label)) : null);
    if (!old) {
      const maturity = row.maturity || parseBondLabel(row.label)?.maturity || "";
      // A matured bond is history, not a live holding. An older CAS still brings
      // it across, so the final set does not depend on which file arrived first.
      if (!canAdd && identityOnly && maturity && maturity < now) {
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
        decisions.push({ isin: row.isin, label: row.label, action: "add", existing: null,
          next, changes: [], flags: [], reason: "new holding" });
      } else {
        skipped += 1;
        decisions.push({ isin: row.isin, label: row.label, action: "skip", existing: null,
          next: null, changes: [], flags: ["older-snapshot"],
          reason: identityOnly ? "older CAS: identity only" : "older than the data on file" });
      }
      continue;
    }
    const next = { ...old };
    const changes = [];
    const rowFlags = [];
    const quantityDiffers = row.quantity !== null && moneyDifferent(old.quantity, row.quantity);
    const valueDiffers = row.valuePaise !== null && moneyDifferent(old.valuePaise, row.valuePaise);
    if (snapshotChangeAllowed && !sameDate) {
      if (quantityDiffers) {
        next.quantity = row.quantity;
        changes.push(fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incoming?.label || incoming?.kind, incomingState.date));
      }
      if (valueDiffers) {
        next.valuePaise = row.valuePaise;
        next.valueSource = incoming?.kind === "cas" ? "CAS" : (incoming?.label || incoming?.kind);
        changes.push(fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incoming?.kind === "cas" ? "CAS" : (incoming?.label || incoming?.kind), incomingState.date));
      }
      if (quantityDiffers || valueDiffers) next.asOf = incomingState.date || old.asOf;
    } else if (sameDate) {
      if (quantityDiffers) {
        next.quantity = row.quantity;
        changes.push({ ...fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incoming?.label || incoming?.kind, incomingState.date), requiresConfirm: true });
      }
      if (valueDiffers) {
        next.valuePaise = row.valuePaise;
        changes.push({ ...fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incoming?.kind === "cas" ? "CAS" : (incoming?.label || incoming?.kind),
          incomingState.date), requiresConfirm: true });
      }
    } else if (olderWithData || undatedWithData) {
      if (old.quantity === null && row.quantity !== null) {
        next.quantity = row.quantity;
        changes.push(fieldChange("snapshot", "quantity", old.quantity, row.quantity,
          incoming?.label || incoming?.kind, incomingState.date));
      }
      if (old.valuePaise === null && row.valuePaise !== null) {
        next.valuePaise = row.valuePaise;
        changes.push(fieldChange("snapshot", "value", old.valuePaise, row.valuePaise,
          incoming?.kind === "cas" ? "CAS" : (incoming?.label || incoming?.kind), incomingState.date));
      }
    }
    if (identityOnly) {
      // The CAS still owns the account's identity; no holding field moves.
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
    const needsConfirm = changes.some((change) => change.requiresConfirm);
    if (needsConfirm) {
      ask += 1;
      decisions.push({ isin: row.isin || old.isin, label: row.label || old.label, action: "ask",
        existing: old, next, changes, flags: rowFlags, reason: "same date or manual cost" });
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
    if (!old.isin) continue;
    if (categories.size && old.category && !categories.has(old.category)) continue;
    if (old.source === "manual") {
      manualOnly += 1;
      absent.push({ isin: old.isin, label: old.label, action: "manual",
        reason: "entered by hand, not in any file", next: old });
      continue;
    }
    const maturity = old.maturity || parseBondLabel(old.label)?.maturity || "";
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
  if (flagged) warnings.push(`${flagged} holding${flagged === 1 ? "" : "s"} not in the newer report ${flagged === 1 ? "was" : "were"} kept and flagged.`);

  return {
    incomingAsOf: incomingState.date, incomingDateState: incomingState.state,
    relation, identityOnly, sameDate,
    identityChange: (() => {
      const identity = incoming?.identity;
      if (!identity?.value) return null;
      const current = existing.identity || {};
      if (!current.source) return { action: "attach", value: identity.value, kind: identity.kind };
      if (incoming.kind === "cas" && current.source !== "cas") {
        return { action: "replace", value: identity.value, kind: identity.kind };
      }
      if (incoming.kind === "cas" && current.source === "cas"
        && String(current.value || "") !== String(identity.value)) {
        return { action: "replace", value: identity.value, kind: identity.kind };
      }
      if (current.source !== "cas" && incoming.kind !== "cas"
        && String(current.value || "") !== String(identity.value)) {
        return { action: "alias", value: identity.value, kind: identity.kind };
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
