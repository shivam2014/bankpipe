import test from "node:test";
import assert from "node:assert/strict";
import { detectImportFile, snapshotAsOf, compareAsOf, parseTradebook,
  parseTradebookMatrix, groupBundles, accountMatches, planMerge, accountFieldState,
  normalizeAccount } from "./import-flow.js";

// Synthetic identifiers only. The real files are never committed.
const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const other = (n) => `INE${String(n).padStart(9, "0")}`;

const holding = (over = {}) => ({
  security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
  quantity: 10, cost_paise: null, value_paise: 100000, purchase_date: "",
  as_of: "2026-09-30", value_source: "CAS", source: "report", ...over,
});

const incoming = (over = {}) => ({
  kind: "broker", label: "Motilal Oswal holdings report", asOf: "2026-11-12",
  identity: { kind: "ucid", value: "6638002" }, categories: ["bond"],
  rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
    quantity: 10, valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }],
  ...over,
});

// --- detection --------------------------------------------------------------

const CAS_TEXT = "National Securities Depository Limited Consolidated Account Statement for the month of October 2026. Statement for the period from 01-Oct-2026 to 31-Oct-2026. Your Demat Account ICICI BANK LIMITED DP ID:XX000001 Client ID:73183122";
const MOTILAL_TEXT = "Motilal Oswal Financial Services Limited Portfolio Holding Summary Since Inception to 12 Nov 2026 CLIENT UCID : 6638002 BONDS ISIN Instrument Qty Investment Amount";
const DIGIFINN_PORTFOLIO = "DIGIFINN - HOLDINGS REPORT\nDemat Account No.,9999000001140907\nAs Of,26 Oct 2026\nISIN,Bond Name,Purchase date,Qty,Investment Value (₹)\nINE999900058,9.25% OPGPL 07 OCT 2029,23-Oct-2026,10,10000";
const DIGIFINN_INVESTMENT = "Investment Report\nBond Name,Issuer,Coupon,Maturity Date,Purchase Date,Yield,Invested Amount\n9.25% OPGPL,OPG POWER,9.25%,10/7/29,10/23/26,10.5,10000";
const DIGIFINN_PAYOUTS = "Date,Issuer,ISIN,Amount,Frequency,Units\n2026-10-18,10.00% PGL,INE999900116,2465.75,Monthly Payout,30";
const DIGIFINN_CASHFLOW = "Note: Cash flows are indicative estimates\nTotal FutureExpected Interest,Total Expected Principal,Total Cashflow\nISIN,Bond Name,Next Payout Date\nINE999900116,PGL,2026-10-18";
const TRADEBOOK = "symbol,isin,trade_date,exchange,trade_type,quantity,price\nSUPREMEIND,INE999900181,2025-11-13,NSE,buy,5,3811.50\nSUPREMEIND,INE999900181,2025-11-14,NSE,buy,4,3900\nSUPREMEIND,INE999900181,2025-11-15,NSE,sell,2,4000";

test("detects each supported depository and broker file from its contents", () => {
  assert.equal(detectImportFile({ name: "anything.pdf", text: CAS_TEXT }).kind, "cas");
  assert.equal(detectImportFile({ name: "statement.pdf", text: MOTILAL_TEXT }).kind, "motilal");
  assert.equal(detectImportFile({ name: "holdings-report.csv", text: DIGIFINN_PORTFOLIO }).kind,
    "digifinn-portfolio");
  assert.equal(detectImportFile({ name: "investment.csv", text: DIGIFINN_INVESTMENT }).kind,
    "digifinn-investment");
  assert.equal(detectImportFile({ name: "payouts.csv", text: DIGIFINN_PAYOUTS }).kind,
    "digifinn-payouts");
  assert.equal(detectImportFile({ name: "cashflow.csv", text: DIGIFINN_CASHFLOW }).kind,
    "digifinn-cashflow");
  assert.equal(detectImportFile({ name: "tradebook.csv", text: TRADEBOOK }).kind,
    "zerodha-tradebook");
  const holdings = [[], ["Symbol", "ISIN", "Sector", "Quantity Available", "Average Price"],
    ["SUPREMEIND", "INE999900181", "Industrials", 5, 3811.5]];
  assert.equal(detectImportFile({ name: "holdings.xlsx", matrix: holdings }).kind,
    "zerodha-holdings");
});

