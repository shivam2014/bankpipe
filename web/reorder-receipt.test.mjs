import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { reorderLine } from "./reorder-line.js";

const run = (from, to, extra = {}) => ({
  from, to, formula: false, convention: "", ...extra,
});

test("the sheet line shows three runs and counts the rest", () => {
  const runs = Array.from({ length: 12 }, (_, i) => run(i * 2 + 1, i * 2 + 2));
  const line = reorderLine({ reorder: { runs, moved: 0, signCorrected: 0,
    reason: "chain does not reconcile" } });
  const [summary, reasons] = line.split("\n");
  assert.match(summary, /rows 1-2 inferred/);
  assert.match(summary, /rows 3-4 inferred/);
  assert.match(summary, /rows 5-6 inferred/);
  assert.match(summary, /\+9 more runs/);
  assert.doesNotMatch(summary, /rows 7-8/);
  assert.equal(reasons, "order unchanged: chain does not reconcile");
});

test("the sheet line caps the live run list and keeps the decline below", () => {
  const line = reorderLine({ reorder: {
    moved: 0, signCorrected: 0,
    reason: "2 rows without a balance · ambiguous within-day order · chain does not reconcile",
    runs: [
      { from: 3, to: 4, formula: false, convention: "" },
      { from: 5, to: 153, formula: true, convention: "post" },
      { from: 154, to: 155, formula: false, convention: "" },
      { from: 156, to: 159, formula: true, convention: "post" },
      { from: 160, to: 263, formula: false, convention: "" },
    ],
  } });
  const [summary, reasons] = line.split("\n");
  assert.equal(summary,
    "rows 3-4 inferred · rows 5-153 formula (post-entry)"
    + " · rows 154-155 inferred · +2 more runs");
  assert.equal(reasons,
    "order unchanged: 2 rows without a balance"
    + " · ambiguous within-day order · chain does not reconcile");
});

test("an order verified as printed says so", () => {
  const line = reorderLine({ reorder: { moved: 0, signCorrected: 0,
    verifiedAsPrinted: true,
    runs: [{ from: 3, to: 30, formula: false, convention: "" }] } });
  assert.match(line, /order verified as printed/);
});

test("the sheet line prints repairs and per-run evidence", () => {
  const line = reorderLine({ reorder: { moved: 4, signCorrected: 2,
    runs: [
      { from: 2, to: 6, formula: true, convention: "opening",
        moved: 4, signCorrected: 2 },
      { from: 7, to: 9, formula: false, convention: "post",
        moved: 0, signCorrected: 0 },
    ] } });
  assert.match(line, /rows 2-6 formula \(opening\)/);
  assert.match(line, /rows 7-9 inferred \(post-entry\)/);
  assert.match(line, /reordered 4 rows/);
  assert.match(line, /sign corrected on 2 rows/);
});

test("the page renders the line with its own reason line", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /import \{ reorderLine \} from "\.\/reorder-line\.js"/);
  assert.match(html, /white-space:pre-line/);
  assert.match(html, /esc\(reorderLine\(r\)\)/);
  assert.match(html, /dates read as Excel serials/);
  assert.match(html, /serialText\(r\)/);
});
