// The import inbox has to keep recognising the same file shapes, and keep
// refusing what it cannot read. These tests walk a synthetic corpus through the
// same detect -> parse -> group path the page uses, including a real XLSX
// round-trip. Real statements are never stored here; see fixtures/import/README.md.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectImportFile, parseTradebook, parseTradebookMatrix, groupBundles }
  from "./import-flow.js";
import { parseZerodhaHoldings, parseZerodhaHoldingsSheets } from "./zerodha.js";
import { scanFiles } from "./privacy-scan.mjs";
import { DETECTION_CASES, DIGIFINN_FILES, KITE_CONSOLE_SHEETS,
  ZERODHA_HOLDINGS_MATRIX, ZERODHA_TRADEBOOK_MATRIX } from "./fixtures/import/samples.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("./vendor/xlsx.full.min.js");

const ROOT = new URL("../", import.meta.url).pathname;
const FIXTURES_ROOT = new URL("./fixtures/", import.meta.url).pathname;
const PRIVATE = new URL("./private/import-denylist.txt", import.meta.url).pathname;

function xlsxRoundTrip(matrix, sheetName = "Statement") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), sheetName);
  const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return { bytes, read: XLSX.read(bytes, { type: "buffer" }) };
}

function sheetRows(wb, name = wb.SheetNames[0]) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name],
    { header: 1, raw: true, defval: "" });
}

function workbookBytes(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, matrix] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("every supported import kind is detected by content, not by name", () => {
  for (const item of DETECTION_CASES) {
    const got = detectImportFile({ name: item.name, text: item.text || "",
      matrix: item.matrix || null });
    assert.equal(got.kind, item.kind, item.name);
    assert.equal(got.family, item.family, item.name);
    assert.equal(got.confidence, item.confidence, item.name);
    assert.equal(got.asOf, item.asOf, item.name);
  }
});

test("a misleading file name does not beat the contents", () => {
  const motilalInCasSlot = detectImportFile({
    name: "consolidated-account-statement.pdf",
    text: DETECTION_CASES.find((item) => item.kind === "motilal").text,
  });
  assert.equal(motilalInCasSlot.kind, "motilal");

  const casWithBrokerName = detectImportFile({
    name: "zerodha-holdings.xlsx",
    text: DETECTION_CASES.find((item) => item.kind === "cas").text,
  });
  assert.equal(casWithBrokerName.kind, "cas");
});

test("the tradebook parser reads text and matrix forms identically", () => {
  const text = ["symbol,isin,trade_date,exchange,trade_type,quantity,price",
    "TESTSTOCK,INE000000001,2025-11-13,NSE,buy,5,100.50",
    "TESTSTOCK,INE000000001,2025-11-14,NSE,sell,2,110"].join("\n");
  const fromText = parseTradebook(text);
  const fromMatrix = parseTradebookMatrix(ZERODHA_TRADEBOOK_MATRIX);
  assert.equal(fromText.error, null);
  assert.equal(fromMatrix.error, null);
  assert.equal(fromText.rows.length, 2);
  assert.equal(fromMatrix.rows.length, 2);
  assert.deepEqual(fromText.firstBuyByIsin, fromMatrix.firstBuyByIsin);
  assert.equal(fromMatrix.firstBuyByIsin.INE000000001, "2025-11-13");
  assert.equal(fromMatrix.rows[1].type, "sell");
});

test("a tradebook XLSX survives the workbook round-trip the page performs", () => {
  const { read } = xlsxRoundTrip(ZERODHA_TRADEBOOK_MATRIX, "Equity");
  const sheet = sheetRows(read);
  const detected = detectImportFile({ matrix: sheet });
  assert.equal(detected.kind, "zerodha-tradebook");
  assert.equal(detected.confidence, "content");
  const parsed = parseTradebookMatrix(sheet);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.firstBuyByIsin.INE000000001, "2025-11-13");
  assert.equal(parsed.firstBuyBySymbol.TESTSTOCK, "2025-11-13");
});

test("a holdings XLSX keeps its Client ID, date and rows through the round-trip", () => {
  const { read } = xlsxRoundTrip(ZERODHA_HOLDINGS_MATRIX, "Equity");
  const sheets = read.SheetNames.map((name) => sheetRows(read, name));
  const detected = detectImportFile({ matrix: sheets[0] });
  assert.equal(detected.kind, "zerodha-holdings");
  const parsed = parseZerodhaHoldingsSheets(sheets);
  assert.equal(parsed.error, null);
  assert.equal(parsed.clientId, "TEST500");
  assert.equal(parsed.asOf, "2026-11-12");
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].quantity, 5);
  assert.equal(parsed.rows[0].averagePrice, 100.5);
});

test("a Kite Console three-sheet XLSX reads each security once", () => {
  const bytes = workbookBytes(KITE_CONSOLE_SHEETS);
  const read = XLSX.read(bytes, { type: "buffer" });
  const names = read.SheetNames;
  const sheets = names.map((name) => sheetRows(read, name));
  assert.deepEqual(names, ["Equity", "Mutual Funds", "Combined"]);
  const detected = sheets.map((sheet) => detectImportFile({ matrix: sheet }))
    .find((found) => found.kind !== "unknown");
  assert.equal(detected.kind, "zerodha-holdings");
  assert.equal(detected.confidence, "content");
  const parsed = parseZerodhaHoldingsSheets(sheets, names);
  assert.equal(parsed.error, null);
  assert.equal(parsed.clientId, "TEST500");
  assert.equal(parsed.asOf, "2026-11-12");
  assert.equal(parsed.rows.length, 5);
  assert.equal(new Set(parsed.rows.map((row) => row.isin)).size, 5);
  assert.equal(parsed.rows.filter((row) => row.category === "mf").length, 2);
  assert.equal(parsed.rows.find((row) => row.symbol === "TESTPOWER").quantity, 77);
  assert.equal(parsed.rows.find((row) => row.symbol === "TESTPOWER").pledged, 7);
});

