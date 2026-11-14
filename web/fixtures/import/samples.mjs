// Synthetic import fixtures. Every name, account number, ISIN and amount here
// is invented. The real statements never enter this directory; the private
// harness in ../../import-private.test.mjs reads them from a path outside the
// repo instead.
//
// The shapes mirror the files the parsers actually receive: a CAS text layer, a
// Motilal holdings summary, a Zerodha holdings workbook, a Zerodha tradebook,
// the five DigiFInn reports and a bank statement. Keep them small; the test
// asserts counts and fields, not the contents of a statement.

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
