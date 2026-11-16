import test from "node:test";
import assert from "node:assert/strict";
import { casRoute } from "./cas.js";
import { casGroupByAsset, casReplacePlan } from "./cas-apply.js";
import { assetMetrics } from "./finance.js";
import { accountFolios, folioAdoptedHome, folioHome, folioKey,
  folioAdoptionPlan, folioOwnership, normalizeFolio } from "./folio.js";

// A registrar prints a check digit after the folio number. A zero check digit
// is the same folio; every other suffix is a different position. Synthetic
// values only.
const DEMAT = "IN99990001344321";
const BASE = "90000001234";
const PRINTED = "90000001234/0";
const ISIN = "INF000000777";

const demat = {
  id: "d1", label: "Demat · NSDL", category: "demat", subtype: "equity",
  number: DEMAT,
};

const valueOnly = (over = {}) => ({
  id: "axis-value",
  label: "Axis mutual fund",
  bank: "Axis",
  category: "demat",
  subtype: "mutual fund",
  type: "mf",
  number: BASE,
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    current_value_paise: 31000000 }),
  ...over,
});

// The duplicate an earlier bad import leaves behind: the same canonical folio
// on a manual total and on an account that already holds units.
const settled = (over = {}) => ({
  id: "axis-settled",
  label: "Axis mutual fund · folio …8993",
  category: "demat",
  subtype: "mutual fund",
  type: "mf",
  number: PRINTED,
  holdings: [{ security_id: ISIN, quantity: 90, value_paise: 30000000 }],
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    folios: [PRINTED] }),
  ...over,
});

const casFund = (over = {}) => ({
  isin: ISIN,
  label: "Axis Bluechip Fund - Direct Plan - Growth",
  kind: "mf",
  category: "mf",
  folio: PRINTED,
  amc: "Axis",
  amcFull: "Axis Mutual Fund",
  quantity: 100,
  valuePaise: 32453600,
  costPaise: 24000000,
  account: DEMAT,
  ...over,
});

const parsed = (holdings) => ({
  depository: "CDSL",
  demat: DEMAT,
  accounts: [{ boId: DEMAT, dpName: "Test DP", holdings }],
  holdings,
  transactions: [],
});

test("a zero check digit is the same folio and every other suffix is not", () => {
  assert.equal(normalizeFolio(PRINTED), BASE);
  assert.equal(normalizeFolio(" X / 0 "), "x");
  // One suffix is stripped, not a chain of them.
  assert.equal(normalizeFolio("90000001234/0/0"), "90000001234/0");
  assert.equal(normalizeFolio("90000001234/1"), "90000001234/1");
  assert.equal(normalizeFolio("12345/68"), "12345/68");
  assert.equal(normalizeFolio("90000001234/00"), "90000001234/00");
  assert.notEqual(normalizeFolio("90000001234/1"), normalizeFolio(BASE));
  assert.notEqual(normalizeFolio("90000001234/68"), normalizeFolio(BASE));
  assert.notEqual(normalizeFolio("90000001234/00"), normalizeFolio(BASE));
  // The existing PDF clean-up still applies before the check digit is read.
  assert.equal(normalizeFolio("123\u00AD/4\u200B"), "123/4");
  assert.equal(normalizeFolio("90000001234/\u00AD0"), BASE);
});

test("a reference note in the number column is not a folio", () => {
  const reference = valueOnly({ number: "Payment From 000000000000" });
  assert.deepEqual(accountFolios(reference), []);
  assert.deepEqual(accountFolios(valueOnly()), [BASE]);
});

test("an account that prints one folio two ways answers to one identity", () => {
  const account = valueOnly({ number: PRINTED,
    meta: JSON.stringify({ amc: "axis", folios: [PRINTED, BASE] }) });
  assert.deepEqual(accountFolios(account), [BASE]);
});

