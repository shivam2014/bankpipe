#!/usr/bin/env node
// What a printed zero check digit does to folio identity. Synthetic only; run
// from the repo root. The legacy block shows the pre-fix raw-string identity
// (two positions, no offer) beside the shipped plan (one offer, one position
// after an explicit adopt), then the `/1` near miss that must stay distinct.

import { assetMetrics } from "../web/finance.js";
import { casRoute } from "../web/cas.js";
import { casGroupByAsset, casManualTargetEvents, casManualTargetRows,
  casReplacePlan } from "../web/cas-apply.js";
import { folioAdoptionPlan, folioKey, folioOwnership } from "../web/folio.js";
import { accountMatches } from "../web/import-flow.js";

const DEMAT = "IN99990001344321";
const BASE = "90000001234";
const PRINTED = "90000001234/0";
const NEAR = "90000001234/1";
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
// parser: the three legacy* functions are the pre-fix rules, reproduced.
const legacyNormalize = (value) => String(value ?? "")
  .replace(/[\u00AD\u200B]/g, "").replace(/\s+/g, "").toLowerCase();
const legacyMeta = (account) => {
  try { return JSON.parse(account.meta || "{}"); } catch (e) { return {}; }
};
// The pre-fix accountFolios: a fund account's number is one of its folios, and
// no check digit is stripped.
const legacyFolios = (account) => {
  const meta = legacyMeta(account);
  const raw = [...(Array.isArray(meta.folios) ? meta.folios : []),
    meta.folio, meta.folio_no];
  if (/mutual\s*fund|^mf$/i.test(String(account.subtype || ""))
    || /^mf$/i.test(String(account.type || ""))) {
    raw.push(account.number, account.folio, account.folio_no);
  }
  return [...new Set(raw.map((value) => String(value ?? "").trim())
    .filter(Boolean).map(legacyNormalize))];
};
// The pre-fix candidate rule: an account that answers to any folio is not a
// value-only candidate, even when its folio is the printed one without `/0`.
// The other two conditions (value-only, fund-house lookalike) hold here.
const legacyCandidate = legacyFolios(valueOnly).length === 0;
const legacyCarries = legacyFolios(valueOnly).includes(legacyNormalize(PRINTED));
const legacyOffers = legacyCandidate ? 1 : 0;
const legacyHome = legacyCarries ? valueOnly : null;
const legacyReason = legacyCandidate ? "value-only lookalike"
  : legacyCarries ? "one raw folio" : "another raw folio";
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
  + ` · offers ${legacyOffers} (${legacyReason})`
  + ` · homeless ${legacyHome ? 0 : 1}`
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

// The duplicate an earlier import can leave behind: the same canonical folio on
// a manual total and on an account that already holds units. One folio is one
// position, so both array orders route to the account with the units and no
// offer is made over it.
const duplicateManual = { ...valueOnly };
const duplicateSettled = {
  id: "axis-settled", label: "Axis mutual fund · folio …8993", category: "demat",
  subtype: "mutual fund", type: "mf", number: PRINTED,
  holdings: [{ security_id: ISIN, quantity: 90, value_paise: 30000000 }],
  meta: JSON.stringify({ amc: "axis", amc_full: "Axis Mutual Fund",
    folios: [PRINTED] }),
};
const duplicateRoute = (accounts) => casRoute(parsed(), accounts);
const duplicatePlan = (accounts) => folioAdoptionPlan({ holdings: [holding], accounts,
  rowsOf: (id) => (id === duplicateSettled.id ? duplicateSettled.holdings : []) });
const manualFirst = [demat, duplicateManual, duplicateSettled];
const settledFirst = [demat, duplicateSettled, duplicateManual];
const manualFirstRoute = duplicateRoute(manualFirst);
const settledFirstRoute = duplicateRoute(settledFirst);
const manualFirstPlan = duplicatePlan(manualFirst);
const settledFirstPlan = duplicatePlan(settledFirst);

console.log("");
line("duplicate manual first", `home ${manualFirstRoute.groups[0]?.assetId || "none"}`
  + ` · offers ${manualFirstPlan.offers.length}`
  + ` · homeless ${manualFirstRoute.homeless.length}`);
