// The import inbox, as pure functions. A file is detected by its contents, its
// holdings rows are compared with what the ledger already holds, and every
// decision names the field group and the date it came from. Nothing is written
// here: the page owns the preview, the confirmation and the database.

import { boId } from "./bo-id.js";
import { accountFolios, isFolioAccount, normalizeFolio } from "./folio.js";
import { categoryOf, isDepositoryAccount, isImportAccount } from "./assets.js";
import { parseCsv } from "./digifinn.js";
import { parseDate, parseNumber, parseMoney } from "./holding-import.js";
import { bondInputsMissing, bondMaturity, isDisposed, termSourceRank } from "./bonds.js";

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

// A Kite holdings sheet is identified by its header, not by where the header
// sits. The summary block above it can be any length, and the Combined sheet
// shifts every column by one, so only the two required names matter.
function matrixLooksLikeHoldings(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  for (const row of rows) {
    const cells = (row || []).map(norm);
    if (cells.includes("isin") && cells.includes("quantity available")) return true;
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
    // A spreadsheet hands the Price column in as a number of rupees. asMoney
    // reads numbers as paise because stored rows already are; a tradebook cell
    // is not stored, so it is converted here or the same CSV and XLSX would
    // disagree about the trade.
    const rawPrice = row[cols.price];
    const pricePaise = typeof rawPrice === "number"
      ? Math.round(rawPrice * 100) : asMoney(rawPrice);
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

const fileExtension = (name) => {
  const match = String(name || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toUpperCase() : "";
};

/**
 * The trade rows an optional report carries. A parsed tradebook has them under
 * `parsed.rows`; callers that hand the parsed result in directly use `trades`.
 * A holdings report answers with its holdings, so its kind is checked too.
 */
function tradebookRows(file) {
  if (!/tradebook/i.test(String(file?.kind || ""))) return "";
  const rows = Array.isArray(file?.trades) && file.trades.length
    ? file.trades : (Array.isArray(file?.rows) ? file.rows : []);
  if (!rows.length) return "";
  return rows.map((row) => [upper(row?.symbol || ""), upper(row?.isin || ""),
    String(row?.date || ""), norm(row?.type || ""), String(row?.quantity ?? ""),
    String(row?.pricePaise ?? "")].join("|")).sort().join("\n");
}

function duplicateKey(file) {
  if (baseKind(file?.kind)) return "";
  const rows = tradebookRows(file);
  if (!rows) return "";
  return [file.kind, upper(file.accountKey || ""), upper(file.accountKind || ""),
    String(file.asOf || ""), rows].join("\n");
}

/** The one line a file that arrived in two formats carries instead of its name. */
export function duplicateFileLabel(file) {
  const formats = [...new Set((file?.formats || []).filter(Boolean))];
  if (formats.length > 1) return `${formats.join(" and ")} of the same tradebook`;
  const format = formats[0] || "file";
  const count = Math.max((file?.duplicates || []).length + 1, 2);
  return `${count} ${format} copies of the same tradebook`;
}

/**
 * Collapse the same optional report supplied twice, in two formats. The parsed
 * trade rows decide, never the file name: a renamed copy is still one file, and
 * two tradebooks whose rows differ are two files and both stay. A holdings
 * snapshot is never folded into another, because two snapshots are two dates.
 */
export function dedupeImportFiles(files = []) {
  const out = [];
  const seen = new Map();
  for (const original of files || []) {
    const key = duplicateKey(original);
    if (!key) { out.push(original); continue; }
    if (!seen.has(key)) {
      const file = { ...original,
        formats: [...new Set([fileExtension(original.name)].filter(Boolean))] };
      seen.set(key, file);
      out.push(file);
      continue;
    }
    const kept = seen.get(key);
    kept.duplicates = [...(kept.duplicates || []), original];
    kept.formats = [...new Set([...(kept.formats || []),
      fileExtension(original.name)].filter(Boolean))];
  }
  return out;
}

/**
 * One bundle per account. The base holdings file decides the account; optional
 * reports ride along and only fill the facts they carry. Files are sorted by
 * kind before merging, so dropping the same set in another order gives the same
 * plan.
 */
export function groupBundles(files = []) {
  const list = dedupeImportFiles(files).filter((file) => IMPORT_KINDS[file?.kind]?.family
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
    const tradebooks = optionals.filter((file) => file.kind === "zerodha-tradebook");
    if (tradebooks.length > 1) {
      bundle.warnings.push(`${tradebooks.length} tradebooks are in this set and their rows differ. `
        + "All are used; the earliest purchase date wins.");
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

/**
 * The accounts a statement's targets will write: one per distinct resolved id,
 * plus one for each target that has no account yet. Two BO IDs that both
 * resolve to one legacy account are one account, not two.
 * @param {Array<{targetId?: string}>} targets
 * @returns {{resolved: Array<string>, unresolved: number, count: number}}
 */
export function statementAccounts(targets = []) {
  const resolved = [];
  let unresolved = 0;
  for (const target of targets || []) {
    const id = String(target?.targetId || "");
    if (!id) { unresolved += 1; continue; }
    if (!resolved.includes(id)) resolved.push(id);
  }
  return { resolved, unresolved, count: resolved.length + unresolved };
}

const shortBo = (bo) => `…${String(bo).slice(-4)}`;

const FUND_KIND = /^(mf|mutual\s*fund|fund)$/i;
const FUND_ISIN = /^INF[A-Z0-9]{9}$/;
const cleanIsin = (value) => String(value || "").toUpperCase().replace(/\s+/g, "");
const isFundRow = (row) => FUND_KIND.test(String(row?.kind || row?.category || "").trim());

/**
 * Whether every movement a depository statement records has an account that will
 * exist when the writer runs.
 *
 * The account a movement names is placed by, in order:
 *
 * - an account on file whose number is that BO ID;
 * - the statement's own target for that BO ID, when the import will create it
 *   from the rows the statement lists for it. The writer creates accounts before
 *   it writes events, so creating is enough;
 * - the statement's target when it attaches to an account that has no number
 *   yet, because the writer fills that number from the statement;
 * - the statement's target while the person still has to choose between two
 *   accounts. That is a choice, and the card already asks for it.
 *
 * A movement account with no holdings row in the statement has nothing to build
 * an account from, so it stays blocked. A movement that names no account is a
 * folio movement when it names a fund ISIN or its ISIN is a folio row in the
 * statement: the folio owns it, and the folio's own plan applies it. Any other
 * account-less movement cannot be routed to a new account at all and needs an
 * account on file; that is the old rule, kept whole.
 *
 * @param {{movements?: Array<object>, accounts?: Array<object>,
 *   targets?: Array<{boId?: string, targetId?: string, rows?: Array<object>,
 *   tie?: boolean, createChoice?: boolean, folio?: boolean}>}} input
 * @returns {{missing: Array<string>, pending: boolean, blocked: boolean,
 *   reason: string, folio: number}} `folio` counts the account-less movements
 *   that belong to a fund folio, so they are not a movement-account gap.
 */
export function movementAccountGap({ movements = [], accounts = [], targets = [] } = {}) {
  const onFile = new Map();
  for (const account of accounts || []) {
    const key = boId(account?.number || account?.bo_id || "").boId;
    if (key && !onFile.has(key)) onFile.set(key, account);
  }
  const fundRows = new Set();
  for (const target of targets || []) {
    for (const row of target?.rows || []) {
      const isin = cleanIsin(row?.isin || row?.security_id || "");
      if (isin && (row?.folio || (target?.folio && isFundRow(row)))) fundRows.add(isin);
    }
  }
  const named = new Set();
  let anonymous = 0;
  let folio = 0;
  for (const movement of movements || []) {
    const key = boId(movement?.account || "").boId;
    if (key) { named.add(key); continue; }
    const isin = cleanIsin(movement?.isin);
    if (movement?.folio || isFundRow(movement)
      || (isin && (FUND_ISIN.test(isin) || fundRows.has(isin)))) {
      folio += 1;
      continue;
    }
    anonymous += 1;
  }
  const byBo = new Map();
  for (const target of targets || []) {
    const key = boId(target?.boId || "").boId;
    if (key && !byBo.has(key)) byBo.set(key, target);
  }
  const missing = [];
  let pending = false;
  for (const bo of named) {
    if (onFile.has(bo)) continue;
    const target = byBo.get(bo);
    if (!target) { missing.push(bo); continue; }
    if (!target.targetId) {
      // A tie is answered on the card before Import is offered. Creating is the
      // default only when the statement's rows can build the account.
      if (target.tie && !target.createChoice) { pending = true; continue; }
      if (!(target.rows || []).length) missing.push(bo);
      continue;
    }
    const home = (accounts || []).find((account) => account?.id === target.targetId);
    const number = String(home?.number || home?.bo_id || "").trim();
    // A blank number is written from the statement. A different number is
    // another account, and this movement has nowhere to land.
    if (number && boId(number).boId !== bo) missing.push(bo);
  }
  // A movement that names no account is only found through an account on file.
  // Nothing this import creates can be chosen for it, so the old refusal stands.
  // A folio movement was removed from the count above: the folio is its home.
  const unowned = anonymous > 0 && !(accounts || []).length
    && !(targets || []).some((target) => target?.targetId);
  const reason = missing.length === 1
    ? `No demat on file for the movement account ${shortBo(missing[0])}. `
      + "Add that account, then import again."
    : missing.length > 1
      ? `No demat on file for the movement accounts ${missing.slice(0, -1)
        .map(shortBo).join(", ")} and ${shortBo(missing[missing.length - 1])}. `
        + "Add those accounts, then import again."
      : unowned
        ? "No account on file can take this statement's movements. Add the demat "
          + "account the statement names, then import again."
        : "";
  return { missing, pending, blocked: missing.length > 0 || unowned, reason, folio };
}

// The writer's sentence for a credit it refuses. It is built in cas-apply.js as
// `<ISIN>: <reason> (<printed wording>).` Every movement of this class is refused
// for that same reason, so the reason can be stated once above a list; the other
// warnings carry a balance, a lot or a count and keep their own line.
const CREDIT_NOT_ADDED = /^([A-Z0-9]{12}): a credit with no purchase or transfer-in wording is not added(?: \((.*)\))?\.$/;

/**
 * The card's warnings, with the one per-movement class folded into a count and
 * its detail folded into one line per security.
 *
 * A statement can print a credit for every payout it received. The writer
 * refuses each one for the same reason and names the ISIN and the printed
 * wording, so nineteen of them read as a wall that pushes the plan's summary off
 * the screen. The refusal is unchanged; it becomes one line with the detail
 * behind a disclosure, and that detail names each security once.
 *
 * @param {Array<string>} warnings
 * @returns {{lines: Array<string>, groups: Array<{key: string, count: number,
 *   summary: string, detail: Array<string>}>, count: number}}
 */
export function importWarningDigest(warnings = []) {
  const credit = [];
  const lines = [];
  for (const raw of warnings || []) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const refusal = CREDIT_NOT_ADDED.exec(text);
    if (refusal) credit.push({ isin: refusal[1], wording: refusal[2] || "" });
    else lines.push(text);
  }
  const groups = [];
  if (credit.length) {
    groups.push({
      key: "credit-not-added",
      count: credit.length,
      summary: `${credit.length} credit${credit.length === 1 ? " was" : "s were"} `
        + `not added because ${credit.length === 1 ? "it names" : "they name"} `
        + "no purchase or transfer-in.",
      detail: creditDetail(credit),
    });
  }
  return { lines, groups, count: credit.length };
}

/**
 * One line per security and printed wording, carrying the count when a security
 * repeats.
 *
 * The reason is the summary's to state, so a line carries only what tells two
 * refusals apart: the ISIN and the statement's own wording. Two movements of one
 * security printed differently stay apart, because a line must not stand for a
 * refusal it does not describe.
 *
 * @param {Array<{isin: string, wording: string}>} credit
 * @returns {Array<string>}
 */
function creditDetail(credit) {
  const seen = new Map();
  for (const { isin, wording } of credit) {
    const key = `${isin}\u0000${wording}`;
    const line = seen.get(key);
    if (line) line.count += 1;
    else seen.set(key, { isin, wording, count: 1 });
  }
  return [...seen.values()].map(({ isin, wording, count }) =>
    [isin, count > 1 ? `${count} credits` : "", wording].filter(Boolean).join(" · "));
}

/**
 * The broker-first gate for a statement that disposes a security. It returns the
 * staged broker plan that would put a cost on one of the disposed ISINs, or null
 * when no broker would change that cost.
 *
 * A disposal can name its account. A broker only funds a disposal on its own
 * account. A broker with nothing to write, another account, another ISIN, a
 * purchase or maturity change, or a date it cannot pass does not gate. The
 * narrow condition is what keeps the statement from being trapped behind a card
 * that cannot be applied; an ask is not a block, because the person can answer
 * it.
 *
 * @param {{accounts?: Array<string>, disposed?: Array<string|{isin?: string,
 *   accountId?: string}>, brokers?: Array<{key: string, label?: string,
 *   accountId?: string, blocked?: boolean, changes?: Array<{isin?: string,
 *   group?: string, field?: string}>}>}} input
 * @returns {{key: string, label: string}|null}
 */
export function movementGate({ accounts = [], disposed = [], brokers = [] } = {}) {
  const owned = new Set((accounts || []).map((id) => String(id || "")).filter(Boolean));
  const needs = (disposed || []).map((item) => (typeof item === "string"
    ? { isin: String(item || "").toUpperCase(), accountId: "" }
    : { isin: String(item?.isin || "").toUpperCase(),
        accountId: String(item?.accountId || "") }))
    .filter((item) => item.isin
      && (!owned.size || !item.accountId || owned.has(item.accountId)));
  if (!needs.length) return null;
  for (const broker of brokers || []) {
    if (!broker || broker.blocked) continue;
    const accountId = String(broker.accountId || "");
    const funds = needs.some((need) =>
      (need.accountId ? need.accountId === accountId : owned.has(accountId))
      && (broker.changes || []).some((change) =>
        String(change?.isin || "").toUpperCase() === need.isin
        && change?.group === "cost" && change?.field === "cost"));
    if (funds) return { key: broker.key, label: broker.label || "broker report" };
  }
  return null;
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
 * account, and must not receive a depository snapshot. The identity kind keeps
 * the two apart: a folio number reaches only a fund folio, and a BO ID, UCID or
 * client ID reaches only a custody account, never a fund folio.
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
        if (!isFolioAccount(raw)) continue;
        if (!account.folios.includes(normalizeFolio(identity.value))) continue;
        identityKind = "folio";
      } else {
        // A BO ID, UCID or client ID is a custody identity. A fund folio
        // answers to its folio number, never to one of these, so a depository
        // statement cannot land on a fund account by ISIN overlap either.
        if (isFolioAccount(raw)) continue;
        if ((identity.kind === "bo" || identity.kind === "demat")
          && account.boId && boId(identity.value).boId === account.boId) identityKind = "BO ID";
        else if (identity.kind === "ucid" && account.ucid === identity.value) identityKind = "UCID";
        else if (identity.kind === "client" && account.clientId === identity.value) identityKind = "client ID";
        else if (identity.kind === "client" && upper(account.number) === identity.value) identityKind = "client ID";
      }
    } else if (forCas && isFolioAccount(raw)) {
      // A statement with no readable account number cannot prove that a fund
      // account is its custodian. Only a folio identity may reach one.
      continue;
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

const BROKER_TOKEN = {
  zerodha: /zerodha/i,
  motilal: /motilal/i,
  digifinn: /digifinn/i,
};

/**
 * Every depository account already filed under a broker, whether or not the
 * report can prove it is the same one. A report with no identity match and no
 * ISIN overlap must attach to one of these instead of creating a second
 * account for the same broker.
 * @param {string} family broker family from IMPORT_KINDS
 * @param {Array<object>} accounts raw accounts from the store
 * @returns {Array<object>} the same shape normalizeAccount() returns
 */
export function brokerDematAccounts(family, accounts = []) {
  const token = BROKER_TOKEN[String(family || "")];
  if (!token) return [];
  return (accounts || []).filter((raw) => {
    if (!isDepositoryAccount(raw)) return false;
    const meta = safeMeta(raw);
    return token.test([raw.label, raw.bank, meta.dp, meta.broker_source]
      .filter(Boolean).join(" "));
  }).map((raw) => normalizeAccount(raw, raw?.holdings || []));
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

// What each row is to the account right now: a current position, a matured lot
// still owed, or sold history. One rule for the status line and the gap list, so
// a card cannot count a holding it calls missing.
function holdingPositions(rows, today) {
  return (rows || []).map((row) => {
    const quantity = asNumber(row?.quantity);
    const disposed = isDisposed(row);
    const maturity = holdingMaturity(row);
    const matured = !disposed && !!(maturity && maturity < today);
    return { row, matured, disposed,
      active: !disposed && !matured && quantity !== null && quantity > 0 };
  });
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
  // Broker-only means a stored file named the account, not that a row carries a
  // date: a row date alone falls back to "report", and an account typed by hand
  // must not inherit that name.
  const brokerOnly = meta.broker_only === "1" || meta.broker_only === true
    || (!state.identity.source && !!text(meta.holdings_source));
  const brokerAsOf = state.cost.asOf || String(meta.broker_as_of || "").slice(0, 10)
    || (state.identity.source && state.identity.source !== "cas" ? state.identity.asOf : "");
  const casAsOf = state.identity.source === "cas" ? state.identity.asOf : "";
  const positions = holdingPositions(rows, today);
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

/**
 * Which reports a person can fetch, when to fetch it and what it adds. Copy,
 * not state: the card renders it behind one closed disclosure so the guide is
 * on demand and never a paragraph above the accounts.
 */
export const IMPORT_REPORT_GUIDE = {
  sources: [
    { source: "CAS, CDSL or NSDL", when: "After month end",
      adds: "names every demat, the quantities in it and the account number" },
    { source: "Broker holdings report", when: "Whenever it arrives",
      adds: "fills cost, purchase dates and bond terms" },
    { source: "Transaction statement", when: "Only when a sale needs proving",
      adds: "gives the sale date and price, so the realised cost is right" },
  ],
  note: "Nothing updates on its own: month-end quantities, daily prices and terms "
    + "where a source exists, on your schedule.",
};

/**
 * What one account is missing, as plain sentences, from provenance already
 * stored. There is no score and no new field: a line appears only when the
 * ledger can name the absent or stale fact, and a line disappears as soon as a
 * file fills it. A typed account has no report to fetch, so its lines say what
 * could be added instead of reading like breakage.
 *
 * Two absences are deliberately not lines here. A month with no new statement
 * is not a gap: a long-held bond's quantities do not change, and the meta line
 * already dates the snapshot. A row whose `source` is empty is not a gap either,
 * because cas-apply writes every CAS row that way; the account-level
 * `holdings_source` is the same fact, and the status pill already says
 * "Broker-only" when no depository statement has named the account.
 */
export function importAccountGaps(account, holdings = [],
  formatDate = (value) => String(value || ""),
  today = new Date().toISOString().slice(0, 10)) {
  const rows = holdings || [];
  const meta = safeMeta(account);
  const state = accountFieldState(account, rows);
  // Nothing on this account names a file, so a file is not what it is missing.
  // Read the stored meta, not the derived state: a row date alone falls back to
  // "report", and a typed account must not inherit that name. A row can carry
  // the source too: cas-apply leaves the row's own `source` empty and stamps
  // `value_source` instead, which is still a statement naming the account.
  // Manual and BSE are values, not files: a hand-entered or fetched price does
  // not turn a typed account into one a broker report can fill.
  const filed = rows.some((row) => {
    const valueSource = text(row?.valueSource ?? row?.value_source).toLowerCase();
    if (valueSource && valueSource !== "manual" && valueSource !== "bse") return true;
    const source = text(row?.source).toLowerCase();
    return !!source && source !== "manual" && source !== "bse";
  });
  const manual = !filed && !text(meta.holdings_source) && !text(meta.identity_source)
    && !text(meta.cost_source || meta.broker_source);
  const live = holdingPositions(rows, today)
    .filter((position) => position.active).map((position) => position.row);
  if (!live.length) return { manual, gaps: [] };
  const gaps = [];
  const missing = live.map((row) => bondInputsMissing(row));
  const uncosted = missing.filter((input) => input.noCost).length;
  const plural = (count) => (count === 1 ? "" : "s");
  if (uncosted) {
    gaps.push({ kind: "cost", text: manual
      ? `Could add cost for ${uncosted} holding${plural(uncosted)}`
      : `No cost on ${uncosted} holding${plural(uncosted)}` });
  }
  if (!manual && state.cost.asOf && state.snapshot.asOf
    && state.cost.asOf < state.snapshot.asOf) {
    gaps.push({ kind: "cost-older", text: `Cost from ${formatDate(state.cost.asOf)}, `
      + `older than the ${formatDate(state.snapshot.asOf)} holdings` });
  }
  const termless = missing.filter((input) => input.noTerms).length;
  if (termless) {
    gaps.push({ kind: "terms", text: manual
      ? `Could add the missing coupon or maturity for ${termless} bond${plural(termless)}`
      : `A coupon or maturity is missing on ${termless} bond${plural(termless)}` });
  }
  return { manual, gaps };
}

/**
 * The page-level sentence above a bond book: how many live bond lots a broker
 * holdings report can fill, and with which fields. Lots, not gaps: one lot
 * missing both is one bond, not two. Only an import account gets a banner; a
 * typed demat still is one, a cost-only record is not. Returns null when no
 * live bond lot has a fillable gap.
 *
 * @param {object} account
 * @param {Array<object>} holdings
 * @param {string} [today]
 * @returns {{count: number, needs: string, text: string}|null}
 */
export function bondGapBanner(account, holdings = [],
  today = new Date().toISOString().slice(0, 10)) {
  if (!isImportAccount(account)) return null;
  const liveBonds = holdingPositions(holdings || [], today)
    .filter((position) => position.active
      && String(position.row?.category || "").trim().toLowerCase() === "bond")
    .map((position) => position.row);
  const missing = liveBonds.map((row) => bondInputsMissing(row))
    .filter((input) => input.noCost || input.noTerms);
  if (!missing.length) return null;
  const both = missing.filter((input) => input.noCost && input.noTerms).length;
  const cost = missing.filter((input) => input.noCost).length;
  const terms = missing.filter((input) => input.noTerms).length;
  const needs = both === missing.length ? "cost and terms"
    : cost && terms ? "cost or terms" : cost ? "cost" : "terms";
  const count = missing.length;
  return {
    count, needs,
    text: `${count} bond${count === 1 ? "" : "s"} ${count === 1 ? "needs" : "need"} `
      + `${needs} — import a broker report`,
  };
}

/**
 * Where a bond book's Import action may lead. A demat uses the broker section
 * of Import; a bond portfolio uses the generic Import page. A cost-only record
 * receives no target at all, so its banner and card carry no dead link. The
 * gate is the same isImportAccount() the import page uses.
 *
 * @param {object} account
 * @param {string} [assetId]
 * @returns {{importable: boolean, importTarget: string, importVia: "broker"|"page"}}
 */
export function bondImportOf(account, assetId = "") {
  const importable = isImportAccount(account);
  return {
    importable,
    importTarget: importable ? String(assetId || "") : "",
    importVia: categoryOf(account) === "demat" ? "broker" : "page",
  };
}

/**
 * The primary action's label for one plan card. A plan that changes one holding
 * is the common case for a single bond account, so a count of one never prints
 * as "1 holdings". A plan whose only change is a cost basis on a recorded
 * disposal says that, instead of counting a holding it does not hold.
 * Pure, so the copy is testable without a DOM.
 */
export function importPlanPrimary({ family = "", identityOnly = false, planned = 0,
  sales = 0, create = false, soldCost = 0, attachIdentity = false,
  categories = [] } = {}) {
  if (family === "cas") {
    if (identityOnly) return "Attach identity and fill empty values";
    if (planned) return `Import ${planned} ${planned === 1 ? "holding" : "holdings"}`;
    if (sales) return `Record ${sales} sale${sales === 1 ? "" : "s"}`;
    return "Attach identity";
  }
  const kinds = new Set((categories || []).map((value) => String(value || "").toLowerCase())
    .filter(Boolean));
  const hasFunds = kinds.has("mf");
  const mixed = hasFunds && kinds.size > 1;
  const noun = family === "zerodha"
    ? (mixed ? (planned === 1 ? "holding" : "holdings")
      : hasFunds ? (planned === 1 ? "fund" : "funds")
        : (planned === 1 ? "equity" : "equities"))
    : (planned === 1 ? "holding" : "holdings");
  if (!planned && soldCost) {
    return soldCost === 1 ? "Record the sold cost basis"
      : `Record the sold cost basis on ${soldCost} disposals`;
  }
  if (!planned && attachIdentity && !create) return "Attach the account identity";
  if (!planned && !create) return "Nothing to change";
  return `${create ? "Create account and import " : "Import "}${planned} ${noun}`;
}

/**
 * What a card says when its plan would write nothing. A tradebook alone is the
 * common case: it can only fill a purchase date on a holding another file
 * names, so the next step is that file, never an account to create.
 * @param {{hasBase?: boolean, tradebook?: boolean}} input
 * @returns {{reason: string, next: string}}
 */
export function importNoWorkCopy({ hasBase = true, tradebook = false } = {}) {
  if (hasBase) {
    return {
      reason: "Nothing to import yet — every fact in this file is already on file.",
      next: "",
    };
  }
  if (tradebook) {
    return {
      reason: "Nothing to import yet — this tradebook only fills dates on holdings that are not on file.",
      next: "Import the holdings report first.",
    };
  }
  return {
    reason: "Nothing to import yet — this report only adds detail to a holdings report that is not on file.",
    next: "Import the holdings report first.",
  };
}

// --- the merge plan ---------------------------------------------------------

function normalizeHolding(row) {
  const explicitMaturity = parseDate(row.maturity || row.maturity_date || "");
  const terms = bondMaturity(row);
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
    couponPct: asNumber(row.couponPct || row.coupon_pct),
    couponSource: text(row.couponSource || row.coupon_source),
    couponAsOf: parseDate(row.couponAsOf || row.coupon_as_of || ""),
    frequency: text(row.frequency),
    // The stored maturity is a fact; the label is a fallback. Keep which one
    // this row used, so a report's term is not mistaken for a name guess.
    maturity: explicitMaturity || terms.maturity,
    maturitySource: text(row.maturitySource || row.maturity_source)
      || (explicitMaturity ? "" : (terms.maturity ? "label" : "")),
    maturityAsOf: parseDate(row.maturityAsOf || row.maturity_as_of || ""),
    faceSource: text(row.faceSource || row.face_source),
    faceAsOf: parseDate(row.faceAsOf || row.face_as_of || ""),
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
 * Whether a report that names a security with a recorded disposal describes the
 * units the sale accounts for, or units acquired after it.
 *
 * The quantity alone cannot answer this: a full sale of ten units and a
 * re-purchase of ten units look identical. The report's own acquisition date
 * can, so a purchase dated after the sale is a new holding. With no such date,
 * the sale is the only evidence the app has, and a report that names exactly
 * the units on file is read as the position that was sold: a report must not
 * resurrect a holding it never dates. A quantity the sale does not account for
 * stays a question and is never absorbed into the disposal.
 * @param {{quantity?: number|null, purchaseDate?: string, disposed?: object,
 *   live?: number}} input
 * @returns {{kind: "recovery"|"new-position"|"unexplained", reason: string,
 *   reported: number|null, soldOn: string, acquiredOn: string}}
 */
export function soldReportVerdict({ quantity = null, purchaseDate = "",
  disposed = null, live = 0 } = {}) {
  const reported = asNumber(quantity);
  const sold = asNumber(disposed?.disposed_quantity) ?? 0;
  const held = asNumber(live) ?? 0;
  const soldOn = String(disposed?.disposed_at || "").slice(0, 10);
  const acquiredOn = parseDate(purchaseDate) || "";
  const out = { reported, soldOn, acquiredOn };
  if (acquiredOn && soldOn && acquiredOn > soldOn) {
    return { ...out, kind: "new-position",
      reason: `the report dates the purchase on ${acquiredOn}, after the sale on ${soldOn}` };
  }
  if (reported === null) {
    return { ...out, kind: "unexplained", reason: "the report names no quantity" };
  }
  if (Math.abs(reported - (sold + held)) <= 1e-9) {
    return { ...out, kind: "recovery",
      reason: `the report names the ${reported} units the sale on ${soldOn} accounts for` };
  }
  return { ...out, kind: "unexplained",
    reason: `the report shows ${reported} units; the sale and the live row `
      + `account for ${sold + held}` };
}

/**
 * What part of a report's total cost belongs to the units a disposal accounts
 * for. The report's cost covers exactly the units it names, so its own unit
 * price is applied to the sold units; nothing is averaged and nothing is
 * extrapolated past the units the report names. When the report names every
 * unit on file, the rest is the live rows' share; otherwise the live share is
 * not invented and stays null. Returns null when the report cannot price the
 * sale at all.
 * @param {{totalPaise?: number|null, reported?: number|null,
 *   disposed?: number, live?: number}} input
 * @returns {{disposedPaise: number, livePaise: number|null, totalPaise: number,
 *   units: number, sold: number, clean: boolean}|null}
 */
export function soldCostAttribution({ totalPaise = null, reported = null,
  disposed = 0, live = 0 } = {}) {
  const total = asMoney(totalPaise);
  const units = asNumber(reported);
  const sold = asNumber(disposed);
  const held = asNumber(live) ?? 0;
  if (total === null || total <= 0) return null;
  if (units === null || units <= 0) return null;
  if (sold === null || sold <= 0) return null;
  if (sold > units + 1e-9) return null;
  const disposedPaise = sold >= units - 1e-9 ? total : Math.round(total * sold / units);
  const clean = Math.abs(held + sold - units) <= 1e-9;
  return { disposedPaise, livePaise: clean ? total - disposedPaise : null,
    totalPaise: total, units, sold, clean };
}

/**
 * Whether a plan will write anything. A pending ask counts: accepting it is the
 * decision that releases its field change, and an unaccepted ask blocks the
 * plan before any writer runs. Reading the receipt's plan, not the receipt's
 * plan's plan, is the whole point of this function.
 * @param {object} plan a planMerge result or a receipt carrying one
 * @returns {boolean}
 */
export function planHasWork(plan) {
  const summary = (plan?.plan || plan)?.summary || {};
  return (summary.added || 0) + (summary.updated || 0) + (summary.history || 0)
    + (summary.ask || 0) > 0;
}

// Money in a warning is a number a person compares with another number, so it
// carries the grouping the rest of the app uses and never raw paise.
const moneyText = (paise) => (Number(paise) / 100)
  .toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What one report's cost does to one recorded disposal. An empty basis is
 * filled from the report's own unit price; a recorded basis is never rewritten
 * by a report that disagrees with it, and the difference is named. When the
 * report cannot price the units the sale accounts for, nothing is guessed: the
 * basis stays unknown and the card says so.
 * @param {{sold: object, row: object, live?: number, source?: string}} input
 * @returns {{attribution: object|null, stored: number|null,
 *   disposalPaise: number|null, livePaise: number|null, differs: boolean,
 *   flags: Array<string>, warnings: Array<string>, reason: string}}
 */
function soldCostFor({ sold, row, live = 0, source = "" } = {}) {
  const label = source || "the report";
  const disposed = asNumber(sold?.disposed_quantity) ?? 0;
  const soldOn = String(sold?.disposed_at || "").slice(0, 10);
  const attribution = soldCostAttribution({ totalPaise: row.costPaise,
    reported: row.quantity, disposed, live });
  const stored = asMoney(sold?.disposed_cost_paise);
  const out = { attribution: null, stored, disposalPaise: null, livePaise: null,
    differs: false, flags: [], warnings: [], reason: "" };
  if (attribution === null) {
    out.flags.push("sold-cost-unknown");
    out.warnings.push(asMoney(row.costPaise) === null
      ? `${row.isin}: ${label} carries no cost for the ${disposed} units the sale `
        + "accounts for; the cost basis is still unknown."
      : `${row.isin}: ${label} shows ${row.quantity} units, but the sale accounts for `
        + `${disposed}; the report cannot price them. The cost basis is still unknown.`);
    return out;
  }
  out.attribution = attribution;
  out.differs = stored !== null && Math.abs(stored - attribution.disposedPaise) > 1;
  if (out.differs) {
    out.flags.push("sold-cost-differs");
    out.warnings.push(`${row.isin}: the recorded sale already carries `
      + `${moneyText(stored)}; ${label} prices the same units at `
      + `${moneyText(attribution.disposedPaise)}. The recorded cost is kept.`);
  }
  out.disposalPaise = stored === null ? attribution.disposedPaise : null;
  out.livePaise = attribution.livePaise;
  out.reason = `the CAS records ${disposed} units sold on ${soldOn}; the sale stays and `
    + "this report fills its cost basis";
  return out;
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
        // The report names units after a recorded sale. It is either the
        // position the sale already accounts for (a stale pre-sale view, which
        // is what a wrong import order leaves behind) or units acquired after
        // it. Only the second is a live row; the first is a cost basis the
        // disposal is missing, and writing it as a row would hold the bond and
        // sell it at the same time.
        //
        // A depository statement is the custody record, not an enrichment. One
        // that still names a sold bond contradicts the sale, so it stays the
        // person's question and never becomes a cost on the disposal.
        const depository = incoming?.kind === "cas";
        const verdict = depository
          ? { kind: "unexplained", reason: "the statement still names it" }
          : soldReportVerdict({ quantity: row.quantity,
            purchaseDate: row.purchaseDate, disposed: sold });
        if (verdict.kind === "new-position") {
          added += 1;
          const next = { ...row };
          if (!next.asOf) next.asOf = incomingState.date || "";
          decisions.push({ isin: row.isin, label: row.label, action: "add", existing: null,
            next, changes: [], flags: ["sold-rebuy"], reason: "new holding" });
          continue;
        }
        if (verdict.kind === "unexplained") {
          ask += 1;
          const next = { ...row };
          if (!next.asOf) next.asOf = incomingState.date || "";
          decisions.push({
            isin: row.isin, label: row.label, action: "ask", existing: sold, next,
            changes: [{ ...fieldChange("snapshot", "quantity", 0, row.quantity,
              incoming?.label || incoming?.kind, incomingState.date), requiresConfirm: true,
            soldConflict: true }],
            flags: ["sold-conflict", "sold-live-row"],
            reason: `the CAS records ${sold.disposed_quantity ?? 0} sold on ${soldDate}; `
              + (depository ? "the statement still names it and shows "
                + `${row.quantity} units` : verdict.reason),
          });
          continue;
        }
        const cost = soldCostFor({ sold, row, live: 0,
          source: incoming?.label || incoming?.kind });
        warnings.push(...cost.warnings);
        if (cost.attribution === null) {
          skipped += 1;
          decisions.push({ isin: row.isin, label: row.label, action: "skip",
            existing: sold, next: null, changes: [], flags: ["sold-conflict", ...cost.flags],
            reason: "the report cannot price the units the sale accounts for" });
          continue;
        }
        if (cost.disposalPaise === null) {
          kept += 1;
          decisions.push({ isin: row.isin, label: row.label, action: "keep",
            existing: sold, next: sold, changes: [], flags: ["sold-conflict", ...cost.flags],
            reason: "the recorded sale keeps the cost basis it has" });
          continue;
        }
        ask += 1;
        decisions.push({
          isin: row.isin, label: row.label, action: "ask", existing: sold, next: null,
          changes: [{ group: "disposal", field: "soldCost", from: cost.stored,
            to: cost.disposalPaise, source: incoming?.label || incoming?.kind,
            asOf: incomingState.date, requiresConfirm: true }],
          flags: ["sold-conflict", "sold-recovery"],
          recovery: { txnKey: String(sold.txn_key || ""),
            disposedAt: soldDate, costPaise: cost.disposalPaise },
          reason: cost.reason,
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
    // The units a report shows beyond the live row are the units the sale took,
    // unless the report dates its purchase after the sale. Taking that quantity
    // would hold the sold units twice; reading a dated acquisition as a
    // recovery would hide a real holding. The verdict decides, and only a
    // recovery is read for a cost. A depository statement is never a recovery:
    // its snapshot is the custody record, so it stays a question.
    const liveLots = oldRows.filter((item) => !item.disposed_at && item.isin
      && item.isin === row.isin);
    // One report prices one position. Across several lots of the same bond the
    // remainder belongs to no single row, and this writer decides per ISIN, so
    // nothing is written rather than a lot being priced twice or collapsed.
    if (soldConflict && liveLots.length > 1) {
      warnings.push(`${row.isin}: the account holds this bond in ${liveLots.length} lots, `
        + "so a report cannot price the sale across them. Nothing is changed.");
      kept += 1;
      decisions.push({ isin: row.isin || old.isin, label: row.label || old.label,
        action: "keep", existing: old, next: old, changes: [],
        flags: ["sold-conflict", "sold-multi-lot"],
        reason: "the account holds this bond in more than one lot" });
      continue;
    }
    const liveUnits = liveLots.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const soldVerdict = soldConflict && incoming?.kind !== "cas"
      ? soldReportVerdict({ quantity: row.quantity, purchaseDate: row.purchaseDate,
        disposed: sold, live: liveUnits })
      : null;
    const recovery = soldVerdict?.kind === "recovery"
      ? soldCostFor({ sold, row, live: asNumber(old.quantity) ?? 0, source: incomingName })
      : null;
    if (recovery) warnings.push(...recovery.warnings);
    // A broker report newer than the last CAS disagrees with the depository for
    // quantity or value. That is a question, not a silent overwrite. A cost-only
    // difference is still the broker's to take.
    const brokerAfterCas = incoming?.kind !== "cas" && hasExistingSnapshot
      && existingSource === "cas" && relation === "newer" && !unsafeDate;
    const quantityConflict = brokerAfterCas && quantityDiffers;
    const valueConflict = brokerAfterCas && valueDiffers;
    if (recovery) {
      // The report describes the position before the sale, so its quantity and
      // value are not this account's. Only its cost is used, below, and only
      // for the units it names.
    } else if (casQuantityTake) {
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
    if (recovery) {
      rowFlags.push(...recovery.flags);
      if (recovery.disposalPaise !== null) rowFlags.push("sold-recovery");
    }

    if (costMode !== "keep") {
      const immutableManual = costMode === "fill-empty" && manualExisting && old.costPaise !== null;
      const incomingTermSource = incoming?.kind === "cas" ? "CAS"
        : (incoming?.label || incoming?.kind || "");
      // Terms rank by source: a report or a person beats a lookup, and both
      // beat the name. A stored term with no provenance is treated as a
      // statement and is never replaced silently.
      const fillTerm = (field, sourceField, asOfField, oldValue, newValue,
        oldSource, newSource, equal) => {
        if (newValue === null || newValue === undefined || newValue === "") return;
        const same = equal ? equal(oldValue, newValue) : oldValue === newValue;
        const hasOld = oldValue !== null && oldValue !== undefined && oldValue !== "";
        const oldRank = hasOld ? (termSourceRank(oldSource) || 3) : 0;
        const newRank = termSourceRank(newSource);
        if (same) {
          if (hasOld && newRank > oldRank) {
            next[sourceField] = newSource;
            next[asOfField] = incomingState.date || "";
          }
          return;
        }
        if (costMode === "ask") {
          changes.push({ ...fieldChange("cost", field, oldValue, newValue, newSource,
            incomingState.date), requiresConfirm: true });
          return;
        }
        if (!hasOld || newRank > oldRank) {
          next[field] = newValue;
          next[sourceField] = newSource;
          next[asOfField] = incomingState.date || "";
          changes.push(fieldChange("cost", field, oldValue, newValue, newSource,
            incomingState.date));
        }
      };
      const fill = (field, oldValue, newValue) => {
        // A recovery splits the report's cost by unit below. Taking the total
        // here would put the sold units' cost on the live row as well.
        if (recovery && field === "cost") return;
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
      fillTerm("couponPct", "couponSource", "couponAsOf",
        old.couponPct, row.couponPct, old.couponSource,
        row.couponSource === "label" ? "label" : incomingTermSource,
        (a, b) => {
          if (a === null || a === undefined || a === "") return b === null || b === undefined;
          if (b === null || b === undefined || b === "") return false;
          return Math.abs(Number(a) - Number(b)) < 1e-9;
        });
      fill("frequency", old.frequency, row.frequency);
      fillTerm("facePaise", "faceSource", "faceAsOf",
        old.facePaise, row.facePaise, old.faceSource, incomingTermSource,
        (a, b) => !moneyDifferent(a, b));
      fillTerm("maturity", "maturitySource", "maturityAsOf",
        old.maturity, row.maturity, old.maturitySource,
        row.maturitySource === "label" ? "label" : incomingTermSource,
        (a, b) => String(a || "").slice(0, 10) === String(b || "").slice(0, 10));
      fill("yieldPct", old.yieldPct, row.yieldPct);
      fill("interestDate", old.interestDate, row.interestDate);
      fill("payoutPaise", old.payoutPaise, row.payoutPaise);
      fill("futureInterestPaise", old.futureInterestPaise, row.futureInterestPaise);
      fill("futurePrincipalPaise", old.futurePrincipalPaise, row.futurePrincipalPaise);
    }

    // A recovery prices the sold units, and the live units too when the report
    // names exactly the position on file. One report carries one cost: the same
    // money never lands on both rows.
    let recoveryPatch = null;
    if (recovery) {
      if (recovery.disposalPaise !== null) {
        recoveryPatch = { txnKey: String(sold.txn_key || ""),
          disposedAt: String(sold.disposed_at || "").slice(0, 10),
          costPaise: recovery.disposalPaise };
        changes.push({ group: "disposal", field: "soldCost", from: recovery.stored,
          to: recovery.disposalPaise, source: incomingName, asOf: incomingState.date,
          requiresConfirm: true });
      }
      if (recovery.livePaise !== null && recovery.livePaise > 0 && old.costPaise === null) {
        next.costPaise = recovery.livePaise;
        changes.push(fieldChange("cost", "cost", old.costPaise, recovery.livePaise,
          incomingName, incomingState.date));
      }
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
        existing: old, next, changes, flags: rowFlags,
        ...(recoveryPatch ? { recovery: recoveryPatch } : {}),
        reason: recovery ? recovery.reason : soldConflict
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
  const reportSource = source.family === "cas" ? "CAS" : (source.label || source.family || "");
  const reportAsOf = source.asOf || "";
  const termSource = (value, stored) => stored || (value !== null
    && value !== undefined && value !== "" ? reportSource : "");
  const termAsOf = (value, stored) => stored || (value !== null
    && value !== undefined && value !== "" ? reportAsOf : "");
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
    coupon_pct: next.couponPct ?? next.coupon_pct ?? null,
    coupon_source: termSource(next.couponPct ?? next.coupon_pct, next.couponSource),
    coupon_as_of: termAsOf(next.couponPct ?? next.coupon_pct, next.couponAsOf),
    maturity: next.maturity || "",
    maturity_source: termSource(next.maturity, next.maturitySource),
    maturity_as_of: termAsOf(next.maturity, next.maturityAsOf),
    face_source: termSource(next.facePaise ?? next.face_paise, next.faceSource),
    face_as_of: termAsOf(next.facePaise ?? next.face_paise, next.faceAsOf),
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
 * survives; an accepted recovery fills its cost basis instead of adding the
 * report's row beside it, because the sale is the fact and the report is the
 * stale view. An ask the person has not accepted keeps the row already on file.
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
  // An accepted recovery names the disposal it prices: the latest sale for that
  // ISIN, matched by its transaction key, or by its date on a legacy row.
  const recoveryOf = (holding) => {
    if (!acceptAsk) return null;
    const decision = decisions.get(String(holding.security_id || "").toUpperCase());
    if (decision?.action !== "ask" || !decision.recovery) return null;
    const marker = decision.recovery;
    const key = String(holding.txn_key || "");
    if (marker.txnKey && key) return key === marker.txnKey ? marker : null;
    return String(holding.disposed_at || "").slice(0, 10) === marker.disposedAt
      ? marker : null;
  };
  for (const holding of holdings || []) {
    if (holding.source === "manual") continue;
    if (holding.disposed_at) {
      const recovery = recoveryOf(holding);
      push(recovery ? { ...holding, disposed_cost_paise: recovery.costPaise } : holding);
      continue;
    }
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
    // A quantity the sale does not explain is an accepted live row. A recovery
    // is a cost basis on the disposal, and an unaccepted ask writes nothing.
    if (decision.action === "add"
      || (decision.action === "ask" && acceptAsk
        && (decision.flags || []).includes("sold-live-row"))) {
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
  "coupon_pct", "coupon_source", "coupon_as_of", "maturity", "maturity_source",
  "maturity_as_of", "face_source", "face_as_of",
  "as_of", "disposed_at", "disposed_quantity", "disposed_type", "disposed_source",
  "disposed_reason", "disposed_cost_paise", "txn_key"];

// Two rows for one security are two rows: a disposal is history and a live lot
// is not, so they must not collapse into one key in a before/after count.
const holdingKey = (row) => `${String(row?.security_id || row?.isin || "").toUpperCase()
  || `label:${norm(row?.label || "")}`}|${row?.disposed_at
  ? `sold:${row.txn_key || String(row.disposed_at).slice(0, 10)}` : "live"}`;

/**
 * What one plan changes in one account, read from the rows before and after.
 * The receipts say what each file did, and a row that one file adds and another
 * fills cost on is one added holding, not an add plus an update. A matured row
 * moved to zero is history, not an update. A cost a report puts on a recorded
 * disposal is a sold cost basis, not a live holding.
 * @param {Array<object>} before
 * @param {Array<object>} after
 * @returns {{added: number, updated: number, kept: number, history: number,
 *   removed: number, soldCost: number}}
 */
export function planNetChange(before = [], after = []) {
  const old = new Map((before || []).map((row) => [holdingKey(row), row]));
  const seen = new Set();
  const net = { added: 0, updated: 0, kept: 0, history: 0, removed: 0, soldCost: 0 };
  for (const row of after || []) {
    const key = holdingKey(row);
    seen.add(key);
    const prior = old.get(key);
    if (row.disposed_at) {
      if (prior && fieldsWouldChange(prior, row, NET_FIELDS).length) net.soldCost += 1;
      else net.kept += 1;
      continue;
    }
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
      receipts, rows: state.holdings || [], net: planNetChange(chain.holdings || [], state.holdings || []),
      ...aggregateReceipts(receipts) };
  });
  const net = out.reduce((total, chain) => {
    for (const key of Object.keys(total)) total[key] += chain.net[key] || 0;
    return total;
  }, { added: 0, updated: 0, kept: 0, history: 0, removed: 0, soldCost: 0 });
  return { chains: out, net,
    ...aggregateReceipts(out.flatMap((chain) => chain.receipts)) };
}
