// The import inbox's promise: a column that moves, a spelling that changes, an
// unknown extra column or a CSV/XLSX pair must all read the same rows, and a
// required column that disappears must refuse the file by name. These are the
// synthetic variants each family is driven through; a real export is a fifth
// shape the family's own test file already holds.

import test from "node:test";
import assert from "node:assert/strict";
import { parseZerodhaHoldings } from "./zerodha.js";
import { detectImportFile } from "./import-flow.js";
import { parseTradebook, parseTradebookMatrix } from "./import-flow.js";
import { parsePortfolioReport, parseInvestmentReport,
  parseTransactionReport } from "./digifinn-reports.js";
import { parsePayouts } from "./digifinn.js";
import { parseMotilalPages } from "./motilal.js";
import { parseHoldingsMatrix } from "./holding-import.js";
import { parseStatement, rowsFromCsv } from "./parse.js";

const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// A variant of a matrix: columns in a new order, one header spelling changed,
// or an unknown column added. Every variant keeps the same rows underneath.
const permute = (rows, order) => rows.map((row) => order.map((i) => row[i] ?? ""));
const rename = (rows, from, to) => rows.map((row) => row.map((cell) =>
  text(cell) === from ? to : cell));
const extra = (rows, name, value) => rows.map((row, index) =>
  index === 0 ? [...row, name] : [...row, value]);
