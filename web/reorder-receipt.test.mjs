import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the sheet line prints repairs and a named decline together", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /reordered \$\{count\(moved\)\} rows/);
  assert.match(html, /balance convention: opening/);
  assert.match(html, /sign corrected on \$\{count\(sign\)\} row/);
  assert.match(html, /order unchanged: \$\{bits\.join\(" · "\)\}/);
});
