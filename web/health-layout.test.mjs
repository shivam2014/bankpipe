import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("Health uses one 16px margin scale and one divider rule", () => {
  assert.match(html, /data-table="health-checks"/);
  assert.match(html, /data-label="No balance"/);
  assert.match(html, /class="health-actions"/);
  assert.match(html, /\.pad\{padding:18px 16px\}/);
  assert.match(html, /\.health-heading\{padding-left:16px;padding-right:16px\}/);
  assert.ok((html.match(/class="health-heading"/g) || []).length >= 6);

  // The table row, padded card and section heading all land on 16px.
  assert.match(html,
    /table\[data-table\^="health-"\] tr\{display:flex;flex-wrap:wrap;width:100%;[^}]*padding:12px 16px/);
  assert.match(html,
    /table\[data-table\^="health-"\] td,\s*table\[data-table\^="health-"\] th\{[^}]*padding-left:16px;padding-right:16px;border-bottom:0/);

  // Values carry the weight; labels stay light and tighter.
  assert.match(html,
    /table\[data-table\^="health-"\] td\{[^}]*font-weight:560/);
  assert.match(html,
    /table\[data-table\^="health-"\] td\[data-label\]::before\{font-weight:400;letter-spacing:\.04em\}/);
  assert.match(html, /table\[data-table\^="health-"\] th\{letter-spacing:\.04em\}/);

  // One inset divider at both widths, not a different border per breakpoint.
  assert.match(html,
    /table\[data-table\^="health-"\] tr:not\(:last-child\)\{[^}]*background-size:calc\(100% - 32px\) 1px/);
  assert.equal(html.includes("tr:nth-child(n+3)::before"), false);

  // Action buttons keep their content width and cluster.
  assert.match(html,
    /table\[data-table="health-statements"\] \.health-actions \.btn\{flex:0 1 auto\}/);
  // The two extra-full-width cells only change flex, not padding.
  assert.match(html,
    /table\[data-table="health-sheets"\] td:nth-child\(3\),\s*table\[data-table="health-bond-ratings"\] td:nth-child\(2\)\{flex:1 1 100%\}/);
});
