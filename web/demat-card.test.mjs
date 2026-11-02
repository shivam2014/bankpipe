import test from "node:test";
import assert from "node:assert/strict";

import { dematCardHtml, dematCardModel, dematLast4, dematMismatchLine, dematText,
  syncPreviewCardHtml } from "./demat-card.js";

const reportDemat = "1201090009140907";
const targetDemat = "IN30302873183122";
const mappedAsset = {
  id: "bonds-2",
  label: "Bonds · portfolio 2",
  bank: "DigiFInn",
  number: reportDemat,
  holder: "MINENDER BHALLA",
};
const base = {
  target: "bonds-1",
  reportDemat,
  reportHolder: "MINENDER BHALLA",
  targetDemat,
  mapped: "bonds-2",
  mappedAsset,
  removed: 5,
  current: 17,
};

test("one red line names the snapshot, one names the move and removals", () => {
  const model = dematCardModel(base);
  assert.equal(model.heading,
    "This snapshot is for Demat 1201090009140907 (MINENDER BHALLA).");
  assert.equal(model.consequence,
    "Applying here would move that Demat from Bonds · portfolio 2 (MINENDER BHALLA)"
    + " and remove 5 of the 17 lots.");
  assert.equal(model.sub, "Nothing is written until you choose.");
  assert.equal(model.safe.label,
    "Apply to Bonds · portfolio 2 (MINENDER BHALLA)");
  assert.equal(model.create, "Create a portfolio for …0907");
  assert.equal(model.override, "Apply here anyway");
  assert.equal(model.cancel, "Cancel");
});

test("a mapping move without removals keeps one clause", () => {
  const model = dematCardModel({ ...base, removed: 0 });
  assert.equal(model.consequence,
    "Applying here would move that Demat from Bonds · portfolio 2 (MINENDER BHALLA).");
});

test("removals without a mapping move keep the lot clause", () => {
  const model = dematCardModel({ ...base, mapped: "", mappedAsset: null });
  assert.equal(model.consequence, "Applying here would remove 5 of the 17 lots.");
});

test("no mapping move and no removals leaves no second red line", () => {
  const model = dematCardModel({ ...base, mapped: "bonds-1", removed: 0 });
  assert.equal(model.consequence, "");
});

test("a missing holder drops the parentheses in the mapped identity", () => {
  const model = dematCardModel({
    ...base, mappedAsset: { ...mappedAsset, holder: "" },
  });
  assert.equal(model.safe.label, "Apply to Bonds · portfolio 2");
  assert.equal(model.consequence,
    "Applying here would move that Demat from Bonds · portfolio 2"
    + " and remove 5 of the 17 lots.");
});

test("a missing mapped asset falls back to the id, never an empty label", () => {
  const model = dematCardModel({ ...base, mappedAsset: null });
  assert.equal(model.safe.label, "Apply to bonds-2");
  assert.equal(model.safe.label.includes('""'), false);
});

test("the safe destination disappears when it is the current portfolio", () => {
  assert.equal(dematCardModel({ ...base, mapped: "bonds-1" }).safe, null);
});

test("the safe destination disappears when nothing is mapped", () => {
  assert.equal(dematCardModel({ ...base, mapped: "", mappedAsset: null }).safe, null);
});

test("a quote-only Demat is treated as absent", () => {
  const model = dematCardModel({ ...base, reportDemat: '""', reportHolder: "" });
  assert.equal(model.heading, "This snapshot is for another Demat.");
  assert.equal(model.heading.includes('""'), false);
  assert.equal(dematMismatchLine('""', ""),
    "These reports belong to another Demat, not this portfolio.");
});

test("the mismatch line uses the full Demat and holder", () => {
  assert.equal(dematMismatchLine(reportDemat, "MINENDER BHALLA"),
    "These reports belong to Demat 1201090009140907 (MINENDER BHALLA), not this portfolio.");
  assert.equal(dematMismatchLine(reportDemat, ""),
    "These reports belong to Demat 1201090009140907, not this portfolio.");
  assert.equal(dematMismatchLine("", ""),
    "These reports belong to another Demat, not this portfolio.");
  assert.equal(dematMismatchLine("").includes("…"), false);
});

test("the first card states the snapshot and the choice once each", () => {
  const html = dematCardHtml(base);
  const count = (text) => html.split(text).length - 1;
  assert.equal(count("This snapshot is for Demat 1201090009140907 (MINENDER BHALLA)."), 1);
  assert.equal(count("Nothing is written until you choose."), 1);
  assert.equal(count("Apply here anyway"), 1);
  assert.equal(count("Apply sync"), 0);
});

test("a safe preview card has no danger line", () => {
  const html = syncPreviewCardHtml({
    header: "<b>Applying to Bonds · portfolio 2 (MINENDER BHALLA)</b>",
    body: `<div class="stats"></div><details class="sync-details"><summary>Details</summary></details>`,
  });
  assert.equal((html.match(/class="card pad"/g) || []).length, 1);
  assert.equal(html.includes("sync-danger"), false);
  assert.ok(html.includes("Applying to Bonds · portfolio 2 (MINENDER BHALLA)"));
});

test("the first card is one card with four buttons and no preview", () => {
  const html = dematCardHtml(base);
  assert.equal((html.match(/class="card pad"/g) || []).length, 1);
  assert.equal(html.includes('class="stats"'), false);
  assert.equal(html.includes("<details"), false);
  assert.equal(html.includes("Apply sync"), false);
  const safe = html.indexOf("Apply to Bonds · portfolio 2 (MINENDER BHALLA)");
  const create = html.indexOf("Create a portfolio for …0907");
  const override = html.indexOf("Apply here anyway");
  const cancel = html.indexOf("Cancel");
  assert.ok(safe > -1 && safe < create && create < override && override < cancel);
  assert.match(html, /class="btn danger" onclick="bpDigiFinnKeepPortfolio\(\)"/);
  assert.match(html, /onclick="bpDigiFinnCancel\(\)"/);
  assert.equal(html.includes("Import into"), false);
  assert.equal(html.includes("Keep this portfolio"), false);
  assert.equal(html.includes("Import anyway"), false);
});

test("the preview body replaces the button row in the same card", () => {
  const body = `<div class="stats"><div><div class="k">Removed</div><div class="v">5</div></div></div>
    <details class="sync-details"><summary>Details</summary></details>
    <button class="btn" onclick="bpDigiFinnSyncApply()">Apply sync</button>`;
  const html = dematCardHtml(base, { body });
  assert.equal((html.match(/class="card pad"/g) || []).length, 1);
  assert.equal(html.includes("Apply here anyway"), false);
  assert.equal(html.includes("Create a portfolio for …0907"), false);
  assert.ok(html.includes(body), "the preview lands where the buttons were");
  assert.equal(html.indexOf("This snapshot is for") < html.indexOf('class="stats"'), true);
});

test("an unknown or matching Demat still shows no card", () => {
  assert.equal(dematCardHtml({ ...base, targetDemat: "" }), "");
  assert.equal(dematCardHtml({ ...base, reportDemat: "" }), "");
  assert.equal(dematCardHtml({ ...base, targetDemat: reportDemat }), "");
});

test("last four digits are digits only", () => {
  assert.equal(dematLast4("1201 0900 0914 0907"), "0907");
  assert.equal(dematLast4(""), "");
});

test("a quote-only Demat is empty text, not two quote characters", () => {
  assert.equal(dematText('""'), "");
  assert.equal(dematText('"1201090009140907"'), "1201090009140907");
  assert.equal(dematText("  "), "");
});
