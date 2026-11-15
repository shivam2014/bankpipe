import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("./onboarding.js", import.meta.url), "utf8");

test("the help button keeps a 44px hit area around its 34px circle", () => {
  const button = onboarding.match(/\.bp-help \{([^}]*)\}/);
  assert.ok(button, ".bp-help rule is in onboarding.js");
  assert.match(button[1], /width: 44px/);
  assert.match(button[1], /height: 44px/);

  const circle = onboarding.match(/\.bp-help::before \{([^}]*)\}/);
  assert.ok(circle, "the visible circle is the ::before");
  assert.match(circle[1], /inset: 5px/);
  assert.match(circle[1], /z-index: -1/, "the glyph stays above the circle");
  assert.match(circle[1], /border-radius: 50%/);
});

test("the help control sits one band above the tab bar and the page reserves it", () => {
  const base = onboarding.match(/\.bp-help \{([^}]*)\}/);
  assert.ok(base, ".bp-help rule is in onboarding.js");
  assert.match(
    base[1],
    /bottom: calc\(var\(--tabbar-h, 0px\) \+ 12px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    "one formula places the help on every screen",
  );
  assert.doesNotMatch(onboarding, /@media \(min-width: 641px\) \{\s*\/\*[^]*?\.bp-help \{/,
    "no desktop-only offset for the help");

  const root = html.match(/:root\{([^}]*)\}/);
  assert.ok(root);
  assert.match(root[1], /--fab-safe:calc\(var\(--tabbar-h\) \+ 44px \+ 12px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(html, /@media \(max-width:640px\)\{\s*:root\{--tabbar-h:40px\}/);
  assert.match(html, /@media\(min-width:641px\)\{:root\{--tabbar-h:64px\}/);
});

test("the privacy toggle is 44px on phones, not 36px", () => {
  const base = html.match(/\.privacy-toggle\{([^}]*)\}/);
  assert.ok(base);
  assert.match(base[1], /width:44px/);
  assert.match(base[1], /height:44px/);

  const phone = [...html.matchAll(/@media\(max-width:640px\)\{\.privacy-toggle\{([^}]*)\}\}/g)];
  assert.equal(phone.length, 1);
  assert.match(phone[0][1], /width:44px/);
  assert.match(phone[0][1], /height:44px/);
});

test("the bank queue table is fluid and cards start at 720px", () => {
  const table = html.match(/<table([^>]*)data-table="bank-batch"/);
  assert.ok(table, "the list of files is a table");
  assert.match(table[1], /width:100%/);
  assert.doesNotMatch(table[1], /min-width/, "no forced width for the card band to fight");

  const cards = html.match(
    /@media \(max-width:(\d+)px\)\{\s*(?:\/\*[\s\S]*?\*\/\s*)?table\[data-table="bank-batch"\]\{display:block/);
  assert.ok(cards, "the bank table has a card layout");
  assert.equal(cards[1], "720");
});