line("duplicate settled first", `home ${settledFirstRoute.groups[0]?.assetId || "none"}`
  + ` · offers ${settledFirstPlan.offers.length}`
  + ` · homeless ${settledFirstRoute.homeless.length}`);

// One clone deeper: a manual total and two accounts that carry the folio and
// already hold units, neither declaring the AMC. There is no safe pick, so no
// manual total is offered, the route writes nothing, and no account is created.
const SECOND_ISIN = "INF000000888";
const silentTwin = (id, label, isin, units) => ({
  id, label, category: "demat", subtype: "mutual fund", type: "mf", number: PRINTED,
  holdings: [{ security_id: isin, quantity: units, value_paise: 2500000 }],
  meta: JSON.stringify({ folios: [PRINTED] }),
});
const neutralManual = {
  ...valueOnly, id: "axis-manual-neutral", label: "Fund total", bank: "",
  meta: JSON.stringify({ current_value_paise: MANUAL_PAISE }),
};
const multiAccounts = [demat, neutralManual,
  silentTwin("axis-a", "Fund folio A", SECOND_ISIN, 90),
  silentTwin("axis-b", "Fund folio B", SECOND_ISIN, 10)];
const multiPlan = folioAdoptionPlan({ holdings: [holding], accounts: multiAccounts,
  rowsOf: (id) => multiAccounts.find((account) => account.id === id)?.holdings || [] });
const multiRoute = casRoute(parsed(), multiAccounts);
const multiState = folioOwnership(holding, multiAccounts).state;
console.log("");
line("multi-owner plan", `offers ${multiPlan.offers.length}`
  + ` · contested ${multiPlan.contested.length}`
  + ` · owners ${multiPlan.contested[0]?.accounts.length || 0}`
  + ` · create ${multiState === "new" ? "yes" : "no"}`);
line("multi-owner route", `groups ${multiRoute.groups.length}`
  + ` · homeless ${multiRoute.homeless.length}`
  + ` · home ${multiPlan.homes[0]?.id || "none"}`);

// Preview and write name one account. The generic matcher sorts by label and can
// name the manual total; the plan's home is what the inbox preview and casRoute
// both read, so the write lands where the preview pointed.
const agreeManual = { ...duplicateManual, label: "Axis mutual fund" };
const agreeSettled = { ...silentTwin("axis-settled-agree", "Axis mutual fund · folio …8993",
  SECOND_ISIN, 90) };
const agreeAccounts = [demat, agreeManual, agreeSettled];
const agreePlan = folioAdoptionPlan({ holdings: [holding], accounts: agreeAccounts,
  rowsOf: (id) => agreeAccounts.find((account) => account.id === id)?.holdings || [] });
const agreeRoute = casRoute(parsed(), agreeAccounts);
const agreeMatch = accountMatches({ accountKey: PRINTED, accountKind: "folio",
  amc: "Axis", rows: [holding] }, agreeAccounts, { forCas: true });
const previewId = agreePlan.homes[0]?.id || "";
const writeId = agreeRoute.groups[0]?.assetId || "";
line("preview vs write", `matchIdentity ${agreeMatch.identityId || "none"}`
  + ` · preview ${previewId || "none"} · route ${writeId || "none"}`
  + ` · agree ${previewId && previewId === writeId ? "yes" : "no"}`);

// A kept folio and a manual demat target: the row and its movement are withheld.
const keptMovement = [{ isin: ISIN, side: "debit", quantity: 10 }];
line("kept manual target", `rows ${casManualTargetRows([holding]).length}`
  + ` · events ${casManualTargetEvents(keptMovement, [holding]).length}`);

// Why the withholding list must come from the statement, not the scoped write:
// the inbox has already dropped the kept row when the writer reads it, so only
// the full list can tell a demat holding the same ISIN that the event is foreign.
const fullWithheld = casManualTargetEvents(keptMovement, [holding]).length;
const scopedWithheld = casManualTargetEvents(keptMovement, []).length;
line("kept event scope", `full list ${fullWithheld} event`
  + ` · scoped list ${scopedWithheld} event`
  + ` · ${scopedWithheld && !fullWithheld ? "the full list is required" : "unexpected"}`);