test("the exact folio is offered, with no target until a choice is made", () => {
  const holding = casFund();
  const plan = folioAdoptionPlan({ holdings: [holding],
    accounts: [demat, valueOnly()], rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  const offer = plan.offers[0];
  assert.equal(offer.basis, "folio");
  assert.equal(offer.state, "offer");
  assert.equal(offer.chosen, "");
  assert.deepEqual(plan.targets, {});
  assert.equal(offer.candidates.length, 1);
  assert.equal(offer.candidates[0].id, "axis-value");
  assert.equal(offer.candidates[0].valuePaise, 31000000);
});

test("adopt routes to the existing id, keep writes nothing, create is not offered", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const accounts = [demat, valueOnly()];

  const adopted = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: () => [], choices: { [key]: "axis-value" } });
  assert.equal(adopted.offers[0].state, "adopt");
  assert.equal(adopted.offers[0].chosen, "axis-value");
  assert.deepEqual(adopted.targets, { [key]: "axis-value" });

  const kept = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: () => [], choices: { [key]: "__skip__" } });
  assert.equal(kept.offers[0].state, "kept");
  assert.equal(kept.offers[0].chosen, "__skip__");
  assert.deepEqual(kept.targets, {});

  // A second account with the same canonical folio is the duplicate this rule
  // exists to prevent, so the exact offer never carries a create answer.
  const created = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: () => [], choices: { [key]: "__create__" } });
  assert.equal(created.offers[0].state, "offer");
  assert.deepEqual(created.targets, {});
});

test("a lookalike without the folio keeps the adopt or keep-both choice", () => {
  const holding = casFund();
  const guess = valueOnly({ id: "axis-guess", label: "Axis Bluechip Fund",
    number: "", meta: JSON.stringify({ current_value_paise: 31000000 }) });
  const key = folioKey(holding);
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [demat, guess],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].basis, "guess");
  const create = folioAdoptionPlan({ holdings: [holding], accounts: [demat, guess],
    rowsOf: () => [], choices: { [key]: "__create__" } });
  assert.equal(create.offers[0].chosen, "__create__");
  assert.deepEqual(create.targets, {});
});

test("the route keeps the value-only home out until the exact choice", () => {
  const holding = casFund();
  const assets = [demat, valueOnly()];
  const key = folioKey(holding);

  const none = casRoute(parsed([holding]), assets);
  assert.equal(none.groups.length, 0);
  assert.equal(none.homeless.length, 1);
  assert.equal(none.homeless[0].folioNo, PRINTED);

  const adopted = casRoute(parsed([holding]), assets,
    { adopt: { [key]: "axis-value" } });
  assert.equal(adopted.groups.length, 1);
  assert.equal(adopted.groups[0].assetId, "axis-value");
  assert.equal(adopted.homeless.length, 0);

  const kept = casRoute(parsed([holding]), assets,
    { adopt: { [key]: "__skip__" } });
  assert.equal(kept.groups.length, 0);
  assert.equal(kept.homeless.length, 1);
});

test("a nil holdings list fails closed: no automatic write into a manual total", () => {
  const holding = casFund();
  const bare = valueOnly();
  delete bare.holdings;
  const route = casRoute(parsed([holding]), [demat, bare]);
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.length, 1);
});

test("one suffix away from zero is a different folio and no offer", () => {
  const holding = casFund({ folio: "90000001234/1" });
  const assets = [demat, valueOnly()];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: assets,
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 0);
  const route = casRoute(parsed([holding]), assets);
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.length, 1);
});

test("the same folio printed two ways is one group, one offer and one key", () => {
  const one = casFund({ isin: "INF000000778", folio: BASE });
  const two = casFund();
  const assets = [demat, valueOnly()];
  assert.equal(folioKey(one), folioKey(two));
  const plan = folioAdoptionPlan({ holdings: [one, two], accounts: assets,
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].candidates.length, 1);
  const route = casRoute(parsed([one, two]), assets);
  const folios = route.homeless.filter((group) => group.folio);
  assert.equal(folios.length, 1);
  assert.equal(folios[0].count, 2);
  assert.equal(folios[0].valuePaise, 32453600 * 2);
});

