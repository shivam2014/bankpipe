// The import contract. Six supported files, each read once through the same
// parser the page uses. The expectations in fixtures/import/parser-contract.json
// are written from the fixture's own printed values, never captured from the
// parser, so a reader that takes the wrong column cannot agree with itself.
// The detection matrix runs every fixture through every detector, and the
// refusal matrix proves each guard still names what it could not read.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";

import { rowsFromCsv, parseStatement, looksLikeBankStatement } from "./parse.js";
import { extractPdf, PdfPasswordError } from "./pdf-statement.js";
import { parseCas } from "./cas.js";
import { parseMotilalPages } from "./motilal.js";
import { parseZerodhaHoldings, parseZerodhaHoldingsSheets,
  looksLikeZerodhaHoldings, ZERODHA_HOLDINGS_SCHEMA } from "./zerodha.js";
import { parseIciciHoldings, looksLikeIciciHoldings,
  ICICI_DETECTION_SCHEMA } from "./icici.js";
import { parseReportFile, PORTFOLIO_DETECTION_SCHEMA, INVESTMENT_SCHEMA,
  TRANSACTIONS_DETECTION_SCHEMA } from "./digifinn-reports.js";
import { parseCsv, PAYOUTS_DETECTION_SCHEMA } from "./digifinn.js";
import { detectImportFile, TRADEBOOK_SCHEMA, looksLikeCasText,
  looksLikeMotilalText, looksLikeDigiFinnCashflow } from "./import-flow.js";
import { findHeaderRow } from "./table-schema.js";
import { ICICI_HOLDINGS_TEXT, KITE_CONSOLE_SHEETS } from "./fixtures/import/samples.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("./vendor/xlsx.full.min.js");

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(FIXTURES, "import/parser-contract.json"), "utf8"));
const CASE = (name) => CONTRACT.cases[name];
const REFUSAL = (name) => CONTRACT.refusals[name];

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const paise = (rupees) => Math.round(rupees * 100);

function headerIn(text, schema) {
  return findHeaderRow(parseCsv(String(text || "")), schema).index >= 0;
}

function matrixIn(matrix, schema) {
  return Array.isArray(matrix) && findHeaderRow(matrix, schema).index >= 0;
}

// Each detector is the check the inbox consults before it routes a file. A
// detector sees only the input form the inbox gives that file: CSV and PDF
// arrive as text, XLSX arrives as a matrix.
const DETECTORS = [
  { kind: "bank", claims: ({ text }) => looksLikeBankStatement(text) },
  { kind: "cas", claims: ({ text }) => looksLikeCasText(text) },
  { kind: "motilal", claims: ({ text }) => looksLikeMotilalText(text) },
  { kind: "zerodha-holdings", claims: ({ text, matrix }) => matrix
    ? looksLikeZerodhaHoldings(matrix)
    : headerIn(text, ZERODHA_HOLDINGS_SCHEMA) },
  { kind: "zerodha-tradebook", claims: ({ text, matrix }) => matrix
    ? matrixIn(matrix, TRADEBOOK_SCHEMA)
    : headerIn(text, TRADEBOOK_SCHEMA) },
  { kind: "icici-holdings", claims: ({ text, matrix }) => matrix
    ? looksLikeIciciHoldings(matrix)
    : headerIn(text, ICICI_DETECTION_SCHEMA) },
  { kind: "digifinn-portfolio", claims: ({ text }) => headerIn(text, PORTFOLIO_DETECTION_SCHEMA) },
  { kind: "digifinn-investment", claims: ({ text }) => headerIn(text, INVESTMENT_SCHEMA) },
  { kind: "digifinn-transactions", claims: ({ text }) => headerIn(text, TRANSACTIONS_DETECTION_SCHEMA) },
  { kind: "digifinn-payouts", claims: ({ text }) => headerIn(text, PAYOUTS_DETECTION_SCHEMA) },
  { kind: "digifinn-cashflow", claims: ({ text }) => looksLikeDigiFinnCashflow(text) },
];