test("a three-sheet workbook with no Kite header is still unknown", () => {
  const bytes = workbookBytes({
    Equity: [["Summary", "Invested Value"], ["", 100000]],
    "Mutual Funds": [["Portfolio", "Units"], ["", 0]],
    Combined: [["Notes"], ["Nothing to import"]],
  });
  const read = XLSX.read(bytes, { type: "buffer" });
  const names = read.SheetNames;
  const sheets = names.map((name) => sheetRows(read, name));
  for (const sheet of sheets) {
    assert.equal(detectImportFile({ matrix: sheet }).kind, "unknown");
  }
  const parsed = parseZerodhaHoldingsSheets(sheets, names);
  assert.match(parsed.error, /No equity holdings sheet/);
  assert.equal(parsed.rows.length, 0);
});

test("the five DigiFinn reports still group as one account set", () => {
  const files = DIGIFINN_FILES.map((file) => ({ ...file }));
  const bundles = groupBundles(files);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].family, "digifinn");
  assert.equal(bundles[0].files.length, 5);
  assert.equal(bundles[0].base.kind, "digifinn-portfolio");
  assert.equal(bundles[0].optional.length, 4);
  assert.deepEqual(bundles[0].optional.map((file) => file.kind).sort(), [
    "digifinn-cashflow", "digifinn-investment", "digifinn-payouts",
    "digifinn-transactions",
  ]);
});

test("malformed and truncated inputs fail closed instead of throwing", () => {
  assert.equal(detectImportFile({}).kind, "unknown");
  assert.equal(detectImportFile({ matrix: null }).kind, "unknown");
  assert.equal(detectImportFile({ matrix: [] }).kind, "unknown");
  assert.equal(detectImportFile({ text: "x".repeat(200_000) }).kind, "unknown");
  assert.equal(detectImportFile({ matrix: [["Symbol", "ISIN"]] }).kind, "unknown");

  for (const input of [undefined, null, "", "symbol,isin,qty\nX,INE000000001,1"]) {
    const parsed = parseTradebookMatrix(input);
    assert.match(parsed.error, /No tradebook header|no readable trades/);
    assert.equal(parsed.rows.length, 0);
  }
  assert.match(parseTradebook("").error, /No tradebook header/);

  for (const input of [undefined, null, [], [["Symbol", "ISIN"]]]) {
    const parsed = parseZerodhaHoldings(input);
    assert.ok(parsed.error);
    assert.equal(parsed.rows.length, 0);
  }
  assert.ok(parseZerodhaHoldingsSheets([]).error);

  assert.deepEqual(groupBundles([]), []);
  assert.deepEqual(groupBundles([{ kind: "unknown", name: "x" }]), []);
});

test("the page routes a tradebook XLSX through parseTradebookMatrix", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /parseTradebookMatrix/);
  const xlsxBranch = html.slice(html.indexOf('} else if (ext === "xlsx"'),
    html.indexOf("} else {", html.indexOf('} else if (ext === "xlsx"')));
  assert.match(xlsxBranch, /detected\.kind === "zerodha-tradebook"/,
    "the XLSX branch accepts a tradebook");
  assert.match(xlsxBranch, /parseTradebookMatrix\(sheet, \{ file: entry\.name \}\)/,
    "the XLSX branch parses the matrix, not a missing text body");
});

// --- privacy guard ----------------------------------------------------------

const BINARY = /\.(pdf|xlsx|xls|xlsm|zip|bpk|db|sqlite|wasm|png|jpe?g|gif|webp|ico|gz|tgz|7z|rar)$/i;
const ALLOWED_BINARY = new Set([
  "hdfc.xlsx",
  "encrypted/example_password.xlsx",
  "banks/icici-savings-2026-08.xlsx",
  "banks/icici-savings-2026-10.xlsx",
  "banks/sbi-savings-2026-07.xlsx",
  "import/pdf/cas-sold.pdf",
  "import/pdf/blank-synthetic.pdf",
  "import/pdf/locked-synthetic.pdf",
  "import/pdf/motilal-sold.pdf",
  "import/zerodha/kite-holdings-2026-11.xlsx",
]);

function fixtureFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) out.push(...fixtureFiles(path, rel));
    else out.push(rel);
  }
  return out;
}

test("every fixture is synthetic, listed and small", () => {
  for (const rel of fixtureFiles(FIXTURES_ROOT)) {
    const stat = statSync(join(FIXTURES_ROOT, rel));
    assert.equal(stat.isFile(), true, rel);
    if (BINARY.test(rel)) {
      assert.ok(ALLOWED_BINARY.has(rel), `${rel} is an unlisted binary fixture`);
    }
    assert.ok(stat.size <= 64 * 1024, `${rel} is too large for a synthetic fixture`);
  }
});

test("no tracked web file contains an identifier from the local denylist", () => {
  let denylist = [];
  try {
    denylist = readFileSync(PRIVATE, "utf8").split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!denylist.length) return;
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "web"],
    { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = scanFiles(tracked, denylist, { root: ROOT });
  assert.deepEqual(findings, [],
    findings.map((finding) => `${finding.path}:${finding.line}`).join("\n"));
});
