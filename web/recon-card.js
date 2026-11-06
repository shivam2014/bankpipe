// The Reconcile card, as text. The audit lives in recon.js and the storage link
// in db.js; this only turns a result into the sentence a person reads, so the
// wording is testable without a browser.
//
// The one rule: a card that has nothing to say says why. An empty list is not a
// clean report, it is a missing statement.

const escape = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const units = (n) => {
  const v = Number(n) || 0;
  return `${v} unit${v === 1 ? "" : "s"}`;
};

const STATE_TEXT = {
  quantity_differs: (l) => `seller ${units(l.lotQty)} · depository ${units(l.custodianQty)}`,
  not_settled: (l) => `seller ${units(l.lotQty)} · not in the statement`,
  cost_missing: (l) => `${units(l.custodianQty)} held · no purchase record`,
  in_transit: (l) => `bought after the statement date`,
  matched: (l) => units(l.lotQty),
  closed: (l) => `matured ${l.maturity}`,
};

const STATE_LABEL = {
  quantity_differs: "Quantity differs",
  not_settled: "Not settled",
  cost_missing: "Cost missing",
  in_transit: "In transit",
  matched: "Matched",
  closed: "Closed",
};

/** The one-line receipt: what was compared and what broke. */
export function reconHeadline(result) {
  if (!result) return "";
  if (result.reason === "empty") {
    return "No demat number on this asset yet. Add it to link the depository statement.";
  }
  if (result.reason === "client-code" || result.reason === "unknown") {
    return "The number here is not a BO ID, so no depository statement can be matched to it.";
  }
  if (result.reason === "no-second-statement") {
    return "No second statement for this account yet. Import the demat file or a CAS to audit it.";
  }
  if (result.reason === "ambiguous-pair") {
    return "Two assets share this demat. Make one of them the depository view before auditing.";
  }
  const total = Number(result.total) || 0;
  const breaks = Number(result.breaks) || 0;
  const matched = Number(result.counts?.matched) || 0;
  return `${total} position${total === 1 ? "" : "s"} · ${matched} matched · `
    + `${breaks} break${breaks === 1 ? "" : "s"}`;
}

/** One row per break, in the order recon.js sorted them. */
export function reconRows(result) {
  if (!result || !result.lines) return [];
  return result.lines
    .filter((line) => line.state !== "matched")
    .map((line) => ({
      isin: line.isin,
      label: line.label || line.isin,
      state: line.state,
      stateLabel: STATE_LABEL[line.state] || line.state,
      detail: (STATE_TEXT[line.state] || (() => ""))(line),
    }));
}

/** The whole card. `money` formats paise so this module stays free of the UI. */
export function reconCardHtml(result, { money = (p) => String(p), shapeText = "" } = {}) {
  if (!result) return "";
  const rows = reconRows(result);
  const cost = Number(result.costPaise) || 0;
  const head = reconHeadline(result);
  const body = rows.length
    ? rows.map((r) => `<div class="kv-row">
        <div class="k">${r.stateLabel}</div>
        <div class="v">${escape(r.label)}<br>
          <span class="muted" style="font-size:11.5px">${escape(r.detail)}</span></div>
      </div>`).join("")
    : "";
  // The shape report is safe to paste: counts and formats, never a value. It is
  // the only way a report can be debugged without the statements themselves.
  const shapeBlock = shapeText
    ? `<details style="margin-top:10px">
        <summary class="muted" style="font-size:11.5px;cursor:pointer">
          Shape report — safe to share</summary>
        <pre style="font-size:11px;white-space:pre-wrap;margin:8px 0 0">${escape(shapeText)}</pre>
      </details>`
    : "";
  return `<div class="card pad" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
      <h2 style="margin:0">Reconcile</h2>
      ${cost ? `<span class="muted" style="font-size:11.5px">cost ${escape(money(cost))}</span>` : ""}
    </div>
    <div class="muted" style="font-size:12.5px;margin-top:5px">${escape(head)}</div>
    ${body ? `<div class="kv" style="margin-top:8px">${body}</div>` : ""}
    ${shapeBlock}
  </div>`;
}
