// Synthetic import fixtures. Every name, account number, ISIN and amount here
// is invented. The real statements never enter this directory; the private
// harness in ../../import-private.test.mjs reads them from a path outside the
// repo instead.
//
// The shapes mirror the files the parsers actually receive: a CAS text layer, a
// Motilal holdings summary, a Zerodha holdings workbook, Kite Console's
// three-sheet export, a Zerodha tradebook, the five DigiFInn reports and a bank
// statement. Keep them small; the test asserts counts and fields, not the
// contents of a statement.

export const CAS_TEXT = [
  "Central Depository Services (India) Limited",
  "CONSOLIDATED ACCOUNT STATEMENT (CAS) FOR SECURITIES HELD IN DEMAT",
  "Statement for the period from 01-09-2026 to 30-09-2026",
  "Name: TEST HOLDER",
  "Demat Account: IN99990003000000",
].join("\n");

export const MOTILAL_TEXT = [
  "Motilal Oswal Financial Services Limited",
  "Portfolio Holding Summary",
  "Since Inception to 12 Nov 2026",
  "CLIENT UCID : TEST0001",
  "BONDS",
  "ISIN Instrument Qty Investment Amount",
  "INE000000001 9.00% TEST BOND 31 Dec 2026 10 10000",
].join("\n");

export const BANK_TEXT = [
  "Date,Description,Debit,Credit,Balance",
  "01/10/2026,OPENING BALANCE,,,100000.00",
  "02/10/2026,TEST PAYMENT,1000.00,,99000.00",
].join("\n");

export const UNKNOWN_TEXT = "This is not a statement.\nNothing to import.";

export const ZERODHA_TRADEBOOK_MATRIX = [
  ["Client ID", "TEST500"],
  ["Tradebook for Equity from 2025-11-13 to 2026-11-12"],
  ["Symbol", "ISIN", "Trade Date", "Exchange", "Segment", "Series",
    "Trade Type", "Auction", "Quantity", "Price", "Trade ID", "Order ID",
    "Order Execution Time"],
  ["TESTSTOCK", "INE000000001", "2025-11-13", "NSE", "EQ", "EQ",
    "buy", false, 5, 100.5, "T1", "O1", "2025-11-13T09:51:25"],
  ["TESTSTOCK", "INE000000001", "2025-11-14", "NSE", "EQ", "EQ",
    "sell", false, 2, 110, "T2", "O2", "2025-11-14T09:51:25"],
];

export const ZERODHA_HOLDINGS_MATRIX = [
  ["Client ID", "TEST500"],
  ["Holdings statement as on 2026-11-12"],
  ["Symbol", "ISIN", "Sector", "Quantity Available", "Average Price",
    "Previous Closing Price", "Unrealized P&L"],
  ["TESTSTOCK", "INE000000001", "Test", 5, 100.5, 110, 47.5],
  ["TESTFUND", "INF000000001", "Test", 10, 20, 21, 10],
];

// ICICI Direct's holdings export. The header is the live shape; the rows are
// synthetic. The ISINs carry security types 01 (equity), 07, 08 and 09 (debt).
export const ICICI_HOLDINGS_MATRIX = [
  ["Stock Name", "Stock", "ISIN", "Allocated Quantity", "Blocked for Trade",
    "Block For Margin", "Current Market Price", "% Change", "Market Value",
    "Mandate Quantity"],
  ["TEST EQUITY ONE", "TEONE", "INE000001010", 3, 0, 0, 101.25, 1.25, 303.75, 0],
  ["9.00% TEST BOND 2030", "TESTBOND1", "INE000007020", 10, 0, 0, 1001, 0, 10010, 0],
  ["8.50% TEST BOND 2031", "", "INE000008030", 5, 0, 0, 1000, 0, 5000, 0],
  ["7.25% TEST BOND 2032", "TESTBOND3", "INE000009040", 2, 0, 0, 1000, 0, 2000, 0],
];

