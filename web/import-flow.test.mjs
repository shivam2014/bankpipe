import test from "node:test";
import assert from "node:assert/strict";
import { detectImportFile, snapshotAsOf, compareAsOf, parseTradebook,
  parseTradebookMatrix, groupBundles, groupResolvedPlans, accountMatches, planMerge,
  accountFieldState, normalizeAccount, mergeRowsFromPlan, planStateAfter,
  planImportChains } from "./import-flow.js";
import { casReplacePlan } from "./cas-apply.js";

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
  identity: { kind: "ucid", value: "9990001" }, categories: ["bond"],
  rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
    quantity: 10, valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }],
  ...over,
});

// --- detection --------------------------------------------------------------

const CAS_TEXT = "National Securities Depository Limited Consolidated Account Statement for the month of October 2026. Statement for the period from 01-Oct-2026 to 31-Oct-2026. Your Demat Account ICICI BANK LIMITED DP ID:IN300000 Client ID:12344321";
const MOTILAL_TEXT = "Motilal Oswal Financial Services Limited Portfolio Holding Summary Since Inception to 12 Nov 2026 CLIENT UCID : 9990001 BONDS ISIN Instrument Qty Investment Amount";
const DIGIFINN_PORTFOLIO = "DIGIFINN - HOLDINGS REPORT\nDemat Account No.,1200000012345678\nAs Of,26 Oct 2026\nISIN,Bond Name,Purchase date,Qty,Investment Value (₹)\nINE000000011,9.25% TESTF 07 OCT 2029,23-Oct-2026,10,10000";
const DIGIFINN_INVESTMENT = "Investment Report\nBond Name,Issuer,Coupon,Maturity Date,Purchase Date,Yield,Invested Amount\n9.25% TESTF,TEST POWER,9.25%,10/7/29,10/23/26,10.5,10000";
const DIGIFINN_PAYOUTS = "Date,Issuer,ISIN,Amount,Frequency,Units\n2026-10-18,10.00% TESTA,INE000000012,2465.75,Monthly Payout,30";
const DIGIFINN_CASHFLOW = "Note: Cash flows are indicative estimates\nTotal FutureExpected Interest,Total Expected Principal,Total Cashflow\nISIN,Bond Name,Next Payout Date\nINE000000012,TESTA,2026-10-18";
const TRADEBOOK = "symbol,isin,trade_date,exchange,trade_type,quantity,price\nTESTSTOCKIND,INE000000010,2025-11-13,NSE,buy,5,3811.50\nTESTSTOCKIND,INE000000010,2025-11-14,NSE,buy,4,3900\nTESTSTOCKIND,INE000000010,2025-11-15,NSE,sell,2,4000";

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
    ["TESTSTOCKIND", "INE000000010", "Industrials", 5, 3811.5]];
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
INE000000012,TESTA,30,10000
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
  assert.equal(parsed.firstBuyByIsin.INE000000010, "2025-11-13");
  assert.equal(parsed.rows[2].type, "sell");
  assert.equal(parsed.rows[0].quantity, 5);
});

