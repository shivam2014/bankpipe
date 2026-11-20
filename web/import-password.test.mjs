// A password-protected statement is never a dead end. These tests pin the one
// rule the inbox and the bank batch share: a wrong or cancelled password leaves
// the file in a locked state that offers the gate again, with no attempt count.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { offersPasswordRetry, passwordFailure, PDF_PASSWORD_CANCELLED,
  PDF_PASSWORD_WRONG } from "./import-password.js";

const wrong = () => Object.assign(new Error("That password did not open this PDF."),
  { name: "PdfPasswordError", wrong: true, cancelled: false });
const cancelled = () => Object.assign(new Error("Password entry was cancelled."),
  { name: "PdfPasswordError", wrong: false, cancelled: true });

test("three wrong passwords still leave a fourth attempt open", () => {
  let entry = { id: "inbox-1", name: "locked-synthetic.pdf", status: "queued", error: "" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failure = passwordFailure(wrong());
    assert.ok(failure, `attempt ${attempt} is a password failure`);
    entry = { ...entry, status: failure.status, error: failure.message };
    assert.equal(offersPasswordRetry(entry), true,
      `after ${attempt} wrong password${attempt === 1 ? "" : "s"} the retry is still offered`);
    assert.equal(entry.error, PDF_PASSWORD_WRONG);
  }
  assert.equal(offersPasswordRetry(entry), true, "a fourth attempt is offered");
  assert.equal("attempts" in entry, false, "a retry never records a count");
  assert.equal("passwordAttempts" in entry, false, "a retry never records a count");
});

test("a cancelled prompt is the same door with its own sentence", () => {
  const failure = passwordFailure(cancelled());
  assert.equal(failure.status, "locked");
  assert.equal(failure.wrong, false);
  assert.equal(failure.message, PDF_PASSWORD_CANCELLED);
  assert.equal(offersPasswordRetry({ status: failure.status }), true);
});

test("an ordinary read error is not a password retry", () => {
  assert.equal(passwordFailure(new Error("This file type is not supported.")), null);
  assert.equal(offersPasswordRetry({ status: "error" }), false);
  assert.equal(offersPasswordRetry(null), false);
  assert.equal(offersPasswordRetry({}), false);
});

// --- the page wiring --------------------------------------------------------

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

test("the row carries the password field, the retry and the remove", () => {
  const row = between("function bpImportPasswordRowHtml", "function bpImportLooseRowHtml");
  assert.match(row, /type="password"/, "the field lives in the file's own row");
  assert.match(row, /bpImportInboxRetryRow\(\$\{jsArg\(entry\.id\)\}\)/);
  assert.match(row, /Try the password again/);
  assert.match(row, /Unlock/);
  assert.match(row, /bpImportDropEntry\(\$\{jsArg\(entry\.id\)\}\)/);
  assert.match(row, /used once, not stored/);
  assert.match(row, /<button class="btn ghost"/,
    "remove stays a real button with a 44px target");
});

test("a retry reads the same entry again with the password in hand", () => {
  const retry = between("window.bpImportInboxRetry = async", "window.bpImportDropPlan");
  assert.match(retry, /state\.entries\.find\(\(item\) => item\.id === id\)/);
  assert.doesNotMatch(retry, /entries\.push/, "a retry never duplicates the file");
  assert.match(retry, /id, password = ""/, "the row can hand back its field");
  assert.match(retry, /entry\.retryPassword = String\(password \|\| ""\)/);
  assert.match(retry, /bpImportInboxReadQueue\(\(\) => bpImportInboxReadOne\(entry\)\)/);
  assert.match(retry, /bpImportInboxPrepare\(true\)/,
    "a successful retry rebuilds the same plan");
});

test("the prompt stays inline and counts no attempts", () => {
  const gate = between("function bpImportInboxPassword(entry, wrong)", "window.bpImportInboxAdd");
  assert.match(gate, /entry\.passwordPrompt = \{ wrong: !!wrong \}/);
  assert.match(gate, /entry\.passwordResolve = resolve/);
  assert.match(gate, /bpImportInboxRender\(\)/);
  assert.equal(/\b(attempt|tries|left)\b/i.test(gate), false,
    "the prompt carries no attempt count");
});

test("the page says the password failure once, in the entry", () => {
  assert.equal(html.includes(PDF_PASSWORD_WRONG), false,
    "the sentence lives in import-password.js, not a second copy in the page");
  const settle = between("function bpImportInboxSettleStatus()", "function bpImportInboxRender()");
  assert.match(settle, /state\.entries\.some\(offersPasswordRetry\)/);
  assert.match(settle, /bpImportInboxStatus\(""\)/,
    "the page line goes quiet instead of repeating the entry");
  const add = between("window.bpImportInboxAdd = async", "window.bpImportChoose");
  assert.match(add, /bpImportInboxSettleStatus\(\)/);
  assert.doesNotMatch(add, /No plan is ready yet/,
    "the page line is decided in one place");
});

test("the bank batch uses the same locked state and the same sentence", () => {
  const batch = between("async function bpBatchPrepare(entry)", "function bpBatchPrepareSheet");
  assert.match(batch, /const failure = passwordFailure\(e\)/);
  assert.match(batch, /entry\.passwordWrong = failure\.wrong/);
  assert.match(html, /entry\.passwordWrong\s+\? PDF_PASSWORD_WRONG : "Locked by the bank\./,
    "a wrong password reads the same on both surfaces");
  assert.equal(/one more try|too many attempts|attempts left|locked out/i.test(html), false,
    "no surface promises or enforces an attempt limit");
});
