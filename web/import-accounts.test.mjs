import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSecuritiesAccount, isImportAccount, isDepositoryAccount } from "./assets.js";
import { accountMatches, bondGapBanner, bondImportOf, groupBundles,
  importAccountGaps, importAccountSummary, importPlanPrimary, normalizeAccount,
  IMPORT_REPORT_GUIDE } from "./import-flow.js";

// Synthetic identifiers only. The real files are never committed.
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const account = (over = {}) => ({
  id: "acct", label: "Account", category: "demat", subtype: "equity",
  number: "IN99990001344321", meta: "", ...over,
});
const row = (n, over = {}) => ({
  security_id: isin(n), quantity: 1, as_of: "2026-10-31", ...over,
});
const meta = (value) => JSON.stringify(value);

// --- what counts as an import target ---------------------------------------

test("a demat, a bond portfolio and a fund folio are securities accounts", () => {
  assert.equal(isSecuritiesAccount(account()), true);
  assert.equal(isSecuritiesAccount(account({ subtype: "mutual fund" })), true);
  assert.equal(isSecuritiesAccount(account({ category: "bonds", subtype: "bond" })), true);
  assert.equal(isSecuritiesAccount(account({ category: "bank", subtype: "savings" })), false);
  assert.equal(isSecuritiesAccount(account({ category: "fd", subtype: "fd" })), false);
});

test("the import list is every securities account except a cost-only record", () => {
  const accounts = [
    account({ id: "demat-1" }),
    account({ id: "bonds-1", category: "bonds", subtype: "bond" }),
    account({ id: "folio-1", subtype: "mutual fund" }),
    account({ id: "legacy-bond", category: "", type: "bond" }),
    account({ id: "bank-1", category: "bank", subtype: "savings" }),
    account({ id: "fd-1", category: "fd", subtype: "fd" }),
    account({ id: "cost-1", category: "bonds", subtype: "bond",
      meta: meta({ cost_only: true }) }),
  ];
  assert.deepEqual(accounts.filter(isImportAccount).map((a) => a.id),
    ["demat-1", "bonds-1", "folio-1", "legacy-bond"]);
});

test("a cost-only record is excluded whether its meta is text or an object", () => {
  assert.equal(isImportAccount(account({ meta: meta({ cost_only: true }) })), false);
  assert.equal(isImportAccount(account({ meta: { cost_only: true } })), false);
  assert.equal(isImportAccount(account({ meta: "{not json" })), true);
});

test("only a demat or a fund folio can receive a CAS", () => {
  assert.equal(isDepositoryAccount(account()), true);
  assert.equal(isDepositoryAccount(account({ subtype: "mutual fund" })), true);
  assert.equal(isDepositoryAccount(account({ category: "bonds", subtype: "bond" })), false);
  assert.equal(isDepositoryAccount(account({ category: "bank", subtype: "savings" })), false);
  assert.equal(isDepositoryAccount(account({ meta: meta({ cost_only: true }) })), false);
});

// --- matching ---------------------------------------------------------------

test("a bond portfolio matches an ISIN it holds", () => {
  const bonds = account({ id: "bonds-1", label: "Bonds · portfolio 1",
    category: "bonds", subtype: "bond", number: "",
    holdings: [row(1), row(2)] });
  const result = accountMatches({ rows: [{ isin: isin(1) }] }, [bonds]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, "bonds-1");
  assert.equal(result.matches[0].hits, 1);
  assert.equal(result.bestId, "bonds-1");
});

test("a legacy bond account matches too", () => {
  const legacy = account({ id: "legacy-bond", category: "", type: "bond",
    number: "", holdings: [row(3)] });
  const result = accountMatches({ rows: [{ isin: isin(3) }] }, [legacy]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, "legacy-bond");
});

test("a bank account with the same ISIN never matches", () => {
  const bank = account({ id: "bank-1", category: "bank", subtype: "savings",
    holdings: [row(1)] });
  const result = accountMatches({ rows: [{ isin: isin(1) }] }, [bank]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.bestId, "");
});

test("an FD never matches, even when the file names its number", () => {
  const fd = account({ id: "fd-1", category: "fd", subtype: "fd",
    number: "FD0001", holdings: [row(1)] });
  const result = accountMatches({ accountKey: "FD0001", accountKind: "client",
    rows: [{ isin: isin(1) }] }, [fd]);
  assert.equal(result.matches.length, 0);
});

test("a cost-only bond record is not a match target", () => {
  const cost = account({ id: "cost-1", category: "bonds", subtype: "bond",
    number: "", meta: meta({ cost_only: true }), holdings: [row(1)] });
  assert.equal(accountMatches({ rows: [{ isin: isin(1) }] }, [cost]).matches.length, 0);
  assert.equal(accountMatches({ rows: [{ isin: isin(1) }] }, [cost],
    { forCas: true }).matches.length, 0);
});

test("a CAS matches the demat, not a bond portfolio holding the same ISIN", () => {
  const demat = account({ id: "demat-1", holdings: [row(1), row(2)] });
  const bonds = account({ id: "bonds-1", label: "Bonds · portfolio 1",
    category: "bonds", subtype: "bond", number: "",
    holdings: [row(1), row(2)] });
  const file = { rows: [{ isin: isin(1) }, { isin: isin(2) }] };

  const cas = accountMatches(file, [bonds, demat], { forCas: true });
  assert.deepEqual(cas.matches.map((match) => match.id), ["demat-1"]);
  assert.equal(cas.bestId, "demat-1");
  assert.equal(cas.tie, false);

  // The broker path keeps the wider list: both accounts still match there.
  const broker = accountMatches(file, [bonds, demat]);
  assert.deepEqual(broker.matches.map((match) => match.id).sort(),
    ["bonds-1", "demat-1"]);
});

test("a CAS ignores a linked bond portfolio and preserves the best demat", () => {
  const linked = account({ id: "linked-bonds", category: "bonds", subtype: "bond",
    number: "", meta: meta({ linked_asset: "demat-2" }), holdings: [row(1), row(2)] });
  const best = account({ id: "demat-1", number: "IN99990006111111",
    holdings: [row(1), row(2)] });
  const partial = account({ id: "demat-2", number: "IN99990007222222",
    holdings: [row(1)] });
  const result = accountMatches({ rows: [{ isin: isin(1) }, { isin: isin(2) }] },
    [linked, partial, best], { forCas: true });
  assert.deepEqual(result.matches.map((match) => match.id), ["demat-1", "demat-2"]);
  assert.equal(result.matches[0].hits, 2);
  assert.equal(result.bestId, "demat-1");
});

// --- a folio is identity -----------------------------------------------------

