import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the sheet line prints moved rows and a named decline together", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /reordered \$\{count\(moved\)\} rows · \$\{reason\}/);
  assert.match(html, /order unchanged: \$\{reason\}/);
});