const pdfText = (pdf) => (pdf.pages || []).flatMap((page) => page.items || [])
  .map((item) => item.str).join(" ");

// A worksheet's used range is as wide as its longest row, so sheet_to_json
// pads shorter rows with empty strings. The canonical matrix does not.
function trimTrailing(row) {
  let end = row.length;
  while (end > 0 && row[end - 1] === "") end -= 1;
  return row.slice(0, end);
}

function readWorkbook(file) {
  const wb = XLSX.read(readFileSync(join(FIXTURES, file)), { type: "buffer" });
  const names = wb.SheetNames.slice();
  const sheets = names.map((name) => XLSX.utils.sheet_to_json(wb.Sheets[name],
    { header: 1, raw: true, defval: "" }).map(trimTrailing));
  return { names, sheets };
}

async function loadCase(name) {
  const item = CASE(name);
  if (item.format === "csv") {
    return { name: basename(item.file), text: readFileSync(join(FIXTURES, item.file), "utf8"),
      matrix: null };
  }
  if (item.format === "pdf") {
    const pdf = await extractPdf(readFileSync(join(FIXTURES, item.file)), {});
    return { name: basename(item.file), text: pdfText(pdf), matrix: null, pdf };
  }
  if (item.format === "xlsx") {
    const { names, sheets } = readWorkbook(item.file);
    return { name: basename(item.file), text: "", matrix: sheets[0], names, sheets };
  }
  throw new Error(`unknown fixture format: ${item.format}`);
}

function compareRows(actual, expected, fields, label) {
  assert.equal(actual.length, expected.length, `${label}: row count`);
  expected.forEach((want, index) => {
    for (const field of fields) {
      assert.deepEqual(actual[index][field], want[field],
        `${label}: row ${index + 1} ${field}`);
    }
  });
}

test("every fixture is claimed by its own detector and refused by every other", async () => {
  for (const name of Object.keys(CONTRACT.cases)) {
    const wanted = CASE(name);
    const input = await loadCase(name);
    const got = detectImportFile({ name: input.name, text: input.text, matrix: input.matrix });
    assert.equal(got.kind, wanted.kind, `${name}: detected kind`);
    assert.equal(got.family, wanted.family, `${name}: family`);
    assert.equal(got.confidence, wanted.confidence, `${name}: confidence`);
    assert.equal(got.asOf, wanted.detectedAsOf, `${name}: detected date`);
    for (const detector of DETECTORS) {
      const claimed = detector.claims(input);
      assert.equal(claimed, detector.kind === wanted.kind,
        `${name}: ${detector.kind} ${claimed ? "claims" : "refuses"} the file`);
    }
    // Every sheet of the one workbook is the same holdings export, and the
    // Combined sheet must not be taken for a tradebook.
    for (const [index, sheet] of (input.sheets || []).entries()) {
      const sheetInput = { text: "", matrix: sheet };
      const sheetGot = detectImportFile({ matrix: sheet });
      assert.equal(sheetGot.kind, wanted.kind,
        `${name}: sheet ${input.names[index]} kind`);
      assert.equal(sheetGot.confidence, "content",
        `${name}: sheet ${input.names[index]} confidence`);
      for (const detector of DETECTORS) {
        assert.equal(detector.claims(sheetInput), detector.kind === wanted.kind,
          `${name}: sheet ${input.names[index]} ${detector.kind}`);
      }
    }
  }
});