test("a folio identity matches the account that carries that folio", () => {
  const mirae = account({ id: "mirae", label: "Mirae Asset mutual fund",
    subtype: "mutual fund", number: "99999999999",
    meta: meta({ folios: ["99999999999"] }), holdings: [row(1)] });
  const other = account({ id: "other", label: "Mirae Asset mutual fund",
    subtype: "mutual fund", number: "88888888888",
    meta: meta({ folios: ["88888888888"] }), holdings: [] });
  const file = { accountKey: "99999999999", accountKind: "folio",
    rows: [{ isin: isin(9) }] };
  const result = accountMatches(file, [other, mirae], { forCas: true });
  assert.deepEqual(result.matches.map((match) => match.id), ["mirae"]);
  assert.equal(result.matches[0].identityKind, "folio");
  assert.equal(result.bestId, "mirae");
});

test("a folio identity never falls through to ISIN overlap", () => {
  const wrongFolio = account({ id: "wrong-folio", label: "Mirae Asset mutual fund",
    subtype: "mutual fund", number: "11111111111",
    meta: meta({ folios: ["11111111111"] }), holdings: [row(1)] });
  const file = { accountKey: "22222222222", accountKind: "folio",
    rows: [{ isin: isin(1) }] };
  const result = accountMatches(file, [wrongFolio], { forCas: true });
  assert.equal(result.matches.length, 0);
  assert.equal(result.bestId, "");
});

test("a folio identity prefers the account of its own AMC", () => {
  const one = account({ id: "one", label: "AMC One mutual fund",
    subtype: "mutual fund", number: "99999999999",
    meta: meta({ amc: "AMC One", folios: ["99999999999"] }), holdings: [] });
  const two = account({ id: "two", label: "AMC Two mutual fund",
    subtype: "mutual fund", number: "99999999999",
    meta: meta({ amc: "AMC Two", folios: ["99999999999"] }), holdings: [] });
  const file = { accountKey: "99999999999", accountKind: "folio", amc: "AMC Two",
    rows: [{ isin: isin(9) }] };
  const result = accountMatches(file, [one, two], { forCas: true });
  assert.equal(result.matches[0].id, "two");
  assert.equal(result.bestId, "two");
  assert.equal(result.identityId, "two");
});

test("normalizeAccount exposes the folios an account carries but not a BO ID", () => {
  const fund = normalizeAccount(account({ subtype: "mutual fund", number: "A/1",
    meta: meta({ folios: ["B/2"] }) }));
  assert.deepEqual(fund.folios.sort(), ["a/1", "b/2"]);
  const demat = normalizeAccount(account({ number: "IN99990001344321" }));
  assert.deepEqual(demat.folios, []);
});

// --- the status line --------------------------------------------------------

test("CAS verified with two holdings shows the count", () => {
  const status = importAccountSummary(
    account({ meta: meta({ holdings_source: "cas", holdings_as_of: "2026-10-31" }) }),
    [row(1), row(2)], (value) => value);
  assert.equal(status.label, "CAS verified");
  assert.equal(status.kind, "good");
  assert.equal(status.count, 2);
  assert.equal(status.countText, "2 holdings");
  assert.equal(status.dates, "CAS 2026-10-31");
});

test("broker-only with one holding says one holding", () => {
  const status = importAccountSummary(
    account({ meta: meta({ broker_only: "1" }) }), [row(1)]);
  assert.equal(status.label, "Broker-only");
  assert.equal(status.kind, "warn");
  assert.equal(status.count, 1);
  assert.equal(status.countText, "1 holding");
});

test("newer broker data outranks a CAS and keeps the count", () => {
  const status = importAccountSummary(account({ meta: meta({
    holdings_source: "cas", holdings_as_of: "2026-10-31",
    cost_source: "broker", cost_as_of: "2026-11-12",
  }) }), [row(1), row(2), row(3)], (value) => value);
  assert.equal(status.label, "Newer broker data");
  assert.equal(status.kind, "warn");
  assert.equal(status.count, 3);
  assert.equal(status.countText, "3 holdings");
  assert.match(status.dates, /CAS 2026-10-31/);
  assert.match(status.dates, /Broker 2026-11-12/);
});

test("an empty account is the only one that says No holdings yet", () => {
  const empty = importAccountSummary(account(), []);
  assert.equal(empty.label, "No holdings yet");
  assert.equal(empty.count, 0);
  assert.equal(empty.matured, 0);
  assert.equal(empty.countText, "");

  const unmarked = importAccountSummary(account({ category: "bonds" }),
    [{ security_id: isin(1), quantity: 1 }]);
  assert.notEqual(unmarked.label, "No holdings yet");
  assert.equal(unmarked.label, "Holdings");
  assert.equal(unmarked.count, 1);
  assert.equal(unmarked.countText, "1 holding");
});

test("a matured row is not counted and is named in the count", () => {
  const current = { security_id: isin(1), label: "TEST EQUITY", category: "equity",
    quantity: 5 };
  const matured = { security_id: isin(2), label: "7.15% TEST BOND 15 May 2020",
    category: "bond", quantity: 10 };
  const status = importAccountSummary(account(), [current, matured],
    (value) => value, "2026-11-14");
  assert.equal(status.label, "Holdings");
  assert.equal(status.count, 1);
  assert.equal(status.matured, 1);
  assert.equal(status.countText, "1 holding · 1 matured");

  const history = importAccountSummary(account(), [matured], (value) => value,
    "2026-11-14");
  assert.equal(history.label, "No current holdings");
  assert.equal(history.count, 0);
  assert.equal(history.matured, 1);
  assert.equal(history.countText, "1 matured");
});

test("a disposed row with a past maturity is sold, not matured", () => {
  const sold = { security_id: isin(2), label: "7.15% TEST BOND 15 May 2020",
    category: "bond", quantity: 0, disposed_at: "2026-06-01" };
  const status = importAccountSummary(account(), [sold], (value) => value,
    "2026-11-14");
  assert.equal(status.count, 0);
  assert.equal(status.matured, 0);
  assert.equal(status.countText, "");
  assert.equal(status.label, "No current holdings");
});

test("a stored maturity outranks a series date in the bond name", () => {
  const row = { security_id: isin(2), label: "7.15% TEST SERIES 15 May 2020",
    category: "bond", quantity: 10, maturity: "2032-05-15" };
  const status = importAccountSummary(account(), [row], (value) => value,
    "2026-11-14");
  assert.equal(status.count, 1);
  assert.equal(status.matured, 0);
  assert.equal(status.countText, "1 holding");
});

test("a zero-quantity row is history, not an active holding", () => {
  const closed = { security_id: isin(1), label: "TEST EQUITY", category: "equity",
    quantity: 0 };
  const status = importAccountSummary(account(), [closed], (value) => value,
    "2026-11-14");
  assert.equal(status.label, "No current holdings");
  assert.equal(status.count, 0);
  assert.equal(status.matured, 0);
  assert.equal(status.countText, "");
});

// --- bank files stay out of the holdings inbox ------------------------------

test("groupBundles drops a bank file and keeps the securities bundle", () => {
  const bundles = groupBundles([
    { kind: "bank", name: "statement.csv", rows: [{ date: "2026-11-01" }] },
    { kind: "zerodha-holdings", name: "holdings.xlsx", asOf: "2026-11-12",
      rows: [{ isin: isin(1), quantity: 5 }] },
  ]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].family, "zerodha");
  assert.equal(bundles[0].rows.length, 1);
});

