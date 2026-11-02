import test from "node:test";
import assert from "node:assert/strict";

import { rowList } from "./receipt-rows.js";

test("eleven no-date rows render as one line", () => {
  const rows = [42, 118, 204, 331, 402, 519, 604, 711, 802, 915, 1002];
  const line = rowList("No-date rows", rows, rows.length);
  assert.equal(line, "No-date rows: 42, 118, 204, 331, 402, 519, 604, 711,"
    + " 802, 915, 1002");
  assert.equal(line.includes("\n"), false);
});

test("fifty-one rows show fifty and one more", () => {
  const rows = Array.from({ length: 51 }, (_, i) => i + 1);
  const line = rowList("No-date rows", rows.slice(0, 50), rows.length);
  assert.match(line, /^No-date rows: 1, 2, /);
  assert.match(line, /50 \(\+1 more\)$/);
  assert.equal(line.includes("51,"), false);
});

test("no rows print no extra line", () => {
  assert.equal(rowList("No-date rows", [], 0), "");
  assert.equal(rowList("No-date rows", undefined, 0), "");
});
