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

test("the card lets a statement create the demat it also moves", () => {
  // The decision lives in one pure function so the card, the button and the
  // footer cannot disagree: a movement account is placed by an account on file,
  // by a target this import will create from the statement's own rows, or by a
  // target whose empty number the writer fills. The page only reads the verdict.
  assert.match(html, /const gap = movementAccountGap\(\{/);
  assert.match(html, /targets: bundle\.casTargets/);
  assert.match(html, /bundle\.movementBlocked = gap\.blocked/);
  assert.match(html, /gap\.reason/);
  assert.match(html, /!safety\.blocked && !bundle\.movementBlocked/);
});

test("the credit warnings collapse to one line with the detail behind a disclosure", () => {
  assert.match(html, /const digest = importWarningDigest\(warnings\)/);
  assert.match(html, /digest\.groups\.map/);
  assert.match(html, /<details class="import-change-more"><summary>Which/);
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
  assert.match(html, /const headerHoldings = writableHoldings\.length/);
  assert.match(html, /const kindCount = \{\}/);
  assert.match(html, /for \(const holding of writableHoldings\)/);
});

test("the inbox preview includes a movement-named demat missing from the holdings table", () => {
  assert.match(html, /const extraMovementTargets = casPreviewAccounts/);
  assert.match(html, /for \(const extra of extraMovementTargets\)/);
  assert.match(html, /accounts: \[extra\.boId\]/);
});

test("the inbox picks a movement-only demat into its import set", () => {
  assert.match(html, /const units = casImportUnits\(\{/);
  assert.match(html, /movements: cas\.transactions/);
});

test("a zero-unit fund is not shown as a folio unit", () => {
  // The folio units come from casRoute, whose positive-folio rule keeps a
  // zero-unit row in the demat and out of the folio ticks.
  assert.match(html, /filter\(\(group\) => group\.kind === "mf" && group\.folio\)/);
  assert.equal(/casFolioHoldings/.test(html), false);
});

test("the writer groups rows through the shared folio rule", () => {
  assert.match(html, /casGroupByAsset\(\{ holdings: cas\.holdings/);
  assert.match(html, /picked: card\.picked \|\| null/);
});

test("a manual demat target keeps a zero-unit folio row", () => {
  assert.match(html,
    /if \(id\) byAsset\.set\(id, cas\.holdings\.filter\(\(h\) => !casClosedRow\(h, importDay\)\)\)/);
  assert.equal(
    /h\.kind === "mf" && h\.folio && !\(Number\(h\.quantity\) > 0\)/.test(html), false);
});

test("the card demat rows use the shared folio rule", () => {
  assert.match(html, /const dematRowsOf = \(bo\) => casDematRows\(writableHoldings, bo\)/);
});

test("unticking a seeded movement-only demat stops its sale", () => {
  assert.match(html, /card\.picked && \(named \|\| movementHome\)/);
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
  assert.match(html, /const writableHoldings = casWritableHoldings\(cas\.holdings, cardImportDay\)/);
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

test("the CAS inbox matches a folio by its number, not by AMC label or ISIN", () => {
  assert.match(html, /accountKey: group\.folioNo, accountKind: "folio"/);
  assert.match(html, /amc: group\.amc,/);
  assert.match(html, /const key = `\$\{amc\.toLowerCase\(\)\}:\$\{normalizeFolio\(folioNo\)\}`/);
  assert.match(html, /const choiceKey = `\$\{bundle\.key\}:\$\{folioKey\(group\)\}`/);
  assert.match(html, /boId: folioKey\(group\)/);
  assert.match(html, /folio: true, amc: group\.amc/);
});

test("the CAS card groups fund units and sales by folio", () => {
  assert.match(html, /const folioGroups = \[\.\.\.route\.groups, \.\.\.route\.homeless\]/);
  assert.match(html, /const key = folioKey\(group\)/);
  assert.match(html, /folioTail\(group\.folioNo\)/);
  assert.match(html, /normalizeFolio\(holding\.folio\) === normalizeFolio\(group\.folioNo\)/);
  const unitKeys = html.match(
    /const unitKey = \(g\) => \(g\.kind === "mf" && g\.folio\)\s*\n?\s*\? folioKey\(g\)/g) || [];
  assert.equal(unitKeys.length, 2, "the card and the writer share one folio key");
});

test("the inbox keeps a new folio row's cost through the plan", () => {
  assert.match(html,
    /casCostedImportHoldings\(\{ holdings: scoped\.holdings, targets: importTargets \}\)/);
});

test("account creation makes one account per folio, not one per AMC label", () => {
  assert.match(html, /const folioNo = String\(group\.folioNo \|\| ""\)\.trim\(\)/);
  assert.match(html, /const folio = normalizeFolio\(folioNo\)/);
  assert.match(html, /done\.has\(folioKey\(group\)\)\) continue;/);
  assert.match(html, /done\.add\(folioKey\(group\)\);/);
  assert.match(html, /if \(folioHome\(\{ folio: folioNo, amc \}, all\)\) continue;/);
  assert.equal(/accountFolios\(a\)\.includes\(folio\)/.test(html), false);
  assert.match(html, /number: folioNo/);
  assert.match(html, /folios: \[folioNo\]/);
  assert.match(html, /folioTail\(folioNo\)/);
  assert.equal(
    /String\(a\.label \|\| ""\)\.toLowerCase\(\)\.includes\(amc\.toLowerCase\(\)\)\)\) continue;/
      .test(html), false);
});

test("a sold-only holdings card keeps its add actions", () => {
  assert.match(html, /No live holdings/);
  assert.match(html, /\$\{isDemat \|\| cat === "bonds" \|\| isFolio/);
});

test("an exact folio offer shows the manual total, not a new-account line", () => {
  assert.match(html, /"Existing folio · choose below"/);
  assert.match(html, /"Kept the manual total"/);
  // The generic identity buttons are hidden for an exact offer, so no click can
  // adopt without the money copy.
  assert.match(html, /target\.offer\?\.basis !== "folio"/);
  assert.match(html, /targetId = offer\.state === "adopt" \? offer\.chosen : ""/);
  assert.match(html, /action: exact/);
  assert.match(html, /offer\.state === "kept" \? "kept" : "decide"/);
  assert.match(html, /target\.action !== "decide"/);
  assert.match(html, /target\.action === "decide"/);
});

test("the exact keep button passes __skip__ and never creates a second folio", () => {
  assert.match(html, /onChoose\(offer, "__skip__"\)/);
  assert.match(html, /accountId === "__skip__" \? "__skip__"/);
  assert.match(html, /folioChoices\[target\.offer\.key\] = "__skip__"/);
  assert.match(html, /target\.action !== "update"\) \{\s*\n\s*units\.delete/);
  assert.match(html, /offer\.basis === "folio" && offer\.state !== "adopt"/);
  assert.match(html, /Keep the manual total/);
  assert.match(html, /none of its rows were imported/);
  assert.match(html, /const keptKeys = new Set/);
  assert.match(html, /Finish without importing/);
  assert.match(html, /heldFolio === "decide" \? "Choose below"/);
});

test("the offer and the route read the same enriched account list", () => {
  // A manual total without its rows looks value-only; a real home with rows
  // looks the same unless every fund account is enriched before routing.
  assert.match(html, /const assets = await bpCasFundAccounts\(await store\.listAccounts\(\), store\)/);
  assert.match(html, /bpCasFolioPlan\(cas\.holdings, assets, prior\.folioChoices/);
  assert.match(html, /const folioPlan = bpCasFolioPlan\(cas\.holdings,/);
  assert.match(html, /await bpCasFundAccounts\(await store\.listAccounts\(\), store\),/);
  assert.match(html, /const current = casRoute\(cas,/);
  assert.match(html, /bpCasFundAccounts\(await store\.listAccounts\(\), store\), \{ adopt \}\)/);
});

test("an exact folio unit is disabled while the offer is undecided", () => {
  assert.match(html, /held \? "disabled" : ""/);
  assert.match(html, /kept the manual total" : "choose below/);
  assert.match(html, /cardState\.picked\.delete\(offer\.key\)/);
});

test("a value-only folio offer is shown, with the difference and both choices", () => {
  assert.match(html, /const folioPlan = folioAdoptionPlan\(\{/);
  assert.match(html, /bundle\.folioPlan = folioPlan/);
  assert.match(html, /const offerHtml = target\.offer/);
  assert.match(html, /casFolioOfferHtml\(target\.offer,/);
  assert.match(html, /looks like your existing/);
  assert.match(html, /They differ by/);
  assert.match(html, /Adopt into \$\{esc\(candidate\.label\)\}/);
  assert.match(html, /Keep both/);
  assert.match(html, /market movement/);
  assert.match(html, /keeping both\s+leaves both totals counting/);
});

test("the writer routes only the folio targets the person chose", () => {
  assert.match(html, /const adopt = folioPlan\.targets/);
  assert.match(html,
    /casRoute\(cas, await bpCasFundAccounts\(await store\.listAccounts\(\), store\)\)/);
  assert.match(html, /const folioChoices = \{\}/);
  assert.match(html, /casRoute\(cas, accounts, \{ adopt: folioChoices \}\)/);
  assert.match(html, /folioChoices\[target\.offer\.key\] = target\.targetId/);
  assert.match(html, /card\.folioChoices/);
});

test("the receipt says when a folio was adopted, kept or left ambiguous", () => {
  assert.match(html, /was not linked: \$\{offer\.reason\}/);
  assert.match(html, /was not linked because you chose Keep both/);
  assert.match(html, /was not linked; it is a new account and both/);
  assert.match(html, /adopted into \$\{adopted\.label\}/);
});

test("the old CAS card offers adoption and keeps the choice", () => {
  assert.match(html, /window\.bpCasAdoptChoice = \(key, folio, accountId\)/);
  assert.match(html, /card\.folioChoices = \{ \.\.\.\(card\.folioChoices \|\| \{\}\),/);
  assert.match(html, /const folioPlan = bpCasFolioPlan\(cas\.holdings,/);
  assert.match(html, /const adopt = folioPlan\.targets/);
});

test("adoption replaces the manual total and writes the folio on the account", () => {
  assert.match(html, /if \(isFolioAccount\(asset\)\) \{\s*\n\s*delete meta\.current_value_paise;/);
  assert.match(html, /nextMeta\.folios = \[\.\.\.new Set\(\[\.\.\.known, \.\.\.folios\]\)\]/);
  assert.match(html, /if \(nextNumber\) patch\.number = nextNumber;/);
});

test("a statement with no printed total offers keep or a named removal, never a default replace", () => {
  // The card says the statement cannot prove it lists everything.
  assert.match(html, /This statement prints no total\./);
  // The gate is the absence of a printed total, not a client-side flag.
  assert.match(html, /if \(replaceGate && !safety\.totalPrinted\) \{/);
  // The rows and their value are on screen before the destructive choice.
  assert.match(html, /keeps the \$\{one \? "holding" : `\$\{removing\} holdings`\} on file/);
  assert.match(html, /money\(removingPaise\)/);
  assert.match(html, /wouldDrop\.slice\(0, 5\)/);
  // Keeping is the primary; removing is a separate button.
  assert.match(html, /onclick="bpCasImportKeep\('\$\{key\}'\)"/);
  assert.match(html, /onclick="bpCasImportReplaceNoTotal\('\$\{key\}'\)"/);
  // The override is one argument on one call, not a stored acceptance.
  assert.match(html,
    /window\.bpCasImportReplaceNoTotal = \(key = "cas-host"\) =>\s*\n\s*window\.bpCasImport\(key, true, \{ replaceAbsent: true, replaceWithoutTotal: true \}\);/);
  assert.match(html, /replaceWithoutTotal: allowAbsentRemoval && !!opts\.replaceWithoutTotal/);
  assert.equal(/card\.replaceWithoutTotal|state\.replaceWithoutTotal|acceptNoTotal/.test(html),
    false);
});

test("the printed-total dialog keeps its replace path", () => {
  assert.match(html, /} else if \(replaceGate\) \{/);
  assert.match(html, /onclick="bpCasImportConfirm\('\$\{key\}'\)"/);
  assert.match(html, /Replace and import<\/button>/);
});