export const ICICI_HOLDINGS_TEXT = [
  "Stock Name,Stock,ISIN,Allocated Quantity,Blocked for Trade,Block For Margin,"
    + "Current Market Price,% Change,Market Value,Mandate Quantity",
  "TEST EQUITY ONE,TEONE,INE000001010,3,0,0,101.25,1.25,303.75,0",
  "9.00% TEST BOND 2030,TESTBOND1,INE000007020,10,0,0,1001,0,10010,0",
  "8.50% TEST BOND 2031,,INE000008030,5,0,0,1000,0,5000,0",
  "7.25% TEST BOND 2032,TESTBOND3,INE000009040,2,0,0,1000,0,2000,0",
].join("\n");

// Kite Console's three-sheet export. Equity and Mutual Funds carry the same
// preamble and differ by one column (Sector versus Instrument Type). Combined
// repeats both with an extra leading column, so reading it as well would count
// every row twice. The pledged pair on the first equity is 5 + 2 units.
export const KITE_CONSOLE_SHEETS = {
  Equity: [
    ["Client ID", "TEST500"],
    ["Equity Holdings Statement as on 2026-11-12"],
    ["Summary", "Invested Value", "Present Value", "Unrealized P&L"],
    ["", 100000, 120000, 20000],
    ["Symbol", "ISIN", "Sector", "Quantity Available", "Quantity Discrepant",
      "Quantity Long Term", "Quantity Pledged (Margin)", "Quantity Pledged (Loan)",
      "Average Price", "Previous Closing Price", "Unrealized P&L",
      "Unrealized P&L Pct."],
    ["TESTPOWER", "INE000000028", "ENERGY", 70, 0, 0, 5, 2, 191.2386, 208, 1173.3, 8.7647],
    ["TESTGAS", "INE000000026", "ENERGY", 80, 0, 40, 0, 0, 590.9125, 582.7, -657, -1.3898],
    ["TESTBANK", "INE000000024", "FINANCE", 25, 0, 25, 0, 0, 400, 410, 250, 2.5],
  ],
  "Mutual Funds": [
    ["Client ID", "TEST500"],
    ["Mutual Funds Holdings Statement as on 2026-11-12"],
    ["Summary", "Invested Value", "Present Value", "Unrealized P&L"],
    ["", 3000, 3150, 150],
    ["Symbol", "ISIN", "Instrument Type", "Quantity Available", "Quantity Discrepant",
      "Quantity Pledged (Margin)", "Quantity Pledged (Loan)", "Average Price",
      "Previous Closing Price", "Unrealized P&L", "Unrealized P&L Pct."],
    ["TESTFUNDGROWTH", "INF000000031", "EQUITY", 100, 0, 0, 0, 20, 21, 100, 5],
    ["TESTFUNDDEBT", "INF000000032", "DEBT", 50, 0, 0, 0, 10, 10.2, 10, 1],
  ],
  Combined: [
    ["Asset Type", "Symbol", "ISIN", "Sector", "Quantity Available",
      "Quantity Discrepant", "Quantity Long Term", "Quantity Pledged (Margin)",
      "Quantity Pledged (Loan)", "Average Price", "Previous Closing Price",
      "Unrealized P&L", "Unrealized P&L Pct."],
    ["Equity", "TESTPOWER", "INE000000028", "ENERGY", 70, 0, 0, 5, 2, 191.2386, 208, 1173.3, 8.7647],
    ["Equity", "TESTGAS", "INE000000026", "ENERGY", 80, 0, 40, 0, 0, 590.9125, 582.7, -657, -1.3898],
    ["Equity", "TESTBANK", "INE000000024", "FINANCE", 25, 0, 25, 0, 0, 400, 410, 250, 2.5],
    ["Mutual Fund", "TESTFUNDGROWTH", "INF000000031", "EQUITY", 100, 0, 0, 0, 0, 20, 21, 100, 5],
    ["Mutual Fund", "TESTFUNDDEBT", "INF000000032", "DEBT", 50, 0, 0, 0, 0, 10, 10.2, 10, 1],
  ],
};

const DIGIFINN_HOLDINGS = [
  "DIGIFINN - HOLDINGS REPORT",
  "Demat Account No.,1200000000000000",
  "As Of,26 Oct 2026",
  "ISIN,Bond Name,Purchase date,Qty,Investment Value (₹)",
  "INE000000001,9.00% TEST BOND 31 Dec 2026,23-Oct-2026,10,10000",
].join("\n");

