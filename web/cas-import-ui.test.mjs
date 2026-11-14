import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The import inbox and the CAS card are one module. These checks fail when the
// wiring that keeps the preview, the writer and the receipt on the same plan is
// removed; the planner itself is covered by cas-apply.test.mjs and
// cas-events.test.mjs.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("a movements-only statement never offers the replace dialog", () => {
  assert.match(html, /const movementsOnly = !\(cas\.holdings \|\| \[\]\)\.length/);
  assert.match(html, /replacing && !confirmed && !movementsOnly/);
  assert.match(html, /confirmed: allowAbsentRemoval && confirmed && !movementsOnly/);
});

test("a movement named by its own account receives the disposal without holdings", () => {
  assert.match(html, /const movementBos = new Set/);
  assert.match(html, /const movementHome = movementBos\.has\(accountBo\)/);
  assert.match(html, /movementHome\s*\n?\s*\|\| held\.some/);
  // Only a demat target, so a cost-only portfolio never receives movements.
  assert.match(html, /String\(account\.category \|\| ""\) !== "demat"/);
});

test("a movement BO absent from the holdings table still passes its account", () => {
  assert.match(html, /casMovementAccountBos\(\{ accounts,/);
  assert.match(html, /routeAccounts: route\.accounts/);
});

test("a movement-only demat is seeded into the preview", () => {
  assert.match(html, /casPreviewAccounts\(\{/);
  assert.match(html, /const previewAccounts = casPreviewAccounts/);
  assert.match(html, /for \(const account of previewAccounts\)/);
  assert.match(html, /const headerHoldings = casWritableHoldings/);
});

test("a trade-only statement with no account is not reported ready", () => {
  assert.match(html, /bundle\.movementBlocked/);
  assert.match(html, /!safety\.blocked && !bundle\.movementBlocked/);
  assert.match(html, /No account on file can take this statement's movements/);
});

test("the inbox receipt carries the sold, linked and conflict counts", () => {
  assert.match(html, /sold: outcome\.sold \|\| 0/);
  assert.match(html, /linkedSold: outcome\.linkedSold \|\| 0/);
  assert.match(html, /parts\.push\(`\$\{sold\} sale/);
  assert.match(html, /conflicts\.length \? "" : "good"/);
});

test("the CAS preview lists a sold row with its cost", () => {
  assert.match(html, /casSoldLines\(plan, \{ money \}\)/);
});

test("a movement-only card keeps its manual target and says it has no account", () => {
  assert.match(html, /const movementLines = /);
  assert.match(html, /const noHome = !hasTarget/);
  assert.match(html, /No account for these\s+movements yet/);
  assert.match(html, /const manual = \(!route\.demat \|\| !routeHomed\) && manualTargets\.length/);
});

test("the card requires a homed route or a manual target before Import", () => {
  assert.match(html, /\(!!route\.demat && routeHomed\) \|\| \(!!manual && manualTargets\.length > 0\)/);
  assert.match(html, /manualTarget: !!manualTargetId && manualTargetId === assetId/);
  assert.match(html, /onchange="bpCasManualPreview\('\$\{hostId\}', this\.value\)"/);
  assert.match(html, /manualTarget: true \}\);/);
});

test("the preview and the writer share the closed-holding rule", () => {
  assert.match(html, /import \{ casClosedRow, /);
  assert.equal(/function casClosedRow\(/.test(html), false);
  assert.match(html, /casClosedRow\(h, importDay\)/);
  assert.match(html, /casClosedRow\(h, cardImportDay\)/);
});

test("an identity-only target contributes no rows to the write", () => {
  assert.match(html, /casImportHoldings\(\{ parsed, targets \}\)/);
  assert.match(html, /accounts: scoped\.accounts/);
});

test("a holdings file and a bond CSV keep the sold rows on file", () => {
  const kept = html.match(/const disposed = before\.filter\(\(row\) => row\.disposed_at\)/g) || [];
  assert.equal(kept.length, 2);
});

test("linked warnings do not enable Import as if they were sales", () => {
  assert.match(html, /const hasSales = salePlans\.some/);
  assert.match(html, /\.concat\(linkedLines, movementLines\)/);
  assert.equal(/\.concat\(linkedLines, linkedWarnings\)/.test(html), false);
});

test("a sold-only holdings card keeps its add actions", () => {
  assert.match(html, /No live holdings/);
  assert.match(html, /\$\{isDemat \|\| cat === "bonds" \|\| isFolio/);
});
