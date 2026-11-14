#!/usr/bin/env node
// A static fixture for the securities-accounts card, so the gap lines and the
// one "Which report?" disclosure can be rendered at 390 and 1280 in both themes.
// It copies the page's own stylesheet and calls the real gap and status
// functions; only the row markup is mirrored from bpImportAccountsHtml. The
// wiring itself is covered by web/import-accounts.test.mjs. Synthetic data only.
//
//   node scripts/import-gaps-fixture.mjs
//
// Prints one file per theme. Open it in a headless browser and look at it.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAccountGaps, importAccountSummary,
  IMPORT_REPORT_GUIDE } from "../web/import-flow.js";

const page = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const start = page.indexOf("<style>");
const end = page.indexOf("</style>", start);
if (start < 0 || end < 0) throw new Error("the page stylesheet was not found");
const css = page.slice(start + "<style>".length, end);

// The page's dateLabel, so the copy matches what the card prints.
const dateLabel = (value) => {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return value || "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    .toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const account = (id, label, number, meta = {}) => ({
  id, label, category: "demat", subtype: "equity", number,
  meta: JSON.stringify(meta),
});

// 1. Complete: a CAS snapshot, a newer broker cost, a bond with coupon and
//    maturity, an equity with cost. Expect no gap line at all.
const complete = account("demat-1", "CDSL · …4321", "IN99990001344321", {
  holdings_source: "cas", holdings_as_of: "2026-10-31",
  identity_source: "cas", identity_as_of: "2026-10-31",
  cost_source: "motilal", cost_as_of: "2026-11-05",
});
const completeRows = [
  { security_id: isin(1), label: "TEST EQUITY", category: "equity", quantity: 40,
    cost_paise: 240000, as_of: "2026-10-31", source: "motilal", value_source: "CAS" },
  { security_id: isin(2), label: "7.15% TEST BOND 15 May 2032", category: "bond",
    quantity: 10, cost_paise: 1000000, yield_bps: 715, face_paise: 1000000,
    as_of: "2026-10-31", source: "motilal", value_source: "CAS" },
];

// 2. Three gaps: a quantity with no cost, a cost dated before the snapshot, and
//    a bond with neither coupon nor maturity.
const gaps = account("demat-2", "Demat · Zerodha", "IN99990002998888", {
  holdings_source: "cas", holdings_as_of: "2026-11-12",
  identity_source: "cas", identity_as_of: "2026-11-12",
  cost_source: "motilal", cost_as_of: "2026-11-05",
});
const gapRows = [
  { security_id: isin(3), label: "TEST EQUITY TWO", category: "equity", quantity: 12,
    cost_paise: 72000, as_of: "2026-11-12", source: "motilal", value_source: "CAS" },
  { security_id: isin(4), label: "NEW TEST BOND", category: "bond", quantity: 5,
    as_of: "2026-11-12", value_source: "CAS" },
  { security_id: isin(5), label: "8.00% TEST BOND 31 Dec 2028", category: "bond",
    quantity: 20, cost_paise: 2000000, yield_bps: 800, as_of: "2026-11-12",
    source: "motilal", value_source: "CAS" },
];

// 3. Typed by hand: no source anywhere, so the lines offer what could be added.
const typed = account("bonds-1", "Bond portfolio", "bonds-1");
typed.category = "bonds";
typed.subtype = "bond";
const typedRows = [
  { security_id: isin(6), label: "TEST BOND BY HAND", category: "bond", quantity: 3,
    as_of: "2026-10-01", source: "manual" },
];

const row = (accountValue, holdings) => {
  const status = importAccountSummary(accountValue, holdings, dateLabel);
  const gap = importAccountGaps(accountValue, holdings, dateLabel);
  const label = accountValue.label;
  const bits = [status.countText, accountValue.number !== label ? accountValue.number : "",
    status.dates, status.brokerOnly ? "No CAS to reconcile against" : ""]
    .filter(Boolean).join(" · ");
  const gapHtml = gap.gaps.length
    ? `<span class="import-account-gap${gap.manual ? " optional" : ""}">${
      esc(gap.gaps.map((item) => item.text).join(" · "))}</span>` : "";
  return `<button type="button" class="import-account-btn">
    <span class="import-account-main">
      <span class="import-account-name">${esc(label)}</span>
      <span class="import-account-meta">${esc(bits)}</span>
      ${gapHtml}
    </span>
    <span class="import-account-status ${status.kind}">${esc(status.label)}</span>
  </button>`;
};

const guide = () => {
  const lines = IMPORT_REPORT_GUIDE.sources.map((source) => `<div class="import-help-row">
    <b>${esc(source.source)}</b>
    <span class="muted">${esc(source.when)} — ${esc(source.adds)}</span></div>`).join("");
  return `<details class="import-help">
    <summary>Which report?</summary>
    <div class="import-help-body">${lines}
      <div class="import-help-row"><span class="muted">${
        esc(IMPORT_REPORT_GUIDE.note)}</span></div>
    </div>
  </details>`;
};

const card = `<div class="card pad">
  <div class="import-card-head"><h2>Securities accounts</h2>
    <span class="import-card-sub">3 accounts</span></div>
  <div class="import-accounts">
    ${row(complete, completeRows)}
    ${row(gaps, gapRows)}
    ${row(typed, typedRows)}
    ${guide()}
  </div>
</div>`;

const fixture = (theme) => `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>
  body { margin: 0; padding: 24px 16px 40px; background: var(--bg); color: var(--ink); }
  .fixture { max-width: 760px; margin: 0 auto; }
  .fixture-head { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .fixture-sub { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
</style>
</head>
<body>
<main class="fixture">
  <p class="fixture-head">What each account is missing</p>
  <p class="fixture-sub">Synthetic content. Complete, three gaps, and typed by hand.</p>
  ${card}
</main>
</body>
</html>`;

for (const theme of ["light", "dark"]) {
  const path = join(tmpdir(), `bankpipe-import-gaps-${theme}.html`);
  writeFileSync(path, fixture(theme));
  console.log(path);
}