test("a tradebook without its header fails closed", () => {
  const parsed = parseTradebook("symbol,isin,qty\nTESTSTOCKIND,INE000000010,5");
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
  { id: "nsdl", label: "Demat · ICICI · …4321", category: "demat",
    number: "IN99990001344321", meta: JSON.stringify({ holdings_source: "cas" }),
    holdings: [1, 2, 3, 4].map((n) => ({ security_id: isin(n) })) },
  { id: "cdsl", label: "Demat · Motilal Oswal · …5678", category: "demat",
    number: "1200000012345678", meta: JSON.stringify({ holdings_source: "cas" }),
    holdings: Array.from({ length: 16 }, (_, i) => ({ security_id: other(i + 1) })) },
  { id: "broker", label: "Demat · Motilal Oswal · 9990001", category: "demat",
    number: "", meta: JSON.stringify({ broker_only: "1", ucid: "9990001" }),
    holdings: [] },
];

test("matches by UCID, BO ID and ISIN overlap, best first", () => {
  const file = { accountKey: "9990001", accountKind: "ucid",
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
  const file = { accountKey: "1200000012345678", accountKind: "bo", rows: [] };
  const result = accountMatches(file, accountsForMatch);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, "cdsl");
  assert.equal(result.matches[0].identityKind, "BO ID");
});

test("equal overlap without an identity match is a tie, not a silent pick", () => {
  const accounts = [
    { id: "a", label: "A", category: "demat", number: "IN99990001344321",
      holdings: [{ security_id: isin(1) }] },
    { id: "b", label: "B", category: "demat", number: "1200000012345678",
      holdings: [{ security_id: isin(1) }] },
  ];
  const result = accountMatches({ rows: [{ isin: isin(1) }] }, accounts);
  assert.equal(result.tie, true);
  assert.equal(result.bestId, "");
  assert.equal(result.matches.length, 2);
});

test("a single overlapping ISIN does not name an account to auto-attach", () => {
  const accounts = [{ id: "demat-1", label: "Demat", category: "demat",
    subtype: "equity", number: "IN99990006111111", meta: "",
    holdings: [{ security_id: isin(1), quantity: 1 }] }];
  const file = { rows: Array.from({ length: 20 }, (_, i) => ({ isin: isin(i + 1) })) };
  for (const options of [{}, { forCas: true }]) {
    const result = accountMatches(file, accounts, options);
    assert.equal(result.matches.length, 1);
    // The candidate is still listed so a person can choose it. It is not
    // evidence enough to move 500 rows into that account unasked.
    assert.equal(result.bestId, "demat-1");
    assert.equal(result.attachId, "");
  }
});

test("an 80 percent overlap names the account for both report families", () => {
  const accounts = [{ id: "demat-1", label: "Demat", category: "demat",
    subtype: "equity", number: "IN99990006111111", meta: "",
    holdings: Array.from({ length: 4 }, (_, i) => ({ security_id: isin(i + 1) })) }];
  const file = { rows: Array.from({ length: 5 }, (_, i) => ({ isin: isin(i + 1) })) };
  for (const options of [{}, { forCas: true }]) {
    assert.equal(accountMatches(file, accounts, options).attachId, "demat-1");
  }
});

test("an identity match names the account even with no overlapping ISIN", () => {
  const accounts = [{ id: "demat-1", label: "Demat", category: "demat",
    subtype: "equity", number: "IN99990006111111", meta: "",
    holdings: [] }];
  const file = { accountKey: "IN99990006111111", accountKind: "bo",
    rows: Array.from({ length: 20 }, (_, i) => ({ isin: isin(i + 1) })) };
  assert.equal(accountMatches(file, accounts).attachId, "demat-1");
});

test("the two CAS data facts produce the expected account hits", () => {
  const nsdl = { accountKey: "IN99990001344321", accountKind: "bo",
    rows: [
      ...Array.from({ length: 4 }, (_, i) => ({ isin: isin(i + 1) })),
      ...Array.from({ length: 11 }, (_, i) => ({ isin: other(i + 10) })),
      ...Array.from({ length: 3 }, (_, i) => ({ isin: `INF${String(i).padStart(9, "0")}` })),
    ] };
  const nsdlMatch = accountMatches(nsdl, accountsForMatch);
  assert.equal(nsdlMatch.matches[0].id, "nsdl");
  assert.equal(nsdlMatch.matches[0].identityKind, "BO ID");
  assert.equal(nsdl.rows.length, 18);

  const motilal = { accountKey: "9990001", accountKind: "ucid",
    rows: Array.from({ length: 17 }, (_, i) => ({ isin: other(i + 1) })) };
  const motilalMatch = accountMatches(motilal, accountsForMatch);
  const cdsl = motilalMatch.matches.find((match) => match.id === "cdsl");
  assert.equal(cdsl.hits, 16);
  assert.equal(cdsl.of, 17);
});

test("Zerodha's 28 equities match the 13 the CAS account already holds", () => {
  const account = { id: "zerodha", label: "Demat · Zerodha · …8054",
    category: "demat", number: "1200000000000001",
    holdings: Array.from({ length: 13 }, (_, i) => ({ security_id: other(i + 1) })) };
  const file = { accountKey: "TEST500", accountKind: "client",
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
  bundleFile("digifinn-portfolio", { name: "holdings-report.csv", accountKey: "1200000012345678",
    accountKind: "bo", base: true,
    rows: [{ isin: other(1), label: "9.25% TESTF 07 OCT 2029", category: "bond",
      quantity: 10, costPaise: 1000000, purchaseDate: "2026-10-23" }] }),
  bundleFile("digifinn-investment", { name: "investment-report.csv",
    termsByLabel: [{ label: "9.25% TESTF 07 OCT 2029", couponPct: 9.25,
      maturity: "2029-10-07", issuer: "TEST POWER", yieldPct: 10.5 }] }),
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
    rows: [{ isin: other(3), label: "TESTSTOCKIND", category: "equity",
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
      kind: "digifinn", asOf: bundle.asOf, identity: { kind: "bo", value: "1200000012345678" },
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

test("a newer broker that shows the pre-sale quantity asks before overwriting the sale", () => {
  const sold = holding({ quantity: 0, cost_paise: 0, value_paise: 0,
    disposed_at: "2026-08-12", disposed_quantity: 4, disposed_type: "sale",
    disposed_source: "CAS", disposed_reason: "SALE", as_of: "2026-08-12" });
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-12",
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 10, valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-08-31" },
      holdings: [holding({ quantity: 6, as_of: "2026-08-31" }), sold],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.ask, 1);
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-conflict"), true);
  const change = decision.changes.find((item) => item.field === "quantity");
  assert.equal(change.requiresConfirm, true);
  assert.equal(change.soldConflict, true);
  assert.match(decision.reason, /recorded sale/i);
  assert.equal(decision.next.quantity, 10);
  assert.equal(change.from, 6);
  assert.equal(change.to, 10);
});

test("a report that names a fully sold bond is a question, not a revival", () => {
  const sold = holding({ quantity: 0, cost_paise: 0, value_paise: 0,
    disposed_at: "2026-08-12", disposed_quantity: 10, disposed_type: "sale",
    disposed_source: "CAS", disposed_reason: "SALE", as_of: "2026-08-12" });
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-12",
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 10, valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-08-12" },
      holdings: [sold],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.ask, 1);
  const decision = plan.decisions.find((item) => item.action === "ask");
  assert.equal(decision.flags.includes("sold-conflict"), true);
  assert.match(decision.reason, /sold on 2026-08-12/);
  assert.equal(plan.decisions.some((item) => item.action === "update"), false);
});

test("a report that omits a sold bond leaves its record alone", () => {
  const sold = holding({ security_id: isin(2), quantity: 0, cost_paise: 0, value_paise: 0,
    disposed_at: "2026-08-12", disposed_quantity: 5, disposed_type: "sale",
    disposed_source: "CAS", disposed_reason: "SALE", as_of: "2026-08-12" });
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-12" }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-08-12" },
      holdings: [holding(), sold],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.decisions.some((item) => String(item.isin) === isin(2)), false);
  assert.equal(plan.absent.some((item) => String(item.isin) === isin(2)), false);
  assert.equal(plan.summary.ask, 0);
});

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
      identity: { kind: "bo", value: "IN99990001344321" }, categories: ["bond"],
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

test("an older CAS takes quantity and value while the broker keeps cost", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
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
  assert.equal(plan.relation, "older");
  assert.equal(plan.identityOnly, false);
  assert.equal(plan.identityChange.action, "replace");
  assert.equal(plan.summary.added, 0);
  assert.equal(plan.summary.updated, 1);
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 7);
  assert.equal(decision.next.valuePaise, 90000);
  assert.equal(decision.next.valueSource, "CAS");
  assert.equal(decision.next.costPaise, 200000);
  assert.equal(decision.next.purchaseDate, "2024-06-06");
  assert.equal(decision.next.asOf, "2026-09-30");
});

