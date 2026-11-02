import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("review amounts keep a right inset and never wrap", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html,
    /table\[data-table="issues"\] tr\{display:block;box-sizing:border-box;width:100%;\s*padding:14px 16px/);
  assert.match(html,
    /table\[data-table="issues"\] td\.n > \.amt\{display:block;min-width:0;max-width:100%;/);
  assert.match(html, /text-overflow:ellipsis;white-space:nowrap/);
  assert.match(html,
    /data-label="Amount"><span class="amt">\$\{amountInr\(r\.amount\)\}<\/span>/);
  assert.match(html,
    /data-label="Balance"><span class="amt">\$\{amountInr\(r\.balance\)\}<\/span>/);
});