test("a Motilal PDF in the CAS input is recognised as Motilal, not CAS", () => {
  const detected = detectImportFile({ name: "CAS.pdf", text: MOTILAL_TEXT });
  assert.equal(detected.kind, "motilal");
  assert.equal(detected.family, "motilal");
  assert.notEqual(detected.kind, "cas");
});

test("a cashflow export that also contains a holdings table is still cashflow", () => {
  const text = `Note: Cash flows are indicative estimates
ISIN,Bond Name,Qty,Investment Value
INE999900116,PGL,30,10000
Total FutureExpected Interest,Total Expected Principal`;
  assert.equal(detectImportFile({ name: "portfolio-cashflow-future.csv", text }).kind,
    "digifinn-cashflow");
});

test("detects a bank statement and reports an unknown file honestly", () => {
  const bank = "Date,Narration,Withdrawal,Deposit,Balance\n01-11-2026,Salary,0,1000,5000";
  assert.equal(detectImportFile({ name: "statement.csv", text: bank }).kind, "bank");
  assert.equal(detectImportFile({ name: "notes.txt", text: "hello" }).confidence, "none");
});

test("the as-of date is read from the wording each report uses", () => {
  assert.equal(detectImportFile({ text: CAS_TEXT }).asOf, "2026-10-31");
  assert.equal(detectImportFile({ text: MOTILAL_TEXT }).asOf, "2026-11-12");
  assert.equal(detectImportFile({ text: DIGIFINN_PORTFOLIO }).asOf, "2026-10-26");
});

// --- dates ------------------------------------------------------------------

test("a missing date is undated, an unreadable one invalid, a future one flagged", () => {
  assert.deepEqual(snapshotAsOf("", { today: "2026-11-14" }),
    { raw: "", date: "", state: "undated", dated: false });
  assert.equal(snapshotAsOf("not a date", { today: "2026-11-14" }).state, "invalid");
  assert.equal(snapshotAsOf("2027-01-01", { today: "2026-11-14" }).state, "future");
  assert.equal(snapshotAsOf("2026-11-12", { today: "2026-11-14" }).state, "dated");
});

test("comparison says newer, older, same, and never lets undated beat dated", () => {
  assert.equal(compareAsOf("2026-11-12", "2026-09-30").relation, "newer");
  assert.equal(compareAsOf("2026-09-30", "2026-11-12").relation, "older");
  assert.equal(compareAsOf("2026-11-12", "2026-11-12").relation, "same");
  assert.equal(compareAsOf("", "2026-11-12").relation, "older");
  assert.equal(compareAsOf("2026-11-12", "").relation, "newer");
  assert.equal(compareAsOf("", "").relation, "undated");
  assert.equal(compareAsOf("bad", "2026-11-12").relation, "invalid");
});

// --- tradebook --------------------------------------------------------------

test("the tradebook supplies first buy dates and never a holding quantity", () => {
  const parsed = parseTradebook(TRADEBOOK);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.firstBuyByIsin.INE999900181, "2025-11-13");
  assert.equal(parsed.rows[2].type, "sell");
  assert.equal(parsed.rows[0].quantity, 5);
});

test("a tradebook without its header fails closed", () => {
  const parsed = parseTradebook("symbol,isin,qty\nSUPREMEIND,INE999900181,5");
  assert.match(parsed.error, /No tradebook header/);
  assert.equal(parsed.rows.length, 0);
});

test("a tradebook spreadsheet is detected from its matrix, not rejected as a holdings export", () => {
  const matrix = [
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
  const detected = detectImportFile({ matrix });
  assert.equal(detected.kind, "zerodha-tradebook");
  assert.equal(detected.confidence, "content");
  const parsed = parseTradebookMatrix(matrix);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.firstBuyByIsin.INE000000001, "2025-11-13");
  assert.equal(parsed.firstBuyBySymbol.TESTSTOCK, "2025-11-13");
  assert.equal(parsed.rows[1].type, "sell");
});

// --- account matching -------------------------------------------------------