test("an older CAS adds a matured row as history so file order does not lose it", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
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

test("an older CAS replaces a broker row's quantity and value but not cost", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-09-30",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
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
  assert.equal(plan.relation, "older");
  assert.equal(plan.identityOnly, false);
  assert.equal(plan.summary.updated, 1);
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 7);
  assert.equal(decision.next.valuePaise, 90000);
  assert.equal(decision.next.valueSource, "CAS");
  assert.equal(decision.next.costPaise, 200000);
  assert.equal(decision.next.purchaseDate, "2024-06-06");
});

test("an older safe CAS sets quantity and value while the broker keeps cost and terms", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-10-31",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 40, valuePaise: 400000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      identity: { source: "broker", asOf: "2026-11-05" },
      snapshot: { source: "broker", asOf: "2026-11-05" },
      cost: { source: "motilal", asOf: "2026-11-05" },
      holdings: [holding({ quantity: 100, value_paise: 1000000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-11-05" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.relation, "older");
  assert.equal(plan.identityOnly, false);
  assert.equal(plan.summary.updated, 1);
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 40);
  assert.equal(decision.next.valuePaise, 400000);
  assert.equal(decision.next.costPaise, 200000);
  assert.equal(decision.next.purchaseDate, "2024-06-06");
  assert.equal(decision.next.asOf, "2026-10-31");
  const quantity = decision.changes.find((change) => change.field === "quantity");
  assert.equal(quantity.fromSource, "broker");
  assert.equal(quantity.fromAsOf, "2026-11-05");
});

test("a newer broker report asks before changing a CAS-sourced quantity", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-05", rows: [{ isin: isin(1),
      label: "9.00% TEST BOND 31 Dec 2026", category: "bond", quantity: 100,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-10-31" },
      cost: { source: "motilal", asOf: "2026-10-31" },
      holdings: [holding({ quantity: 40, value_paise: 400000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-10-31" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.relation, "newer");
  assert.equal(plan.summary.ask, 1);
  assert.equal(plan.blocking, true);
  const decision = plan.decisions.find((item) => item.action === "ask");
  const quantity = decision.changes.find((change) => change.field === "quantity");
  assert.equal(quantity.requiresConfirm, true);
  assert.equal(quantity.fromSource, "cas");
  assert.equal(quantity.fromAsOf, "2026-10-31");
  assert.equal(quantity.asOf, "2026-11-05");
});

test("a newer broker report takes a cost-only difference without asking", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-05", rows: [{ isin: isin(1),
      label: "9.00% TEST BOND 31 Dec 2026", category: "bond", quantity: 40,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-10-31" },
      cost: { source: "motilal", asOf: "2026-10-31" },
      holdings: [holding({ quantity: 40, value_paise: 400000, cost_paise: 150000,
        purchase_date: "2024-01-01", as_of: "2026-10-31" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.ask, 0);
  assert.equal(plan.blocking, false);
  const decision = plan.decisions.find((item) => item.action === "update");
  assert.equal(decision.next.quantity, 40);
  assert.equal(decision.next.valuePaise, 400000);
  assert.equal(decision.next.costPaise, 200000);
});

test("a broker report that omits a CAS bond keeps it and flags it", () => {
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-05", rows: [] }),
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-10-31" },
      cost: { source: "motilal", asOf: "2026-10-31" },
      holdings: [holding({ quantity: 40, value_paise: 400000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-10-31" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.absent.length, 1);
  assert.equal(plan.absent[0].action, "flag");
  assert.equal(plan.summary.flagged, 1);
  assert.equal(plan.summary.history, 0);
  const rows = applyPlan([holding({ quantity: 40, value_paise: 400000,
    cost_paise: 200000, purchase_date: "2024-06-06", as_of: "2026-10-31" })], plan);
  assert.equal(rows[0].quantity, 40);
});

test("an older CAS never adds a live row to the broker snapshot", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "2026-10-31",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
      rows: [{ isin: other(8), label: "8.00% NEW BOND 31 Dec 2027", category: "bond",
        quantity: 5, valuePaise: 50000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      snapshot: { source: "broker", asOf: "2026-11-05" },
      cost: { source: "motilal", asOf: "2026-11-05" },
      holdings: [holding({ quantity: 100, value_paise: 1000000, cost_paise: 200000,
        purchase_date: "2024-06-06", as_of: "2026-11-05" })],
    }),
    today: "2026-11-14",
  });
  assert.equal(plan.summary.added, 0);
  assert.equal(plan.summary.skipped, 1);
});

test("an older CAS does not put its value on a quantity it did not take", () => {
  const plan = planMerge({
    incoming: {
      kind: "cas", label: "CAS", asOf: "",
      identity: { kind: "bo", value: "1200000012345678" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 40, valuePaise: 400000, costPaise: null, purchaseDate: "" }],
    },
    existing: existingAccount({
      snapshot: { source: "broker", asOf: "2026-11-05" },
      cost: { source: "motilal", asOf: "2026-11-05" },
      holdings: [holding({ quantity: 100, value_paise: null, value_source: "",
        cost_paise: 200000, purchase_date: "2024-06-06", as_of: "2026-11-05" })],
    }),
    today: "2026-11-14",
  });
  const decision = plan.decisions[0];
  assert.equal(decision.next.quantity, 100);
  assert.equal(decision.next.valuePaise, null);
  assert.equal(decision.next.valueSource, "");
  assert.ok(decision.flags.includes("value-quantity-mismatch"));
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
      kind: "cas", asOf: "2026-11-13", identity: { kind: "bo", value: "IN99990001344321" },
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
      kind: "cas", asOf: "2026-08-01", identity: { kind: "bo", value: "IN99990001344321" },
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

test("the preview and the CAS writer keep the same cost when a quantity moves without one", () => {
  const row = holding({ quantity: 10, cost_paise: 100000, as_of: "2026-11-01" });
  const parsed = { asOf: "2026-11-01", transactions: [], holdings: [{ isin: isin(1),
    label: "9.00% TEST BOND 31 Dec 2026", kind: "bond", quantity: 12,
    valuePaise: 120000, costPaise: null }] };
  const write = casReplacePlan({ parsed, existing: [row], holdings: parsed.holdings,
    asOf: "2026-11-01" });
  const preview = planMerge({
    incoming: { kind: "cas", label: "CAS", asOf: "2026-11-01",
      identity: { kind: "bo", value: "IN99990001344321" }, categories: ["bond"],
      rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
        quantity: 12, valuePaise: 120000, costPaise: null }] },
    existing: existingAccount({
      snapshot: { source: "cas", asOf: "2026-11-01" },
      identity: { source: "cas", asOf: "2026-11-01", value: "IN99990001344321" },
      holdings: [row],
    }),
    today: "2026-11-15",
  });
  const decision = preview.decisions.find((item) => item.isin === isin(1));
  assert.equal(write.rows[0].cost_paise, 100000);
  assert.equal(decision.next.costPaise, 100000);
  assert.equal(decision.next.quantity, 12);
  assert.match(preview.warnings.join(" "), /last known cost is kept/i);
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
    incoming: incoming({ identity: { kind: "ucid", value: "9990001" } }),
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
    identity: { kind: "bo", value: "IN99990001344321" }, categories: ["bond"],
    rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
      quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "" }],
  };
  const broker = incoming({ asOf: "2026-11-12", identity: { kind: "ucid", value: "9990001" } });
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

test("an identical re-import of the broker's own key changes nothing", () => {
  const row = { security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2026",
    category: "bond", quantity: 10, cost_paise: 200000, purchase_date: "2024-06-06",
    value_paise: 100000, as_of: "2026-11-12", source: "motilal" };
  const cases = [
    { family: "motilal", source: "motilal", key: "9990001", kind: "ucid",
      meta: { ucid: "9990001" } },
    { family: "zerodha", source: "zerodha", key: "AB1234", kind: "client",
      meta: { client_id: "AB1234" } },
  ];
  for (const item of cases) {
    const account = { id: `${item.family}-account`, label: "Demat", category: "demat",
      subtype: "equity", number: "", meta: JSON.stringify({ broker_only: "1",
        identity_source: item.source, identity_as_of: "2026-11-12",
        holdings_source: item.source, holdings_as_of: "2026-11-12",
        cost_source: item.family, cost_as_of: "2026-11-12", ...item.meta }) };
    const existing = { ...accountFieldState(account, [row]), holdings: [row] };
    const plan = planMerge({
      incoming: incoming({ kind: item.family, asOf: "2026-11-12",
        identity: { kind: item.kind, value: item.key } }),
      existing,
      today: "2026-11-15",
    });
    assert.equal(plan.identityChange, null, item.family);
    assert.equal(plan.summary.added + plan.summary.updated + plan.summary.history, 0,
      item.family);
  }
});

test("a bond re-import does not count a maturity field the holding table cannot store", () => {
  const row = { security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2028",
    category: "bond", quantity: 10, cost_paise: 200000, purchase_date: "2024-06-06",
    value_paise: 100000, as_of: "2026-11-05", source: "motilal" };
  const account = { id: "demat-1", label: "Demat", category: "demat", subtype: "equity",
    number: "IN99990001344321", meta: JSON.stringify({ broker_only: "1",
      identity_source: "motilal", identity_as_of: "2026-11-05",
      holdings_source: "motilal", holdings_as_of: "2026-11-05",
      cost_source: "motilal", cost_as_of: "2026-11-05", ucid: "TEST0001" }) };
  const plan = planMerge({
    incoming: incoming({ asOf: "2026-11-05", rows: [{ isin: isin(1),
      label: "9.00% TEST BOND 31 Dec 2028", category: "bond", quantity: 10,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] }),
    existing: { ...accountFieldState(account, [row]), holdings: [row] },
    today: "2026-11-15",
  });
  assert.equal(plan.summary.added + plan.summary.updated + plan.summary.history, 0);
  assert.equal(plan.summary.kept, 1);
  assert.equal(plan.summary.ask, 0);
});

test("a genuine alias still reports the stored key and the incoming key", () => {
  const row = { security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2026",
    category: "bond", quantity: 10, cost_paise: 200000, purchase_date: "2024-06-06",
    value_paise: 100000, as_of: "2026-11-12", source: "motilal" };
  const account = { id: "motilal-account", label: "Demat", category: "demat",
    subtype: "equity", number: "", meta: JSON.stringify({ broker_only: "1",
      identity_source: "motilal", identity_as_of: "2026-11-12",
      holdings_source: "motilal", holdings_as_of: "2026-11-12",
      cost_source: "motilal", cost_as_of: "2026-11-12", ucid: "9990001" }) };
  const existing = { ...accountFieldState(account, [row]), holdings: [row] };
  const plan = planMerge({
    incoming: incoming({ kind: "motilal", asOf: "2026-11-12",
      identity: { kind: "ucid", value: "9990002" } }),
    existing,
    today: "2026-11-15",
  });
  assert.equal(plan.identityChange.action, "alias");
  assert.equal(plan.identityChange.value, "9990002");
  assert.equal(plan.identityChange.from, "9990001");
});

test("the account field state names the source and date of each group", () => {
  const account = { number: "IN99990001344321", meta: JSON.stringify({
    holdings_source: "cas", holdings_as_of: "2026-10-31",
    broker_source: "motilal", cost_source: "Motilal Oswal Portfolio Holding Summary",
    cost_as_of: "2026-11-12", identity_source: "cas", identity_as_of: "2026-10-31",
  }) };
  const state = accountFieldState(account, []);
  assert.deepEqual(state.identity, { source: "cas", asOf: "2026-10-31",
    value: "IN99990001344321" });
  assert.deepEqual(state.snapshot, { source: "cas", asOf: "2026-10-31" });
  assert.equal(state.cost.asOf, "2026-11-12");
  assert.equal(state.cost.manual, false);
});

test("a broker-only account has no CAS to reconcile against", () => {
  const account = normalizeAccount({ id: "broker", label: "Demat · Motilal Oswal · 9990001",
    category: "demat", number: "", meta: JSON.stringify({ broker_only: "1",
      ucid: "9990001" }) });
  assert.equal(account.brokerOnly, true);
  assert.equal(account.ucid, "9990001");
  assert.equal(account.boId, "");
});

// --- one plan per resolved account ------------------------------------------

const resolvedBundle = (key, family, accounts, over = {}) => ({
  key, family, accounts, ...over,
});
const DEMAT_BO = "IN99990001344321";
const FOLIO = "91062983856";

test("a CAS and two broker files for one demat become one plan", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:cas", "cas", ["demat-1"]),
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
    resolvedBundle("zerodha:TEST500", "zerodha", ["demat-1"]),
  ]);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].members,
    ["cas:cas", "motilal:9990001", "zerodha:TEST500"]);
  assert.deepEqual(plans[0].accounts, ["demat-1"]);
  assert.equal(plans[0].family, "cas");
});