test("bank CSV: the Standard Chartered shape reads every dated row", async () => {
  const wanted = CASE("bank");
  const input = await loadCase("bank");
  const parsed = parseStatement(rowsFromCsv(input.text));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.header, wanted.headerRow);
  assert.deepEqual(parsed.mapping, wanted.mapping);
  assert.equal(parsed.order, wanted.order);

  const dated = parsed.rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  assert.equal(dated.length, wanted.rowCount);
  assert.equal(parsed.rows.filter((row) => !row.date).length, wanted.undatedTail);
  compareRows(dated, wanted.rows, ["date", "description", "amount", "balance"], "bank");

  const expectedDeposits = sum(wanted.rows.filter((row) => row.amount > 0), (row) => row.amount);
  const expectedWithdrawals = -sum(wanted.rows.filter((row) => row.amount < 0), (row) => row.amount);
  const expectedNet = sum(wanted.rows, (row) => row.amount);
  assert.equal(wanted.totals.depositsPaise, expectedDeposits);
  assert.equal(wanted.totals.withdrawalsPaise, expectedWithdrawals);
  assert.equal(wanted.totals.netPaise, expectedNet);
  assert.equal(wanted.totals.closingPaise, wanted.rows[0].balance);

  assert.equal(sum(dated.filter((row) => row.amount > 0), (row) => row.amount), expectedDeposits);
  assert.equal(-sum(dated.filter((row) => row.amount < 0), (row) => row.amount), expectedWithdrawals);
  assert.equal(sum(dated, (row) => row.amount), expectedNet);
  assert.equal(dated[0].balance, wanted.totals.closingPaise);
});

test("CAS PDF: the sold-bond pair reads one holding and one sale", async () => {
  const wanted = CASE("cas");
  const input = await loadCase("cas");
  const parsed = parseCas(input.pdf);
  assert.equal(parsed.depository, wanted.depository);
  assert.equal(parsed.demat, wanted.demat);
  assert.equal(parsed.holdings.length, wanted.holdingsCount);
  assert.equal(parsed.transactions.length, wanted.transactionsCount);
  assert.equal(parsed.counts.quarantined, 0);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.sections, wanted.sections);
  compareRows(parsed.holdings, wanted.holdings,
    ["isin", "label", "kind", "quantity", "valuePaise", "couponPct", "maturity"], "cas holding");
  compareRows(parsed.transactions, wanted.transactions,
    ["isin", "security", "date", "type", "quantity", "openingPaise",
      "creditPaise", "debitPaise", "closingPaise"], "cas transaction");

  const expectedQuantity = sum(wanted.holdings, (row) => row.quantity);
  const expectedValue = sum(wanted.holdings, (row) => row.valuePaise);
  const expectedDebit = sum(wanted.transactions, (row) => row.debitPaise);
  assert.equal(wanted.totals.holdingsQuantity, expectedQuantity);
  assert.equal(wanted.totals.holdingsValuePaise, expectedValue);
  assert.equal(wanted.totals.transactionDebitPaise, expectedDebit);

  assert.equal(sum(parsed.holdings, (row) => row.quantity), expectedQuantity);
  assert.equal(sum(parsed.holdings, (row) => row.valuePaise), expectedValue);
  assert.equal(sum(parsed.transactions, (row) => row.debitPaise), expectedDebit);
});

test("Zerodha XLSX: the Kite Console three-sheet export reads each security once", async () => {
  const wanted = CASE("zerodha");
  const input = await loadCase("zerodha");
  assert.deepEqual(input.names, Object.keys(KITE_CONSOLE_SHEETS));
  for (const [name, matrix] of Object.entries(KITE_CONSOLE_SHEETS)) {
    assert.deepEqual(input.sheets[input.names.indexOf(name)], matrix, `workbook sheet ${name}`);
  }

  const parsed = parseZerodhaHoldingsSheets(input.sheets, input.names, { file: input.name });
  assert.equal(parsed.error, null);
  assert.equal(parsed.clientId, wanted.clientId);
  assert.equal(parsed.asOf, wanted.asOf);
  compareRows(parsed.rows, wanted.rows,
    ["symbol", "isin", "quantity", "pledged", "averagePrice", "category"], "zerodha");

  const expectedQuantity = sum(wanted.rows, (row) => row.quantity);
  const expectedPledged = sum(wanted.rows, (row) => row.pledged);
  const expectedCost = sum(wanted.rows, (row) => paise(row.quantity * row.averagePrice));
  assert.equal(wanted.totals.totalQuantity, expectedQuantity);
  assert.equal(wanted.totals.totalPledged, expectedPledged);
  assert.equal(wanted.totals.totalCostPaise, expectedCost);
  assert.equal(sum(parsed.rows, (row) => row.quantity), expectedQuantity);
  assert.equal(sum(parsed.rows, (row) => row.pledged), expectedPledged);
  assert.equal(sum(parsed.rows, (row) => paise(row.quantity * row.averagePrice)), expectedCost);
  assert.equal(new Set(parsed.rows.map((row) => row.isin)).size, wanted.rowCount);
});

