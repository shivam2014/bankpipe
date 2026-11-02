import test from "node:test";
import assert from "node:assert/strict";

import { dematCardHtml, dematCardModel, dematLast4, dematMismatchLine, dematText }
  from "./demat-card.js";

const reportDemat = "1201090009140907";
const targetDemat = "1201090009143122";
const base = {
  target: "bonds-1",
  reportDemat,
  targetDemat,
  mapped: "bonds-2",
  mappedLabel: "Bonds · portfolio 2",
};

test("the heading names both Demats and the destination button names the portfolio", () => {
  const model = dematCardModel(base);
  assert.equal(model.heading,
    "This snapshot belongs to Demat …0907, not this portfolio (…3122).");
  assert.equal(model.safe.label, "Apply to Bonds · portfolio 2");
  assert.equal(model.safe.id, "bonds-2");
  assert.equal(model.create, "Create a portfolio for …0907");
  assert.equal(model.override, "Apply here anyway");
  assert.equal(model.cancel, "Cancel");
});

test("an absent target last-4 drops the parenthetical, not the sentence", () => {
  const model = dematCardModel({ ...base, targetDemat: "" });
  assert.equal(model.heading,
    "This snapshot belongs to Demat …0907, not this portfolio.");
  assert.equal(/\(\)/.test(model.heading), false);
  assert.equal(model.heading.includes('""'), false);
  const quoted = dematCardModel({ ...base, targetDemat: '""' });
  assert.equal(quoted.heading,
    "This snapshot belongs to Demat …0907, not this portfolio.");
  assert.equal(quoted.heading.includes('""'), false);
});

test("an absent report last-4 drops the Demat suffix", () => {
  const model = dematCardModel({ ...base, reportDemat: "" });
  assert.equal(model.heading,
    "This snapshot belongs to another Demat, not this portfolio (…3122).");
  assert.equal(model.create, "Create a portfolio for this Demat");
});

test("a missing mapped label falls back to the id, never an empty button", () => {
  const model = dematCardModel({ ...base, mappedLabel: "" });
  assert.equal(model.safe.label, "Apply to bonds-2");
  assert.equal(model.safe.label.includes('""'), false);
});

test("the safe destination disappears when it is the current portfolio", () => {
  assert.equal(dematCardModel({ ...base, mapped: "bonds-1" }).safe, null);
});

test("the safe destination disappears when nothing is mapped", () => {
  assert.equal(dematCardModel({ ...base, mapped: "", mappedLabel: "" }).safe, null);
});

test("the mismatch line drops the Demat suffix when the last-4 is absent", () => {
  assert.equal(dematMismatchLine(reportDemat),
    "These reports belong to Demat …0907, not this portfolio.");
  assert.equal(dematMismatchLine(""),
    "These reports belong to another Demat, not this portfolio.");
  assert.equal(dematMismatchLine("").includes("…"), false);
  assert.equal(dematMismatchLine('""'),
    "These reports belong to another Demat, not this portfolio.");
});

test("the card buttons run safe, create, destructive, cancel in that order", () => {
  const html = dematCardHtml(base);
  const safe = html.indexOf("Apply to Bonds · portfolio 2");
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
