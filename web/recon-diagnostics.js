// Shape-only diagnostics for the bond audit, built on the same rule as
// diagnostics.js: counts, kinds and character shapes travel; values never do.
// A real portfolio can then be debugged from a pasted report without sending an
// ISIN, an amount, a demat number or a name.
//
// `shape()` already turns letters into A-runs and digits into 9-runs, so a
// quantity or a date keeps its format and loses its content.

import { shape } from "./diagnostics.js";
import { boId } from "./bo-id.js";

const kinds = (value) => {
  const id = boId(value);
  return id.kind === "bo"
    ? `bo:${id.depository.toLowerCase()}:${id.dpId.length}+${id.clientId.length}`
    : id.kind;
};

const firstShape = (rows, field) => {
  const hit = (rows || []).find((r) => r && r[field] !== undefined && r[field] !== null
    && String(r[field]).trim() !== "");
  return hit ? shape(hit[field]) : "";
};

/**
 * Build the report. `result` is what db.reconFor returns; its `inputs` carry the
 * raw counts so a skipped row is visible instead of silently missing.
 * @param {object} result
 * @returns {object} a JSON-safe object with no values in it
 */
export function reconShape(result) {
  if (!result) return { version: 1, kind: "recon", reason: "missing" };
  const counts = { ...(result.counts || {}) };
  const inputs = result.inputs || {};
  return {
    version: 1,
    kind: "recon",
    reason: String(result.reason || "ok"),
    assetBoId: kinds(result.asset?.number),
    counterpartBoId: kinds(result.custodian?.number),
    inputs: {
      lots: Number(inputs.lots) || 0,
      positions: Number(inputs.positions) || 0,
      withoutIsin: Number(inputs.withoutIsin) || 0,
      lotsWithoutCost: Number(inputs.lotsWithoutCost) || 0,
      lotsWithoutDate: Number(inputs.lotsWithoutDate) || 0,
      quantityShape: String(inputs.quantityShape || ""),
      dateShape: String(inputs.dateShape || ""),
    },
    positions: Number(result.total) || 0,
    breaks: Number(result.breaks) || 0,
    states: counts,
    labels: {
      fromSeller: Number(inputs.labelsFromSeller) || 0,
      fromDepository: Number(inputs.labelsFromDepository) || 0,
    },
  };
}

/**
 * The same report as plain text, for a person to paste into a message.
 * @param {object} report from reconShape
 * @returns {string}
 */
export function reconShapeText(report) {
  if (!report) return "";
  const r = report;
  const lines = [
    `BankPipe recon shape · v${r.version}`,
    `reason           ${r.reason}`,
    `asset BO ID      ${r.assetBoId || "—"}`,
    `counterpart      ${r.counterpartBoId || "—"}`,
    `inputs           lots ${r.inputs.lots} · positions ${r.inputs.positions}`
      + ` · no ISIN ${r.inputs.withoutIsin}`,
    `                 no cost ${r.inputs.lotsWithoutCost}`
      + ` · no date ${r.inputs.lotsWithoutDate}`,
    `formats          qty ${r.inputs.quantityShape || "—"}`
      + ` · date ${r.inputs.dateShape || "—"}`,
    `result           ${r.positions} positions · ${r.breaks} breaks`,
  ];
  for (const [state, n] of Object.entries(r.states || {})) {
    if (n) lines.push(`  ${state.padEnd(16)} ${n}`);
  }
  return lines.join("\n");
}

/**
 * Count the input rows before the audit drops any, so a skipped row is reported.
 * @param {Array<object>} lots
 * @param {Array<object>} positions
 * @returns {object}
 */
export function reconInputs(lots = [], positions = []) {
  const hasIsin = (r) => String(r?.security_id ?? "").trim() !== "";
  const lotsWithIsin = (lots || []).filter(hasIsin);
  return {
    lots: (lots || []).length,
    positions: (positions || []).length,
    withoutIsin: (lots || []).filter((r) => !hasIsin(r)).length
      + (positions || []).filter((r) => !hasIsin(r)).length,
    lotsWithoutCost: lotsWithIsin.filter((r) =>
      r.cost_paise === null || r.cost_paise === undefined).length,
    lotsWithoutDate: lotsWithIsin.filter((r) =>
      !String(r.purchase_date ?? "").trim()).length,
    quantityShape: firstShape(lotsWithIsin, "quantity"),
    dateShape: firstShape(lotsWithIsin, "purchase_date"),
    labelsFromSeller: lotsWithIsin.filter((r) => String(r.label ?? "").trim()).length,
    labelsFromDepository: (positions || []).filter((r) =>
      String(r.label ?? "").trim()).length,
  };
}