const accountsForMatch = [
  { id: "nsdl", label: "Demat · ICICI · …3122", category: "demat",
    number: "IN99990009183122", meta: JSON.stringify({ holdings_source: "cas" }),
    holdings: [1, 2, 3, 4].map((n) => ({ security_id: isin(n) })) },
  { id: "cdsl", label: "Demat · Motilal Oswal · …0907", category: "demat",
    number: "9999000001140907", meta: JSON.stringify({ holdings_source: "cas" }),
    holdings: Array.from({ length: 16 }, (_, i) => ({ security_id: other(i + 1) })) },
  { id: "broker", label: "Demat · Motilal Oswal · 6638002", category: "demat",
    number: "", meta: JSON.stringify({ broker_only: "1", ucid: "6638002" }),
    holdings: [] },
];

test("matches by UCID, BO ID and ISIN overlap, best first", () => {
  const file = { accountKey: "6638002", accountKind: "ucid",
    rows: Array.from({ length: 17 }, (_, i) => ({ isin: other(i + 1) })) };
  const result = accountMatches(file, accountsForMatch);
  assert.equal(result.matches[0].id, "broker");
  assert.equal(result.matches[0].identityKind, "UCID");
  assert.equal(result.bestId, "broker");
  const cdsl = result.matches.find((match) => match.id === "cdsl");
  assert.equal(cdsl.hits, 16);
  assert.equal(cdsl.of, 17);
});

test("an account with no overlapping ISIN still appears when the file names it", () => {
  const file = { accountKey: "9999000001140907", accountKind: "bo", rows: [] };
  const result = accountMatches(file, accountsForMatch);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, "cdsl");
  assert.equal(result.matches[0].identityKind, "BO ID");
});

test("equal overlap without an identity match is a tie, not a silent pick", () => {
  const accounts = [
    { id: "a", label: "A", category: "demat", number: "IN99990009183122",
      holdings: [{ security_id: isin(1) }] },
    { id: "b", label: "B", category: "demat", number: "9999000001140907",
      holdings: [{ security_id: isin(1) }] },
  ];
  const result = accountMatches({ rows: [{ isin: isin(1) }] }, accounts);
  assert.equal(result.tie, true);
  assert.equal(result.bestId, "");
  assert.equal(result.matches.length, 2);
});

test("the two CAS data facts produce the expected account hits", () => {
  const nsdl = { accountKey: "IN99990009183122", accountKind: "bo",
    rows: [
      ...Array.from({ length: 4 }, (_, i) => ({ isin: isin(i + 1) })),
      ...Array.from({ length: 11 }, (_, i) => ({ isin: other(i + 10) })),
      ...Array.from({ length: 3 }, (_, i) => ({ isin: `INF${String(i).padStart(9, "0")}` })),
    ] };
  const nsdlMatch = accountMatches(nsdl, accountsForMatch);
  assert.equal(nsdlMatch.matches[0].id, "nsdl");
  assert.equal(nsdlMatch.matches[0].identityKind, "BO ID");
  assert.equal(nsdl.rows.length, 18);

  const motilal = { accountKey: "6638002", accountKind: "ucid",
    rows: Array.from({ length: 17 }, (_, i) => ({ isin: other(i + 1) })) };
  const motilalMatch = accountMatches(motilal, accountsForMatch);
  const cdsl = motilalMatch.matches.find((match) => match.id === "cdsl");
  assert.equal(cdsl.hits, 16);
  assert.equal(cdsl.of, 17);
});

test("Zerodha's 28 equities match the 13 the CAS account already holds", () => {
  const account = { id: "zerodha", label: "Demat · Zerodha · …8054",
    category: "demat", number: "9999000002398054",
    holdings: Array.from({ length: 13 }, (_, i) => ({ security_id: other(i + 1) })) };
  const file = { accountKey: "XXX002", accountKind: "client",
    rows: Array.from({ length: 28 }, (_, i) => ({ isin: other(i + 1) })) };
  const result = accountMatches(file, [account]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].hits, 13);
  assert.equal(result.matches[0].of, 28);
  assert.equal(result.bestId, "zerodha");
});

// --- bundles ----------------------------------------------------------------