test("an explicit adoption writes one position and replaces the manual total", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const accounts = [demat, valueOnly()];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: () => [], choices: { [key]: "axis-value" } });
  const route = casRoute(parsed([holding]), accounts, { adopt: plan.targets });
  const rows = casGroupByAsset({ holdings: [holding], groups: route.groups })
    .get("axis-value") || [];
  const write = casReplacePlan({ parsed: parsed([holding]), existing: [],
    holdings: rows, assetId: "axis-value", asOf: "2026-09-30",
    confirmed: true, merge: true });
  assert.equal(write.rows.length, 1);
  assert.equal(write.rows[0].security_id, ISIN);
  assert.equal(write.rows[0].quantity, 100);
  assert.equal(write.rows[0].value_paise, 32453600);
  assert.equal(write.rows[0].cost_paise, 24000000);
  const after = assetMetrics({
    ...valueOnly(), holdings_count: 1, holdings_value: 32453600,
    holdings_cost: 24000000,
    meta: JSON.stringify({ amc: "axis", folios: [PRINTED] }),
  }, "demat").value;
  assert.equal(after, 32453600);
});

test("keeping the manual total leaves the one position at 3,10,000", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const accounts = [demat, valueOnly()];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: () => [], choices: { [key]: "__skip__" } });
  const route = casRoute(parsed([holding]), accounts, { adopt: plan.targets });
  const rows = casGroupByAsset({ holdings: [holding], groups: route.groups });
  assert.equal(rows.size, 0);
  assert.equal(assetMetrics(valueOnly(), "demat").value, 31000000);
});

test("after adoption the folio is a plain home and no offer appears again", () => {
  const holding = casFund();
  const adopted = valueOnly({
    holdings: [{ security_id: ISIN, quantity: 100, value_paise: 32453600,
      cost_paise: 24000000 }],
    meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
      folios: [PRINTED] }),
  });
  const accounts = [demat, adopted];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: (id) => id === "axis-value" ? adopted.holdings : [] });
  assert.equal(plan.offers.length, 0);
  assert.deepEqual(plan.targets, {});
  const route = casRoute(parsed([holding]), accounts);
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].assetId, "axis-value");
  assert.equal(route.homeless.length, 0);
});

test("the adopted home accepts this folio and refuses a different one", () => {
  const assets = [demat, valueOnly()];
  assert.equal(folioAdoptedHome(casFund(), assets,
    { [folioKey(casFund())]: "axis-value" })?.id, "axis-value");
  const near = casFund({ folio: "90000001234/1" });
  assert.equal(folioAdoptedHome(near, assets, { [folioKey(near)]: "axis-value" }), null);
  // A manual record that has since gained rows is no longer value-only.
  const gained = valueOnly({ holdings: [{ security_id: ISIN, quantity: 1 }] });
  assert.equal(folioAdoptedHome(casFund(), [demat, gained],
    { [folioKey(casFund())]: "axis-value" }), null);
  // A manual total is never the home on its own; the exact choice is.
  assert.equal(folioHome(casFund(), assets), null);
  assert.equal(folioHome(near, assets), null);
});

test("two exact value-only accounts stay a choice, not a silent pick", () => {
  const holding = casFund();
  const second = valueOnly({ id: "axis-value-2", label: "Axis mutual fund two" });
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [demat, valueOnly(), second],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].basis, "folio");
  assert.equal(plan.offers[0].state, "offer");
  assert.equal(plan.offers[0].choosable.length, 2);
  assert.deepEqual(plan.targets, {});
});