// --- the page wiring --------------------------------------------------------

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

test("both account loaders use one import-account rule", () => {
  const load = between("window.bpImportAccountsLoad = async", "function bpImportAccountRow");
  const prepare = between("async function bpImportInboxPrepare", "function bpImportInboxEntryError");
  for (const [name, body] of [["load", load], ["prepare", prepare]]) {
    assert.match(body, /filter\(isImportAccount\)/, `${name} uses isImportAccount`);
    assert.doesNotMatch(body, /categoryOf\(a\) === "demat"/,
      `${name} must not filter on a demat category`);
  }
});

test("the CAS resolver asks the matcher for depository targets only", () => {
  const cas = between("function bpImportResolveCas", "async function bpImportInboxPrepare");
  const calls = cas.match(/accountMatches\(/g) || [];
  const guarded = cas.match(/\}, accounts, \{ forCas: true \}\)/g) || [];
  assert.equal(calls.length, 2, "the demat and folio matches are both in the CAS resolver");
  assert.equal(guarded.length, 2, "both CAS matches pass forCas");
  const broker = between("function bpImportResolveBroker", "function bpImportResolveCas");
  assert.doesNotMatch(broker, /forCas/, "a broker file keeps the wider list");
});

test("a broker file attaches or creates only on the shared match rule", () => {
  const broker = between("function bpImportResolveBroker", "function bpImportResolveCas");
  assert.match(broker, /bundle\.match\.attachId/, "the broker resolver uses the shared attach id");
  assert.doesNotMatch(broker, /bundle\.match\.bestId/, "a weak best match is not a target");
  assert.match(broker, /bundle\.canCreate = bundle\.match\.matches\.length === 0/);
  assert.match(broker, /bundle\.create = bundle\.canCreate/,
    "only a file that matches nothing may create an account");
  assert.match(broker, /bundle\.needsChoice = !targetId && bundle\.match\.matches\.length > 0/,
    "a weak overlap is a question");
});

test("the CAS resolver reads the same threshold from the matcher", () => {
  const cas = between("function bpImportResolveCas", "async function bpImportInboxPrepare");
  assert.match(cas, /match\.attachId/);
  assert.doesNotMatch(cas, /share >= 0\.8/, "the threshold lives in the matcher, not here");
});

test("the status line renders the holding count before the rest of the metadata", () => {
  const render = between("function bpImportAccountsHtml", "function bpImportAccountsRender");
  assert.match(render, /const bits = \[status\.countText,/);
  assert.match(html, /importAccountSummary\(row\.account, row\.holdings, dateLabel\)/);
});

test("the list says what it holds and refreshes when Import opens", () => {
  assert.match(html, /<h2>Securities accounts<\/h2>/);
  assert.match(html, /No securities accounts yet/);
  assert.match(html, /bpImportAccountsLoad\?\.\(true\)/);
});

// --- what one account is missing --------------------------------------------
// The gap list is computed from provenance already stored: holdings_source,
// holdings_as_of, cost_source, cost_as_of, plus each row's own fields. No new
// field remembers a gap and no score ranks the account.

const gapText = (value) => value.gaps.map((gap) => gap.text);

test("an account with current quantities, cost and terms names no gap", () => {
  const gaps = importAccountGaps(account({ meta: meta({
    holdings_source: "cas", holdings_as_of: "2026-10-31",
    cost_source: "motilal", cost_as_of: "2026-10-31",
  }) }), [
    { ...row(1), quantity: 5, cost_paise: 500000, source: "motilal" },
    { security_id: isin(2), label: "7.15% TEST BOND 15 May 2032", category: "bond",
      quantity: 10, cost_paise: 1000000, yield_bps: 715, as_of: "2026-10-31",
      source: "motilal" },
  ], (value) => value, "2026-11-14");
  assert.deepEqual(gaps, { manual: false, gaps: [] });
});

test("no cost is named on the holdings that lack it", () => {
  const gaps = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31", cost_source: "motilal", cost_as_of: "2026-10-31" }) }),
    [{ ...row(1), cost_paise: 100 }, row(2)], (value) => value, "2026-11-14");
  assert.deepEqual(gapText(gaps), ["No cost on 1 holding"]);
  const both = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31", cost_source: "motilal", cost_as_of: "2026-10-31" }) }),
    [row(1), row(2)], (value) => value, "2026-11-14");
  assert.deepEqual(gapText(both), ["No cost on 2 holdings"]);
});

test("cost behind the quantities names both dates", () => {
  const fmt = (value) => ({ "2026-11-05": "5 Nov 2026", "2026-11-12": "12 Nov 2026" }[value] || value);
  const stale = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-11-12", cost_source: "motilal", cost_as_of: "2026-11-05" }) }),
    [{ ...row(1), cost_paise: 100 }], fmt, "2026-11-14");
  assert.deepEqual(gapText(stale),
    ["Cost from 5 Nov 2026, older than the 12 Nov 2026 holdings"]);
  const even = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-11-12", cost_source: "motilal", cost_as_of: "2026-11-12" }) }),
    [{ ...row(1), cost_paise: 100 }], fmt, "2026-11-14");
  assert.deepEqual(even.gaps, []);
});

test("a bond with no coupon and no maturity is named once", () => {
  const gaps = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31" }) }), [
    { security_id: isin(2), label: "TEST BOND", category: "bond", quantity: 10,
      cost_paise: 100, as_of: "2026-10-31" },
    { security_id: isin(3), label: "TEST BOND TWO", category: "bond", quantity: 5,
      cost_paise: 100, as_of: "2026-10-31" },
  ], (value) => value, "2026-11-14");
  assert.deepEqual(gapText(gaps), ["A coupon or maturity is missing on 2 bonds"]);
});

test("one term is a gap: bondAnalytics needs both", () => {
  // A coupon without a date, or a date without a coupon, cannot be estimated
  // and the card cannot compute its anchor.
  const gaps = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31" }) }), [
    { security_id: isin(2), label: "7.15% TEST BOND", category: "bond", quantity: 1,
      cost_paise: 1, as_of: "2026-10-31" },
    { security_id: isin(3), label: "TEST BOND 15 May 2032", category: "bond", quantity: 1,
      cost_paise: 1, as_of: "2026-10-31" },
  ], (value) => value, "2026-11-14");
  assert.deepEqual(gapText(gaps), ["A coupon or maturity is missing on 2 bonds"]);
});

test("a matured or disposed row is history, not a gap", () => {
  const matured = { security_id: isin(2), label: "TEST BOND 15 May 2020", category: "bond",
    quantity: 10, as_of: "2026-10-31" };
  const sold = { ...matured, security_id: isin(3), quantity: 0, disposed_at: "2026-06-01" };
  const gaps = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31" }) }), [matured, sold], (value) => value, "2026-11-14");
  assert.deepEqual(gaps.gaps, []);
});

