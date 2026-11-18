// Shape-based privacy rules shared by the tree check, the history check and
// the local no-data gate. The patterns catch identifiers by their form, not by
// a value list, so the check also works in CI where web/private/ does not
// exist. Synthetic fixture values live in privacy-allowlist.json.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 16 * 1024 * 1024;

export const ALLOWLIST_PATH = fileURLToPath(
  new URL("./privacy-allowlist.json", import.meta.url));

export const ALLOW = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));

const ALLOW_PATTERNS = (ALLOW.patterns || []).map((pattern) => new RegExp(pattern));

// Higher-priority patterns come first. A 10-digit mobile is also a 10-digit
// number, and a 12-digit Aadhaar is also a 12-digit account; the first match
// wins so the report names the more specific shape.
export const PATTERNS = [
  { kind: "PAN", regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { kind: "IFSC", regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { kind: "FD deposit number", regex: /\b\d{6,}DP\d+\b/g },
  { kind: "email address", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?![:\/])/g },
  { kind: "phone number", regex: /(?<!\d)(?:\+?91[ -]?)?[6-9]\d{9}(?!\d)/g },
  { kind: "toll-free phone number", regex: /(?<!\d)1800[ -]?\d{3}[ -]?\d{4}(?!\d)/g },
  { kind: "Aadhaar-shaped number", regex: /(?<!\d)[2-9]\d{3}(?:[ -]?\d{4}){2}(?!\d)/g },
  { kind: "account/demat-shaped number", regex: /(?<![\dA-Za-z])[0-9]{10,16}(?![\dA-Za-z])/g },
];

const SKIP_PREFIXES = [
  "web/vendor/",
  "assets/",
  "web/logos/",
  "web/broker-logos/",
];

const SKIP_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".tif", ".tiff", ".zip", ".gz", ".tgz", ".7z", ".rar", ".bpk",
  ".db", ".db-wal", ".db-shm", ".sqlite", ".wasm", ".jar", ".class",
  ".so", ".dylib", ".dll", ".exe", ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".mov", ".webm", ".wav",
]);

const WORKBOOK = /\.(?:xlsx|xlsm|xls)$/i;

let xlsx = null;
function loadXlsx() {
  if (!xlsx) {
    const require = createRequire(import.meta.url);
    xlsx = require("../web/vendor/xlsx.full.min.js");
  }
  return xlsx;
}

/** The comparable forms of a value: raw, upper-case and alphanumeric. */
function forms(value) {
  const raw = String(value ?? "").trim();
  return [
    raw,
    raw.toUpperCase(),
    raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase(),
  ].filter(Boolean);
}

const ALLOW_FORMS = new Set((ALLOW.values || []).flatMap(forms));
const ALLOW_PATHS = new Set(ALLOW.paths || []);

/** True when a whole fixture file is a reviewed synthetic exception. */
export function isPathAllowed(path) {
  return ALLOW_PATHS.has(String(path).replace(/\\/g, "/"));
}

function allowForms(allow) {
  if (allow === ALLOW) return ALLOW_FORMS;
  return new Set((allow.values || []).flatMap(forms));
}

function allowPatterns(allow) {
  if (allow === ALLOW) return ALLOW_PATTERNS;
  return (allow.patterns || []).map((pattern) => new RegExp(pattern));
}

/** True when a value is a committed synthetic fixture or placeholder. */
export function isAllowed(value, allow = ALLOW) {
  const candidates = forms(value);
  const values = allowForms(allow);
  const patterns = allowPatterns(allow);
  for (const candidate of candidates) {
    if (values.has(candidate)) return true;
    for (const pattern of patterns) {
      if (pattern.test(candidate)) return true;
    }
  }
  return false;
}

/** Why a path is not scanned, or null when it can be scanned. */
export function skipPath(path) {
  const normal = String(path).replace(/\\/g, "/");
  const lower = normal.toLowerCase();
  if (SKIP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "vendored";
  if (SKIP_EXTENSIONS.has(extname(lower))) return "binary";
  return null;
}

/** Findings for one line, with overlapping lower-priority shapes removed. */
export function scanLine(line, allow = ALLOW) {
  const found = [];
  for (const { kind, regex } of PATTERNS) {
    for (const match of line.matchAll(regex)) {
      const value = match[0];
      if (isAllowed(value, allow)) continue;
      const start = match.index;
      const end = start + value.length;
      if (found.some((item) => start < item.end && end > item.start)) continue;
      found.push({ kind, value, start, end });
    }
  }
  return found.map(({ kind, value, start, end }) => ({ kind, value, start, end }));
}

/** Findings for a text block, with 1-based line numbers. */
export function scanText(text, allow = ALLOW) {
  const findings = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    for (const hit of scanLine(line, allow)) {
      findings.push({ line: index + 1, kind: hit.kind, value: hit.value });
    }
  });
  return findings;
}

function scanWorkbook(buffer, path, allow) {
  let workbook;
  try {
    const XLSX = loadXlsx();
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    if ((ALLOW.unreadableWorkbooks || []).includes(path)) {
      return { findings: [], skipped: "unreadable-allowlisted" };
    }
    return {
      findings: [{ line: 0, kind: "unreadable workbook (not verified)", value: "" }],
      skipped: "unreadable",
    };
  }
  const findings = [];
  for (const name of workbook.SheetNames) {
    for (const hit of scanLine(name, allow)) {
      findings.push({ line: `${name} (sheet name)`, kind: hit.kind, value: hit.value });
    }
    const sheet = workbook.Sheets[name];
    for (const address of Object.keys(sheet)) {
      if (address[0] === "!") continue;
      const cell = sheet[address];
      if (!cell || typeof cell.v !== "string") continue;
      for (const hit of scanLine(cell.v, allow)) {
        findings.push({ line: `${name}!${address}`, kind: hit.kind, value: hit.value });
      }
    }
  }
  return { findings, skipped: null };
}

/** Scan one file's bytes. Workbooks are read as cells, not as compressed XML. */
export function scanBuffer(buffer, path, allow = ALLOW) {
  const skipped = skipPath(path);
  if (skipped) return { findings: [], skipped };
  if (isPathAllowed(path)) return { findings: [], skipped: "allowlisted fixture" };
  if (buffer.length > MAX_BYTES) {
    return {
      findings: [{ line: 0, kind: "large blob (not verified)", value: "" }],
      skipped: "large",
    };
  }
  if (WORKBOOK.test(path)) return scanWorkbook(buffer, path, allow);
  if (buffer.includes(0)) return { findings: [], skipped: "binary" };
  return { findings: scanText(buffer.toString("utf8"), allow), skipped: null };
}
