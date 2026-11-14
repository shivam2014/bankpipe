#!/usr/bin/env node
// Builds the local privacy denylist from real statements. The output stays in
// web/private/ and is gitignored. This tool never prints a value.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCashflowReport, parseInvestmentReport, parsePayoutReport,
  parsePortfolioReport, parseTransactionReport } from "../digifinn-reports.js";
import { parseTradebook, parseTradebookMatrix } from "../import-flow.js";
import { parseStatement, rowsFromCsv, scanPreamble } from "../parse.js";
import { parseZerodhaHoldingsSheets } from "../zerodha.js";

const require = createRequire(import.meta.url);
const XLSX = require("../vendor/xlsx.full.min.js");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUT = resolve(HERE, "../private/import-denylist.txt");
const SEED = resolve(HERE, "../private/import-denylist.seed");
const MAX_FILE = 20 * 1024 * 1024;
const values = new Map();

const norm = (value) => String(value ?? "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();
const clean = (value) => String(value ?? "").trim()
  .replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
const PLACEHOLDER = /^(?:na|n\/a|none|null|name|holder|account|demat|client|folio|isin|pan|phone|email|address|india|bank|limited|private|mutual|fund)$/i;
const NAME_STOP = new Set(["PRIVATE", "LIMITED", "FINANCIAL", "SERVICES", "BANK",
  "INDIA", "MUTUAL", "FUND", "COMPANY", "TRUST", "INSURANCE", "CAPITAL",
  "SECURITIES", "HOLDER", "ACCOUNT", "NOMINEE", "ASSET", "ASSETS", "INVESTMENT",
  "INVESTMENTS", "MANAGEMENT", "ADVISORS", "ADVISORY", "HOLDINGS", "GROWTH",
  "EQUITY", "DEBT", "CREDIT", "LOAN", "LOANS", "HOUSING", "POWER", "ENERGY",
  "INFRA", "INFRASTRUCTURE", "INDUSTRIES", "INDUSTRY", "ENTERPRISES", "TRADING",
  "CONSTRUCTION", "DEVELOPERS", "PROPERTIES", "REALTY", "TEXTILES", "PHARMA",
  "LABORATORIES", "TECHNOLOGIES", "SOLUTIONS", "SYSTEMS", "VENTURES", "PARTNERS",
  "ASSOCIATES", "GROUP", "GLOBAL", "NATIONAL", "INTERNATIONAL", "GENERAL"]);

function add(value, category) {
  const text = clean(value);
  if (text.length < 4 || text.length > 120 || PLACEHOLDER.test(text)) return;
  if (/^\[.*\]$/.test(text) || /^9999/.test(text)) return;
  if (!values.has(text)) values.set(text, category);
  if (/[A-Za-z]/.test(text)) {
    const upper = text.toUpperCase();
    if (!values.has(upper)) values.set(upper, category);
  }
}

function addName(value) {
  const name = clean(value).replace(/[^A-Za-z .'-]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 4 || name.split(" ").length < 2) return;
  add(name, "name");
  for (const token of name.split(" ")) {
    if (token.length >= 4 && !NAME_STOP.has(token.toUpperCase())) add(token, "name");
  }
}

function addIsin(value) {
  const isin = clean(value).toUpperCase();
  if (/^IN[EF][A-Z0-9]{9}$/.test(isin)) add(isin, "isin");
}

function addAccount(value) {
  const raw = clean(value);
  const packed = raw.replace(/\s+/g, "");
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 9 && digits.length <= 18) add(digits, "account");
  if (/^IN\d{14}$/i.test(packed)) add(packed.toUpperCase(), "bo");
  if (raw !== packed && raw.length >= 8 && raw.length <= 24) add(raw, "account");
}

function addFolio(value) {
  const folio = clean(value);
  if (/^[0-9/]{4,20}$/.test(folio)) add(folio, "folio");
}

function scanText(text) {
  for (const match of text.matchAll(/\bIN[EF][A-Z0-9]{9}\b/g)) addIsin(match[0]);
  for (const match of text.matchAll(/\bIN\d{14}\b/g)) addAccount(match[0]);
  const patterns = [
    [/(?:CLIENT\s+UCID|UCID\s+NO\.?)\s*[:.]?\s*([A-Z0-9]{4,})/gi, "ucid"],
    [/\bClient\s+ID\s*[:.]?\s*([A-Z0-9]{4,})/gi, "client"],
    [/\bDemat\s+Account\s*(?:No\.?)?\s*[:.]?\s*([A-Z0-9]{6,})/gi, "demat"],
    [/\bBO\s*ID\s*[:.]?\s*([A-Z0-9]{6,})/gi, "bo"],
    [/\bDP\s*ID\s*[:.]?\s*([A-Z0-9]{6,})/gi, "dp"],
    [/\bFolio\s*(?:No\.?)?\s*[:.]?\s*([0-9A-Z/]{4,})/gi, "folio"],
    [/\b(?:Account|A\/C)\s*(?:No\.?|Number)?\s*[:.]?\s*([0-9]{6,})/gi, "account"],
    [/\b(?:Phone|Mobile)\s*(?:No\.?)?\s*[:.]?\s*([0-9]{10})\b/gi, "phone"],
    [/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, "pan"],
    [/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, "email"],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      if (kind === "folio") addFolio(value);
      else if (kind === "account") addAccount(value);
      else if (/\d/.test(value)) add(value, kind);
    }
  }
  for (const match of text.matchAll(
    /(?<!AMC )(?<!DP )(?<!Bank )(?<!Branch )(?<!Scheme )(?<!Nominee )\bName\s*[:]\s*([A-Za-z][A-Za-z .'-]{3,})/gi)) {
    addName(match[1]);
  }
}

const LABELS = new Map([
  ["name", "name"], ["holder", "name"], ["client id", "client"],
  ["demat account no", "demat"], ["demat account", "demat"],
  ["bo id", "bo"], ["dp id", "dp"], ["ucid", "ucid"],
  ["client ucid", "ucid"], ["folio", "folio"], ["folio no", "folio"],
  ["account no", "account"], ["account number", "account"],
]);

function scanMatrix(sheet) {
  for (const row of sheet) {
    scanText(row.map((cell) => String(cell ?? "")).join(","));
    for (let c = 0; c < row.length; c++) {
      const kind = LABELS.get(norm(row[c]));
      if (!kind) continue;
      for (let k = c + 1; k < row.length; k++) {
        const value = clean(row[k]);
        if (!value) continue;
        if (kind === "name") addName(value);
        else if (kind === "folio") addFolio(value);
        else if (kind === "account") addAccount(value);
        else if (/\d/.test(value)) add(value, kind);
        break;
      }
    }
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "." || name === "..") continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function parseCsvFile(text) {
  const portfolio = parsePortfolioReport(text);
  if (portfolio) {
    addName(portfolio.identity?.name);
    add(portfolio.identity?.pan, "pan");
    add(portfolio.identity?.phone, "phone");
    add(portfolio.identity?.email, "email");
    addAccount(portfolio.demat);
    for (const row of portfolio.rows) addIsin(row.isin);
  }
  for (const report of [parseInvestmentReport(text), parseTransactionReport(text)]) {
    for (const row of report?.rows || []) addIsin(row.isin);
  }
  for (const report of [parsePayoutReport(text), parseCashflowReport(text)]) {
    for (const group of report?.groups || []) addIsin(group.isin);
  }
  const tradebook = parseTradebook(text);
  for (const row of tradebook.rows) addIsin(row.isin);
  const rows = rowsFromCsv(text);
  const parsed = parseStatement(rows);
  if (!parsed.error) {
    const preamble = scanPreamble(rows, parsed.header ? parsed.header - 1 : 0);
    for (const number of preamble.numbers.filter((value) => value.length >= 10)) {
      addAccount(number);
    }
    addAccount(preamble.accountNumber);
  }
}

function parseWorkbook(path) {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  const sheets = wb.SheetNames.map((name) => XLSX.utils.sheet_to_json(
    wb.Sheets[name], { header: 1, raw: false, defval: "" }));
  for (const sheet of sheets) {
    scanMatrix(sheet);
    const holdings = parseZerodhaHoldingsSheets([sheet]);
    if (!holdings.error) {
      add(holdings.clientId, "client");
      for (const row of holdings.rows) addIsin(row.isin);
    }
    const tradebook = parseTradebookMatrix(sheet);
    for (const row of tradebook.rows) addIsin(row.isin);
  }
}

function pdfText(path, state) {
  try {
    return execFileSync("pdftotext", ["-q", path, "-"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT" && !state.warned) {
      console.warn("pdftotext not found; skipping PDFs");
      state.warned = true;
    }
    return "";
  }
}

function guardOutput() {
  try {
    execFileSync("git", ["-C", ROOT, "check-ignore", "-q",
      "web/private/import-denylist.txt"], { stdio: "ignore" });
  } catch {
    console.error("refusing to write: web/private/import-denylist.txt is not gitignored");
    process.exit(1);
  }
  let tracked = false;
  try {
    execFileSync("git", ["-C", ROOT, "ls-files", "--error-unmatch",
      "web/private/import-denylist.txt"], { stdio: "ignore" });
    tracked = true;
  } catch {}
  if (tracked) {
    console.error("refusing to write: web/private/import-denylist.txt is tracked");
    process.exit(1);
  }
}

function main() {
  const dir = process.env.BANKPIPE_PRIVATE_IMPORT_DIR;
  if (!dir) {
    console.error("set BANKPIPE_PRIVATE_IMPORT_DIR to the directory of real statements");
    process.exit(1);
  }
  const realRoot = resolve(dir);
  if (!existsSync(realRoot) || !statSync(realRoot).isDirectory()) {
    console.error("BANKPIPE_PRIVATE_IMPORT_DIR is not a directory");
    process.exit(1);
  }
  if (realRoot === ROOT || realRoot.startsWith(ROOT + sep)) {
    console.error("BANKPIPE_PRIVATE_IMPORT_DIR must be outside the repository");
    process.exit(1);
  }

  const files = walk(realRoot).filter((path) => {
    if (!/\.(csv|txt|xlsx|xls|xlsm|pdf)$/i.test(path)) return false;
    try { return statSync(path).size <= MAX_FILE; } catch { return false; }
  });
  if (!files.length) {
    console.error("no supported statements found");
    process.exit(1);
  }

  const pdfState = { warned: false };
  for (const path of files) {
    const ext = extname(path).toLowerCase();
    try {
      if (ext === ".csv" || ext === ".txt") parseCsvFile(readFileSync(path, "utf8"));
      else if (ext === ".pdf") scanText(pdfText(path, pdfState));
      else parseWorkbook(path);
    } catch {
      console.warn(`skipped one unreadable ${ext.slice(1)} file`);
    }
  }

  if (existsSync(SEED)) {
    for (const line of readFileSync(SEED, "utf8").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      add(value, "seed");
      addName(value);
    }
  } else {
    console.warn("no local seed at web/private/import-denylist.seed");
  }

  if (!values.size) {
    console.error("no values extracted; nothing written");
    process.exit(1);
  }

  guardOutput();
  mkdirSync(dirname(OUT), { recursive: true });
  const sorted = [...values.keys()].sort((a, b) => a.localeCompare(b));
  const body = [
    "# Generated by web/tools/privacy-denylist.mjs. Do not commit.",
    "# One value per line. Keep this file in web/private/.",
    ...sorted,
    "",
  ].join("\n");
  writeFileSync(OUT, body);

  const counts = {};
  for (const category of values.values()) counts[category] = (counts[category] || 0) + 1;
  console.log(`wrote ${sorted.length} values to web/private/import-denylist.txt`);
  console.log(Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(" "));
}

main();