test("a typed account is offered what it could add, not told what is missing", () => {
  const gaps = importAccountGaps(account({ meta: "" }), [
    { security_id: isin(1), label: "TEST EQUITY", category: "equity", quantity: 5,
      as_of: "2026-10-01" },
    { security_id: isin(2), label: "TEST BOND", category: "bond", quantity: 10,
      as_of: "2026-10-01" },
  ], (value) => value, "2026-11-14");
  assert.equal(gaps.manual, true);
  assert.deepEqual(gapText(gaps),
    ["Could add cost for 2 holdings", "Could add the missing coupon or maturity for 1 bond"]);
  for (const gap of gaps.gaps) assert.doesNotMatch(gap.text, /^No /);
});

test("a typed account with dated rows is not called broker-only", () => {
  // A row date must not turn "no report yet" into a broker's name. The broker
  // pill and its warning are for an account a file actually named.
  const typed = importAccountSummary(account({ meta: "" }),
    [{ security_id: isin(1), quantity: 5, as_of: "2026-10-01" }],
    (value) => value, "2026-11-14");
  assert.equal(typed.label, "Holdings");
  assert.equal(typed.brokerOnly, false);
  const filed = importAccountSummary(account({ meta: meta({ holdings_source: "zerodha",
    holdings_as_of: "2026-10-01" }) }),
    [{ security_id: isin(1), quantity: 5, as_of: "2026-10-01" }], (value) => value,
    "2026-11-14");
  assert.equal(filed.label, "Broker-only", "a broker file still names its account");
});

test("a row a statement named is not a typed account", () => {
  // cas-apply stamps value_source and leaves the row source empty. That is
  // provenance, so the account is not hand-typed just because its meta is thin.
  const gaps = importAccountGaps(account({ meta: "" }),
    [{ ...row(1), cost_paise: 100, value_source: "CAS" }], (value) => value, "2026-11-14");
  assert.equal(gaps.manual, false);
  assert.deepEqual(gaps.gaps, []);
});

test("a hand-entered or fetched value does not file a typed account", () => {
  const typed = account({ meta: "" });
  const manual = [{ security_id: isin(2), label: "TEST BOND", category: "bond",
    quantity: 5, cost_paise: null, value_paise: 2500000, value_source: "Manual",
    as_of: "2026-10-01" }];
  const gaps = importAccountGaps(typed, manual, (value) => value, "2026-11-14");
  assert.equal(gaps.manual, true);
  assert.deepEqual(gapText(gaps),
    ["Could add cost for 1 holding", "Could add the missing coupon or maturity for 1 bond"]);
  assert.equal(bondGapBanner(typed, manual, "2026-11-14").text,
    "1 bond needs cost and terms — import a broker report",
    "a typed demat is still an import account");
  const bse = [{ ...manual[0], value_source: "BSE" }];
  assert.equal(importAccountGaps(typed, bse, (value) => value, "2026-11-14").manual,
    true, "a fetched price is not a file");
});

test("a CAS row with an empty source is not called unsourced", () => {
  // cas-apply writes every CAS row with an empty row source; the statement is
  // the account's source and the meta line already carries its date.
  const gaps = importAccountGaps(account({ meta: meta({ holdings_source: "cas",
    holdings_as_of: "2026-10-31", identity_source: "cas" }) }),
    [{ ...row(1), cost_paise: 100, value_source: "CAS", source: "" }],
    (value) => value, "2026-11-14");
  assert.deepEqual(gaps.gaps, []);
});

// A CAS-only bond lot: the name, ISIN, units and statement value arrived; the
// cost, coupon and maturity did not.
const bondLot = (n, over = {}) => ({
  security_id: isin(n), label: `TEST BOND ${n}`, category: "bond", quantity: 10,
  value_paise: 2500000, value_source: "CAS", as_of: "2026-10-31", ...over,
});
const filed = account({ meta: meta({ holdings_source: "cas",
  holdings_as_of: "2026-10-31" }) });

test("the banner names sixteen bonds that a broker report fills", () => {
  const lots = Array.from({ length: 16 }, (_, index) => bondLot(index + 20));
  const banner = bondGapBanner(filed, lots, "2026-11-14");
  assert.equal(banner.count, 16);
  assert.equal(banner.text,
    "16 bonds need cost and terms — import a broker report");
  const singular = bondGapBanner(filed, [bondLot(21)], "2026-11-14");
  assert.equal(singular.text, "1 bond needs cost and terms — import a broker report");
});

test("the banner is quiet when there is nothing a report can fill", () => {
  assert.equal(bondGapBanner(filed, [], "2026-11-14"), null);
  const complete = [bondLot(20, { cost_paise: 1000,
    label: "7.15% TEST BOND 15 May 2030" })];
  assert.equal(bondGapBanner(filed, complete, "2026-11-14"), null);
  const matured = [bondLot(21, { label: "TEST BOND 15 May 2020" })];
  assert.equal(bondGapBanner(filed, matured, "2026-11-14"), null,
    "a matured lot is awaiting payment, not work");
});

test("the banner says which input is missing when the lots disagree", () => {
  const mixed = [
    bondLot(20, { label: "7.15% TEST BOND 15 May 2030" }),
    bondLot(21, { cost_paise: 1000 }),
  ];
  assert.equal(bondGapBanner(filed, mixed, "2026-11-14").text,
    "2 bonds need cost or terms — import a broker report");
  const costOnly = [bondLot(20, { label: "7.15% TEST BOND 15 May 2030" })];
  assert.equal(bondGapBanner(filed, costOnly, "2026-11-14").text,
    "1 bond needs cost — import a broker report");
  const termsOnly = [bondLot(21, { cost_paise: 1000 })];
  assert.equal(bondGapBanner(filed, termsOnly, "2026-11-14").text,
    "1 bond needs terms — import a broker report");
});

test("a typed demat is an import account and gets the banner", () => {
  const typed = account({ meta: "" });
  const lots = [bondLot(20, { value_source: "", source: "" })];
  assert.equal(bondGapBanner(typed, lots, "2026-11-14").text,
    "1 bond needs cost and terms — import a broker report");
});

test("a bonds portfolio gets the banner, a cost-only record does not", () => {
  const bonds = account({ id: "bonds-1", category: "bonds", subtype: "bond" });
  assert.equal(bondGapBanner(bonds, [bondLot(20)], "2026-11-14").text,
    "1 bond needs cost and terms — import a broker report");
  const cost = account({ id: "cost-1", category: "bonds", subtype: "bond",
    meta: meta({ cost_only: true }) });
  assert.equal(bondGapBanner(cost, [bondLot(20)], "2026-11-14"), null);
});