const DIGIFINN_INVESTMENT = [
  "Investment Report",
  "Bond Name,Issuer,Coupon,Maturity Date,Purchase Date,Yield,Invested Amount",
  "9.00% TEST BOND,TEST ISSUER,9.00%,12/31/26,10/23/26,9.5,10000",
].join("\n");

const DIGIFINN_TRANSACTIONS = [
  "Transaction Type,ISIN,Bond Name,Date,Units,Amount",
  "BUY,INE000000001,9.00% TEST BOND,23-Oct-2026,10,10000",
].join("\n");

const DIGIFINN_PAYOUTS = [
  "Date,Issuer,ISIN,Amount,Frequency,Units",
  "2026-11-18,TEST ISSUER,INE000000001,2465.75,Monthly Payout,10",
].join("\n");

const DIGIFINN_CASHFLOW = [
  "Note: Cash flows are indicative estimates",
  "Total FutureExpected Interest,Total Expected Principal,Total Cashflow",
  "ISIN,Bond Name,Next Payout Date",
  "INE000000001,TEST BOND,2026-11-18",
].join("\n");

export const DIGIFINN_FILES = [
  { name: "holdings.csv", text: DIGIFINN_HOLDINGS, kind: "digifinn-portfolio",
    accountKey: "1200000000000000", accountKind: "bo", asOf: "2026-10-26" },
  { name: "investment.csv", text: DIGIFINN_INVESTMENT, kind: "digifinn-investment" },
  { name: "transactions.csv", text: DIGIFINN_TRANSACTIONS, kind: "digifinn-transactions" },
  { name: "payouts.csv", text: DIGIFINN_PAYOUTS, kind: "digifinn-payouts" },
  { name: "cashflow.csv", text: DIGIFINN_CASHFLOW, kind: "digifinn-cashflow" },
];

// The table the regression test walks. `parse` names the parser that must
// accept the fixture; detection alone is not enough.
export const DETECTION_CASES = [
  { name: "cas.pdf", text: CAS_TEXT, kind: "cas", family: "cas",
    confidence: "content", asOf: "2026-09-30", parse: null },
  { name: "motilal.pdf", text: MOTILAL_TEXT, kind: "motilal", family: "motilal",
    confidence: "content", asOf: "2026-11-12", parse: null },
  { name: "tradebook.csv", text: null, matrix: ZERODHA_TRADEBOOK_MATRIX,
    kind: "zerodha-tradebook", family: "zerodha", confidence: "content",
    asOf: "", parse: "tradebook" },
  { name: "holdings.xlsx", text: null, matrix: ZERODHA_HOLDINGS_MATRIX,
    kind: "zerodha-holdings", family: "zerodha", confidence: "content",
    asOf: "", parse: "holdings" },
  { name: "ICICI_Holdings.csv", text: ICICI_HOLDINGS_TEXT, kind: "icici-holdings",
    family: "icici", confidence: "content", asOf: "", parse: "icici" },
  { name: "holdings.csv", text: DIGIFINN_HOLDINGS, kind: "digifinn-portfolio",
    family: "digifinn", confidence: "content", asOf: "2026-10-26", parse: null },
  { name: "investment.csv", text: DIGIFINN_INVESTMENT, kind: "digifinn-investment",
    family: "digifinn", confidence: "content", asOf: "", parse: null },
  { name: "transactions.csv", text: DIGIFINN_TRANSACTIONS, kind: "digifinn-transactions",
    family: "digifinn", confidence: "content", asOf: "", parse: null },
  { name: "payouts.csv", text: DIGIFINN_PAYOUTS, kind: "digifinn-payouts",
    family: "digifinn", confidence: "content", asOf: "", parse: null },
  { name: "cashflow.csv", text: DIGIFINN_CASHFLOW, kind: "digifinn-cashflow",
    family: "digifinn", confidence: "content", asOf: "", parse: null },
  { name: "bank.csv", text: BANK_TEXT, kind: "bank", family: "bank",
    confidence: "content", asOf: "", parse: null },
  { name: "notes.txt", text: UNKNOWN_TEXT, kind: "unknown", family: "",
    confidence: "none", asOf: "", parse: null },
];
