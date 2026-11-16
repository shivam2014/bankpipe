import test from "node:test";
import assert from "node:assert/strict";
import { casRoute } from "./cas.js";
import { casGroupByAsset, casReplacePlan } from "./cas-apply.js";
import { assetMetrics } from "./finance.js";
import { folioHome, folioKey, folioAdoptionPlan } from "./folio.js";

const FOLIO = "91062983856";
const DEMAT = "IN99990001344321";
const ISIN = "INF000000001";

const valueOnly = (over = {}) => ({
  id: "axis-value",
  label: "Axis mutual fund",
  bank: "Axis",
  category: "demat",
  subtype: "mutual fund",
  type: "mf",
  number: "",
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    current_value_paise: 32100000 }),
  ...over,
});

const casFund = (over = {}) => ({
  isin: ISIN,
  label: "Axis Bluechip Fund - Direct Plan - Growth",
  kind: "mf",
  category: "mf",
  folio: FOLIO,
  amc: "Axis",
  amcFull: "Axis Mutual Fund",
  quantity: 100,
  valuePaise: 31357941,
  costPaise: 24002176,
  account: DEMAT,
  ...over,
});

const parsed = (holdings) => ({
  depository: "NSDL",
  demat: DEMAT,
  accounts: [{ boId: DEMAT, dpName: "NSDL", holdings }],
  holdings,
  transactions: [],
});

const routeAssets = (over = {}) => [
  { id: "d1", label: "Demat · NSDL", category: "demat", subtype: "equity",
    number: DEMAT },
  valueOnly(over),
];

test("a value-only fund account with no folio is offered, never adopted by default", () => {
  const holding = casFund();
  const plan = folioAdoptionPlan({ holdings: [holding],
    accounts: routeAssets(), rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].state, "offer");
  assert.equal(plan.offers[0].candidates.length, 1);
  assert.equal(plan.offers[0].candidates[0].id, "axis-value");
  assert.equal(plan.offers[0].candidates[0].valuePaise, 32100000);
  assert.equal(plan.offers[0].valuePaise, 31357941);
  assert.deepEqual(plan.targets, {});
  // No choice means the folio is homeless, so the writer must create a new
  // account rather than pick the value-only one behind the user's back.
  const route = casRoute(parsed([holding]), routeAssets());
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.length, 1);
  assert.equal(route.homeless[0].folioNo, FOLIO);
});

test("an explicit choice adopts the folio into the account and keeps its id", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: routeAssets(),
    rowsOf: () => [], choices: { [key]: "axis-value" } });
  assert.equal(plan.offers[0].state, "adopt");
  assert.deepEqual(plan.targets, { [key]: "axis-value" });

  const route = casRoute(parsed([holding]), routeAssets(), { adopt: plan.targets });
  assert.equal(route.groups.length, 1);
  assert.equal(route.groups[0].assetId, "axis-value");
  assert.equal(route.groups[0].folioNo, FOLIO);
  assert.equal(route.homeless.length, 0);
});

test("adoption writes the statement's units, cost, value and source under the same id", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: routeAssets(),
    rowsOf: () => [], choices: { [key]: "axis-value" } });
  const route = casRoute(parsed([holding]), routeAssets(), { adopt: plan.targets });
  const rows = casGroupByAsset({ holdings: [holding], groups: route.groups })
    .get("axis-value") || [];
  assert.equal(rows.length, 1);
  const write = casReplacePlan({ parsed: parsed([holding]), existing: [], holdings: rows,
    assetId: "axis-value", asOf: "2026-09-30", confirmed: true, merge: true });
  assert.equal(write.rows.length, 1);
  assert.equal(write.rows[0].security_id, ISIN);
  assert.equal(write.rows[0].quantity, 100);
  assert.equal(write.rows[0].cost_paise, 24002176);
  assert.equal(write.rows[0].value_paise, 31357941);
  assert.equal(write.rows[0].value_source, "CAS");
  assert.equal(write.rows[0].as_of, "2026-09-30");
});

test("two candidate accounts are ambiguous and are not picked without a choice", () => {
  const holding = casFund();
  const key = folioKey(holding);
  const second = valueOnly({ id: "axis-value-2", label: "Axis Bluechip Fund" });
  const plan = folioAdoptionPlan({ holdings: [holding],
    accounts: [valueOnly(), second], rowsOf: () => [] });
  assert.equal(plan.offers[0].state, "ambiguous");
  assert.equal(plan.offers[0].candidates.length, 2);
  assert.deepEqual(plan.targets, {});

  const chosen = folioAdoptionPlan({ holdings: [holding],
    accounts: [valueOnly(), second], rowsOf: () => [],
    choices: { [key]: "axis-value-2" } });
  assert.equal(chosen.offers[0].state, "adopt");
  assert.deepEqual(chosen.targets, { [key]: "axis-value-2" });
});

