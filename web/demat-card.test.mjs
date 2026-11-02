import test from "node:test";
import assert from "node:assert/strict";

import { dematCardHtml, dematCardModel, dematLast4, dematMismatchLine, dematText }
  from "./demat-card.js";

const reportDemat = "1201090009140907";
const targetDemat = "IN30302873183122";
const targetAsset = {
  id: "bonds-1",
  label: "Bonds · portfolio 1",
  bank: "DigiFInn",
  number: targetDemat,
  holder: "BABITA BHALLA",
};
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
  targetAsset,
  targetDemat,
  mapped: "bonds-2",
  mappedAsset,
};

test("the card uses the full Demat, label and holder from the same identity", () => {
  const model = dematCardModel(base);
  assert.equal(model.heading,
    "This snapshot is for Demat 1201090009140907 (MINENDER BHALLA).");
  assert.equal(model.applying,
    "You are applying to Bonds · portfolio 1 · IN30302873183122 (BABITA BHALLA).");
  assert.equal(model.safe.label,
    "Apply to Bonds · portfolio 2 (MINENDER BHALLA)");
  assert.equal(model.create, "Create a portfolio for …0907");
  assert.equal(model.override, "Apply here anyway");
  assert.equal(model.cancel, "Cancel");
});

test("a missing holder drops the parentheses, not the identity", () => {
  const noReportHolder = dematCardModel({ ...base, reportHolder: "" });
  assert.equal(noReportHolder.heading,
    "This snapshot is for Demat 1201090009140907.");
  const noTargetHolder = dematCardModel({
    ...base, targetAsset: { ...targetAsset, holder: "" },
  });
  assert.equal(noTargetHolder.applying,
    "You are applying to Bonds · portfolio 1 · IN30302873183122.");
  const noMappedHolder = dematCardModel({
    ...base, mappedAsset: { ...mappedAsset, holder: "" },
  });
  assert.equal(noMappedHolder.safe.label, "Apply to Bonds · portfolio 2");
});

test("a missing number drops the middle clause without a double separator", () => {
  const model = dematCardModel({
    ...base, targetDemat: "", targetAsset: { ...targetAsset, number: "" },
  });
  assert.equal(model.applying,
    "You are applying to Bonds · portfolio 1 (BABITA BHALLA).");
  assert.equal(/·\s*·/.test(model.applying), false);
});

test("the safe destination falls back to the mapped id, never an empty label", () => {
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

test("the card buttons run safe, create, destructive, cancel in that order", () => {
  const html = dematCardHtml(base);
  const safe = html.indexOf("Apply to Bonds · portfolio 2 (MINENDER BHALLA)");
  const create = html.indexOf("Create a portfolio for …0907");
  const override = html.indexOf("Apply here anyway");
  const cancel = html.indexOf("Cancel");
  assert.ok(safe > -1 && safe < create && create < override && override < cancel);
  assert.match(html, /class="btn danger" onclick="bpDigiFinnKeepPortfolio\(\)"/);
  assert.match(html, /onclick="bpDigiFinnCancel\(\)"/);
  assert.match(html, /bpDigiFinnSyncPreview\(&quot;bonds-2&quot;\)/);
  assert.equal(html.includes("Import into"), false);
  assert.equal(html.includes("Keep this portfolio"), false);
  assert.equal(html.includes("Use "), false);
  assert.equal(html.includes('""'), false);
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