test("a settled owner wins over a manual total whatever the account order", () => {
  const holding = casFund();
  const rowsOf = (id) => (id === "axis-settled" ? settled().holdings : []);
  const manualFirst = [demat, valueOnly(), settled()];
  const settledFirst = [demat, settled(), valueOnly()];
  for (const accounts of [manualFirst, settledFirst]) {
    // One folio is one position. The account that already holds units is that
    // position, so no offer is made over it and the route lands there.
    const plan = folioAdoptionPlan({ holdings: [holding], accounts, rowsOf });
    assert.equal(plan.offers.length, 0);
    assert.deepEqual(plan.targets, {});
    const route = casRoute(parsed([holding]), accounts);
    assert.equal(route.groups.length, 1);
    assert.equal(route.groups[0].assetId, "axis-settled");
    assert.equal(route.homeless.length, 0);
  }
});

test("a settled owner beats a manual total without a caller-supplied predicate", () => {
  const holding = casFund();
  assert.equal(folioHome(holding, [valueOnly(), settled()])?.id, "axis-settled");
  assert.equal(folioHome(holding, [settled(), valueOnly()])?.id, "axis-settled");
  // A manual total is not a home on its own; the offer is still the only way in.
  assert.equal(folioHome(holding, [valueOnly()]), null);
});

test("two settled owners with no AMC tie are contested, not picked by order", () => {
  const holding = casFund();
  const second = settled({ id: "axis-settled-2", label: "Axis folio two" });
  const accounts = [demat, valueOnly(), settled(), second];
  const rowsOf = (id) => (accounts.find((account) => account.id === id)?.holdings || []);
  assert.equal(folioHome(holding, accounts), null);
  const plan = folioAdoptionPlan({ holdings: [holding], accounts, rowsOf });
  // A manual total is not offered over two positions, and neither position is
  // picked by label or array order.
  assert.equal(plan.offers.length, 0);
  assert.deepEqual(plan.targets, {});
  assert.equal(plan.contested.length, 1);
  assert.equal(plan.contested[0].key, folioKey(holding));
  assert.deepEqual(plan.contested[0].accounts.map((account) => account.id),
    ["axis-settled", "axis-settled-2"]);
  const route = casRoute(parsed([holding]), accounts);
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.length, 1);
  // A stale adoption of the manual total is refused while two owners exist.
  const stale = casRoute(parsed([holding]), accounts,
    { adopt: { [folioKey(holding)]: "axis-value" } });
  assert.equal(stale.groups.length, 0);
  assert.equal(stale.homeless.length, 1);
});

test("a unique AMC tie names one of two settled owners", () => {
  const holding = casFund();
  const other = settled({ id: "axis-other", label: "Axis folio two",
    meta: JSON.stringify({ amc: "other", folios: [PRINTED] }) });
  const accounts = [demat, settled(), other];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: (id) => accounts.find((account) => account.id === id)?.holdings || [] });
  assert.equal(plan.offers.length, 0);
  assert.equal(plan.contested.length, 0);
  assert.equal(plan.homes.length, 1);
  assert.equal(plan.homes[0].id, "axis-settled");
  const route = casRoute(parsed([holding]), accounts);
  assert.equal(route.groups[0]?.assetId, "axis-settled");
});

test("two settled owners that both name the AMC are still contested", () => {
  const holding = casFund();
  const twin = settled({ id: "axis-settled-2", label: "Axis mutual fund two" });
  const accounts = [demat, settled(), twin];
  const plan = folioAdoptionPlan({ holdings: [holding], accounts,
    rowsOf: (id) => accounts.find((account) => account.id === id)?.holdings || [] });
  assert.equal(plan.offers.length, 0);
  assert.equal(plan.contested.length, 1);
  assert.equal(casRoute(parsed([holding]), accounts).groups.length, 0);
});

test("a folio with no owner at all is the only state that creates an account", () => {
  const holding = casFund();
  const ownership = (accounts) => folioOwnership(holding, accounts);
  assert.equal(ownership([demat]).state, "new");
  assert.equal(ownership([demat, valueOnly()]).state, "manual");
  assert.equal(ownership([demat, valueOnly(), settled()]).state, "home");
  assert.equal(ownership([demat, settled(), settled({ id: "axis-settled-2",
    label: "Axis folio two" })]).state, "contested");
});