test("one account that looks like two folios is blocked for both", () => {
  const one = casFund();
  const two = casFund({ folio: "91062983857", isin: "INF999900287" });
  const plan = folioAdoptionPlan({ holdings: [one, two],
    accounts: routeAssets(), rowsOf: () => [],
    choices: { [folioKey(one)]: "axis-value", [folioKey(two)]: "axis-value" } });
  assert.equal(plan.offers.length, 2);
  for (const offer of plan.offers) {
    assert.equal(offer.state, "ambiguous");
    assert.equal(offer.candidates.every((candidate) => candidate.shared), true);
    assert.equal(offer.choosable.length, 0);
  }
  assert.deepEqual(plan.targets, {});
});

test("a value-only account carrying a different folio is a different position", () => {
  const holding = casFund();
  const other = valueOnly({ number: "123/4",
    meta: JSON.stringify({ amc: "axis", folios: ["123/4"],
      current_value_paise: 32100000 }) });
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [other],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 0);
});

test("a value-only account carrying the same folio is offered, not silently adopted", () => {
  const holding = casFund();
  const same = valueOnly({ number: FOLIO,
    meta: JSON.stringify({ amc: "axis", current_value_paise: 32100000 }) });
  // A manual total is a candidate, not a home: the exact offer is the only way
  // in and the number is the identity that offer is keyed on.
  assert.equal(folioHome(holding, [same]), null);
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [same],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].basis, "folio");
  assert.equal(plan.offers[0].state, "offer");
  assert.deepEqual(plan.targets, {});
  // A manual total is never written without the person choosing it.
  const route = casRoute(parsed([holding]), routeAssets({ number: FOLIO,
    meta: JSON.stringify({ amc: "axis", current_value_paise: 32100000 }) }));
  assert.equal(route.groups.length, 0);
  assert.equal(route.homeless.length, 1);
});

test("a unit-bearing account is not a value-only candidate", () => {
  const holding = casFund();
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: routeAssets(),
    rowsOf: () => [{ security_id: ISIN, quantity: 100, value_paise: 31357941 }] });
  assert.equal(plan.offers.length, 0);
});

test("an account with no current value is not a value-only candidate", () => {
  const holding = casFund();
  const plan = folioAdoptionPlan({ holdings: [holding],
    accounts: [valueOnly({ meta: JSON.stringify({ amc: "axis" }) })],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 0);
});

test("a scheme match offers even when the account only names the scheme", () => {
  const holding = casFund({ amc: "", amcFull: "" });
  const account = valueOnly({ label: "Bluechip Fund", bank: "",
    meta: JSON.stringify({ current_value_paise: 32100000 }) });
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [account],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);

  const liquid = valueOnly({ id: "axis-liquid", label: "Axis Liquid Fund", bank: "",
    meta: JSON.stringify({ current_value_paise: 32100000 }) });
  const no = folioAdoptionPlan({ holdings: [holding], accounts: [liquid],
    rowsOf: () => [] });
  assert.equal(no.offers.length, 0);
});

test("a large value difference is shown, not used as a gate", () => {
  const holding = casFund({ valuePaise: 31357941 });
  const cheap = valueOnly({ meta: JSON.stringify({ amc: "axis",
    current_value_paise: 10000000 }) });
  const plan = folioAdoptionPlan({ holdings: [holding], accounts: [cheap],
    rowsOf: () => [] });
  assert.equal(plan.offers.length, 1);
  assert.equal(plan.offers[0].state, "offer");
  assert.ok(plan.offers[0].candidates[0].diffPct > 0.4);
});

test("the same holding counts twice before adoption and once after", () => {
  const manual = {
    category: "demat", subtype: "mutual fund", holdings_count: 0,
    holdings_value: null, holdings_cost: null,
    meta: JSON.stringify({ current_value_paise: 32100000 }),
  };
  const folio = {
    category: "demat", subtype: "mutual fund", holdings_count: 1,
    holdings_value: 31357941, holdings_cost: 24002176,
    meta: JSON.stringify({ folios: [FOLIO] }),
  };
  const before = assetMetrics(manual, "demat").value
    + assetMetrics(folio, "demat").value;
  assert.equal(before, 63457941);

  const adopted = {
    ...manual, holdings_count: 1, holdings_value: 31357941,
    holdings_cost: 24002176,
    meta: JSON.stringify({ folios: [FOLIO], amc: "axis" }),
  };
  assert.equal(assetMetrics(adopted, "demat").value, 31357941);
});
