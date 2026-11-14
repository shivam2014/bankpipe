import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSecuritiesAccount, isImportAccount, isDepositoryAccount } from "./assets.js";
import { accountMatches, groupBundles, importAccountSummary } from "./import-flow.js";

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
