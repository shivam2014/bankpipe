import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from > -1, `missing ${start}`);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return html.slice(from, to);
};

test("the manual holding editor asks for fund fields, not bond terms", () => {
  const form = between("function renderManualHoldingForm()", "window.bpManualHoldingSave");
  for (const id of ["mh-name", "mh-isin", "mh-units", "mh-cost", "mh-bought",
    "mh-value", "mh-value-date"]) {
    assert.match(form, new RegExp(`id="${id}"`), `${id} is in the form`);
  }
  assert.doesNotMatch(form, /bh-coupon|bh-maturity|bh-rating|bh-freq/);
  assert.match(form, /id="mh-class"/);
});

test("the manual holding saves a fund or share class with source manual", () => {
  const save = between("window.bpManualHoldingSave", "window.bpHoldingsEdit");
  assert.match(save, /category: kind/);
  assert.match(save, /security_id: key/);
  assert.match(save, /MANUAL-/);
  assert.match(save, /upsertHolding/);
});

test("an empty folio shows the one action instead of disappearing", () => {
  const block = between("function holdingsBlock", "window.bpBondSort");
  assert.doesNotMatch(block, /if \(!rows \|\| !rows\.length\) return "";/);
  assert.match(block, /bpManualHoldingNew/);
  assert.match(block, /Add mutual fund/);
  assert.match(block, /holdings-empty/);
});

test("fund and equity cards carry edit and remove actions", () => {
  const card = between("function holdingCardHtml", "function holdingCards");
  assert.match(card, /class="bond-card-actions"/);
  assert.match(card, /bpManualHoldingEdit/);
  assert.match(card, /bpManualHoldingDelete/);
  assert.match(card, /accountValue/);
});

test("bond and holding cards share one action layout", () => {
  const bond = between("function bondCardHtml", "function holdingCardHtml");
  const holding = between("function holdingCardHtml", "function holdingCards");
  for (const card of [bond, holding]) {
    assert.match(card, /class="bond-card-title"/);
    assert.match(card, /class="bond-card-actions"/);
    assert.doesNotMatch(card, /flex-wrap:wrap">\s*<span class="bond-rating"/);
  }
});

test("the action row is top-right on desktop and below the title on narrow screens", () => {
  assert.match(html, /\.bond-card-head\{display:flex;justify-content:space-between;[\s\S]*?flex-wrap:nowrap\}/);
  assert.match(html, /\.bond-card-actions\{display:flex;gap:6px;align-items:center;flex-shrink:0;margin-left:auto;flex-wrap:wrap\}/);
  assert.match(html, /@media \(max-width:520px\)\{\.bond-card-head\{flex-wrap:wrap\}\.bond-card-actions\{flex-basis:100%;margin-left:0/);
  assert.match(html, /@media \(pointer:coarse\)\{\.bond-card-actions \.mini-btn,\.holding-head-actions \.btn\{min-height:44px\}\}/);
});

test("a folio page drops stray bond rows and the global reconcile card", () => {
  assert.match(html, /if \(isFundAccount\(account\)\) \{\s*holdings = holdings\.filter\(\(h\) => holdingClass\(h\) !== "bond"\);/);
  assert.match(html, /reconEligible\(\{ \.\.\.a, category: cat \}, holdings\)/);
  assert.match(html, /reconDismissed\(a\.id\) \? reconHiddenHtml\(\) : `<div id="recon-card"><\/div>`/);
  assert.match(html, /bpReconDismiss/);
  assert.match(html, /bpReconShow/);
});

test("the folio hero shows an account value with zero holding rows", () => {
  const hero = between("function dematHero", "function assetFocusCard");
  assert.match(hero, /value on the account/);
  assert.match(hero, /assetValue\(a\)\.paise/);
});