test("the import gate follows the account, not the category", () => {
  assert.deepEqual(bondImportOf(account({ id: "demat-1", category: "demat" }),
    "demat-1"), { importable: true, importTarget: "demat-1", importVia: "broker" });
  assert.deepEqual(bondImportOf(account({ id: "typed-1", category: "demat",
    meta: "" }), "typed-1"),
  { importable: true, importTarget: "typed-1", importVia: "broker" });
  assert.deepEqual(bondImportOf(account({ id: "bonds-1", category: "bonds",
    subtype: "bond" }), "bonds-1"),
  { importable: true, importTarget: "bonds-1", importVia: "page" });
  assert.deepEqual(bondImportOf(account({ id: "cost-1", category: "bonds",
    subtype: "bond", meta: meta({ cost_only: true }) }), "cost-1"),
  { importable: false, importTarget: "", importVia: "page" });
});

test("a purchase yield alone is not a coupon in the gap list", () => {
  const gaps = importAccountGaps(filed, [bondLot(20, { cost_paise: 1000,
    label: "TEST BOND", yield_bps: 900 })], (value) => value, "2026-11-14");
  assert.deepEqual(gapText(gaps), ["A coupon or maturity is missing on 1 bond"]);
});

test("the disclosure prints the account sentences before the bond rows", () => {
  // The page's initial import gaps and the account card's sentences are one
  // function, so the two screens cannot drift.
  const lots = [bondLot(20), bondLot(21)];
  const gaps = importAccountGaps(filed, lots, (value) => value, "2026-11-14");
  assert.deepEqual(gaps.gaps.map((gap) => gap.text),
    ["No cost on 2 holdings", "A coupon or maturity is missing on 2 bonds"]);
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const card = html.slice(html.indexOf("function holdingsCard"),
    html.indexOf("// A demat account's holdings arrive"));
  assert.match(card, /const importGaps = importAccountGaps\(account, rows, dateLabel,\n\s*new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*\{ accounts: window\.bpGapAccountRows \|\| \[\],/);
  assert.match(card, /importGaps\.gaps\.map\(\(gap\) =>/);
  assert.match(card, /esc\(gap\.text\)/);
});

test("the bond page wires the banner before the summary and no filled button", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const card = html.slice(html.indexOf("function holdingsCard"),
    html.indexOf("// A demat account's holdings arrive"));
  assert.match(html, /function holdingsCard\(allRows, assetId, account\)/);
  assert.match(html, /holdingsCard\(shown, assetId, asset\)/);
  assert.match(html, /holdingsCard\(list, assetId, asset\)/);
  const sort = html.slice(html.indexOf("window.bpBondSort"),
    html.indexOf("// One press for the whole portfolio"));
  assert.match(sort, /window\.bpAssetsForFocus \|\| \[\]\)\.find/,
    "a re-render looks the account up again");
  assert.match(card, /const banner = bondGapBanner\(account, rows\)/);
  assert.match(card, /const importOf = bondImportOf\(account, assetId\)/);
  assert.match(card, /const \{ importTarget, importVia \} = importOf/);
  assert.match(card, /const atCost = assetAtCost\(account\)/,
    "the card follows the account's at-cost measure");
  assert.match(card, /atCost: atCost \|\| \(v\.value === null && v\.cost !== null\)/,
    "a cost-only lot stays at cost when a neighbour has a price");
  assert.match(card, /bondGapBannerHtml\(banner, importTarget, importVia\)/);
  assert.match(card, /needsFetch \|\| importGaps\.gaps\.length \? `<details class="needs-details">/);
  assert.doesNotMatch(card, /class="needs-details" open/,
    "the disclosure starts closed");
  assert.doesNotMatch(card, /Import broker report/,
    "the banner sentence is the only action wording");
  assert.match(card, /needsFetch && !banner \? "primary" : ""/);
  assert.match(card, /costNote = missingCost && !banner/);
  assert.match(card, /needsFetch \|\| importGaps\.gaps\.length \? ""/);
  assert.match(card, /summaryFigures/);
  assert.match(card, /data-empty="true"/, "an empty summary bar drops its chrome");
  assert.match(card, /const marketViews = views\.filter\(\(v\) => v\.value !== null\)/);
  assert.match(card, /market value \$\{moneyOrDash\(marketValue\)\}/);
  assert.match(card, /bondCoverageText\(summary\.costed, summary\.count, "costed"\)/);
  assert.match(card, /class="bs-scope"/);
  assert.match(card, /data-scope="true"/);
  assert.match(card, /const costedCount = views\.filter/);
  assert.match(card, /bondCoverageText\(costedCount, views\.length, "costed"\)/);
  assert.match(card, /bondCoverageText\(marketViews\.length, views\.length, "priced"\)/);
  assert.doesNotMatch(card, /moneyOrDash\(s\.value\)/,
    "the statement value never reaches the market-value slot");
  assert.match(card, /const showHoldFigures = s\.cost !== null \|\| marketValue !== null/);
  assert.match(card, /needsFetch \? missingLine : showHoldFigures \? figuresLine : ""/);
  const disclosure = card.indexOf("needs-details");
  const banner = card.indexOf("bondGapBannerHtml(banner, importTarget, importVia)");
  const summary = card.indexOf("${summaryBar}");
  assert.ok(disclosure > -1 && banner > disclosure && summary > banner,
    "the banner sits after the disclosure and before the summary bar");
  const css = html.slice(0, html.indexOf("</style>"));
  assert.match(css, /\.bond-gap-line\{[^}]*font-size:13\.5px/);
  assert.match(css, /\.bond-gap-banner\{[^}]*border-radius:10px/);
  assert.match(css, /\.bond-gap-link:focus-visible/);
  assert.match(css, /\.bond-gap-banner:focus-visible/);
  assert.match(css, /@media \(pointer:coarse\)\{\.bond-gap-banner\{min-height:44px\}\}/);
  assert.match(css, /\.bond-summary\[data-empty="true"\]\{position:static;border:0;background:none;padding:0;justify-content:flex-end\}/);
  assert.match(css, /\.bond-summary\[data-scope="true"\]\{flex-wrap:wrap\}/);
  assert.match(css, /\.bond-summary \.bs-scope\{[^}]*font-size:11px/);
  assert.match(css, /\.bond-matured-gap\{[^}]*font-size:12px/);
  assert.doesNotMatch(css, /\.bond-gap-banner \.btn/,
    "the banner is the action, not a box around one");
});

test("the guide names three reports and claims nothing live", () => {
  assert.equal(IMPORT_REPORT_GUIDE.sources.length, 3);
  const names = IMPORT_REPORT_GUIDE.sources.map((source) => source.source).join("|");
  assert.match(names, /CAS/);
  assert.match(names, /Broker holdings report/);
  assert.match(names, /Transaction statement/);
  assert.match(IMPORT_REPORT_GUIDE.note, /month-end quantities/);
  assert.match(IMPORT_REPORT_GUIDE.note, /on your schedule/);
  assert.doesNotMatch(IMPORT_REPORT_GUIDE.note, /live|real-time|automatic/i);
});

test("the accounts card names gaps and holds one closed guide", () => {
  const render = between("function bpImportAccountsHtml", "function bpImportAccountsRender");
  assert.match(render, /importAccountGaps\(row\.account, row\.holdings, dateLabel,\n\s*new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s*\{ accounts: state\.accountRows,/);
  assert.match(render, /import-account-gap/);
  assert.match(render, /<summary>Which report\?<\/summary>/);
  assert.match(render, /IMPORT_REPORT_GUIDE\.sources/);
  assert.match(render, /!gap\.manual && gap\.gaps\.length/,
    "the guide appears only when a file can fill a gap");
  assert.equal((html.match(/Which report\?/g) || []).length, 1,
    "one disclosure on the card, not one per account");
});

// --- one plan per resolved account ------------------------------------------

test("the inbox groups resolved files into plans, not family bundles", () => {
  const prepare = between("async function bpImportInboxPrepare", "function bpImportInboxEntryError");
  assert.match(prepare, /state\.plans = bpImportPlans\(/,
    "the prepare step regroups once resolution has run");
  const plans = between("function bpImportPlans", "async function bpImportInboxPrepare");
  assert.match(plans, /groupResolvedPlans\(/,
    "the grouping key is the account each file resolved to");
  assert.match(html, /function bpImportPlanForBundles\(/);
});

test("a plan with nothing to write says why and disables its primary", () => {
  assert.match(html, /const noWork = plan\.noWorkCopy \|\| null/);
  assert.match(html, /plan\.noWork \? "Nothing to import yet"/);
  assert.match(html, /plan\.ready && !state\.applying && !plan\.noWork/);
  assert.match(html, /bpImportNoWorkAccountHtml\(bundle\)/);
  assert.match(html, /noWork\.next/);
  assert.match(html, /const noWork = !splitCas && !extraBlocked/);
  assert.match(html, /const removal = bpImportRemovals\(head\)/);
  assert.match(html, /\+ \(composed\.summary\.ask \|\| 0\) \+ removal\.count/);
  assert.match(html, /writes === 0 && !identityChange/);
  assert.match(html, /const reviewable = plans\.some\(\(plan\) => !plan\.noWork\)/);
});

test("the pending card has one reason, one row per decision, and no not-change block", () => {
  const card = between("function bpImportPlanHtml", "function bpImportInboxSettleStatus");
  assert.match(card, /<summary>More<\/summary>/);
  assert.doesNotMatch(card, /What will not change/,
    "the not-change block is gone from the card");
  assert.doesNotMatch(card, /Other accounts with overlapping ISINs/,
    "the chosen account row already says which account changes");
  assert.match(card, /bpImportDecisionsHtml\(askItems\)/);
  assert.match(card, /import-reason/);
  assert.match(card, /Use the file's values · \$\{summary\.ask\}/);
});

test("a decision row is a structured line with its evidence behind it", () => {
  const fields = between("function bpImportDecisionField", "function bpImportDecisionRow");
  assert.match(fields, /qty/);
  assert.match(fields, /cost/);
  assert.match(fields, /date/);
  const row = between("function bpImportDecisionRow", "function bpImportDecisionDetail");
  assert.match(row, /import-decision-line/);
  assert.match(row, /import-decision-facts/);
  const detail = between("function bpImportDecisionParts", "function bpImportDecisionRow");
  assert.match(detail, /source/);
  assert.match(detail, /fromSource/);
  assert.match(detail, /asOf/);
  assert.match(detail, /label/);
});

test("a small update set names the rows instead of a bare count", () => {
  const names = between("function bpImportPlanUpdateNames", "function bpImportReceiptsHtml");
  assert.match(names, /names\.length <= 3/);
  assert.match(names, /Update \$\{count\}: \$\{names\.join\(", "\)\}/);
  assert.match(names, /length <= 48/);
  assert.match(names, /names.join\(", "\)/,
    "a hidden list is still spelled out in the disclosure");
});

test("a broker file with no match attaches to its broker's demat instead of creating one", () => {
  const resolve = between("function bpImportResolveBroker", "function bpImportResolveCas");
  assert.match(resolve, /brokerDematAccounts\(bundle\.family, accounts\)/);
  assert.match(resolve, /brokerAccount: true/);
  assert.match(resolve, /bundle\.create = bundle\.canCreate && !!bundle\.base/);
  assert.match(html, /Attach to \$\{label\}/);
});

test("the file line names both formats when one tradebook arrived twice", () => {
  assert.match(html, /duplicateFileLabel\(file\)/);
  assert.match(html, /const meta = \(file\.duplicates \|\| \[\]\)\.length/);
});

test("dropping one format drops the copy it was folded into", () => {
  const helper = between("function bpImportBundleEntryIds",
    "function bpImportBrokerContribution");
  assert.match(helper, /file\.duplicates/);
  const drop = between("window.bpImportDropPlan", "function bpImportScrollBehavior");
  assert.match(drop, /bpImportBundleEntryIds\(bundles\)/);
  const entry = between("window.bpImportDropEntry", "window.bpImportInboxRetry");
  assert.match(entry, /bpImportBundleEntryIds\(bundles\)/);
  assert.match(entry, /duplicate\.entryId/);
});

test("the inbox renders one card per plan and one confirmation per card", () => {
  assert.match(html, /const plans = state\.plans \|\| \[\]/);
  assert.match(html, /\$\{plans\.map\(bpImportPlanHtml\)\.join\(""\)\}/);
  assert.equal(/bpImportApplyBundle/.test(html), false,
    "the per-family-bundle confirmation is gone");
  const apply = between("window.bpImportApplyPlan = async", "window.bpImportApplyAll");
  assert.match(apply, /for \(const extra of plan\.extras\)/);
  assert.match(apply, /bpImportApplyBroker\(/);
});

test("a plan checks every file before the head writer runs", () => {
  const apply = between("window.bpImportApplyPlan = async", "window.bpImportApplyAll");
  const guard = apply.indexOf("bpImportPlanBlockedReceipt(plan)");
  const write = apply.indexOf("bpImportApplyCas(plan.head");
  assert.ok(guard >= 0, "the plan has a blocked-file pre-flight");
  assert.ok(write > guard, "the pre-flight runs before any writer");
  assert.match(apply, /Nothing was written/);
});

test("a plan's extra receipt is planned after the head file's rows", () => {
  const plans = between("function bpImportPlanForBundles", "function bpImportPlans");
  assert.match(plans, /planImportChains\(\{/);
  assert.match(plans, /extras/);
});

// --- a statement with movements stays its own card --------------------------

test("the inbox locks a statement that records movements", () => {
  const plans = between("function bpImportPlans", "async function bpImportInboxPrepare");
  assert.match(plans, /locked:/,
    "a statement with movements is locked out of a broker's plan");
  assert.match(plans, /base\?\.parsed\?\.transactions/);
  assert.match(html, /import it first to keep its cost on the disposal/);
});

test("the card shows every ask it can accept", () => {
  const asks = between("function bpImportAskDecisions", "function bpImportPlanAskItems");
  assert.doesNotMatch(asks, /\.slice\(/, "the head's ask list is not truncated");
  const planAsks = between("function bpImportPlanAskItems", "function bpImportDecisionsHtml");
  assert.doesNotMatch(planAsks, /\.slice\(/, "the extras' ask list is not truncated");
});

test("the card counts the net plan change, not the sum of its files", () => {
  const items = between("function bpImportPlanItems", "function bpImportReceiptsHtml");
  assert.match(items, /const net = plan\.net \|\| \{\}/);
  assert.match(items, /net\.added/);
  assert.match(items, /net\.updated/);
  assert.match(items, /net\.history/);
  assert.match(items, /plan\.removals/);
  assert.match(items, /bpImportRemovalLine\(plan\)/,
    "the removal the writer will perform is a named line, not a hidden count");
  assert.doesNotMatch(items, /summary\.added|summary\.updated|summary\.history/,
    "the headline is the net, not the summed receipts");
  assert.equal(/adds \$\{summary\.added\}|updates \$\{summary\.updated\}/.test(items), false,
    "per-file lines do not repeat additive counts");
});

test("the card and the receipt count every account the plan writes", () => {
  const plans = between("function bpImportPlanForBundles", "function bpImportPlans");
  // A folio that is kept or still undecided writes no account, so it must not
  // inflate the count.
  assert.match(plans, /statementAccounts\(\(head\.casTargets \|\| \[\]\)\.filter/);
  assert.match(plans, /target\.action !== "kept" && target\.action !== "decide"/);
  assert.match(html, /plan\.accountCount > 1/);
  const apply = between("window.bpImportApplyPlan = async", "window.bpImportApplyAll");
  assert.match(apply, /plan\.accountCount > 1/);
});

test("a movement statement's card is gated on the broker that funds its disposal", () => {
  const plans = between("function bpImportPlans", "async function bpImportInboxPrepare");
  assert.match(plans, /movementGate\(\{/);
  assert.match(plans, /plan\.gate = /);
  assert.match(plans, /if \(plan\.gate\) plan\.ready = false/);
  assert.match(plans, /eventPlan\?\.rows/, "the gate reads the disposal the writer will make");
  assert.match(plans, /row\.disposed_at/);
  assert.match(plans, /!target\.plan\?\.identityOnly/);
  assert.match(plans, /accountId: target\.targetId/);
  assert.match(html, /function bpImportPlanChanges/);
  assert.match(html, /function bpImportPlanDateBlocked/);
  assert.match(html, /Import the \$\{esc\(plan\.gate\.label\)\} report first/);
  assert.match(html, /bpImportGoToPlan/);
  const apply = between("window.bpImportApplyPlan = async", "window.bpImportApplyAll");
  assert.match(apply, /if \(plan\.gate\)/);
});

test("the batch closes through the ready flag and reports the net", () => {
  const render = between("function bpImportInboxRender", "async function bpImportInboxReadOne");
  assert.match(render, /plans\.length > 0 && plans\.every\(\(plan\) => plan\.ready\)/);
  const all = between("window.bpImportApplyAll = async", "window.bpImportUseWrongCas");
  assert.doesNotMatch(all, /plan\.gate/,
    "Import all is closed by the ready flag, not a gate special case");
  assert.match(all, /plan\.net\?\.added/);
  assert.match(all, /plan\.net\?\.updated/);
  assert.match(all, /plan\.net\?\.history/);
});

test("the batch offers Import all only when every plan can run", () => {
  // A dead primary that keeps the accent fill competes with the gate message.
  // Only the action is absent until it can act.
  const render = between("function bpImportInboxRender", "async function bpImportInboxReadOne");
  assert.match(render, /\$\{allReady\s*\n?\s*\? `<button class="btn primary"/,
    "the button is rendered by the ready flag, not disabled by it");
  assert.doesNotMatch(render, /class="btn primary" disabled[\s\S]{0,60}Import all/,
    "there is no disabled Import all left in the batch");
  assert.match(render, /bpImportBatchState\(plans\)/);
  assert.doesNotMatch(render, /Selection order does not matter|Import all appears when/,
    "the bar states its state and explains nothing about itself");
});

test("the batch says ready or names the choice", () => {
  const state = between("function bpImportBatchState", "// One password gate");
  assert.match(state, /Ready to import/);
  assert.match(state, /\$\{choices === 1 \? "" : "s"\} need\$\{choices === 1 \? "s" : ""\} a choice/);
  assert.match(state, /nothing to import/);
});

test("the page status names the first missing thing and counts the rest", () => {
  const settle = between("function bpImportPlanMissing", "function bpImportInboxRender");
  assert.match(settle, /Choose an account for \$\{title\}/);
  assert.match(settle, /and \$\{waiting\.length - 1\} more/);
  assert.match(settle, /Add a file to start\./);
  assert.doesNotMatch(settle, /Check the file messages above/,
    "the page never sends the person hunting for a message");
});

test("the card leads with its title, one metric line and one state line", () => {
  const card = between("function bpImportPlanHtml", "function bpImportPlanMissing");
  assert.doesNotMatch(card, /Selection order does not matter|No CAS is needed/,
    "self-description is gone from the card");
  assert.doesNotMatch(card, /plan\.files\.length[\s\S]{0,40}file/,
    "the file count moved behind More");
  assert.match(card, /Nothing is written until you press Import\./,
    "consent stays visible beside the primary action");
  assert.match(card, /<details class="import-change-more"><summary>More<\/summary>/);
});

test("a sold-sale ask keeps its consequence behind the decision", () => {
  const reason = between("function bpImportAskReason", "function bpImportReceiptRole");
  assert.match(reason, /or a recorded sale/);
  const parts = between("function bpImportDecisionParts", "function bpImportDecisionRow");
  assert.match(parts, /sold-conflict/);
  assert.match(parts, /decision\.reason/,
    "the row detail keeps the consequence of accepting a sold decision");
});

test("a plan of one holding says holding, not holdings", () => {
  assert.equal(importPlanPrimary({ family: "cas", planned: 1 }), "Import 1 holding");
  assert.equal(importPlanPrimary({ family: "cas", planned: 3 }), "Import 3 holdings");
  assert.equal(importPlanPrimary({ family: "motilal", planned: 1 }), "Import 1 holding");
  assert.equal(importPlanPrimary({ family: "zerodha", planned: 1 }), "Import 1 equity");
  assert.equal(importPlanPrimary({ family: "zerodha", planned: 2 }), "Import 2 equities");
  assert.equal(importPlanPrimary({ family: "zerodha", planned: 1,
    categories: ["mf"] }), "Import 1 fund");
  assert.equal(importPlanPrimary({ family: "zerodha", planned: 2,
    categories: ["mf"] }), "Import 2 funds");
  assert.equal(importPlanPrimary({ family: "zerodha", planned: 5,
    categories: ["equity", "mf"] }), "Import 5 holdings");
  assert.equal(importPlanPrimary({ family: "motilal", planned: 1, create: true }),
    "Create account and import 1 holding");
  assert.equal(importPlanPrimary({ family: "cas", planned: 0, sales: 1 }), "Record 1 sale");
  assert.equal(importPlanPrimary({ family: "cas", planned: 0, sales: 2 }), "Record 2 sales");
  assert.equal(importPlanPrimary({ family: "cas", identityOnly: true }),
    "Attach identity and fill empty values");
  assert.equal(importPlanPrimary({ family: "cas" }), "Attach identity");
  // A cost basis on a recorded disposal is not a holding, and a plan with
  // nothing to write says so instead of importing zero of them.
  assert.equal(importPlanPrimary({ family: "motilal", soldCost: 1 }),
    "Record the sold cost basis");
  assert.equal(importPlanPrimary({ family: "motilal", soldCost: 2 }),
    "Record the sold cost basis on 2 disposals");
  assert.equal(importPlanPrimary({ family: "motilal", planned: 1, soldCost: 1 }),
    "Import 1 holding");
  assert.equal(importPlanPrimary({ family: "motilal" }), "Nothing to change");
  assert.equal(importPlanPrimary({ family: "motilal", attachIdentity: true }),
    "Attach the account identity");
});

test("a removal-only CAS names the removal in the primary", () => {
  // The inbox label lives beside the card, so the removal branch is here, not
  // inside importPlanPrimary: a CAS plan with zero adds must not fall through
  // to "Attach identity" while it deletes rows.
  const label = between("function bpImportPrimaryLabel", "function bpImportPlanHtml");
  assert.match(label, /Remove \$\{count\} demat holding/);
  assert.match(label, /and remove \$\{count\}/);
  assert.match(label, /and import/);
  assert.match(html, /: plan\.removals \? bpImportPrimaryLabel\(plan, planned\)/);
});

test("a buy-only movement card says movements, not disposals", () => {
  const plans = between("function bpImportPlanForBundles", "function bpImportPlans");
  assert.match(plans, /hasDebit/);
  assert.match(plans, /This statement records movements/);
  assert.match(plans, /This statement records disposals/);
});

test("a demat identity never matches a fund folio by ISIN overlap", () => {
  const folio = account({ id: "folio-1", label: "Test Mutual Fund",
    subtype: "mutual fund", type: "mf", number: "90000001234",
    meta: meta({ folios: ["90000001234"] }), holdings: [row(1)] });
  const file = { accountKey: "1200000012345678", accountKind: "bo",
    rows: [row(1)] };
  assert.deepEqual(accountMatches(file, [folio], { forCas: true }).matches, []);
  // A broker report is a custody report too, so its BO ID cannot land there.
  assert.deepEqual(accountMatches(file, [folio]).matches, []);
});

test("a fund identity never matches a custody account that carries the number", () => {
  const demat = account({ id: "demat-1", subtype: "equity", type: "equity",
    number: "1200000012345678",
    meta: meta({ folios: ["90000001234"] }), holdings: [row(1)] });
  const file = { accountKey: "90000001234", accountKind: "folio",
    rows: [row(1)] };
  assert.deepEqual(accountMatches(file, [demat], { forCas: true }).matches, []);
});

test("a CAS with no readable account number does not attach to a fund account", () => {
  const folio = account({ id: "folio-1", subtype: "mutual fund", type: "mf",
    number: "90000001234", holdings: [row(1)] });
  assert.deepEqual(accountMatches({ rows: [row(1)] }, [folio],
    { forCas: true }).matches, []);
});

test("the Import intro is the three file types, not a reassurance paragraph", () => {
  const intro = between('<div class="import-intro">', '<div class="card pad import-inbox-card">');
  assert.match(intro, /Files you can add/);
  assert.match(intro, /Depository statement \(CAS\) — CDSL or NSDL, after month end/);
  assert.match(intro, /Broker holdings report — Zerodha, Motilal Oswal, DigiFInn/);
  assert.match(intro, /Bank statement — CSV, XLSX or PDF/);
  assert.doesNotMatch(intro, /logins, OTPs and PINs/i);
  assert.doesNotMatch(intro, /Nothing is saved until you confirm/);
  assert.equal((html.match(/Bank and broker logins, OTPs and PINs are never\s+requested\./g) || [])
    .length, 1, "the login line survives once, inside What can I add?");
});

test("What can I add is the download steps and the format, not the rationale", () => {
  const guide = between('<details class="import-help" id="import-help" open>',
    '<div id="import-inbox-status"');
  assert.match(guide, /<b>Depository statement \(CAS\) PDF<\/b>/);
  assert.match(guide, /Format: PDF\. Password: your PAN/);
  assert.match(guide, /<b>Bank statement CSV, XLSX or PDF<\/b>/);
  assert.match(guide, /not a\s+scan/);
  // One broker surface, not a wall of every broker's steps above a second copy.
  assert.match(guide, /\$\{brokerImportBodyHtml\(\)\}/);
  assert.equal((html.match(/\$\{brokerImportBodyHtml\(\)\}/g) || []).length, 1,
    "the broker picker renders in one place");
  assert.doesNotMatch(guide, /A broker report can start an account on its own/);
  assert.doesNotMatch(guide, /It fills invested for matching ISINs/);
  assert.doesNotMatch(guide, /market price and market value are ignored/);
  assert.doesNotMatch(guide, /One demat holds bonds/);
});

test("the guide ships open and carries no queue state", () => {
  assert.match(html, /<details class="import-help" id="import-help" open>/);
  assert.doesNotMatch(html, /helpManual|bpImportHelpSync|bpImportStagedCount|importGuideOpen/);
});

test("the picker carries its broker's steps and format, once", () => {
  const zerodha = between("function zerodhaImportGuideHtml", "function motilalImportGuideHtml");
  assert.match(zerodha, /Format: XLSX, not CSV/);
  assert.match(zerodha, /Portfolio → Holdings/);
  const motilal = between("function motilalImportGuideHtml", "function digifinnImportReportsHtml");
  assert.match(motilal, /Format: PDF, not XLSX or CSV/);
  assert.match(motilal, /Since Inception/);
  const icici = between("function iciciImportGuideHtml", "function brokerImportBodyHtml");
  assert.match(icici, /Demat Holdings/);
  assert.match(icici, /Format: CSV/);
  assert.match(icici, /bpImportInboxAdd/);
});

test("erasing the browser deletes the database file, not just its rows", () => {
  const erase = between('if (b.dataset.act === "erase")', 'location.replace("/")');
  assert.match(erase, /store\.eraseDb\(\)/,
    "an erase must delete the sealed file, or the next visit asks for its passphrase");
  assert.doesNotMatch(erase, /store\.clearAll\(\)/);
  assert.match(erase, /store\.isUnlocked\(\)/,
    "a locked database is not snapshotted, so erasing never asks for its passphrase");
});
