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

// Walk every data row in the balance column, group contiguous rows by whether
// the cell carries a formula, and classify each formula run on its own. Value
// runs stay evidence-free for the chain fallback. A formula run whose formulas
// disagree (or cannot be read) is evidence-free too, with `mixed`/`unreadable`
// set so the receipt can say so instead of quietly taking a majority.
export function balanceRunsFromSheet(ws, sheet, matrix = []) {
  if (!ws || !sheet || !Array.isArray(sheet.columns)) return [];
  const headerRow = Math.max(0, (sheet.header_row || 1) - 1);
  const cols = sheet.columns.filter((c) =>
    c.role !== "ignore" && c.kind === "amount");
  if (!cols.length) return [];
  const withUse = cols.map((c) => ({
    ...c,
    use: c.use || classifyAmountHeader(matrix[headerRow]?.[colIndex(c.col)]),
  }));
  let balance = withUse.find((c) => c.use === "balance");
  if (!balance && withUse.length >= 3) balance = withUse[2];
  if (!balance) return [];
  const balanceCol = String(balance.col).toUpperCase();
  const amountCols = withUse.filter((c) => c !== balance)
    .map((c) => String(c.col).toUpperCase());

  const firstData = Math.max(1, sheet.header_row || 1);
  const runs = [];
  for (let i = firstData; i < matrix.length; i++) {
    const row = i + 1;
    const cell = ws[balanceCol + row];
    const formula = !!(cell && cell.f);
    const last = runs[runs.length - 1];
    if (last && last.formula === formula) last.to = row;
    else runs.push({ from: row, to: row, formula, convention: "",
      mixed: false, unreadable: false });
  }

  for (const run of runs) {
    if (!run.formula) continue;
    const verdicts = [];
    for (let row = run.from; row <= run.to; row++) {
      const cell = ws[balanceCol + row];
      if (!cell || !cell.f) continue;
      verdicts.push(classifyBalanceFormula(cell.f, {
        row, balanceCol, amountCols,
      }));
    }
    if (!verdicts.length) {
      run.formula = false;
      continue;
    }
    if (verdicts.some((v) => !v)) {
      run.unreadable = true;
      continue;
    }
    if (verdicts.some((v) => v !== verdicts[0])) {
      run.mixed = true;
      continue;
    }
    run.convention = verdicts[0];
  }
  return runs;
}
