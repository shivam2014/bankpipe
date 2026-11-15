#!/usr/bin/env node
// A static fixture for the import plan card. It copies the page's own stylesheet
// and the card's markup, then writes one file per theme to the OS temp directory
// so a render check can open it at 390 and 1280. Synthetic content only.
//
//   node scripts/plan-card-fixture.mjs
//
// The fixture is a design check, not the page's renderer. The card's classes,
// copy and numbers mirror bpImportPlanHtml; the wiring is covered by the tests.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const page = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const start = page.indexOf("<style>");
const end = page.indexOf("</style>", start);
if (start < 0 || end < 0) throw new Error("the page stylesheet was not found");
const css = page.slice(start + "<style>".length, end);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const file = (name, meta) => `<div class="import-file">
  <span class="import-file-name">${esc(name)}</span>
  <span class="import-file-meta">${esc(meta)}</span>
</div>`;

const account = (name, meta, hits) => `<div class="import-account-choice">
  <span class="import-choice-main">
    <span class="import-choice-name">${esc(name)}</span>
    <span class="import-choice-meta">${esc(meta)}</span>
  </span>
  <span class="import-choice-hits">${esc(hits)}</span>
</div>`;

const action = (label, primary = false, disabled = false) =>
  `<button class="btn${primary ? " primary" : ""}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;

function card({ kicker, title, sub, pill, files, where, also = "", change, still,
  ask = "", warning = "", primary, primaryDisabled = false }) {
  return `<div class="card pad import-bundle">
    <div class="import-bundle-head">
      <div><div class="import-kicker">${esc(kicker)}</div>
        <div class="import-title">${esc(title)}</div>
        <div class="import-sub">${esc(sub)}</div></div>
      ${pill}
    </div>
    <div class="import-files">${files}</div>
    ${where}
    ${also}
    <div class="import-change-grid">
      <div class="import-change"><b>What will change</b><ul>${change
        .map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>
      <div class="import-change"><b>What will not change</b><ul>${still
        .map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>
    </div>
    ${ask}
    ${warning}
    <div class="import-actions">
      ${action(primary, true, primaryDisabled)}
      ${action("Review differences")}
      ${action("Remove")}
    </div>
  </div>`;
}

const ready = '<span class="import-pill good">Ready</span>';
const review = '<span class="import-pill warn">Review the differences</span>';

const askBox = (count, lines) => `<div class="import-wrong">
  <b>${count} difference${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your decision.</b>
  <div class="muted">The report and the data on file carry the same date, or the difference
    would replace a cost you entered by hand, or a newer report disagrees with a quantity
    or value a CAS set, or it names a bond the statement recorded as sold. Using the file
    prices that sale and keeps it; it does not put the units back. Choose what to keep.</div>
  <ul class="muted import-ask-list">${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
  <div class="import-actions">${action("Use the file's values")}</div>
</div>`;

const merged = card({
  kicker: "Depository statement",
  title: "CDSL CAS",
  sub: "2 bonds, 1 fund and 1 equity · as on 31 Oct 2026 · 3 files · 2 accounts",
  pill: ready,
  files: [
    file("cas-oct-2026.pdf", "Depository statement (CAS) · 31 Oct 2026"),
    file("motilal-holdings.pdf", "Motilal Oswal holdings report · 5 Nov 2026"),
    file("zerodha-holdings.xlsx", "Zerodha holdings · 12 Nov 2026"),
  ].join(""),
  where: `<div class="import-section">
    <div class="import-section-title">Accounts in this statement</div>
    <div class="import-account-list">
      ${account("CDSL · …4321", "Update the account · 3 of 3 ISINs match", "3 holdings")}
      ${account("Test mutual fund · folio …3856", "New mutual fund folio account", "1 fund")}
    </div>
    <div class="muted import-note">The account number in the statement decides where its holdings
      go. A new number creates a new account.</div>
  </div>`,
  also: `<div class="import-section">
    <div class="import-section-title">Also in this plan</div>
    ${file("Motilal Oswal holdings report", "fills cost and terms")}
    ${file("Zerodha holdings", "adds the holdings it names")}
  </div>`,
  change: [
    "Add 3 holdings",
    "Update 2 holdings",
    "Motilal Oswal holdings report: fills cost and terms",
    "Zerodha holdings: adds the holdings it names",
    "Attach the CAS identity",
  ],
  still: [
    "Nothing is written until you press Import",
    "Other accounts with overlapping ISINs are untouched",
    "Quantity and value come from the newest safe statement; the latest broker keeps cost and terms",
  ],
  ask: askBox(8, [
    "TESTBOND1: cost empty → 200000 (Motilal Oswal holdings report 5 Nov 2026)",
    "TESTBOND2: cost empty → 250000 (Motilal Oswal holdings report 5 Nov 2026)",
    "TESTBOND3: cost empty → 300000 (Motilal Oswal holdings report 5 Nov 2026)",
    "TESTSTOCK1: quantity 10 → 12 (Zerodha holdings 12 Nov 2026)",
    "TESTSTOCK2: quantity 8 → 10 (Zerodha holdings 12 Nov 2026)",
    "TESTSTOCK3: value 100000 → 120000 (Zerodha holdings 12 Nov 2026)",
    "TESTFUND1: cost empty → 50000 (Motilal Oswal holdings report 5 Nov 2026)",
    "TESTFUND2: label changed (Zerodha holdings 12 Nov 2026)",
  ]),
  primary: "Import 5 holdings",
  primaryDisabled: true,
});

const movementCas = card({
  kicker: "Depository statement",
  title: "CDSL CAS",
  sub: "1 bond · as on 31 Oct 2026 · 1 file",
  pill: ready,
  files: file("cas-oct-2026.pdf", "Depository statement (CAS) · 31 Oct 2026"),
  where: `<div class="import-section">
    <div class="import-section-title">Accounts in this statement</div>
    <div class="import-account-list">
      ${account("CDSL · …4321", "Update the account · 1 of 1 ISIN matches", "1 holding")}
    </div>
  </div>`,
  change: ["Update 1 holding", "Record 1 sale or transfer as sold"],
  still: [
    "Nothing is written until you press Import",
    "Other accounts with overlapping ISINs are untouched",
    "Quantity and value come from the newest safe statement; the latest broker keeps cost and terms",
  ],
  warning: `<div class="muted import-note">This statement records disposals. A broker report for the
    same account stays its own card; import it first to keep its cost on the disposal.</div>`,
  primary: "Import 1 holding",
});

const movementBroker = card({
  kicker: "Broker holdings report",
  title: "Motilal Oswal holdings report",
  sub: "1 bond · as on 5 Nov 2026 · 1 file",
  pill: review,
  files: file("motilal-holdings.pdf", "Motilal Oswal holdings report · 5 Nov 2026"),
  where: `<div class="import-section">
    <div class="import-section-title">Account</div>
    <div class="import-account-list">
      ${account("CDSL · …4321", "UCID match · 1 holding in the report", "1 of 1")}
    </div>
  </div>`,
  change: ["Record the sold cost basis on 1 disposal", "Update 1 holding",
    "Attach the account identity"],
  still: [
    "Nothing is written until you press Import",
    "Other accounts with overlapping ISINs are untouched",
    "Quantity and value come from the newest safe statement; the latest broker keeps cost and terms",
  ],
  ask: askBox(1, [
    "8.00% SOLD BOND 31 Dec 2028: sold cost empty → ₹ 2,000.00 "
      + "(Motilal Oswal holdings report 2026-11-05) · the CAS records 10 units sold on "
      + "2026-10-10; the sale stays and this report fills its cost basis",
  ]),
  primary: "Record the sold cost basis",
  primaryDisabled: true,
});

// A disposal that already carries a basis keeps it. Nothing is asked, and the
// card names both numbers instead of leaving the person to compare them.
const keptBasis = card({
  kicker: "Broker holdings report",
  title: "Motilal Oswal holdings report",
  sub: "1 bond · as on 5 Nov 2026 · 1 file",
  pill: ready,
  files: file("motilal-holdings.pdf", "Motilal Oswal holdings report · 5 Nov 2026"),
  where: `<div class="import-section">
    <div class="import-section-title">Account</div>
    <div class="import-account-list">
      ${account("CDSL · …4321", "UCID match · 1 holding in the report", "1 of 1")}
    </div>
  </div>`,
  change: ["Nothing to change"],
  still: [
    "Nothing is written until you press Import",
    "Other accounts with overlapping ISINs are untouched",
    "Quantity and value come from the newest safe statement; the latest broker keeps cost and terms",
  ],
  warning: `<div class="muted import-note">INE000000201: the recorded sale already carries
    1,900.00; Motilal Oswal holdings report prices the same units at 2,000.00. The recorded
    cost is kept.</div>`,
  primary: "Nothing to change",
});

const fixture = (theme, cards) => `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>
  body { margin: 0; padding: 24px 16px 40px; background: var(--bg); color: var(--ink); }
  .fixture { max-width: 760px; margin: 0 auto; }
  .fixture-head { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
  .fixture-sub { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
  .fixture-cards { display: grid; gap: 16px; }
</style>
</head>
<body>
<main class="fixture">
  <p class="fixture-head">One plan per resolved account</p>
  <p class="fixture-sub">Synthetic content. The card uses the app's own classes and stylesheet.</p>
  <div class="fixture-cards">${cards}</div>
</main>
</body>
</html>`;

for (const theme of ["light", "dark"]) {
  const path = join(tmpdir(), `bankpipe-plan-card-${theme}.html`);
  writeFileSync(path, fixture(theme, merged));
  console.log(path);
  const movedPath = join(tmpdir(), `bankpipe-plan-card-moved-${theme}.html`);
  writeFileSync(movedPath, fixture(theme, `${movementCas}${movementBroker}${keptBasis}`));
  console.log(movedPath);
}