test("files that resolve to different accounts stay separate plans", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:cas", "cas", ["demat-1"]),
    resolvedBundle("motilal:9990001", "motilal", ["demat-2"]),
  ]);
  assert.deepEqual(plans.map((plan) => plan.key), ["cas:cas", "motilal:9990001"]);
  assert.deepEqual(plans.map((plan) => plan.accounts), [["demat-1"], ["demat-2"]]);
});

test("an unresolved file keeps its own plan and is never attached to a guess", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:cas", "cas", ["demat-1"]),
    resolvedBundle("motilal:9990001", "motilal", []),
    resolvedBundle("zerodha:TEST500", "zerodha", []),
  ]);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[1].accounts, []);
  assert.deepEqual(plans[2].accounts, []);
  assert.notEqual(plans[1].key, plans[2].key);
});

test("a CAS folio stays a distinct account in the plan, not a broker's home", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:cas", "cas", ["demat-1", `mf:${FOLIO}`]),
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
  ]);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].accounts, ["demat-1", `mf:${FOLIO}`]);
  // The broker claims the demat only; the folio account is untouched by it.
  assert.deepEqual(plans[0].members, ["cas:cas", "motilal:9990001"]);
});

test("a file that would join two unrelated plans does not merge them", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:a", "cas", ["demat-1"]),
    resolvedBundle("cas:b", "cas", ["demat-2"]),
    resolvedBundle("odd", "motilal", ["demat-1", "demat-2"]),
  ]);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0].accounts, ["demat-1"]);
  assert.deepEqual(plans[1].accounts, ["demat-2"]);
  assert.deepEqual(plans[2].accounts, ["demat-1", "demat-2"]);
});

