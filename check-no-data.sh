#!/bin/bash
# Gate before sharing or reading the codebase: no data files may live here.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

found=$(find . -type f \( -name '*.db' -o -name '*.xlsx' -o -name '*.xlsm' -o -name '*.csv' \) \
  -not -path './venv/*' -not -path './dist/*' -not -path './build/*' \
  -not -path './web/fixtures/*' 2>/dev/null)
if [ -n "$found" ]; then
  echo "DATA FOUND IN THE CODE TREE:"
  echo "$found"
  exit 1
fi

# The extension check above deliberately excludes the scrubbed fixtures. Scan
# their text and workbook cells as well, so a real identifier cannot be added
# back through a fixture, a test, a doc or a config file.
node - <<'NODE' || exit 1
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const XLSX = require("./web/vendor/xlsx.full.min.js");

const TEXT = /\.(?:md|txt|json|jsonc|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|csv|html|css|svg|ya?ml|toml|command)$/i;
const SKIP = /^(?:web\/vendor\/|assets\/|web\/logos\/)|\.(?:webp|png|jpe?g|gif|ico|wasm|zip|gz|pdf)$/i;
const UNREADABLE_KNOWN = new Set(["web/fixtures/encrypted/example_password.xlsx"]);

// Reserved synthetic namespace used by the scrubbed fixtures and tests.
const SYNTHETIC = /^9999/;

// Placeholders and public/test values that are not real identifiers.
const PAN_ALLOW = new Set(["AAAAA0000A", "ABCDE1234F", "XXXXX1234F"]);
const MOBILE_ALLOW = new Set(["9000000001", "9876543210", "9999999999", "9999009300"]);
const NUMBER_ALLOW = new Set([
  "04000000000",       // synthetic test landline
  "123456789012",      // classic dummy account in parser tests
  "1234567890123456",  // dummy demat account in assets test
  "1201000000000000",  // dummy demat account in DigiFInn test
  "1700000000000",     // epoch-millisecond constant in backup test
  "818823170955",      // public Google OAuth client id, not a secret
  "18001802222",       // published PNB toll-free
  "18001032222",       // published PNB toll-free
  "18001234567",       // public helpline discussed in UI-REVIEW
  "910000000000",      // masked/placeholder IMPS field in a fixture
  "919000000001",      // synthetic country-code phone in a fixture
  "0036515075873",     // SBI statement reference
  "061328525600",      // SCB statement reference
  "212113428100",      // SCB statement reference
  "154310564110235",   // Zerodha transaction reference
  "002283000000071",   // Zerodha NEFT reference
]);

// Real deposit numbers and payment references are not stored here. The
// patterns below catch them by shape; the scrubbed fixtures use the 9999
// namespace, so anything else is a real value.

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "venv"
        || name === "dist" || name === "build") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p.replace(/^\.\//, ""));
  }
  return out;
}

function files() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
  } catch {
    return walk(".");
  }
}

const hits = [];
function report(file, loc, kind) {
  hits.push(`${file}:${loc}: ${kind}`);
}

function scan(file, loc, text) {
  for (const m of text.matchAll(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g)) {
    if (!PAN_ALLOW.has(m[0])) report(file, loc, "PAN-shaped identifier");
  }
  for (const m of text.matchAll(/(?<!\d)[6-9]\d{9}(?!\d)/g)) {
    if (!MOBILE_ALLOW.has(m[0])) report(file, loc, "10-digit mobile-shaped identifier");
  }
  // An FD deposit number is digits, DP, more digits. The scrubbed fixtures use
  // the reserved 9999 prefix, so anything else is a real deposit number.
  for (const m of text.matchAll(/\b\d{6,}DP\d+\b/g)) {
    if (!SYNTHETIC.test(m[0])) report(file, loc, "FD deposit number");
  }
  // Ten-digit bank references start with 0; the ICICI reference in the old
  // fixtures starts with 6265. Neither is stored here as a full value.
  for (const m of text.matchAll(/(?<![0-9a-fA-F])0\d{9}(?![0-9a-fA-F])/g)) {
    report(file, loc, "10-digit payment reference");
  }
  for (const m of text.matchAll(/\b6265\d{8}\b/g)) {
    if (!SYNTHETIC.test(m[0])) report(file, loc, "12-digit payment reference");
  }
  for (const m of text.matchAll(/(?<![\dA-Za-z])\d{11,16}(?![\dA-Za-z])/g)) {
    const value = m[0];
    if (SYNTHETIC.test(value) || NUMBER_ALLOW.has(value)) continue;
    const before = text[m.index - 1] || "";
    const after = text[m.index + value.length] || "";
    const context = text.slice(Math.max(0, m.index - 40), m.index);
    // A number introduced by an account/FD label is an identifier even when
    // it sits between slashes (for example "A/C NO/123456789012/").
    if (/(?:A\/C|ACCT|ACCOUNT|FD|DEPOSIT|DEAL|CUSTOMER\s*ID|LOGIN)\b/i.test(context)) {
      report(file, loc, `${value.length}-digit account/FD-shaped identifier`);
      continue;
    }
    // A transaction reference between delimiters (UPI/IMPS/BIL rows) is not
    // an account number. An account number at the end of a slash-separated
    // narration is not delimited on both sides and is still caught.
    if ((before === "/" || before === "|") && (after === "/" || after === "|")) continue;
    if (/IMPS\|/.test(text) && before === "|" && (after === " " || after === "" || after === "|")) continue;
    if (before === "-" && after === "-") {
      const left = text.slice(Math.max(0, m.index - 30), m.index);
      const right = text.slice(m.index + value.length, m.index + value.length + 30);
      if (/[A-Za-z]/.test(left) && /[A-Za-z]/.test(right)) continue;
    }
    report(file, loc, `${value.length}-digit account/FD-shaped identifier`);
  }
}

for (const file of files()) {
  if (SKIP.test(file)) continue;
  const abs = file;
  if (/\.xlsx$/i.test(file)) {
    let wb;
    try {
      wb = XLSX.read(readFileSync(abs), { type: "buffer" });
    } catch (e) {
      if (!UNREADABLE_KNOWN.has(file)) report(file, "workbook", "unreadable workbook — cannot verify");
      continue;
    }
    for (const name of wb.SheetNames) {
      scan(file, `sheet name ${JSON.stringify(name)}`, name);
      const ws = wb.Sheets[name];
      for (const addr of Object.keys(ws)) {
        if (addr[0] === "!") continue;
        const cell = ws[addr];
        if (cell && typeof cell.v === "string") scan(file, `${name}!${addr}`, cell.v);
      }
    }
    continue;
  }
  if (!TEXT.test(file)) continue;
  const text = readFileSync(abs, "utf8");
  text.split("\n").forEach((line, i) => scan(file, i + 1, line));
}

if (hits.length) {
  console.error("IDENTIFIERS FOUND IN THE CODE TREE:");
  for (const hit of hits) console.error("  " + hit);
  console.error(`\n${hits.length} hit(s). Use a placeholder or a 9999-prefixed synthetic value, then rerun.`);
  process.exit(1);
}
console.log("clean: no PAN, mobile or account/FD-shaped identifiers in tracked text/XLSX");
NODE

echo "clean: no database, workbook or csv in the code tree"
