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
  assert.match(html, /dematCardHtml, dematLast4, dematMismatchLine, dematText,/);
  assert.match(html, /syncPreviewCardHtml \} from "\.\/demat-card\.js"/);
  assert.match(html, /matchDemat\(reportDemat, targetDemat\) === "mismatch"/);
  // One card host. The old warning card and the second detail card are gone.
  assert.match(html, /host\.innerHTML = `<div id="df-sync-card"><\/div>`/);
  assert.equal(html.includes('id="df-demat-warning"'), false);
  assert.equal(html.includes('id="df-detail"'), false);
  assert.match(html, /cardHost\.innerHTML = dematCardHtml\(\{/);
  assert.match(html, /dematMismatchLine\(reportDemat,/);
  assert.match(html, /import \{ assetIdentity, assetShortIdentity \} from "\.\/asset-identity\.js"/);
  assert.match(html, /const expanded = !mismatch \|\| window\.bpDigiFinnOverride === true;/);
  assert.match(html, /dematCardHtml\(\{[\s\S]*?\}, \{ body \}\)/);
  assert.match(html, /These reports belong to a different Demat\. Use 'Apply here anyway' if you are sure\./);
});