test("an empty set has no plans, and plan order follows the file order", () => {
  assert.deepEqual(groupResolvedPlans([]), []);
  const plans = groupResolvedPlans([
    resolvedBundle("first", "motilal", []),
    resolvedBundle("second", "zerodha", ["demat-1"]),
    resolvedBundle("third", "digifinn", ["demat-1"]),
  ]);
  assert.deepEqual(plans.map((plan) => plan.key), ["first", "second"]);
  assert.deepEqual(plans[1].members, ["second", "third"]);
});

// --- planning one account's files in order ---------------------------------

const planAccount = (over = {}) => ({
  id: "demat-1", label: "Demat · Test · …4321", category: "demat", subtype: "equity",
  number: DEMAT_BO, meta: JSON.stringify({ ucid: "TEST0001" }), ...over,
});

const casContribution = (over = {}) => ({
  key: "cas", family: "cas", label: "CDSL CAS", asOf: "2026-11-14",
  accountKey: DEMAT_BO, identity: { kind: "bo", value: DEMAT_BO },
  rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
    quantity: 10, valuePaise: 100000, costPaise: null }],
  ...over,
});

const brokerContribution = (over = {}) => ({
  key: "motilal", family: "motilal", label: "Motilal Oswal holdings report",
  asOf: "2026-11-12", accountKey: "TEST0001",
  identity: { kind: "ucid", value: "TEST0001" }, attributed: true,
  rows: [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026", category: "bond",
    quantity: 10, valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }],
  ...over,
});

test("the second file in a plan is planned against the first file's result", () => {
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account: planAccount(), holdings: [],
      contributions: [casContribution(), brokerContribution()] }],
    today: "2026-11-15",
  });
  assert.equal(composed.chains.length, 1);
  const [cas, broker] = composed.chains[0].receipts;
  assert.equal(cas.plan.summary.added, 1);
  assert.equal(broker.plan.summary.added, 0, "the broker does not add a second row");
  assert.equal(broker.plan.summary.updated, 1);
  const cost = broker.plan.decisions[0].changes.find((change) => change.field === "cost");
  assert.equal(cost.to, 200000);
  const final = composed.chains[0].rows.find((row) => row.security_id === isin(1));
  assert.equal(final.quantity, 10);
  assert.equal(final.value_paise, 100000);
  assert.equal(final.cost_paise, 200000);
  assert.equal(final.purchase_date, "2024-06-06");
});

