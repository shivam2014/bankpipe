import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const db = readFileSync(new URL("./db.js", import.meta.url), "utf8");

test("Health review buttons carry the account and kind", () => {
  assert.match(html, /window\.bpIssuesFor = \(accountId = "", kind = "", label = ""\)/);
  assert.match(html, /bpIssuesFor\(\$\{jsArg\(a\.account_id\)\},''/);
  assert.match(html, /bpIssuesFor\(\$\{jsArg\(a\.account_id\)\},'balance_break'/);
  assert.match(html, /issueAccount: accountId \|\| ""/);
});

test("the review page filters before rendering and resolves only visible ids", () => {
  assert.match(html, /const allRows = await store\.listIssues\(\)/);
  assert.match(html, /const rows = allRows\.filter/);
  assert.match(html, /window\.bpIssueIds = rows\.map/);
  assert.match(html, /await store\.resolveIssueIds\(ids, state\)/);
  assert.match(db, /store\.resolveIssueIds = \(ids, state\) =>/);
  assert.match(db, /export async function resolveIssueIds\(ids, state\)/);
});

test("global review links clear an old filter", () => {
  assert.match(html, /window\.bpIssuesAll = \(\) =>/);
  assert.match(html, /onclick="bpIssuesAll\(\)"/);
});

test("the review table becomes cards on phones", () => {
  assert.match(html, /data-label="Check"/);
  assert.match(html, /table\[data-table="issues"\]\{display:block;min-width:0!important\}/);
  assert.match(html, /table\[data-table="issues"\] td\[data-label\]::before\{/);
});
