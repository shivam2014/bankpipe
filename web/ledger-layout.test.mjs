import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the ledger column widths use the v3 key, not the stale v2 key", () => {
  assert.match(html, /bp\.cols\.v3\./);
  assert.doesNotMatch(html, /bp\.cols\.v2\./,
    "old widths produced the gap before Date; they must be ignored once");
});

test("Delete all sits in the toolbar before the ledger table", () => {
  const toolbar = html.indexOf('<div class="fact-toolbar">');
  const bar = html.indexOf('id="fact-bar"');
  const all = html.indexOf('class="mini-btn danger fact-delete-all"');
  const table = html.indexOf('<table data-table="account">');
  assert.ok(toolbar > -1, "the toolbar exists");
  assert.ok(bar > toolbar, "the selection group is inside the toolbar");
  assert.ok(all > bar, "Delete all follows the selection group");
  assert.ok(table > all, "Delete all is above the ledger table");
  assert.match(html, /Delete all\s+\$\{totals\.n \|\| 0\} transactions/);
});

test("the ledger date has a phone form and the description keeps the full narration", () => {
  assert.match(html, /class="date-text date-full"/);
  assert.match(html, /class="date-text date-short"/);
  assert.match(html, /class="ledger-desc" title="\$\{esc\(f\.narration \|\| ""\)\}"/,
    "the full narration is the cell title");
  assert.match(html, /class="desc-clamp"/);
  assert.match(html,
    /table\[data-table="account"\] th:nth-child\(5\),\s*table\[data-table="account"\] td:nth-child\(5\)\{display:none\}/,
    "the balance column is hidden on phones");
});