const bundleFile = (kind, extra = {}) => ({
  kind, name: extra.name || `${kind}.csv`, accountKey: extra.accountKey || "",
  accountKind: extra.accountKind || "", asOf: extra.asOf || "2026-10-26",
  rows: extra.rows || [], base: extra.base,
  firstBuyByIsin: extra.firstBuyByIsin || {},
  termsByIsin: extra.termsByIsin || [], termsByLabel: extra.termsByLabel || [],
});
const DIGIFINN_FILES = () => [
  bundleFile("digifinn-portfolio", { name: "holdings-report.csv", accountKey: "9999000001140907",
    accountKind: "bo", base: true,
    rows: [{ isin: other(1), label: "9.25% OPGPL 07 OCT 2029", category: "bond",
      quantity: 10, costPaise: 1000000, purchaseDate: "2026-10-23" }] }),
  bundleFile("digifinn-investment", { name: "investment-report.csv",
    termsByLabel: [{ label: "9.25% OPGPL 07 OCT 2029", couponPct: 9.25,
      maturity: "2029-10-07", issuer: "OPG POWER", yieldPct: 10.5 }] }),
  bundleFile("digifinn-transactions", { name: "transaction-report.csv",
    firstBuyByIsin: { [other(1)]: "2026-10-23" } }),
  bundleFile("digifinn-payouts", { name: "upcoming-payouts.csv",
    termsByIsin: [{ isin: other(1), frequency: "monthly", interestDate: "2026-11-18",
      payoutPaise: 246575 }] }),
  bundleFile("digifinn-cashflow", { name: "portfolio-cashflow-future.csv", asOf: "",
    termsByIsin: [{ isin: other(1), futureInterestPaise: 500000,
      futurePrincipalPaise: 1000000 }] }),
];
const ZERODHA_FILES = () => [
  bundleFile("zerodha-holdings", { name: "holdings.xlsx", base: true,
    rows: [{ isin: other(3), label: "SUPREMEIND", category: "equity",
      quantity: 5, costPaise: 1905750 }] }),
  bundleFile("zerodha-tradebook", { name: "tradebook.csv", asOf: "",
    firstBuyByIsin: { [other(3)]: "2025-11-13" } }),
];

test("a DigiFInn set groups as one bundle and each optional file adds its facts", () => {
  const bundles = groupBundles(DIGIFINN_FILES());
  assert.equal(bundles.length, 1);
  const bundle = bundles[0];
  assert.equal(bundle.family, "digifinn");
  assert.equal(bundle.ready, true);
  assert.equal(bundle.files.length, 5);
  assert.equal(bundle.base.kind, "digifinn-portfolio");
  assert.equal(bundle.rows.length, 1);
  assert.equal(bundle.rows[0].couponPct, 9.25);
  assert.equal(bundle.rows[0].frequency, "monthly");
  assert.equal(bundle.rows[0].futurePrincipalPaise, 1000000);
  assert.equal(bundle.rows[0].purchaseDate, "2026-10-23");
  assert.equal(bundle.rows[0].quantity, 10);
  assert.equal(bundle.adds.length, 4);
});

test("the optional payout facts reach the merge plan", () => {
  const bundle = groupBundles(DIGIFINN_FILES())[0];
  const plan = planMerge({
    incoming: {
      kind: "digifinn", asOf: bundle.asOf, identity: { kind: "bo", value: "9999000001140907" },
      categories: ["bond"], rows: bundle.rows,
    },
    existing: {
      identity: { source: "cas", asOf: "2026-09-30" },
      snapshot: { source: "cas", asOf: "2026-09-30" },
      cost: { source: "", asOf: "" },
      holdings: [holding({ quantity: 10, cost_paise: null, value_paise: 100000,
        interest_date: "", payout_paise: null, frequency: "" })],
    },
    today: "2026-11-14",
  });
  const next = plan.decisions.find((decision) => decision.action === "update")?.next;
  assert.equal(next.frequency, "monthly");
  assert.equal(next.interestDate, "2026-11-18");
  assert.equal(next.payoutPaise, 246575);
  assert.equal(next.futurePrincipalPaise, 1000000);
});