test("a stale broker beside a newer CAS in one plan fills cost without a question", () => {
  const account = planAccount({ meta: JSON.stringify({
    ucid: "TEST0001", holdings_source: "broker", holdings_as_of: "2026-11-12",
    cost_source: "motilal", cost_as_of: "2026-10-01",
  }) });
  const holdings = [{ security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2026",
    category: "bond", quantity: 8, cost_paise: 150000, value_paise: null,
    purchase_date: "", value_source: "Motilal Oswal holdings report",
    as_of: "2026-11-12" }];
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account, holdings,
      contributions: [casContribution({ rows: [{ isin: isin(1),
        label: "9.00% TEST BOND 31 Dec 2026", category: "bond", quantity: 10,
        valuePaise: 120000, costPaise: null }] }), brokerContribution()] }],
    today: "2026-11-15",
  });
  const [cas, broker] = composed.chains[0].receipts;
  assert.equal(cas.plan.summary.updated, 1);
  assert.equal(cas.plan.summary.ask, 0);
  assert.equal(broker.plan.summary.updated, 1);
  assert.equal(broker.plan.summary.ask, 0, "an older broker is not a same-date question");
  assert.equal(broker.plan.relation, "older");
  const final = composed.chains[0].rows.find((row) => row.security_id === isin(1));
  assert.equal(final.quantity, 10);
  assert.equal(final.value_paise, 120000);
  assert.equal(final.cost_paise, 200000);
  assert.equal(composed.summary.ask, 0);
});

test("an unsafe file blocks the plan and names the file", () => {
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account: planAccount(), holdings: [],
      contributions: [casContribution(),
        brokerContribution({ asOf: "2027-01-01" })] }],
    today: "2026-11-15",
  });
  assert.equal(composed.blocking, true);
  assert.equal(composed.summary.ask, 0);
  assert.match(composed.warnings.join(" "), /Motilal Oswal holdings report: .*future/i);
  assert.match(composed.warnings.join(" "), /will not overwrite dated data|dated .* in the future/i);
});

test("an unresolved file plans alone, with no account to update", () => {
  const composed = planImportChains({
    chains: [{ accountId: "", account: null, holdings: [],
      contributions: [brokerContribution({ key: "lonely" })] }],
    today: "2026-11-15",
  });
  assert.equal(composed.chains[0].accountId, "");
  assert.equal(composed.chains[0].receipts[0].plan.summary.added, 1);
  assert.equal(composed.chains[0].plan, undefined);
});

test("the plan's rows match the CAS writer followed by the broker writer", () => {
  const casRows = [{ isin: isin(1), label: "9.00% TEST BOND 31 Dec 2026",
    kind: "bond", quantity: 10, valuePaise: 100000, costPaise: null }];
  const parsed = { depository: "CDSL", demat: DEMAT_BO, asOf: "2026-11-14",
    counts: { quarantined: 0 }, printedTotalPaise: null,
    accounts: [{ boId: DEMAT_BO, dpName: "Test DP", holdings: casRows }],
    holdings: casRows, transactions: [] };
  const written = casReplacePlan({ parsed, existing: [], holdings: casRows,
    asOf: "2026-11-14", events: [], assetId: "demat-1", accounts: [DEMAT_BO],
    route: true });
  assert.equal(written.ok, true);
  const account = { category: "demat", subtype: "equity", number: DEMAT_BO,
    meta: JSON.stringify({ holdings_source: "cas", holdings_as_of: "2026-11-14" }) };
  const brokerPlan = planMerge({
    incoming: { kind: "motilal", label: "Motilal Oswal holdings report",
      asOf: "2026-11-12", identity: { kind: "ucid", value: "TEST0001" },
      categories: ["bond"], rows: brokerContribution().rows },
    existing: { ...accountFieldState(account, written.rows), holdings: written.rows },
    today: "2026-11-15",
  });
  const finalRows = mergeRowsFromPlan(written.rows, brokerPlan,
    { family: "motilal", label: "Motilal Oswal holdings report", asOf: "2026-11-12" });
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account, holdings: written.rows,
      contributions: [brokerContribution({ attributed: false })] }],
    today: "2026-11-15",
  });
  const stored = (row) => ({
    security_id: row.security_id, quantity: row.quantity, cost_paise: row.cost_paise,
    value_paise: row.value_paise, purchase_date: row.purchase_date, as_of: row.as_of,
    value_source: row.value_source,
  });
  assert.deepEqual(composed.chains[0].rows.map(stored), finalRows.map(stored));
});

test("the first plan state carries the CAS snapshot into the next file", () => {
  const before = accountFieldState(planAccount({
    meta: JSON.stringify({ holdings_source: "broker", holdings_as_of: "2026-11-12" }) }),
    [{ security_id: isin(1), as_of: "2026-11-12" }]);
  const receipt = { incomingAsOf: "2026-11-14", summary: { added: 1 }, decisions: [],
    identityChange: { action: "replace" } };
  const after = planStateAfter({ ...before, holdings: [] }, receipt,
    { family: "cas", asOf: "2026-11-14", accountKey: DEMAT_BO });
  assert.deepEqual(after.snapshot, { source: "cas", asOf: "2026-11-14" });
  assert.equal(after.identity.source, "cas");
  assert.equal(after.identity.asOf, "2026-11-14");
  assert.equal(after.cost.asOf, before.cost.asOf, "the CAS does not move the cost date");
});

