import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The import inbox and the CAS card are one module. These checks fail when the
// wiring that keeps the preview, the writer and the receipt on the same plan is
// removed; the planner itself is covered by cas-apply.test.mjs and
// cas-events.test.mjs.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

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

test("a manual demat target takes the statement's rows, never a positive folio", () => {
  assert.match(html,
    /byAsset\.set\(id, casManualTargetRows\(cas\.holdings, importDay\)\)/);
  // The rule lives in the pure module, so the card, the manual preview and the
  // writer share it.
  assert.match(html, /casManualTargetEvents\(card\.cas\.transactions, card\.cas\.holdings\)/);
  assert.match(html, /casManualTargetEvents\(cas\.transactions, withheldRows\)/);
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
  assert.match(html, /casClosedRow\(row, importDay\)/);
  assert.match(html, /const writableHoldings = casWritableHoldings\(cas\.holdings, cardImportDay\)/);
  assert.match(html, /casManualTargetRows\(cas\.holdings, importDay\)/);
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
  // The grouping key is the plan's own key, from the row's AMC as printed. A
  // "Folio" fallback here made the exact offer invisible on the card.
  assert.match(html, /const amc = String\(row\.amc \|\| ""\)\.trim\(\)/);
  assert.match(html, /const key = folioKey\(\{ amc, folioNo \}\)/);
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
  // Only a folio with no owner anywhere is a new account. A settled owner, a
  // manual total and a contested pair all refuse to create.
  assert.match(html,
    /if \(folioOwnership\(\{ folio: folioNo, amc \}, all\)\.state !== "new"\) continue;/);
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
  assert.match(html, /: exact\s*\n\s*\? \(targetId \? "update"/);
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
  assert.match(html, /bpCasFolioPlan\(cas\.holdings, assets, priorChoices\)/);
  assert.match(html, /const folioPlan = bpCasFolioPlan\(cas\.holdings,/);
  assert.match(html, /await bpCasFundAccounts\(await store\.listAccounts\(\), store\),/);
  assert.match(html, /const current = casRoute\(cas,/);
  assert.match(html, /bpCasFundAccounts\(await store\.listAccounts\(\), store\), \{ adopt \}\)/);
});

test("an exact folio unit is disabled while the offer is undecided", () => {
  assert.match(html, /held \|\| conflict \? "disabled" : ""/);
  assert.match(html, /kept the manual total" : "choose below/);
  assert.match(html, /cardState\.picked\.delete\(offer\.key\)/);
  assert.match(html, /cardState\.picked\.delete\(group\.key\)/);
});

test("a contested folio has no target, no create and an honest receipt", () => {
  // The resolver reads the plan's homes and contested states, not the label
  // sort, so the preview names the account the route writes.
  assert.match(html, /const home = folioPlan\.homes\.find/);
  assert.match(html, /const conflict = folioPlan\.contested\.find/);
  assert.match(html, /targetId = bpImportAccountRow\(home\.id\) \? home\.id : ""/);
  assert.match(html, /target\.action === "conflict"/);
  assert.match(html, /action: conflict \? "conflict"/);
  assert.match(html, /Two accounts hold this folio · not imported/);
  assert.match(html, /target\.action !== "conflict"\);/);
  assert.match(html, /none of its rows were\s+imported\. Remove one duplicate/);
  assert.match(html, /units\.delete\(group\.key\)/);
  assert.match(html, /const contested = card\.folioPlan\?\.contested \|\| \[\]/);
  assert.match(html, /two accounts hold this folio · not imported/);
  assert.match(html, /const contestedKeys = new Set/);
});

test("the writer boundary refuses an unanswered exact folio", () => {
  assert.match(html, /function bpCasPendingFolioMessage\(plan\)/);
  assert.match(html, /offer\.basis === "folio"\s*\n?\s*&& offer\.state !== "adopt" && offer\.state !== "kept"/);
  assert.match(html, /const pendingFolio = bpCasPendingFolioMessage\(folioPlan\)/);
  assert.match(html, /const pendingFolio = bpCasPendingFolioMessage\(/);
  assert.match(html, /still need the adopt-or-keep/);
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

test("the old CAS card waits for an exact folio answer before Import", () => {
  assert.match(html, /const undecidedFolio = \(cardState\.folioPlan\?\.offers \|\| \[\]\)/);
  assert.match(html, /offer\.state !== "adopt" && offer\.state !== "kept"/);
  assert.match(html, /&& hasTarget && !safety\.blocked && !undecidedFolio;/);
});

test("adoption replaces the manual total and writes the folio on the account", () => {
  // The manual total goes only when this write actually stored rows: an empty
  // plan must not erase a total it did not replace.
  assert.match(html, /if \(folioAccount && holdings\.length\) \{\s*\n\s*delete meta\.current_value_paise;/);
  assert.match(html, /nextMeta\.folios = \[\.\.\.new Set\(\[\.\.\.known, \.\.\.folios\]\)\]/);
  assert.match(html, /if \(nextNumber\) patch\.number = nextNumber;/);
  // A demat never answers to a folio: only a fund account collects the numbers.
  assert.match(html, /const folios = folioAccount \? \[\.\.\.new Set\(holdings/);
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

test("a kept folio keeps its movements out of the preview and the write", () => {
  const resolver = between("function bpImportResolveCas", "function bpImportPlanFiles");
  // The preview list drops the folio's ISIN before any target plans a sale.
  assert.match(resolver, /const withheldRows = \(base\?\.parsed\?\.holdings \|\| \[\]\)\.filter/);
  assert.match(resolver, /const movements = casManualTargetEvents\(base\?\.parsed\?\.transactions \|\| \[\], withheldRows\)/);
  assert.match(resolver, /if \(target\.folio && \(target\.action === "kept" \|\| target\.action === "decide"/);
  assert.match(resolver, /holdings: rows, events: movements,/);
  assert.match(resolver, /assetId: target\.targetId, asOf: bundle\.asOf \|\| "", confirmed: false/);
  // The writer reads the statement's full list, not the scoped subset it was
  // handed by the inbox.
  assert.match(html, /const withheldRows = \(card\.allHoldings \|\| cas\.holdings \|\| \[\]\)\.filter/);
  assert.match(html, /allHoldings: parsed\.holdings/);
});

test("a kept folio does not stop an unrelated movement or manual target", () => {
  assert.match(html, /const writable = \(card\.eventAssets \|\| \[\]\)\.length > 0 \|\| !!manualTarget/);
  assert.match(html, /if \(!window\.bpCasRoute\.groups\.length && !writable\) \{/);
});

test("a choice never carries into a different statement", () => {
  // Both the success path and the drop path clear every prefixed key.
  const apply = between("window.bpImportApplyPlan = async", "window.bpImportApplyAll");
  assert.match(apply, /choice\.startsWith\(`\$\{bundle\.key\}:`\)/);
  const drop = between("window.bpImportDropPlan", "function bpImportScrollBehavior");
  assert.match(drop, /choice\.startsWith\(`\$\{bundle\.key\}:`\)/);
  // The old card keeps its answers only for the file that asked the question.
  assert.match(html, /const sameFile = !!prior\.file && prior\.file === file/);
  assert.match(html, /const priorChoices = sameFile \? \(prior\.folioChoices \|\| \{\}\) : \{\}/);
  assert.match(html, /folioChoices: priorChoices, owner: sameFile \? prior\.owner : undefined/);
});

test("a manual target is a demat, never a fund account", () => {
  assert.match(html, /const manualTargets = assets\.filter\(\(a\) => categoryOf\(a\) === "demat"\s*\n\s*&& !isFolioAccount\(a\)\)/);
});

test("an adopted folio account gets no synthetic DP", () => {
  assert.match(html, /if \(target\.dpName && !target\.folio\) meta\.dp = target\.dpName/);
});

test("the inbox counts and writes the zero-unit folio row with its demat", () => {
  const resolver = between("function bpImportResolveCas", "function bpImportPlanFiles");
  // The zero-unit row is not a folio position, so it is not in the folio group.
  assert.match(resolver, /if \(!\(Number\(row\.quantity\) > 0\)\) continue/);
  // It stays in the demat's rows, which is the account that stores it.
  assert.match(resolver, /!\(row\.category === "mf" && row\.folio && Number\(row\.quantity\) > 0\)/);
});
