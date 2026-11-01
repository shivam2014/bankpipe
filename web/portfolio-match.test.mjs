import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchDemat } from "./portfolio-match.js";

test("identical Demat numbers match", () => {
  assert.equal(matchDemat("1201000000001234", "1201000000001234"), "match");
});

test("the same last six digits match across different prefixes", () => {
  assert.equal(matchDemat("0000123400001234", "1201000000001234"), "match");
});

test("a different last six is a mismatch", () => {
  assert.equal(matchDemat("1201000000001234", "1201000000005678"), "mismatch");
});

test("a missing Demat on either side is unknown, not a mismatch", () => {
  assert.equal(matchDemat("", "1201000000001234"), "unknown");
  assert.equal(matchDemat("1201000000001234", ""), "unknown");
  assert.equal(matchDemat("", ""), "unknown");
  assert.equal(matchDemat(null, undefined), "unknown");
});

test("fewer than six digits on either side is unknown", () => {
  assert.equal(matchDemat("12345", "1201000000001234"), "unknown");
  assert.equal(matchDemat("1201000000001234", "12345"), "unknown");
  assert.equal(matchDemat("12345", "12345"), "unknown");
});

test("spaces and dashes in one number do not break the match", () => {
  assert.equal(matchDemat("1201 0000 0000 1234", "1201000000001234"), "match");
  assert.equal(matchDemat("1201-0000-0000-1234", "1201000000001234"), "match");
});

test("index.html blocks Apply sync on a mismatch until the override", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /import \{ matchDemat \} from "\.\/portfolio-match\.js"/);
  assert.match(html, /matchDemat\(reportDemat, targetDemat\) === "mismatch"/);
  // The red card names both Demats and offers the four ways out.
  assert.match(html, /These reports are for Demat/);
  assert.match(html, /not this portfolio \(…/);
  assert.match(html, /Import into \$\{esc\(mappedAsset/);
  assert.match(html, /Create a portfolio for …/);
  assert.match(html, /Keep this portfolio/);
  // The apply stays disabled until the person says to import anyway.
  assert.match(html, /onclick="bpDigiFinnSyncApply\(\)"\$\{blocked \? " disabled" : ""\}/);
  assert.match(html, /Import anyway into this portfolio/);
  assert.match(html, /These reports belong to a different Demat\. Use 'Import anyway' if you are sure\./);
  assert.match(html, /These reports belong to Demat …\$\{dematLast4\(reportDemat\)\}, not this portfolio\./);
});

