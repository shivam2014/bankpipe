import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bondSyncNotices, bondSyncAcceptLabel, bondSyncConfirmText } from "./bond-sync-warnings.js";

const mappingLine = "This Demat is mapped to Bonds · portfolio 1."
  + " Applying here will move the mapping to this portfolio.";

test("a target other than the mapped portfolio is a danger", () => {
  const notices = bondSyncNotices({
    removed: 0,
    warnings: ["1 ISIN appears more than once in the Portfolio Report;"
      + " each row is kept as a separate lot."],
  }, { target: "bonds-2", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(notices.dangers, [mappingLine]);
  assert.equal(notices.notes.length, 1);
});

test("removed lots are a danger even when the mapping does not move", () => {
  const notices = bondSyncNotices({ removed: 17, warnings: [] },
    { target: "bonds-1", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(notices.dangers,
    ["Applying here removes 17 existing lots from this portfolio."]);
});

test("the mapping move is read before the removed count", () => {
  const notices = bondSyncNotices({ removed: 17, warnings: [] },
    { target: "bonds-2", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(notices.dangers, [mappingLine,
    "Applying here removes 17 existing lots from this portfolio."]);
});

test("one removed lot is singular", () => {
  const notices = bondSyncNotices({ removed: 1, warnings: [] },
    { target: "bonds-1", mapped: "bonds-1" });
  assert.deepEqual(notices.dangers,
    ["Applying here removes 1 existing lot from this portfolio."]);
});

test("a matching portfolio with nothing removed has no danger", () => {
  const notices = bondSyncNotices({ removed: 0,
    warnings: ["Portfolio report is as of 2026-10-26; Investment report is as of 2026-10-25."] },
    { target: "bonds-1", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(notices.dangers, []);
  assert.deepEqual(notices.notes,
    ["Portfolio report is as of 2026-10-26; Investment report is as of 2026-10-25."]);
});

test("creating a portfolio for an already mapped Demat is a danger", () => {
  const notices = bondSyncNotices({ removed: 0, warnings: [] },
    { target: "__new__", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(notices.dangers, ["This Demat is already mapped to Bonds · portfolio 1."
    + " Creating a new portfolio may duplicate it."]);
});

test("a report from another Demat leads the dangers", () => {
  const line = "These reports belong to Demat …3122, not this portfolio.";
  const notices = bondSyncNotices({ removed: 0, warnings: [] },
    { target: "bonds-1", mapped: "bonds-1", mismatch: true, mismatchLine: line });
  assert.equal(notices.dangers[0], line);
});

test("the dialog body carries the action and the informational notes", () => {
  const text = bondSyncConfirmText({
    target: "bonds-2",
    current: 9,
    notes: ["1 ISIN appears more than once in the Portfolio Report."],
  });
  assert.equal(text, [
    "Replace the holdings on this portfolio with 9 current lots?",
    "1 ISIN appears more than once in the Portfolio Report.",
  ].join("\n\n"));
});

test("creating a portfolio names it in the dialog body", () => {
  const text = bondSyncConfirmText({
    target: "__new__", name: "Bonds · DigiFInn 3122", current: 7,
  });
  assert.equal(text, "Create “Bonds · DigiFInn 3122” and import 7 current lots?");
});

test("the accept label names each danger combination", () => {
  assert.equal(bondSyncAcceptLabel({ mapping: true, removed: 17 }),
    "Move mapping and remove 17 lots");
  assert.equal(bondSyncAcceptLabel({ mapping: false, removed: 17 }),
    "Remove 17 lots");
  assert.equal(bondSyncAcceptLabel({ mapping: true, removed: 0 }),
    "Move mapping");
  assert.equal(bondSyncAcceptLabel({ mapping: false, removed: 0 }),
    "Replace holdings");
  assert.equal(bondSyncAcceptLabel({ mapping: false, removed: 1 }),
    "Remove 1 lot");
});

test("notices report the kinds behind the accept label", () => {
  const both = bondSyncNotices({ removed: 17, warnings: [] },
    { target: "bonds-2", mapped: "bonds-1", mappedLabel: "Bonds · portfolio 1" });
  assert.deepEqual(both.dangers, [mappingLine,
    "Applying here removes 17 existing lots from this portfolio."],
  "the mapping line stays first");
  assert.equal(both.mapping, true);
  assert.equal(both.removed, 17);
  const clean = bondSyncNotices({ removed: 0, warnings: [] },
    { target: "bonds-1", mapped: "bonds-1" });
  assert.equal(clean.mapping, false);
  assert.equal(clean.removed, 0);
});

test("the preview feeds the dialog and writes only after consent", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /\.sync-danger\{color:var\(--red\);font-size:12\.5px;font-weight:600/);
  assert.match(html, /bondSyncNotices\(sync, \{/);
  assert.ok(html.includes("${dangerHtml}<div class=\"stats\">"),
    "dangers come before the numbers");
  const dialog = html.slice(html.indexOf('<dialog id="bond-sync-dialog">'),
    html.indexOf("</dialog>", html.indexOf('<dialog id="bond-sync-dialog">')));
  assert.match(dialog, /id="bond-sync-dangers" class="sync-danger"/);
  assert.ok(dialog.indexOf('id="bond-sync-cancel"') < dialog.indexOf('id="bond-sync-accept"'),
    "Cancel is first in tab order");
  assert.match(html, /#bond-sync-dialog \.btn\.danger\{background:var\(--red\)/);
  const start = html.indexOf("window.bpDigiFinnSyncApply = async () => {");
  const apply = html.slice(start, html.indexOf("function digiFinnCardHtml", start));
  assert.equal(/\bconfirm\(/.test(apply), false, "no native confirm in the apply path");
  assert.match(apply, /acceptLabel: bondSyncAcceptLabel\(kinds\)/);
  const ask = apply.indexOf("await bpBondSyncAsk(");
  const giveUp = apply.indexOf("if (!accepted) return;");
  const snapshot = apply.indexOf('snapshotDb("Before DigiFInn bond sync")');
  const store = apply.indexOf('await import("./db.js")');
  assert.ok(ask > -1 && giveUp > ask && store > giveUp && snapshot > giveUp,
    "reads, consent and writes stay in that order");
  const beforeConsent = apply.slice(ask, giveUp);
  assert.equal(/\bstore\./.test(beforeConsent), false,
    "Cancel never reaches a store call");
  assert.equal(/snapshotDb|replaceHoldings|updateAccount|setSetting/.test(beforeConsent),
    false, "Cancel never reaches a write");
});