test("Motilal PDF: the Portfolio Holding Summary reads its one bond row", async () => {
  const wanted = CASE("motilal");
  const input = await loadCase("motilal");
  const parsed = parseMotilalPages(input.pdf.pages, { file: input.name });
  assert.equal(parsed.error, null);
  assert.equal(parsed.clientUcid, wanted.clientUcid);
  assert.equal(parsed.asOf, wanted.asOf);
  assert.deepEqual(parsed.sections, wanted.sections);
  compareRows(parsed.rows, wanted.rows, ["isin", "section", "label", "quantity", "cost_paise"],
    "motilal");

  const expectedQuantity = sum(wanted.rows, (row) => row.quantity);
  const expectedCost = sum(wanted.rows, (row) => row.cost_paise);
  assert.equal(wanted.totals.totalQuantity, expectedQuantity);
  assert.equal(wanted.totals.totalCostPaise, expectedCost);
  assert.equal(sum(parsed.rows, (row) => row.quantity), expectedQuantity);
  assert.equal(sum(parsed.rows, (row) => row.cost_paise), expectedCost);
});

test("DigiFinn CSV: the Portfolio Report reads its bonds and keeps identity out", async () => {
  const wanted = CASE("digifinn");
  const input = await loadCase("digifinn");
  const parsed = parseReportFile(input.text, input.name);
  assert.equal(parsed.error, null);
  assert.equal(parsed.kind, wanted.parsedKind);
  assert.equal(parsed.demat, wanted.demat);
  assert.equal(parsed.asOf, wanted.asOf);
  compareRows(parsed.rows, wanted.rows,
    ["isin", "label", "purchase_date", "quantity", "cost_paise"], "digifinn");

  const expectedQuantity = sum(wanted.rows, (row) => row.quantity);
  const expectedCost = sum(wanted.rows, (row) => row.cost_paise);
  assert.equal(wanted.totals.totalQuantity, expectedQuantity);
  assert.equal(wanted.totals.totalCostPaise, expectedCost);
  assert.equal(sum(parsed.rows, (row) => row.quantity), expectedQuantity);
  assert.equal(sum(parsed.rows, (row) => row.cost_paise), expectedCost);
  assert.ok(!JSON.stringify(parsed.rows).includes("TEST HOLDER ONE"));
  assert.ok(!JSON.stringify(parsed.rows).includes("ABCDE1234F"));
});

