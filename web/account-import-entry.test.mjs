import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The account page is one renderer in index.html. These checks keep the way in
// on the demat page, keep the shortcut from overriding the file's own match, and
// keep the staged card's discard wording about the queue rather than the ledger.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

test("a demat account page offers Import a statement and opens Import", () => {
  const form = between("function assetForm", "function bondLabelParts");
  assert.match(form, /isImportAccount\(a\)/);
  assert.match(form,
    /onclick="bpAccountImport\(\$\{jsArg\(a\.id\)\}\)">Import a statement</);
  const handler = between("window.bpAccountImport", "window.bpAccountNewFd");
  assert.match(handler, /window\.bpImportTarget = String\(id\)/);
  assert.match(handler, /go\("import"\)/);
});

test("the account shortcut never overrides the file's own match", () => {
  const broker = between("function bpImportResolveBroker", "function bpImportResolveCas");
  const identity = broker.indexOf("bundle.match.identityId");
  const attach = broker.indexOf("bundle.match.attachId");
  const hint = broker.indexOf("window.bpImportTarget");
  assert.ok(identity >= 0 && attach > identity, "the file's match runs first");
  assert.ok(hint > attach, "the shortcut is only the last fallback");
  assert.match(broker, /if \(!targetId && window\.bpImportTarget\)/);
  assert.match(broker, /brokerDematAccounts\(bundle\.family, \[hint\.account\]\)/);
});

test("a staged card discards the file without sounding like a data delete", () => {
  const plan = between("function bpImportPlanHtml", "function bpImportPlanMissing");
  assert.match(plan, /bpImportDropPlan\(\$\{jsArg\(plan\.key\)\}\)">Discard file</);
  assert.equal(/bpImportDropPlan\(\$\{jsArg\(plan\.key\)\}\)">Remove</.test(plan), false,
    "the staged card no longer says Remove");
  const note = plan.indexOf("Removes this file from the queue. Imported data is untouched.");
  const moreStart = plan.indexOf('class="import-change-more"');
  const moreEnd = plan.indexOf("</details>", moreStart);
  assert.ok(note > moreStart && note < moreEnd,
    "the queue-only note sits in More, where the file detail already lives");
});
