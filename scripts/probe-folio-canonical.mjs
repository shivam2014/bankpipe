#!/usr/bin/env node
// What a printed zero check digit does to folio identity. Synthetic only; run
// from the repo root. The legacy block shows the pre-fix raw-string identity
// (two positions, no offer) beside the shipped plan (one offer, one position
// after an explicit adopt), then the `/1` near miss that must stay distinct.

import { assetMetrics } from "../web/finance.js";
import { casRoute } from "../web/cas.js";
import { casGroupByAsset, casReplacePlan } from "../web/cas-apply.js";
import { folioAdoptionPlan, folioKey } from "../web/folio.js";

const DEMAT = "IN99990001344321";
const BASE = "99990000001";
const PRINTED = "99990001/0";
const NEAR = "99990000001/1";
const ISIN = "INF000000777";
const MANUAL_PAISE = 31000000;
const STATEMENT_PAISE = 32453600;

const demat = {
  id: "demat-1", label: "Demat · NSDL · …4321", category: "demat",
  subtype: "equity", number: DEMAT,
};
const valueOnly = {
  id: "axis-value", label: "Axis mutual fund", bank: "Axis Mutual Fund",
  category: "demat", subtype: "mutual fund", type: "mf", number: BASE,
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    current_value_paise: MANUAL_PAISE }),
  holdings: [],
};
const holding = {
  isin: ISIN, label: "Axis Bluechip Fund - Direct Plan - Growth", kind: "mf",
  category: "mf", folio: PRINTED, amc: "Axis", amcFull: "Axis Mutual Fund",
  quantity: 100, valuePaise: STATEMENT_PAISE, costPaise: 24000000, account: DEMAT,
};
const parsed = (row = holding) => ({
  depository: "CDSL", demat: DEMAT,
  accounts: [{ boId: DEMAT, dpName: "Test DP", holdings: [row] }],
  holdings: [row], transactions: [],
});

const inr = (paise) => `₹${(paise / 100).toLocaleString("en-IN", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The old identity kept the suffix, so the stored base number and the printed
// `/0` were two different folios. This is a direct comparison, not a second
// parser: legacyNormalize is the pre-fix function.
const legacyNormalize = (value) => String(value ?? "")
  .replace(/[\u00AD\u200B]/g, "").replace(/\s+/g, "").toLowerCase();
const legacyCarries = legacyNormalize(valueOnly.number) === legacyNormalize(PRINTED);
const legacyOffers = legacyCarries || legacyNormalize(valueOnly.number) ? 0 : 1;
const legacyHome = legacyCarries ? valueOnly : null;
const legacyNewFolio = { category: "demat", subtype: "mutual fund", holdings_count: 1,
  holdings_value: STATEMENT_PAISE, holdings_cost: 24000000,
  meta: JSON.stringify({ folios: [PRINTED] }) };
const legacyTotal = assetMetrics(valueOnly, "demat").value
  + assetMetrics(legacyNewFolio, "demat").value;

const noChoice = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, valueOnly], rowsOf: () => [] });
const choice = folioAdoptionPlan({ holdings: [holding],
  accounts: [demat, valueOnly], rowsOf: () => [],
  choices: { [folioKey(holding)]: valueOnly.id } });
const noRoute = casRoute(parsed(), [demat, valueOnly]);
const yesRoute = casRoute(parsed(), [demat, valueOnly], { adopt: choice.targets });
const rows = casGroupByAsset({ holdings: [holding], groups: yesRoute.groups })
  .get(valueOnly.id) || [];
const write = casReplacePlan({ parsed: parsed(), existing: [], holdings: rows,
  assetId: valueOnly.id, asOf: "2026-09-30", confirmed: true, merge: true });
const after = assetMetrics({
  ...valueOnly,
  holdings_count: write.rows.length,
  holdings_value: write.rows.reduce((total, row) => total + (row.value_paise || 0), 0),
  holdings_cost: write.rows.reduce((total, row) => total + (row.cost_paise || 0), 0),
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    folios: [PRINTED] }),
}, "demat").value;

const nearHolding = { ...holding, folio: NEAR };
const nearPlan = folioAdoptionPlan({ holdings: [nearHolding],
  accounts: [demat, valueOnly], rowsOf: () => [] });
const nearRoute = casRoute(parsed(nearHolding), [demat, valueOnly]);
const nearTotal = assetMetrics(valueOnly, "demat").value
  + assetMetrics({ ...legacyNewFolio, meta: JSON.stringify({ folios: [NEAR] }) },
    "demat").value;

const offer = noChoice.offers[0];
const candidate = offer?.candidates[0];
const line = (label, text) => console.log(`${label.padEnd(28)}${text}`);

line("legacy raw identity", `home ${legacyHome ? legacyHome.id : "none"}`
  + ` · offers ${legacyOffers} · homeless ${legacyHome ? 0 : 1}`
  + ` · positions 2 · total ${inr(legacyTotal)}`);
line("shipped offer", `basis ${offer?.basis || "none"}`
  + ` · state ${offer?.state || "none"}`
  + ` · candidates ${offer?.candidates.length || 0}`
  + ` · candidate ${inr(candidate?.valuePaise || 0)}`
  + ` · statement ${inr(offer?.valuePaise || 0)}`);
line("shipped no choice", `targets ${Object.keys(noChoice.targets).length}`
  + ` · route groups ${noRoute.groups.length}`
  + ` · homeless ${noRoute.homeless.length}`);
line("shipped adopt", `targets ${Object.keys(choice.targets).length}`
  + ` · route group ${yesRoute.groups[0]?.assetId || "none"}`
  + ` · positions 1 · total ${inr(after)}`);
line("shipped write", `rows ${write.rows.length} · units ${write.rows[0]?.quantity}`
  + ` · folio ${write.rows[0]?.folio || PRINTED}`
  + ` · cost ${inr(write.rows[0]?.cost_paise || 0)}`
  + ` · value source ${write.rows[0]?.value_source}`);
line("near miss " + NEAR, `home ${nearRoute.groups.length ? "found" : "none"}`
  + ` · offers ${nearPlan.offers.length} · homeless ${nearRoute.homeless.length}`
  + ` · positions 2 · total ${inr(nearTotal)}`);
