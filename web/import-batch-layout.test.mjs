import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("the bank batch table stacks into file cards on phones", () => {
  assert.match(html, /data-label="Destination"/);
  assert.match(html, /data-label="Detected"/);
  assert.match(html, /data-label="Rows"/);
  assert.match(html, /data-label="Status"/);
  assert.match(html,
    /table\[data-table="bank-batch"\]\{display:block;min-width:0!important\}/);
  assert.match(html, /table\[data-table="bank-batch"\] td\[data-label\]::before\{/);
});

test("an encrypted Office file opens the password prompt automatically", () => {
  assert.match(html, /function bpOfficePasswordPrompt/);
  assert.match(html, /const bytes = await bpOfficePasswordPrompt\(entry\)/);
  assert.match(html, /if \(resolve\) resolve\(bytes\)/);
  assert.match(html, /err\.cancelled = true/);
});