test("a broker receipt only moves the cost date when it changed a cost", () => {
  const state = { identity: { source: "cas", asOf: "2026-10-31", value: "" },
    snapshot: { source: "cas", asOf: "2026-10-31" },
    cost: { source: "motilal", asOf: "2026-10-01", manual: false },
    manualAsOf: "", holdings: [] };
  const noCost = planStateAfter(state, {
    incomingAsOf: "2026-11-12", summary: { added: 0, updated: 1 },
    decisions: [{ changes: [{ group: "snapshot", field: "quantity" }] }],
  }, { family: "zerodha", asOf: "2026-11-12", accountKey: "TEST500" });
  assert.deepEqual(noCost.cost, state.cost);
  assert.deepEqual(noCost.snapshot, { source: "zerodha", asOf: "2026-11-12" });

  const withCost = planStateAfter(state, {
    incomingAsOf: "2026-11-12", summary: { added: 0, updated: 1 },
    decisions: [{ changes: [{ group: "cost", field: "cost" }] }],
  }, { family: "zerodha", asOf: "2026-11-12", accountKey: "TEST500" });
  assert.deepEqual(withCost.cost, { source: "zerodha", asOf: "2026-11-12", manual: false });
});

// --- a statement with movements is not folded into a broker plan ------------

test("a statement with movements keeps a broker for the same account separate", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:moved", "cas", ["demat-1"], { locked: true }),
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
  ]);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].members, ["cas:moved"]);
  assert.deepEqual(plans[0].accounts, ["demat-1"]);
  assert.deepEqual(plans[1].accounts, ["demat-1"]);
});

test("a locked statement does not claim its account from an earlier plan", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
    resolvedBundle("cas:moved", "cas", ["demat-1"], { locked: true }),
  ]);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[1].members, ["cas:moved"]);
});

test("a locked statement does not stop two broker files grouping", () => {
  const plans = groupResolvedPlans([
    resolvedBundle("cas:moved", "cas", ["demat-1"], { locked: true }),
    resolvedBundle("motilal:m", "motilal", ["demat-1"]),
    resolvedBundle("zerodha:z", "zerodha", ["demat-1"]),
  ]);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[1].members, ["motilal:m", "zerodha:z"]);
});

const SOLD_ISIN = other(2);
const soldLabel = "8.00% SOLD BOND 31 Dec 2028";
const saleParsed = {
  asOf: "2026-10-31", counts: { quarantined: 0 }, printedTotalPaise: null,
  holdings: [], accounts: [{ boId: DEMAT_BO, dpName: "Test DP", holdings: [] }],
  transactions: [{ isin: SOLD_ISIN, security: "SOLD BOND", date: "2026-10-10",
    type: "SALE", description: "SALE", quantity: 10, openingPaise: 100000,
    creditPaise: 0, debitPaise: 100000, closingPaise: 0 }],
};
const soldAccount = (over = {}) => ({ id: "demat-1", label: "Demat", category: "demat",
  subtype: "equity", number: DEMAT_BO, meta: JSON.stringify({ ucid: "TEST0001" }), ...over });

