import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { balanceRunsFromSheet, classifyBalanceFormula } from "./balance-formula.js";

const require = createRequire(import.meta.url);
const XLSX = require("./vendor/xlsx.full.min.js");

const profile = {
  header_row: 1,
  columns: [
    { col: "A", kind: "date", role: "value" },
    { col: "B", kind: "free_text", role: "label" },
    { col: "C", kind: "amount", role: "value", use: "debit" },
    { col: "D", kind: "amount", role: "value", use: "credit" },
    { col: "E", kind: "amount", role: "value", use: "balance" },
  ],
};

function workbook(formulas = []) {
  const aoa = [
    ["Date", "Description", "Debit", "Credit", "Balance"],
    ["2024-04-01", "A", 100, 0, 100],
    ["2024-04-02", "B", 0, 50, 150],
    ["2024-04-03", "C", 25, 0, 125],
    ["2024-04-04", "D", 0, 10, 135],
    ["2024-04-05", "E", 5, 0, 130],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 0; i < formulas.length; i++) {
    if (!formulas[i]) continue;
    const row = i + 2;
    ws[`E${row}`] = { t: "n", f: formulas[i], v: aoa[i + 1][4] };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Txns");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const read = XLSX.read(bytes, { type: "array" });
  const sheet = read.Sheets.Txns;
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
  return { ws: sheet, matrix };
}

test("post-entry formulas classify as post", () => {
  const book = workbook([
    "E1+C2-D2", "E2+C3-D3", "E3+C4-D4", "E4+C5-D5", "E5+C6-D6",
  ]);
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.deepEqual(runs, [{ from: 2, to: 6, formula: true, convention: "post",
    mixed: false, unreadable: false }]);
});

test("opening formulas classify as opening", () => {
  const book = workbook([
    "E1+C1-D1", "E2+C2-D2", "E3+C3-D3", "E4+C4-D4", "E5+C5-D5",
  ]);
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.deepEqual(runs, [{ from: 2, to: 6, formula: true, convention: "opening",
    mixed: false, unreadable: false }]);
});

test("a values-only balance column is one evidence-free value run", () => {
  const book = workbook();
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.deepEqual(runs, [{ from: 2, to: 6, formula: false, convention: "",
    mixed: false, unreadable: false }]);
});

test("formula rows followed by value rows become two runs", () => {
  const book = workbook([
    "E1+C1-D1", "E2+C2-D2", "", "", "",
  ]);
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.deepEqual(runs.map((r) => [r.from, r.to, r.formula, r.convention]), [
    [2, 3, true, "opening"],
    [4, 6, false, ""],
  ]);
});

test("formula runs that disagree are each classified", () => {
  const book = workbook([
    "E1+C1-D1", "E2+C2-D2", "", "E4+C5-D5", "E5+C6-D6",
  ]);
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.deepEqual(runs.map((r) => [r.from, r.to, r.formula, r.convention]), [
    [2, 3, true, "opening"],
    [4, 4, false, ""],
    [5, 6, true, "post"],
  ]);
});

test("unparseable formulas are evidence-free, not a majority guess", () => {
  const book = workbook([
    "SUM(E2:E3)", "SUM(E2:E3)", "SUM(E3:E4)", "SUM(E4:E5)", "SUM(E5:E6)",
  ]);
  const runs = balanceRunsFromSheet(book.ws, profile, book.matrix);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].formula, true);
  assert.equal(runs[0].unreadable, true);
  assert.equal(runs[0].convention, "");
});

test("formula shapes name the convention", () => {
  const opts = { row: 3, balanceCol: "E", amountCols: ["C", "D"] };
  assert.equal(classifyBalanceFormula("E2+C3-D3", opts), "post");
  assert.equal(classifyBalanceFormula("E2+C2-D2", opts), "opening");
  assert.equal(classifyBalanceFormula("E4", opts), "opening");
  assert.equal(classifyBalanceFormula("E3+C3", opts), "");
  assert.equal(classifyBalanceFormula("'Other'!E2+C3", opts), "");
  assert.equal(classifyBalanceFormula("SUM(E2:E3)", opts), "");
});

test("the batch CSV path does not read formulas", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /balanceRunsFromSheet\(wb\.Sheets\[name\], sp, rows\)/);
  const start = html.indexOf("function bpBatchPrepareSheet");
  const end = html.indexOf("function bpBatchFinishDetect", start);
  assert.ok(start > -1 && end > start);
  assert.equal(html.slice(start, end).includes("balanceRunsFromSheet"), false);
});
