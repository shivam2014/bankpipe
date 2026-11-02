import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bondSyncNotices, bondSyncConfirmText } from "./bond-sync-warnings.js";

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

test("the Apply confirm repeats the dangers before the notes", () => {
  const text = bondSyncConfirmText({
    target: "bonds-2",
    current: 9,
    dangers: [mappingLine, "Applying here removes 17 existing lots from this portfolio."],
    notes: ["1 ISIN appears more than once in the Portfolio Report."],
  });
  assert.equal(text, [
    "Replace the holdings on this portfolio with 9 current lots?",
    mappingLine,
    "Applying here removes 17 existing lots from this portfolio.",
    "1 ISIN appears more than once in the Portfolio Report.",
  ].join("\n\n"));
});

test("creating a portfolio names it in the confirm", () => {
  const text = bondSyncConfirmText({
    target: "__new__", name: "Bonds · DigiFInn 3122", current: 7,
    dangers: ["This Demat is already mapped to Bonds · portfolio 1. Creating a new portfolio may duplicate it."],
  });
  assert.match(text,
    /^Create “Bonds · DigiFInn 3122” and import 7 current lots\?\n\nThis Demat is already mapped/);
});

test("the preview renders dangers above the stats and Apply repeats them", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /\.sync-danger\{color:var\(--red\);font-size:12\.5px;font-weight:600/);
  assert.match(html, /bondSyncNotices\(sync, \{/);
  assert.ok(html.includes("${dangerHtml}<div class=\"stats\">"),
    "dangers come before the numbers");
  assert.match(html, /confirm\(bondSyncConfirmText\(\{ target, name, current: sync\.current,/);
  assert.match(html, /confirm\(bondSyncConfirmText\(\{ target, current: sync\.current,/);
});