test("a broker that names a bond the statement sold asks, so it cannot ride that plan's accept", () => {
  const parsed = saleParsed;
  const written = casReplacePlan({ parsed, existing: [{ security_id: SOLD_ISIN,
    label: soldLabel, category: "bond", quantity: 10, cost_paise: null,
    value_paise: 100000, as_of: "2026-09-30" }], holdings: parsed.holdings,
    asOf: parsed.asOf, events: parsed.transactions, assetId: "demat-1",
    accounts: [DEMAT_BO], route: true });
  const sold = written.rows.find((row) => row.disposed_at);
  assert.equal(sold.disposed_cost_paise, null);
  const account = soldAccount({ meta: JSON.stringify({ ucid: "TEST0001",
    identity_source: "cas", identity_as_of: "2026-10-31",
    holdings_source: "cas", holdings_as_of: "2026-10-31" }) });
  const broker = planMerge({ incoming: { kind: "motilal",
    label: "Motilal Oswal holdings report", asOf: "2026-11-05",
    identity: { kind: "ucid", value: "TEST0001" }, categories: ["bond"],
    rows: [{ isin: SOLD_ISIN, label: soldLabel, category: "bond", quantity: 10,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] },
    existing: { ...accountFieldState(account, written.rows), holdings: written.rows },
    today: "2026-11-15" });
  assert.equal(broker.summary.ask, 1, "the broker names a bond the statement sold");
  const plans = groupResolvedPlans([
    resolvedBundle("cas:moved", "cas", ["demat-1"], { locked: true }),
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
  ]);
  assert.equal(plans.length, 2, "the ask stays on its own card");
});

test("the card's ask about a sold row cannot carry the broker's ask about another", () => {
  const recorded = other(1);
  const alreadySold = { security_id: recorded,
    label: "7.00% ALREADY SOLD BOND 31 Dec 2027", category: "bond",
    quantity: 0, cost_paise: 0, value_paise: 0, disposed_at: "2026-08-12",
    disposed_quantity: 10, disposed_type: "sale", disposed_source: "CAS",
    disposed_reason: "SALE", as_of: "2026-08-12" };
  const liveB = { security_id: SOLD_ISIN, label: soldLabel, category: "bond",
    quantity: 10, cost_paise: null, value_paise: 100000, as_of: "2026-09-30" };
  const account = soldAccount({ meta: JSON.stringify({ ucid: "TEST0001",
    holdings_source: "cas", holdings_as_of: "2026-08-12" }) });
  const cas = planMerge({ incoming: { kind: "cas", label: "CDSL CAS",
    asOf: "2026-10-31", identity: { kind: "bo", value: DEMAT_BO },
    categories: ["bond"], rows: [{ isin: recorded,
      label: "7.00% ALREADY SOLD BOND 31 Dec 2027", category: "bond",
      quantity: 10, valuePaise: 100000, costPaise: null }] },
    existing: { ...accountFieldState(account, [alreadySold, liveB]),
      holdings: [alreadySold, liveB] },
    today: "2026-11-15" });
  assert.equal(cas.summary.ask, 1, "the statement contradicts the recorded sale");
  const written = casReplacePlan({ parsed: saleParsed,
    existing: [alreadySold, liveB], holdings: [], asOf: saleParsed.asOf,
    events: saleParsed.transactions, assetId: "demat-1", accounts: [DEMAT_BO],
    route: true });
  const broker = planMerge({ incoming: { kind: "motilal",
    label: "Motilal Oswal holdings report", asOf: "2026-11-05",
    identity: { kind: "ucid", value: "TEST0001" }, categories: ["bond"],
    rows: [{ isin: SOLD_ISIN, label: soldLabel, category: "bond", quantity: 10,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] },
    existing: { ...accountFieldState(account, written.rows), holdings: written.rows },
    today: "2026-11-15" });
  assert.equal(broker.summary.ask, 1, "the broker names the bond the statement sold");
  const plans = groupResolvedPlans([
    resolvedBundle("cas:moved", "cas", ["demat-1"], { locked: true }),
    resolvedBundle("motilal:9990001", "motilal", ["demat-1"]),
  ]);
  assert.equal(plans.length, 2, "neither ask can be accepted from the other's card");
  assert.deepEqual(plans[0].members, ["cas:moved"]);
  assert.deepEqual(plans[1].members, ["motilal:9990001"]);
});

test("a broker imported before a full sale gives the disposal its cost", () => {
  const parsed = saleParsed;
  const live = { security_id: SOLD_ISIN, label: soldLabel, category: "bond",
    quantity: 10, cost_paise: null, value_paise: 100000, as_of: "2026-09-30" };
  const account = soldAccount({ meta: JSON.stringify({ ucid: "TEST0001",
    holdings_source: "broker", holdings_as_of: "2026-09-30" }) });
  const brokerPlan = planMerge({ incoming: { kind: "motilal",
    label: "Motilal Oswal holdings report", asOf: "2026-11-05",
    identity: { kind: "ucid", value: "TEST0001" }, categories: ["bond"],
    rows: [{ isin: SOLD_ISIN, label: soldLabel, category: "bond", quantity: 10,
      valuePaise: null, costPaise: 200000, purchaseDate: "2024-06-06" }] },
    existing: { ...accountFieldState(account, [live]), holdings: [live] },
    today: "2026-11-15" });
  const funded = mergeRowsFromPlan([live], brokerPlan,
    { family: "motilal", label: "Motilal Oswal holdings report", asOf: "2026-11-05" },
    false);
  assert.equal(funded[0].cost_paise, 200000, "the broker is the only source of cost");
  const withCost = casReplacePlan({ parsed, existing: funded, holdings: parsed.holdings,
    asOf: parsed.asOf, events: parsed.transactions, assetId: "demat-1",
    accounts: [DEMAT_BO], route: true });
  const withoutCost = casReplacePlan({ parsed, existing: [{ ...live }],
    holdings: parsed.holdings, asOf: parsed.asOf, events: parsed.transactions,
    assetId: "demat-1", accounts: [DEMAT_BO], route: true });
  assert.equal(withCost.rows.find((row) => row.disposed_at).disposed_cost_paise, 200000);
  assert.equal(withoutCost.rows.find((row) => row.disposed_at).disposed_cost_paise, null);
});

// --- the plan's net count, not the sum of its files ------------------------

test("the plan's net count says one added holding, not an add and an update", () => {
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account: planAccount(), holdings: [],
      contributions: [casContribution(), brokerContribution()] }],
    today: "2026-11-15",
  });
  assert.equal(composed.net.added, 1);
  assert.equal(composed.net.updated, 0);
  assert.equal(composed.net.kept, 0);
  assert.equal(composed.summary.added, 1, "the receipts still say what each file did");
});

test("a holding both files change counts once as updated", () => {
  const account = planAccount({ meta: JSON.stringify({
    ucid: "TEST0001", holdings_source: "broker", holdings_as_of: "2026-11-12",
    cost_source: "motilal", cost_as_of: "2026-10-01",
  }) });
  const holdings = [{ security_id: isin(1), label: "9.00% TEST BOND 31 Dec 2026",
    category: "bond", quantity: 8, cost_paise: 150000, value_paise: null,
    purchase_date: "", value_source: "Motilal Oswal holdings report",
    as_of: "2026-11-12" }];
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account, holdings,
      contributions: [casContribution({ rows: [{ isin: isin(1),
        label: "9.00% TEST BOND 31 Dec 2026", category: "bond", quantity: 10,
        valuePaise: 120000, costPaise: null }] }), brokerContribution()] }],
    today: "2026-11-15",
  });
  assert.equal(composed.net.added, 0);
  assert.equal(composed.net.updated, 1);
  assert.equal(composed.net.kept, 0);
});

test("a matured row moved to history is not also counted as updated", () => {
  const account = planAccount({ meta: JSON.stringify({
    ucid: "TEST0001", holdings_source: "broker", holdings_as_of: "2026-09-30",
  }) });
  const holdings = [{ security_id: other(7), label: "7.00% MATURE BOND 31 Aug 2026",
    category: "bond", quantity: 5, cost_paise: 50000, value_paise: 50000,
    as_of: "2026-09-30" }];
  const composed = planImportChains({
    chains: [{ accountId: "demat-1", account, holdings,
      contributions: [brokerContribution({ rows: [] })] }],
    today: "2026-11-15",
  });
  assert.equal(composed.net.history, 1);
  assert.equal(composed.net.updated, 0);
});
