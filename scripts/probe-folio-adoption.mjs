#!/usr/bin/env node
// What a value-only Axis total and an NSDL folio do to net worth before and
// after an explicit adoption. Synthetic only; run from the repo root.

import { assetMetrics } from "../web/finance.js";
import { casRoute } from "../web/cas.js";
import { casGroupByAsset, casReplacePlan } from "../web/cas-apply.js";
import { accountFolios, folioAdoptionPlan, folioKey } from "../web/folio.js";

const DEMAT = "IN99990001344321";
const FOLIO = "91062983856";
const ISIN = "INF000000001";

const demat = {
  id: "demat-1", label: "Demat · NSDL · …4321", category: "demat",
  subtype: "equity", number: DEMAT,
};
const REFERENCE = "Payment From 000000000000";
const valueOnly = {
  id: "axis-value", label: "Axis mutual fund", bank: "Axis", category: "demat",
  subtype: "mutual fund", type: "mf", number: REFERENCE,
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    current_value_paise: 32100000 }),
};
const holding = {
  isin: ISIN, label: "Axis Bluechip Fund - Direct Plan - Growth", kind: "mf",
  category: "mf", folio: FOLIO, amc: "Axis", amcFull: "Axis Mutual Fund",
  quantity: 100, valuePaise: 31357941, costPaise: 24002176, account: DEMAT,
};
const parsed = {
  depository: "NSDL", demat: DEMAT,
  accounts: [{ boId: DEMAT, dpName: "NSDL", holdings: [holding] }],
  holdings: [holding], transactions: [],
};

const inr = (paise) => `₹${(paise / 100).toLocaleString("en-IN", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const beforeValue = assetMetrics(valueOnly, "demat").value;
const beforeFolio = assetMetrics({ category: "demat", subtype: "mutual fund",
  holdings_count: 1, holdings_value: 31357941, holdings_cost: 24002176,
  meta: JSON.stringify({ folios: [FOLIO] }) }, "demat").value;

const noChoice = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, valueOnly], rowsOf: () => [] });
const nearMiss = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, { ...valueOnly, id: "mirae-value", label: "Mirae mutual fund",
    bank: "Mirae", meta: JSON.stringify({ amc: "Mirae",
      amc_full: "Mirae Asset Mutual Fund", current_value_paise: 32100000 }) }],
  rowsOf: () => [] });
const exact = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, valueOnly,
    { ...valueOnly, id: "axis-exact", number: FOLIO,
      meta: JSON.stringify({ amc: "axis", current_value_paise: 32100000 }) }],
  rowsOf: () => [] });
const beforeRoute = casRoute(parsed, [demat, valueOnly]);
const chosen = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, valueOnly], rowsOf: () => [],
  choices: { [folioKey(holding)]: valueOnly.id } });
const afterRoute = casRoute(parsed, [demat, valueOnly], { adopt: chosen.targets });
const rows = casGroupByAsset({ holdings: [holding], groups: afterRoute.groups })
  .get(valueOnly.id) || [];
const plan = casReplacePlan({ parsed, existing: [], holdings: rows,
  assetId: valueOnly.id, asOf: "2026-09-30", confirmed: true, merge: true });
const afterValue = assetMetrics({
  ...valueOnly,
  holdings_count: 1,
  holdings_value: plan.rows.reduce((total, row) => total + (row.value_paise || 0), 0),
  holdings_cost: plan.rows.reduce((total, row) => total + (row.cost_paise || 0), 0),
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund", folios: [FOLIO] }),
}, "demat").value;

console.log("folio adoption probe · synthetic Axis value-only + NSDL folio");
console.log(`identity reference note        folios ${accountFolios(valueOnly).length}`
  + ` (not a folio)`);
console.log(`before  value-only account      ${inr(beforeValue)}`);
console.log(`before  new folio account       ${inr(beforeFolio)}`);
console.log(`before  total                   ${inr(beforeValue + beforeFolio)}`);
console.log(`offer   basis ${noChoice.offers[0]?.basis || "none"}`
  + ` · state ${noChoice.offers[0]?.state || "none"}`
  + ` · candidates ${noChoice.offers[0]?.candidates.length || 0}`
  + ` · candidate ${inr(noChoice.offers[0]?.candidates[0]?.valuePaise || 0)}`
  + ` · statement ${inr(noChoice.offers[0]?.valuePaise || 0)}`);
console.log(`no choice targets ${Object.keys(noChoice.targets).length}`
  + ` · route ${beforeRoute.groups.length} groups / ${beforeRoute.homeless.length} homeless`);
console.log(`near miss other AMC            offers ${nearMiss.offers.length}`);
console.log(`exact priority                 basis ${exact.offers[0]?.basis || "none"}`
  + ` · candidates ${exact.offers[0]?.candidates.length || 0}`
  + ` · ${exact.offers[0]?.candidates.map((candidate) => candidate.id).join(",") || "none"}`);
console.log(`adopt   targets ${Object.keys(chosen.targets).length}`
  + ` · route group ${afterRoute.groups[0]?.assetId || "none"}`
  + ` · account id ${valueOnly.id}`);
console.log(`after   one position            ${inr(afterValue)}`);
console.log(`after   total                   ${inr(afterValue)}`);
console.log(`rows    ${plan.rows.length} · units ${plan.rows[0]?.quantity}`
  + ` · folio ${FOLIO} · cost ${inr(plan.rows[0]?.cost_paise || 0)}`
  + ` · value source ${plan.rows[0]?.value_source}`);