test("file order does not change the bundle or its plan", () => {
  const forward = groupBundles(DIGIFINN_FILES());
  const backward = groupBundles([...DIGIFINN_FILES()].reverse());
  assert.deepEqual(
    forward.map((bundle) => [bundle.key, bundle.files.map((file) => file.kind), bundle.rows]),
    backward.map((bundle) => [bundle.key, bundle.files.map((file) => file.kind), bundle.rows]));
});

test("Zerodha holdings and its tradebook form one bundle; the tradebook fills a date", () => {
  const bundles = groupBundles(ZERODHA_FILES());
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].rows[0].purchaseDate, "2025-11-13");
  assert.equal(bundles[0].rows[0].quantity, 5);
});

test("optional files with no base warn instead of pretending to import", () => {
  const bundles = groupBundles([bundleFile("digifinn-payouts", { name: "upcoming-payouts.csv" })]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].ready, false);
  assert.match(bundles[0].warnings.join(" "), /holdings report/i);
});

// --- the merge plan ---------------------------------------------------------

const existingAccount = (over = {}) => ({
  identity: { source: "cas", asOf: "2026-09-30" },
  snapshot: { source: "cas", asOf: "2026-09-30" },
  cost: { source: "", asOf: "", manual: false },
  manualAsOf: "",
  holdings: [holding()],
  ...over,
});

function applyPlan(holdings, plan) {
  const out = new Map((holdings || []).map((row) => [String(row.security_id || row.isin).toUpperCase(), row]));
  for (const decision of plan.decisions) {
    const key = String(decision.isin || "").toUpperCase();
    if (decision.action === "add" || decision.action === "update") out.set(key, decision.next);
    if (decision.action === "history") out.set(key, decision.next);
  }
  return [...out.values()];
}

test("a newer broker report takes quantity, cost and date while the CAS keeps identity", () => {
  const plan = planMerge({
    incoming: incoming(),
    existing: existingAccount(),
    today: "2026-11-14",
  });
  assert.equal(plan.relation, "newer");
  assert.equal(plan.identityChange, null);
  assert.equal(plan.summary.updated, 1);
  assert.equal(plan.summary.ask, 0);
  const next = plan.decisions.find((decision) => decision.action === "update").next;
  assert.equal(next.quantity, 10);
  assert.equal(next.costPaise, 200000);
  assert.equal(next.purchaseDate, "2024-06-06");
  assert.equal(next.valuePaise, 100000);
});

