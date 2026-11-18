// Optional smoke test over the real statements. It reads them from a directory
// outside the repository, never copies them, and never writes them. Without
// BANKPIPE_PRIVATE_IMPORT_DIR the test is skipped.
//
//   BANKPIPE_PRIVATE_IMPORT_DIR="$HOME/statements" node --test web/import-private.test.mjs
//
// A manifest in that directory pins the expected result:
//   { "files": [ { "name": "tradebook.xlsx", "kind": "zerodha-tradebook", "minRows": 1 } ] }
// The manifest is optional. Without it, every supported file is detected and
// parsed, and the summary is printed; unknown files are listed, not failed.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { detectImportFile, parseTradebook, parseTradebookMatrix } from "./import-flow.js";
import { parseZerodhaHoldingsSheets } from "./zerodha.js";
import { parseDigiFinnFile } from "./digifinn.js";
import { parseReportFile } from "./digifinn-reports.js";

const require = createRequire(import.meta.url);
const XLSX = require("./vendor/xlsx.full.min.js");
const DIR = process.env.BANKPIPE_PRIVATE_IMPORT_DIR || "";
const TEXT_EXT = /\.(csv|txt)$/i;
const SHEET_EXT = /\.(xlsx|xls|xlsm)$/i;
const PDF_EXT = /\.pdf$/i;

function readManifest(dir) {
  for (const name of ["import-manifest.json", "manifest.json"]) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (Array.isArray(value?.files)) return value.files;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
}

const rowCount = (value) => (Array.isArray(value) ? value.length : value ?? null);

function inspect(dir, entry) {
  const path = join(dir, entry);
  const name = basename(entry);
  if (TEXT_EXT.test(name)) {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const detected = detectImportFile({ name, text });
    const result = { name, detected, rows: null, note: "" };
    if (detected.kind === "zerodha-tradebook") {
      result.rows = parseTradebook(text).rows.length;
    } else if (detected.kind === "digifinn-cashflow" || detected.kind === "digifinn-payouts") {
      result.rows = rowCount(parseDigiFinnFile(text, name).rows);
    } else if (detected.kind.startsWith("digifinn-")) {
      result.rows = parseReportFile(text, name)?.rows?.length ?? null;
    }
    return result;
  }
  if (SHEET_EXT.test(name)) {
    const wb = XLSX.read(readFileSync(path), { type: "buffer" });
    const sheets = wb.SheetNames.map((sheet) => XLSX.utils.sheet_to_json(
      wb.Sheets[sheet], { header: 1, raw: true, defval: "" }));
    const detected = sheets.map((sheet) => detectImportFile({ matrix: sheet }))
      .find((found) => found.kind !== "unknown") || detectImportFile({ matrix: [] });
    const result = { name, detected, rows: null, note: "" };
    if (detected.kind === "zerodha-tradebook") {
      result.rows = sheets.map((sheet) => parseTradebookMatrix(sheet))
        .find((parsed) => !parsed.error)?.rows?.length ?? 0;
    } else if (detected.kind === "zerodha-holdings") {
      result.rows = parseZerodhaHoldingsSheets(sheets, wb.SheetNames).rows?.length ?? 0;
    }
    return result;
  }
  if (PDF_EXT.test(name)) {
    return { name, detected: { kind: "pdf", family: "", confidence: "none", asOf: "" },
      rows: null, note: "PDF text extraction is exercised in the page, not here." };
  }
  return null;
}

test("the private statements still detect and parse", { skip: !DIR }, (t) => {
  const manifest = readManifest(DIR);
  const expected = new Map((manifest || []).map((item) => [item.name, item]));
  const files = readdirSync(DIR).filter((name) => {
    const path = join(DIR, name);
    return statSync(path).isFile() && (TEXT_EXT.test(name) || SHEET_EXT.test(name) || PDF_EXT.test(name));
  });
  assert.ok(files.length, `no supported statements in ${DIR}`);

  const seen = new Set();
  const unknown = [];
  for (const name of files) {
    const result = inspect(DIR, name);
    if (!result) continue;
    seen.add(name);
    t.diagnostic(`${name}: ${result.detected.kind}${result.rows === null ? "" : ` rows=${result.rows}`}${result.note ? ` (${result.note})` : ""}`);
    if (result.detected.kind === "unknown") unknown.push(name);
    const want = expected.get(name);
    if (!want) continue;
    assert.equal(result.detected.kind, want.kind, `${name} changed kind`);
    if (want.minRows !== undefined && result.rows !== null) {
      assert.ok(result.rows >= want.minRows, `${name} has ${result.rows} rows, want at least ${want.minRows}`);
    }
  }
  for (const name of expected.keys()) {
    assert.ok(seen.has(name), `manifest names ${name}, but it is not in ${DIR}`);
  }
  if (manifest) assert.deepEqual(unknown, [], "a manifest-pinned statement became unknown");
  assert.ok(seen.size > 0, "no supported statements were read");
});