test("ICICI CSV: the Demat Holdings export reads market value, never cost", async () => {
  const wanted = CASE("icici");
  const input = await loadCase("icici");
  assert.equal(input.text.trimEnd(), ICICI_HOLDINGS_TEXT);
  const parsed = parseIciciHoldings(parseCsv(input.text),
    { file: input.name, asOf: wanted.asOf });
  assert.equal(parsed.error, null);
  assert.equal(parsed.asOf, wanted.asOf);
  assert.equal(parsed.asOfSource, wanted.asOfSource);
  compareRows(parsed.rows, wanted.rows,
    ["isin", "label", "symbol", "category", "quantity", "valuePaise"], "icici");

  const expectedQuantity = sum(wanted.rows, (row) => row.quantity);
  const expectedValue = sum(wanted.rows, (row) => row.valuePaise);
  assert.equal(wanted.totals.totalQuantity, expectedQuantity);
  assert.equal(wanted.totals.totalValuePaise, expectedValue);
  assert.equal(sum(parsed.rows, (row) => row.quantity), expectedQuantity);
  assert.equal(sum(parsed.rows, (row) => row.valuePaise), expectedValue);
  assert.equal(parsed.rows.filter((row) => row.category === "equity").length, 1);
  assert.equal(parsed.rows.filter((row) => row.category === "bond").length, 3);
  assert.ok(parsed.rows.every((row) => row.costPaise === null));
});

test("a renamed required column refuses the file and names the column", async () => {
  const wanted = REFUSAL("renamedIciciColumn");
  const original = readFileSync(join(FIXTURES, wanted.file), "utf8");
  const text = original.replace(wanted.from, wanted.to);
  assert.notEqual(text, original, "the test mutation must change the fixture");

  const detected = detectImportFile({ name: "ICICI_Holdings.csv", text });
  assert.equal(detected.kind, wanted.kind);
  assert.equal(detected.confidence, wanted.confidence);

  const parsed = parseIciciHoldings(parseCsv(text),
    { file: "ICICI_Holdings.csv", asOf: CASE("icici").asOf });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, new RegExp(wanted.message));
});

test("a removed required column refuses the workbook and names the column", async () => {
  const wanted = REFUSAL("removedZerodhaColumn");
  const { names, sheets } = readWorkbook(wanted.file);
  const sheet = sheets[names.indexOf(wanted.sheet)];
  assert.ok(sheet, "the named sheet exists");
  const headerRow = sheet.findIndex((row) => row.includes(wanted.column));
  assert.ok(headerRow >= 0, "the fixture prints the column");
  const column = sheet[headerRow].indexOf(wanted.column);
  const stripped = sheet.map((row) => row.filter((_, index) => index !== column));
  assert.ok(!stripped[headerRow].includes(wanted.column));

  const detected = detectImportFile({ matrix: stripped });
  assert.equal(detected.kind, wanted.kind);
  assert.equal(detected.confidence, "content");

  const parsed = parseZerodhaHoldings(stripped, { file: wanted.file, sheet: wanted.sheet });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, new RegExp(wanted.message));
});

test("a PDF with no text layer imports nothing and the reader names it", async () => {
  const wanted = REFUSAL("noTextPdf");
  const pdf = await extractPdf(readFileSync(join(FIXTURES, wanted.file)), {});
  assert.equal(pdf.numPages, 1);
  assert.ok(pdf.pages.every((page) => page.items.length === 0));
  assert.ok(pdf.pages.every((page) => page.scanned));

  const motilal = parseMotilalPages(pdf.pages, { file: wanted.file });
  assert.equal(motilal.rows.length, 0);
  assert.match(motilal.error, new RegExp(wanted.message, "i"));

  const cas = parseCas(pdf);
  assert.equal(cas.holdings.length, 0);
  assert.equal(cas.transactions.length, 0);
});

test("a password-protected PDF with no password imports nothing", async () => {
  const wanted = REFUSAL("lockedPdf");
  const bytes = readFileSync(join(FIXTURES, wanted.file));
  await assert.rejects(extractPdf(bytes, {}), (error) => {
    assert.ok(error instanceof PdfPasswordError);
    assert.match(error.message, new RegExp(wanted.message, "i"));
    assert.equal(error.wrong, false);
    return true;
  });

  const opened = await extractPdf(bytes, { password: wanted.password });
  assert.equal(opened.numPages, 1);
  const cas = parseCas(opened);
  assert.equal(cas.holdings.length, 0);
  assert.equal(cas.transactions.length, 0);
});