test("a newer CAS takes quantity and value but never overwrites the broker's cost", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-11-13",
      identity: { kind: "bo", value: "IN99990009183122" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 12, valuePaise: 150000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      identity: { source: "broker", asOf: "2026-11-12" },
      snapshot: { source: "broker", asOf: "2026-11-12" },
      cost: { source: "motilal", asOf: "2026-11-12" },
      holdings: [holding({ quantity: 10, cost_paise: 200000, purchase_date: "2024-06-06",
        value_paise: 100000, as_of: "2026-11-12" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.identityChange.action, "replace");
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 12);
  assert.equal(decision.next.valuePaise, 150000);
  assert.equal(decision.next.costPaise, 200000);
  assert.equal(decision.next.purchaseDate, "2024-06-06");
});

test("an older CAS after newer broker data attaches identity only", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "9999000001140907" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "Different CAS label", category: "bond",
        quantity: 7, valuePaise: 90000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      identity: { source: "broker", asOf: "2026-11-12" },
      snapshot: { source: "broker", asOf: "2026-11-12" },
      cost: { source: "motilal", asOf: "2026-11-12" },
      holdings: [holding({ quantity: 10, value_paise: 100000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-11-12" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.identityOnly, true);
  assert.equal(plan.identityChange.action, "replace");
  assert.equal(plan.summary.added, 0);
  assert.equal(plan.summary.updated, 0);
  assert.equal(plan.summary.kept, 1);
  assert.match(plan.warnings.join(" "), /older than the broker data/i);
  const decision = plan.decisions[0];
  assert.equal(decision.next.quantity, 10);
  assert.equal(decision.next.valuePaise, 100000);
  assert.equal(decision.next.costPaise, 200000);
});

test("an older CAS adds a matured row as history so file order does not lose it", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "9999000001140907" }, categories: ["bond"],
      rows: [
        { isin: isin(1), category: "bond", quantity: 10, valuePaise: 100000,
          costPaise: null },
        { isin: isin(2), label: "7.00% MATURE BOND 31 Aug 2026", category: "bond",
          quantity: 5, valuePaise: 50000, costPaise: null },
      ],
    },
    existing: existingAccount({
      identity: { source: "broker", asOf: "2026-11-12" },
      snapshot: { source: "broker", asOf: "2026-11-12" },
      cost: { source: "motilal", asOf: "2026-11-12" },
      holdings: [holding({ quantity: 10, value_paise: 100000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-11-12" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.identityOnly, true);
  assert.equal(plan.summary.history, 1);
  assert.equal(plan.summary.added, 0);
  const history = plan.decisions.find((decision) => decision.action === "history");
  assert.equal(history.isin, isin(2));
  assert.equal(history.next.quantity, 0);
  assert.equal(history.next.valuePaise, 0);
  const rows = applyPlan([holding({ quantity: 10, value_paise: 100000,
    cost_paise: 200000, purchase_date: "2024-06-06", as_of: "2026-11-12" })], plan);
  const matured = rows.find((row) =>
    String(row.security_id || row.isin).toUpperCase() === isin(2));
  assert.equal(matured.quantity, 0);
  assert.equal(matured.valuePaise, 0);
});

test("an older CAS fills a broker row's empty value but not its quantity or cost", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "9999000001140907" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "Different CAS label", category: "bond",
        quantity: 7, valuePaise: 90000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      identity: { source: "broker", asOf: "2026-11-12" },
      snapshot: { source: "broker", asOf: "2026-11-12" },
      cost: { source: "motilal", asOf: "2026-11-12" },
      holdings: [holding({ quantity: 10, value_paise: null, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-11-12" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.identityOnly, true);
  assert.equal(plan.summary.updated, 1);
  const decision = plan.decisions[0];
  assert.equal(decision.next.quantity, 10);
  assert.equal(decision.next.valuePaise, 90000);
  assert.equal(decision.next.costPaise, 200000);
});

test("manual cost is never overwritten silently", () => {
  const plan = planMerge({
    incoming: incoming(),
    existing: existingAccount({
      cost: { source: "manual", asOf: "2026-10-01", manual: true },
      holdings: [holding({ cost_paise: 150000, purchase_date: "2024-01-01" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.ask, 1);
  const decision = plan.decisions[0];
  assert.equal(decision.action, "ask");
  assert.equal(decision.changes.some((change) => change.requiresConfirm), true);
});

test("a newer manual cost wins, an older manual change asks", () => {
  const newer = planMerge({
    incoming: incoming({ manual: { asOf: "2026-11-13" } }),
    existing: existingAccount({
      cost: { source: "digifinn", asOf: "2026-11-01" },
      holdings: [holding({ cost_paise: 150000, purchase_date: "2024-01-01" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(newer.summary.ask, 0);
  assert.equal(newer.decisions[0].next.costPaise, 200000);

  const older = planMerge({
    incoming: incoming({ manual: { asOf: "2026-10-01" } }),
    existing: existingAccount({
      cost: { source: "digifinn", asOf: "2026-11-01" },
      holdings: [holding({ cost_paise: 150000, purchase_date: "2024-01-01" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(older.summary.ask, 1);
});

test("a CAS never replaces a manual cost without confirmation", () => {
  const newerCas = planMerge({
    incoming: {
      kind: "cas", asOf: "2026-11-13", identity: { kind: "bo", value: "IN99990009183122" },
      categories: ["bond"],
      rows: [{ isin: isin(1), category: "bond", quantity: 10, valuePaise: 120000,
        costPaise: 300000 }],
    },
    existing: existingAccount({
      identity: { source: "manual", asOf: "2026-09-01" },
      snapshot: { source: "manual", asOf: "2026-09-01" },
      cost: { source: "manual", asOf: "2026-09-01", manual: true },
      holdings: [holding({ cost_paise: 150000, purchase_date: "2024-01-01",
        as_of: "2026-09-01" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(newerCas.summary.ask, 1);

  const olderCas = planMerge({
    incoming: {
      kind: "cas", asOf: "2026-08-01", identity: { kind: "bo", value: "IN99990009183122" },
      categories: ["bond"],
      rows: [{ isin: isin(1), category: "bond", quantity: 10, valuePaise: 120000,
        costPaise: null }],
    },
    existing: existingAccount({
      identity: { source: "manual", asOf: "2026-11-13" },
      snapshot: { source: "manual", asOf: "2026-11-13" },
      cost: { source: "manual", asOf: "2026-11-13", manual: true },
      holdings: [holding({ cost_paise: 150000, purchase_date: "2024-01-01",
        as_of: "2026-11-13" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(olderCas.identityOnly, true);
  assert.equal(olderCas.decisions[0].next.costPaise, 150000);
});

test("equal dates ask instead of picking a winner", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-12", rows: [{ isin: isin(1), category: "bond",
      quantity: 12, valuePaise: null, costPaise: 250000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      snapshot: { source: "broker", asOf: "2026-11-12" },
      holdings: [holding({ quantity: 10, as_of: "2026-11-12" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.sameDate, true);
  assert.equal(plan.summary.ask, 1);
  assert.equal(plan.decisions[0].action, "ask");
  assert.match(plan.warnings.join(" "), /same date/i);
});

test("an undated report fills an empty cost but cannot overwrite dated quantities", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "", rows: [{ isin: isin(1), category: "bond",
      quantity: 12, valuePaise: 200000, costPaise: 300000, purchaseDate: "2024-06-06" },
      { isin: other(9), category: "bond", quantity: 1, costPaise: 10000 }] }),
    existing: existingAccount(),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.added, 0);
  assert.equal(plan.summary.skipped, 1);
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 10);
  assert.equal(decision.next.valuePaise, 100000);
  assert.equal(decision.next.costPaise, 300000);
  assert.match(plan.warnings.join(" "), /no date/i);
});

test("a future date is flagged and changes nothing", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "2027-01-01" }),
    existing: existingAccount(),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.updated, 0);
  assert.equal(plan.summary.kept, 1);
  assert.equal(plan.blocking, true);
  assert.match(plan.warnings.join(" "), /future/i);
});

test("rows absent from a newer report are flagged, matured bonds become history", () => {
  const plan = planMerge({
    incoming: incoming({ rows: [{ isin: isin(1), category: "bond", quantity: 10,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      holdings: [
        holding({ security_id: isin(1), as_of: "2026-09-30" }),
        holding({ security_id: isin(2), label: "8.00% LIVE BOND 31 Dec 2027",
          value_paise: 50000, as_of: "2026-09-30" }),
        holding({ security_id: isin(3), label: "7.00% MATURE BOND 31 Aug 2026",
          value_paise: 50000, as_of: "2026-09-30" }),
      ],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.history, 1);
  assert.equal(plan.summary.added, 0);
  assert.equal(plan.absent.length, 1);
  assert.equal(plan.absent[0].isin, isin(2));
  const history = plan.decisions.find((decision) => decision.action === "history");
  assert.equal(history.isin, isin(3));
  assert.equal(history.next.quantity, 0);
  assert.equal(history.next.valuePaise, 0);
});

test("a manual-only row stays and is never treated as missing", () => {
  const plan = planMerge({
    incoming: incoming({ rows: [] }),
    existing: existingAccount({
      holdings: [holding({ security_id: isin(7), source: "manual", label: "Manual bond" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.manualOnly, 1);
  assert.equal(plan.absent[0].action, "manual");
  assert.equal(plan.decisions.length, 0);
});

test("a broker-only account is created from a file with no CAS identity", () => {
  const plan = planMerge({
    incoming: incoming({ identity: { kind: "ucid", value: "6638002" } }),
    existing: { identity: { source: "", asOf: "" }, snapshot: { source: "", asOf: "" },
      cost: { source: "", asOf: "" }, holdings: [] },
    today: "2026-11-14",
  });
  assert.equal(plan.identityChange.action, "attach");
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.ask, 0);
  assert.equal(plan.decisions[0].next.costPaise, 200000);
});

test("the 17-row Motilal report adds one new bond, matches 16 and keeps 4 matured", () => {
  const existingRows = [
    ...Array.from({ length: 16 }, (_, i) => holding({ security_id: other(i + 1),
      as_of: "2026-09-30" })),
    ...Array.from({ length: 4 }, (_, i) => holding({ security_id: other(i + 20),
      label: `7.00% MATURED ${i + 1} 31 Aug 2026`, as_of: "2026-09-30" })),
  ];
  const rows = Array.from({ length: 17 }, (_, i) => ({
    isin: other(i + 1), label: "9.00% BOND 31 Dec 2027", category: "bond",
    quantity: 10, costPaise: 200000, purchaseDate: "2024-06-06",
  }));
  const plan = planMerge({
    incoming: incoming({ rows, asOf: "2026-11-12" }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-09-30" },
      holdings: existingRows,
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.updated, 16);
  assert.equal(plan.summary.history, 4);
  assert.equal(plan.summary.flagged, 0);
});

test("importing the same two dated files in either order converges on one row", () => {
  const cas = {
    kind: "cas", label: "CAS", asOf: "2026-09-30",
    identity: { kind: "bo", value: "IN99990009183122" }, categories: ["bond"],
    rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
      quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "" }],
  };
  const broker = incoming({ asOf: "2026-11-12", identity: { kind: "ucid", value: "6638002" } });
  const empty = { identity: { source: "", asOf: "" }, snapshot: { source: "", asOf: "" },
    cost: { source: "", asOf: "" }, holdings: [] };

  const casFirst = planMerge({ incoming: cas, existing: empty, today: "2026-11-14" });
  let rows = applyPlan([], casFirst);
  const brokerSecond = planMerge({
    incoming: broker,
    existing: { ...empty, snapshot: { source: "cas", asOf: "2026-09-30" },
      identity: { source: "cas", asOf: "2026-09-30" }, holdings: rows },
    today: "2026-11-14",
  });
  rows = applyPlan(rows, brokerSecond);

  const brokerFirst = planMerge({ incoming: broker, existing: empty, today: "2026-11-14" });
  let otherRows = applyPlan([], brokerFirst);
  const casSecond = planMerge({
    incoming: cas,
    existing: { ...empty, snapshot: { source: "motilal", asOf: "2026-11-12" },
      identity: { source: "broker", asOf: "2026-11-12" },
      cost: { source: "motilal", asOf: "2026-11-12" }, holdings: otherRows },
    today: "2026-11-14",
  });
  otherRows = applyPlan(otherRows, casSecond);

  const pick = (list) => {
    const row = list.find((item) => String(item.security_id || item.isin).toUpperCase() === isin(1));
    return { quantity: row.quantity, valuePaise: row.valuePaise, costPaise: row.costPaise,
      purchaseDate: row.purchaseDate };
  };
  assert.deepEqual(pick(rows), pick(otherRows));
  assert.deepEqual(pick(rows), { quantity: 10, valuePaise: 100000, costPaise: 200000,
    purchaseDate: "2024-06-06" });
});

test("the account field state names the source and date of each group", () => {
  const account = { number: "IN99990009183122", meta: JSON.stringify({
    holdings_source: "cas", holdings_as_of: "2026-10-31",
    broker_source: "motilal", cost_source: "Motilal Oswal Portfolio Holding Summary",
    cost_as_of: "2026-11-12", identity_source: "cas", identity_as_of: "2026-10-31",
  }) };
  const state = accountFieldState(account, []);
  assert.deepEqual(state.identity, { source: "cas", asOf: "2026-10-31" });
  assert.deepEqual(state.snapshot, { source: "cas", asOf: "2026-10-31" });
  assert.equal(state.cost.asOf, "2026-11-12");
  assert.equal(state.cost.manual, false);
});

test("a broker-only account has no CAS to reconcile against", () => {
  const account = normalizeAccount({ id: "broker", label: "Demat · Motilal Oswal · 6638002",
    category: "demat", number: "", meta: JSON.stringify({ broker_only: "1",
      ucid: "6638002" }) });
  assert.equal(account.brokerOnly, true);
  assert.equal(account.ucid, "6638002");
  assert.equal(account.boId, "");
});
