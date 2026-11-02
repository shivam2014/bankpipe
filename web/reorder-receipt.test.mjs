import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the sheet line prints per-run evidence and a named decline together", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /reordered \$\{count\(moved\)\} rows/);
  assert.match(html, /rows \$\{Number\(run\.from\)\}-\$\{Number\(run\.to\)\}/);
  assert.match(html, /formula \(/);
  assert.match(html, /inferred/);
  assert.match(html, /sign corrected on \$\{count\(sign\)\} row/);
  assert.match(html, /order unchanged: \$\{reason\}/);
});