const csv = (rows) => rows.map((row) => row.map((cell) => {
  const s = String(cell ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\n");

// --- Zerodha holdings -------------------------------------------------------

const HOLDINGS = [
  ["Client ID", "TEST500"],
  ["Equity Holdings Statement as on 2026-11-12"],
  ["Symbol", "ISIN", "Sector", "Quantity Available", "Average Price",
    "Previous Closing Price", "Unrealized P&L"],
  ["TESTPOWER", "INE000000028", "ENERGY", 70, 191.2386, 208, 1173.3],
  ["TESTGAS", "INE000000026", "ENERGY", 80, 590.9125, 582.7, -657],
];

test("zerodha holdings: reordered, renamed, extra column and CSV/XLSX agree", () => {
  const base = parseZerodhaHoldings(HOLDINGS, { file: "kite.xlsx", sheet: "Equity" });
  assert.equal(base.error, null);
  const order = [7, 5, 3, 1, 0, 2, 6, 4];
  const variants = {
    reordered: parseZerodhaHoldings(permute(HOLDINGS, order)),
    renamed: parseZerodhaHoldings(rename(rename(HOLDINGS,
      "Quantity Available", "Qty"), "Average Price", "Avg Price")),
    extra: parseZerodhaHoldings(extra(HOLDINGS, "Notes", "ignored")),
    csv: parseZerodhaHoldings(rowsFromCsv(csv(HOLDINGS))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same holdings`);
    assert.equal(parsed.asOf, "2026-11-12", `${name} reads the snapshot date`);
  }
});

test("zerodha holdings: a renamed header reaches the alias, a removed one refuses", () => {
  const alias = parseZerodhaHoldings(rename(HOLDINGS, "Average Price", "Average Cost"));
  assert.equal(alias.error, null);
  assert.equal(alias.rows.length, 2);

  const broken = parseZerodhaHoldings(rename(HOLDINGS, "Average Price", "Cost Basis"),
    { file: "kite.xlsx", sheet: "Equity" });
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /kite\.xlsx → Equity/);
  assert.match(broken.error, /Average Price/);
  assert.match(broken.error, /row 3/);
});

test("zerodha holdings: an unreadable quantity refuses the file by row and column", () => {
  const rows = HOLDINGS.map((row) => [...row]);
  rows[3][3] = "7O";
  const parsed = parseZerodhaHoldings(rows, { file: "kite.xlsx", sheet: "Equity" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /kite\.xlsx → Equity, row 4/);
  assert.match(parsed.error, /"Quantity Available" is not a number \("7O"\)/);
});

test("a Kite workbook whose quantity column says Qty is still a holdings export", () => {
  // The reported failure: the workbook was rejected as "not a Zerodha holdings
  // export" because detection demanded the literal "Quantity Available".
  const workbook = [["Symbol", "ISIN", "Qty", "Avg Price", "LTP"],
    ["TESTPOWER", "INE000000028", 70, 191.24, 208]];
  assert.equal(detectImportFile({ name: "holdings.xlsx", matrix: workbook }).kind,
    "zerodha-holdings");
  const parsed = parseZerodhaHoldings(workbook, { file: "holdings.xlsx", sheet: "Sheet1" });
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows[0].quantity, 70);
  assert.equal(parsed.rows[0].averagePrice, 191.24);
});

// --- Zerodha tradebook ------------------------------------------------------

const TRADEBOOK = [
  ["symbol", "isin", "trade_date", "trade_type", "quantity", "price"],
  ["TESTSTOCK", "INE000000010", "2025-11-13", "buy", 5, 3811.5],
  ["TESTSTOCK", "INE000000010", "2025-11-14", "buy", 4, 3900],
  ["TESTSTOCK", "INE000000010", "2025-11-15", "sell", 2, 4000],
];

test("tradebook: reordered, renamed, extra column and CSV/XLSX agree", () => {
  const base = parseTradebookMatrix(TRADEBOOK, { file: "tradebook.xlsx" });
  assert.equal(base.error, null);
  const order = [5, 3, 1, 0, 4, 2];
  const variants = {
    reordered: parseTradebookMatrix(permute(TRADEBOOK, order)),
    renamed: parseTradebookMatrix(rename(rename(rename(rename(TRADEBOOK,
      "trade_date", "Date"), "trade_type", "Type"), "quantity", "Qty"),
      "price", "Trade Price")),
    extra: parseTradebookMatrix(extra(TRADEBOOK, "order_id", "X1")),
    csv: parseTradebook(csv(TRADEBOOK), { file: "tradebook.csv" }),
  };
  const expected = base.rows;
  assert.equal(expected.length, 3);
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, expected, `${name} reads the same trades`);
    assert.deepEqual(parsed.firstBuyByIsin, { INE000000010: "2025-11-13" }, name);
  }
});

test("tradebook: an alias spelling reads, a removed price column refuses", () => {
  const alias = parseTradebookMatrix(rename(TRADEBOOK, "price", "Execution Price"));
  assert.equal(alias.error, null);
  assert.equal(alias.rows[0].pricePaise, 381150);

  const broken = parseTradebookMatrix(rename(TRADEBOOK, "price", "Consideration"),
    { file: "tradebook.xlsx", sheet: "Tradebook" });
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /tradebook\.xlsx → Tradebook/);
  assert.match(broken.error, /Price/);
});

test("tradebook: an unreadable trade type or price refuses instead of dropping the row", () => {
  const badType = TRADEBOOK.map((row) => [...row]);
  badType[1][3] = "gift";
  const one = parseTradebookMatrix(badType, { file: "tradebook.xlsx" });
  assert.equal(one.rows.length, 0);
  assert.match(one.error, /row 2: "Trade Type" is "gift"/);

  const badPrice = TRADEBOOK.map((row) => [...row]);
  badPrice[2][5] = "3,9OO";
  const two = parseTradebookMatrix(badPrice, { file: "tradebook.xlsx" });
  assert.equal(two.rows.length, 0);
  assert.match(two.error, /row 3/);
  assert.match(two.error, /"Price" is not a number \("3,9OO"\)/);
});

// --- DigiFInn ---------------------------------------------------------------

const PORTFOLIO = [
  ["DIGIFINN - HOLDINGS REPORT"],
  ["Demat Account No.", "1200000000000000"],
  ["As Of", "26 Oct 2026"],
  ["ISIN", "Bond Name", "Purchase date", "Qty", "Investment Value (₹)"],
  ["INE000000001", "9.00% TEST BOND 31 Dec 2026", "23-Oct-2026", 10, 10000],
  ["INE000000002", "9.50% TEST BOND 31 Dec 2027", "01-Apr-2023", 20, 20000],
];

test("digifinn portfolio: reordered, renamed, extra column and CSV round-trip agree", () => {
  const body = csv(PORTFOLIO);
  const base = parsePortfolioReport(body, "holdings.csv");
  assert.equal(base.error, null);
  const order = [4, 0, 3, 1, 2];
  const variants = {
    reordered: parsePortfolioReport(csv(permute(PORTFOLIO, order))),
    renamed: parsePortfolioReport(csv(rename(rename(PORTFOLIO,
      "Qty", "Quantity"), "Investment Value (₹)", "Invested Amount"))),
    extra: parsePortfolioReport(csv(extra(PORTFOLIO, "Notes", "ignored"))),
    csv: parsePortfolioReport(csv(rowsFromCsv(csv(PORTFOLIO)))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same bonds`);
    assert.equal(parsed.demat, "1200000000000000", name);
  }
});

test("digifinn portfolio: a renamed qty column reads, a removed one refuses", () => {
  const alias = parsePortfolioReport(csv(rename(PORTFOLIO, "Qty", "Units")));
  assert.equal(alias.error, null);
  assert.equal(alias.rows[0].quantity, 10);

  const broken = parsePortfolioReport(csv(rename(PORTFOLIO, "Qty", "Holding")),
    "holdings.csv");
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /holdings\.csv → Portfolio Report/);
  assert.match(broken.error, /"Qty"/);
});

const INVESTMENT = [
  ["Investment Report"],
  ["Bond Name", "Issuer", "Coupon", "Maturity Date", "Purchase Date", "Yield",
    "Invested Amount"],
  ["9.00% TEST BOND", "TEST ISSUER", "9.00%", "12/31/26", "10/23/26", 9.5, 10000],
];

test("digifinn investment: reordered, renamed, extra column and CSV round-trip agree", () => {
  const base = parseInvestmentReport(csv(INVESTMENT));
  assert.equal(base.error, null);
  const order = [6, 3, 0, 5, 2, 1, 4];
  const variants = {
    reordered: parseInvestmentReport(csv(permute(INVESTMENT, order))),
    renamed: parseInvestmentReport(csv(rename(rename(INVESTMENT,
      "Coupon", "Coupon Rate"), "Yield", "YTM"))),
    extra: parseInvestmentReport(csv(extra(INVESTMENT, "Notes", "ignored"))),
    csv: parseInvestmentReport(csv(rowsFromCsv(csv(INVESTMENT)))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same terms`);
  }
});

test("digifinn investment: a removed issuer column refuses by name", () => {
  const broken = parseInvestmentReport(csv(rename(INVESTMENT, "Issuer", "Company")),
    "investment.csv");
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /investment\.csv → Investment Report/);
  assert.match(broken.error, /"Issuer"/);
});

const TRANSACTIONS = [
  ["Date", "ISIN", "Bond Name", "Transaction Type", "Quantity (Units)",
    "Price / Unit (INR)", "Total Value (INR)", "Face Value (INR)", "Coupon Rate (%)",
    "Maturity Date"],
  ["01/09/2026", "INE000000001", "9.00% TEST BOND", "BUY", 2, 1000, 2000, 2000, 9,
    "31/12/2030"],
];

test("digifinn transactions: reordered, renamed, extra column and CSV round-trip agree", () => {
  const base = parseTransactionReport(csv(TRANSACTIONS));
  assert.equal(base.error, null);
  const order = [9, 4, 1, 6, 0, 3, 8, 2, 7, 5];
  const variants = {
    reordered: parseTransactionReport(csv(permute(TRANSACTIONS, order))),
    renamed: parseTransactionReport(csv(rename(rename(TRANSACTIONS,
      "Quantity (Units)", "Units"), "Total Value (INR)", "Value"))),
    extra: parseTransactionReport(csv(extra(TRANSACTIONS, "Order ID", "X1"))),
    csv: parseTransactionReport(csv(rowsFromCsv(csv(TRANSACTIONS)))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same trade`);
  }
});

test("digifinn transactions: a removed transaction type refuses by name", () => {
  const broken = parseTransactionReport(csv(rename(TRANSACTIONS,
    "Transaction Type", "Kind")), "transactions.csv");
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /transactions\.csv → Transactions Report/);
  assert.match(broken.error, /"Transaction Type"/);
});

const PAYOUTS = [
  ["Date", "Issuer", "ISIN", "Amount", "Frequency", "Units"],
  ["2026-11-30", "TEST ISSUER", "INE000000001", "1,000.00", "Quarterly Payout", 2],
];

test("digifinn payouts: reordered, renamed and an extra column agree", () => {
  const base = parsePayouts(csv(PAYOUTS));
  assert.equal(base.error, null);
  const order = [5, 1, 0, 3, 2, 4];
  const variants = {
    reordered: parsePayouts(csv(permute(PAYOUTS, order))),
    renamed: parsePayouts(csv(rename(rename(PAYOUTS,
      "Units", "Quantity"), "Amount", "Payout Amount"))),
    extra: parsePayouts(csv(extra(PAYOUTS, "Notes", "ignored"))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, null, name);
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same payout`);
  }
});

test("digifinn payouts: a removed units column refuses by name", () => {
  const broken = parsePayouts(csv(rename(PAYOUTS, "Units", "Holding")), "payouts.csv");
  assert.equal(broken.rows.length, 0);
  assert.match(broken.error, /payouts\.csv → Upcoming Payouts/);
  assert.match(broken.error, /"Units"/);
});

// --- Motilal portfolio holding summary -------------------------------------

const item = (str, x, y, width) => ({ str, x, y, width });
const page = (items) => ({ items });

function bondsPage({ qty = "Qty", noNumbers = false, extraColumn = false } = {}) {
  const qtyLabel = noNumbers ? "Analyst" : qty;
  return page([
    item("BONDS", 57, 800, 38),
    item("Category", 62, 766, 30),
    item("ISIN", 120, 766, 14),
    item("Instrument", 180, 766, 36),
    item(qtyLabel, 417, 766, qtyLabel.length * 5),
    item(noNumbers ? "Score" : "Investment", 440, 771, 37),
    item(noNumbers ? "Points" : "Amount", 485, 771, 26),
    item("Maturity", 664, 771, 29),
    item("Date", 664, 757, 16),
    ...(extraColumn ? [item("Analyst", 540, 766, 30), item("ignored", 540, 738, 30)] : []),
    item("DEBTR", 244, 743, 23),
    item("TESTD-11.90%-3-12-2026", 163, 742, 69),
    item("INE000000023", 102, 738, 50),
    item("11.9000", 277, 738, 27),
    item("10", 417, 738, 8),
    item("1,00,000.00", 440, 738, 38),
    item("2026-12-03", 664, 738, 50),
    item("Total", 57, 700, 24),
    item("1,00,000.00", 440, 700, 38),
  ]);
}

test("motilal: a renamed quantity header, an extra column and item order agree", () => {
  const base = parseMotilalPages([bondsPage()]);
  assert.equal(base.error, null);
  const alias = parseMotilalPages([bondsPage({ qty: "Units" })]);
  assert.equal(alias.error, null);
  const extraColumn = parseMotilalPages([bondsPage({ extraColumn: true })]);
  assert.equal(extraColumn.error, null);
  // The PDF's items arrive in whatever order the extractor emits. Shuffling the
  // array is the analogue of a reordered column list: geometry decides.
  const shuffled = bondsPage().items.slice().reverse();
  const reordered = parseMotilalPages([page(shuffled)]);
  for (const [name, parsed] of Object.entries({ alias, extraColumn, reordered })) {
    assert.deepEqual(parsed.rows, base.rows, name);
  }
});

test("motilal: a header with neither quantity nor amount refuses the section by name", () => {
  const broken = bondsPage({ noNumbers: true });
  const parsed = parseMotilalPages([broken], { file: "motilal.pdf" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /motilal\.pdf → BONDS/);
  assert.match(parsed.error, /Qty or Investment Amount/);
});

test("motilal: two numbers in one column refuse instead of fusing into a value", () => {
  // The band's numbers both land under the quantity header. Joining them would
  // read 10 and 1,00,000 as 10100000, which is a wrong holding, not a parse.
  const parsed = parseMotilalPages([page([
    item("BONDS", 57, 800, 38),
    item("ISIN", 120, 766, 14),
    item("Qty", 417, 766, 12),
    item("INE000000023", 102, 738, 50),
    item("10", 417, 738, 8),
    item("1,00,000.00", 430, 738, 38),
  ])], { file: "motilal.pdf" });
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /motilal\.pdf → BONDS/);
  assert.match(parsed.error, /Qty holds more than one number/);
});

// --- Bank statements --------------------------------------------------------

const BANK = [
  ["Date", "Narration", "Debit", "Credit", "Balance"],
  ["01/04/2026", "Salary", "", "5000.00", "5000.00"],
  ["02/04/2026", "Rent", "2000.00", "", "3000.00"],
];

test("bank statements: reordered, renamed, extra column and CSV/rows agree", () => {
  const base = parseStatement(BANK);
  assert.equal(base.error, undefined);
  const order = [4, 2, 0, 3, 1];
  const variants = {
    reordered: parseStatement(permute(BANK, order)),
    renamed: parseStatement(rename(rename(BANK, "Narration", "Description"),
      "Debit", "Withdrawal")),
    extra: parseStatement(extra(BANK, "Notes", "ignored")),
    csv: parseStatement(rowsFromCsv(csv(BANK))),
  };
  for (const [name, parsed] of Object.entries(variants)) {
    assert.deepEqual(parsed.rows, base.rows, `${name} reads the same ledger`);
    assert.equal(parsed.order, "asc", name);
  }
});

test("bank statements: a file with no money column refuses instead of importing nothing", () => {
  const parsed = parseStatement([["Date", "Narration", "Balance"],
    ["01/04/2026", "Salary", "5000.00"]]);
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /no amount column/);
});

// --- The generic holdings sheet --------------------------------------------

const GENERIC = [
  ["BondsIndia holdings as on 25 Oct 2026"],
  [],
  ["ISIN", "Security Name", "Quantity", "Buy Value", "Current Value", "Purchase Date"],
  ["INE000000029", "TEST FINANCE NCD 2029", 10, "1,00,000", "1,08,500", "12/03/2024"],
  ["INE000000027", "TEST CAPITAL NCD", 25, "2,50,000", "2,61,000", "01 Apr 2023"],
];

test("a DigiFInn transactions CSV is not taken for a Zerodha tradebook", () => {
  // Both print a date, a quantity and a price. The transactions report names a
  // "Transaction Type" and no trade term, so the more specific reader wins.
  const transactions = [
    "Date,ISIN,Bond Name,Transaction Type,Quantity (Units),Price / Unit (INR),Total Value (INR)",
    "01/09/2026,INE000000001,9.00% TEST BOND,BUY,2,1000,2000",
  ].join("\n");
  assert.equal(detectImportFile({ name: "transactions.csv", text: transactions }).kind,
    "digifinn-transactions");
});

test("a generic holdings sheet with Security Name is not taken for a DigiFInn report", () => {
  const generic = [
    "ISIN,Security Name,Quantity,Buy Value,Current Value",
    "INE000000029,TEST FINANCE NCD 2029,10,100000,108500",
  ].join("\n");
  assert.equal(detectImportFile({ name: "export.csv", text: generic }).kind, "unknown");
});

test("generic holdings: reordered, renamed, extra column and CSV agree", () => {
  const base = parseHoldingsMatrix(GENERIC);
  const order = [5, 3, 1, 4, 0, 2];
  const variants = {
    reordered: parseHoldingsMatrix(permute(GENERIC, order)),
    renamed: parseHoldingsMatrix(rename(rename(GENERIC,
      "Security Name", "Company"), "Quantity", "Units")),
    extra: parseHoldingsMatrix(extra(GENERIC, "Notes", "ignored")),
    csv: parseHoldingsMatrix(rowsFromCsv(csv(GENERIC))),
  };
  // The CSV shape has no blank preamble row, so its source_row counts one
  // lower; the holdings themselves must match.
  const holdings = (parsed) => parsed.rows.map(({ source_row, ...row }) => row);
  for (const [name, parsed] of Object.entries(variants)) {
    assert.equal(parsed.error, undefined, name);
    assert.deepEqual(holdings(parsed), holdings(base), `${name} reads the same holdings`);
  }
});

test("generic holdings: an unreadable quantity refuses by column and row", () => {
  const rows = GENERIC.map((row) => [...row]);
  rows[3][2] = "1O";
  const parsed = parseHoldingsMatrix(rows);
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.error, /holdings, row 4/);
  assert.match(parsed.error, /"Quantity" is not a number \("1O"\)/);
});
