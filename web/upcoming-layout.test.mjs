import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the Upcoming timeline bleeds to the page gutter and keeps its content inset", () => {
  const groups = html.match(/class="card tl-bleed"/g) || [];
  assert.equal(groups.length, 1, "only the Upcoming month groups use the bleed");

  const card = html.match(/\.tl-bleed\{([^}]*)\}/);
  assert.ok(card, ".tl-bleed is declared");
  assert.match(card[1], /margin-left:calc\(var\(--gutter\) \* -1\)/);
  assert.match(card[1], /margin-right:calc\(var\(--gutter\) \* -1\)/);
  assert.match(card[1], /border-radius:initial/, "the outer corners are square");
  assert.match(card[1], /box-shadow:none/, "no floating card shadow at the edge");

  const row = html.match(/\.tl-bleed \.tl-row\{([^}]*)\}/);
  assert.ok(row, ".tl-bleed .tl-row is declared");
  assert.match(row[1], /padding-left:var\(--gutter\)/);
  assert.match(row[1], /padding-right:var\(--gutter\)/, "content stays at its old inset");

  const hover = html.match(/\.tl-bleed \.tl-row:hover\{([^}]*)\}/);
  assert.ok(hover, "the hover background is squared too");
  assert.match(hover[1], /border-radius:initial/);
});

test("the page gutter is 18px, and 14px on phones", () => {
  assert.match(html, /:root\{[^}]*--gutter:18px/);
  assert.match(html, /@media \(max-width:640px\)\{[\s\S]*?\.wrap\{--gutter:14px/);
  assert.match(html, /\.wrap\{[^}]*padding:24px var\(--gutter\)/);
});
