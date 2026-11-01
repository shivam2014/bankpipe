import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("Health tables stack on phones and their actions wrap", () => {
  assert.match(html, /data-table="health-checks"/);
  assert.match(html, /data-label="No balance"/);
  assert.match(html, /class="health-actions"/);
  assert.match(html,
    /\.health-actions\{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end\}/);
  assert.match(html, /table\[data-table\^="health-"\]\{display:block;min-width:0!important\}/);
  assert.match(html,
    /table\[data-table="health-statements"\] \.health-actions \.btn\{flex:1 1 auto\}/);
});
