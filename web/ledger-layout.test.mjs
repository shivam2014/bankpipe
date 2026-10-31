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
  const all = html.indexOf('class="btn danger fact-delete-all"');
  const table = html.indexOf('<table data-table="account">');
  assert.ok(toolbar > -1, "the toolbar exists");
  assert.ok(bar > toolbar, "the selection group is inside the toolbar");
  assert.ok(all > bar, "Delete all follows the selection group");
  assert.ok(table > all, "Delete all is above the ledger table");
  assert.match(html, /Delete all\s+\$\{factTotal \|\| 0\} transactions/);
});

test("Delete all is hidden until the whole account is selected", () => {
  assert.match(html, /class="btn danger fact-delete-all" style="display:none"/,
    "the button starts hidden");
  assert.match(html, /id="fact-bar" class="fact-bar"[\s\S]{0,400}data-total="\$\{esc\(String\(factTotal\)\)\}"/,
    "the bar carries the account total");
  assert.match(html, /data-matched="\$\{esc\(String\(totals\.n \|\| 0\)\)\}"/,
    "the bar carries the filtered match count");
  assert.match(html, /aria-label="Select every matching transaction"/,
    "the header checkbox says it selects every match");
  assert.match(html, /onclick="bpFactPickAll\(false\)"/,
    "Clear selection still uses the shared handler");
});

test("the toolbar keeps both actions on one row", () => {
  assert.match(html, /\.fact-toolbar\{display:flex;align-items:center;justify-content:space-between;\s*gap:6px 16px;flex-wrap:wrap;margin:0 0 8px\}/,
    "one row with a 16px column gap and a 6px row gap only when it wraps");
  assert.doesNotMatch(html, /\.fact-delete-all\{margin-left:auto\}/,
    "the auto margin is what pushed Delete all onto its own line");
  assert.match(html, /<div class="fact-toolbar">[\s\S]*?<button class="btn danger fact-delete-all"/,
    "Delete all is a direct child of the toolbar, not a second wrapping group");
});

test("Delete selected has a handle the bar can hide", () => {
  assert.match(html, /<button class="btn" id="fact-delete-selected"/,
    "the button carries an id");
  assert.match(html, /getElementById\("fact-delete-selected"\)[\s\S]{0,120}whole \? "none" : ""/,
    "bpFactBar hides it whenever Delete all is offered");
  assert.match(html, /showDeleteAll\(window\.bpFactSel\?\.size \|\| 0, factTotal\) \? "none" : ""/,
    "the first render agrees with the bar");
});

test("Delete all uses btn sizing, not mini-btn", () => {
  assert.match(html, /class="btn danger fact-delete-all"/);
  assert.doesNotMatch(html, /mini-btn danger fact-delete-all/,
    "a 28px mini-btn next to 38px .btn read as misaligned");
  assert.match(html, /\.fact-toolbar \.btn\.danger\{color:var\(--red\);/,
    "the danger colour survives the size change");
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
