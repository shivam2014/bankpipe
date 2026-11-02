import { escapeHtml as esc, jsArg } from "./escape.js";
import { matchDemat } from "./portfolio-match.js";
import { assetIdentity } from "./asset-identity.js";

const digits = (value) => String(value ?? "").replace(/\D+/g, "");

// Last four digits of a Demat, digits only, for the "…1234" labels.
export function dematLast4(value) {
  return digits(value).slice(-4);
}

// A stored Demat as display text. A quote-only value is empty, not `""`.
export function dematText(value) {
  return String(value ?? "").replace(/^"+|"+$/g, "").trim();
}

// The copy and buttons for a report whose Demat differs from the portfolio's.
// Pure: the caller supplies the target and mapped assets, so the same identity
// strings as the Assets row come from assetIdentity. Empty fields drop their
// clause instead of printing "…" or "".
export function dematCardModel({ target = "", reportDemat = "", reportHolder = "",
  targetDemat = "", mapped = "", mappedAsset = null, removed = 0, current = 0 } = {}) {
  const report = assetIdentity({ number: reportDemat, holder: reportHolder },
    { numberLabel: "Demat" });
  const destination = assetIdentity(mappedAsset || { id: mapped });
  const report4 = dematLast4(reportDemat);
  const moved = mapped && mapped !== target && !!destination.name;
  const n = Number(removed || 0);
  const total = Number(current || 0);
  const lots = total > 0 ? `${n} of the ${total} lots`
    : `${n} existing lot${n === 1 ? "" : "s"}`;
  const consequence = moved && n > 0
    ? `Applying here would move that Demat from ${destination.name} and remove ${lots}.`
    : moved ? `Applying here would move that Demat from ${destination.name}.`
      : n > 0 ? `Applying here would remove ${lots}.` : "";
  const safe = mapped && mapped !== target && destination.name
    ? { id: mapped, label: `Apply to ${destination.name}` } : null;
  return {
    heading: report.numberLine
      ? `This snapshot is for ${report.numberLine}.`
      : "This snapshot is for another Demat.",
    consequence,
    sub: "Nothing is written until you choose.",
    safe,
    create: report4 ? `Create a portfolio for …${report4}`
      : "Create a portfolio for this Demat",
    override: "Apply here anyway",
    cancel: "Cancel",
  };
}

// The mismatch sentence used when the apply confirm lists dangers. A missing
// number drops the Demat phrase rather than rendering "Demat …".
export function dematMismatchLine(reportDemat = "", reportHolder = "") {
  const report = assetIdentity({ number: reportDemat, holder: reportHolder },
    { numberLabel: "Demat" });
  return report.numberLine
    ? `These reports belong to ${report.numberLine}, not this portfolio.`
    : "These reports belong to another Demat, not this portfolio.";
}

// The neutral card for a safe or new destination. A safe preview passes no
// danger, by construction; a new portfolio may carry one duplicate warning.
export function syncPreviewCardHtml({ header = "", body = "", danger = "" } = {}) {
  return `<div class="card pad" style="background:var(--hair);margin-bottom:14px">
    ${danger}${header}${body}</div>`;
}

export function dematCardHtml(options = {}, { body = "" } = {}) {
  if (matchDemat(options.reportDemat || "", options.targetDemat || "") !== "mismatch") return "";
  const model = dematCardModel(options);
  const actions = [];
  if (model.safe) {
    actions.push(`<button class="btn" onclick="bpDigiFinnSyncPreview(${jsArg(model.safe.id)})">${esc(model.safe.label)}</button>`);
  }
  actions.push(`<button class="btn" onclick="bpDigiFinnSyncPreview('__new__')">${esc(model.create)}</button>`);
  actions.push(`<button class="btn danger" onclick="bpDigiFinnKeepPortfolio()">${esc(model.override)}</button>`);
  actions.push(`<button class="btn" onclick="bpDigiFinnCancel()">${esc(model.cancel)}</button>`);
  return `<div class="card pad" style="border:1px solid var(--red);margin-bottom:10px">
    <b style="color:var(--red);font-size:13.5px">${esc(model.heading)}</b>
    ${model.consequence ? `<div style="color:var(--red);font-size:13.5px;font-weight:600;margin-top:3px">${esc(model.consequence)}</div>` : ""}
    <div class="muted" style="font-size:12px;margin-top:5px">${esc(model.sub)}</div>
    ${body || `<div class="df-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${actions.join("")}</div>`}
  </div>`;
}
