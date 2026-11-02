import { colIndex, classifyAmountHeader } from "./workbook.js";

// A formula is readable when it is a plain same-sheet expression with no
// range or quoted text. Cross-sheet references and ranges are deliberately
// unparseable: they are not evidence for this sheet's balance convention.
function refsOf(formula) {
  let text = String(formula ?? "").replace(/^=/, "").replace(/"[^"]*"/g, "");
  if (!text || text.includes("!") || text.includes(":")) return null;
  const refs = [];
  for (const match of text.matchAll(/\$?([A-Za-z]{1,3})\$?(\d+)/g)) {
    refs.push({ col: match[1].toUpperCase(), row: Number(match[2]) });
  }
  return refs.length ? refs : null;
}

// Post-entry: row i references balance row i-1 and an amount in row i.
// Opening: row i references the previous balance without this row's amount,
// or references the following row's balance.
export function classifyBalanceFormula(formula, {
  row = 0, balanceCol = "", amountCols = [],
} = {}) {
  const refs = refsOf(formula);
  if (!refs || !row || !balanceCol) return "";
  const amounts = amountCols.map((c) => String(c).toUpperCase());
  const prev = refs.some((r) => r.col === balanceCol && r.row === row - 1);
  const next = refs.some((r) => r.col === balanceCol && r.row === row + 1);
  const self = refs.some((r) => r.col === balanceCol && r.row === row);
  const sameAmount = refs.some((r) => amounts.includes(r.col) && r.row === row);
  if (self) return "";
  const post = prev && sameAmount;
  const opening = (prev && !sameAmount) || next;
  if (post === opening) return "";
  return post ? "post" : "opening";
}

// Read the raw sheet's balance formulas before the matrix is built. Returns
// "post" or "opening" only when most populated balance cells are formulas and
// every sampled formula agrees; otherwise "" for the chain fallback.
export function balanceConventionFromSheet(ws, sheet, matrix = []) {
  if (!ws || !sheet || !Array.isArray(sheet.columns)) return "";
  const headerRow = Math.max(0, (sheet.header_row || 1) - 1);
  const cols = sheet.columns.filter((c) =>
    c.role !== "ignore" && c.kind === "amount");
  if (!cols.length) return "";
  const withUse = cols.map((c) => ({
    ...c,
    use: c.use || classifyAmountHeader(matrix[headerRow]?.[colIndex(c.col)]),
  }));
  let balance = withUse.find((c) => c.use === "balance");
  if (!balance && withUse.length >= 3) balance = withUse[2];
  if (!balance) return "";
  const balanceCol = String(balance.col).toUpperCase();
  const amountCols = withUse.filter((c) => c !== balance)
    .map((c) => String(c.col).toUpperCase());

  const firstData = Math.max(1, sheet.header_row || 1);
  const populated = [];
  for (let i = firstData; i < matrix.length; i++) {
    const cell = ws[balanceCol + (i + 1)];
    if (!cell) continue;
    const hasValue = cell.v !== undefined && cell.v !== null
      && String(cell.v).trim() !== "";
    if (hasValue || cell.f) populated.push({ row: i + 1, cell });
  }
  const formulas = populated.filter((x) => x.cell.f);
  if (!formulas.length || formulas.length <= populated.length / 2) return "";

  const sample = formulas.length > 2 ? formulas.slice(1, -1) : formulas;
  const verdicts = sample.map((x) => classifyBalanceFormula(x.cell.f, {
    row: x.row, balanceCol, amountCols,
  }));
  if (!verdicts.length || verdicts.some((v) => !v)) return "";
  return verdicts.every((v) => v === verdicts[0]) ? verdicts[0] : "";
}
