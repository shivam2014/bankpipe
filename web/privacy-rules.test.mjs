import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAllowed, scanText, skipPath } from "../scripts/privacy-rules.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const TREE_CHECK = new URL("../scripts/check-privacy.mjs", import.meta.url).pathname;
const HISTORY_CHECK = new URL("../scripts/check-history-privacy.mjs", import.meta.url).pathname;

// Build the samples at runtime so this test file never contains a contiguous
// identifier that the tree check would have to allowlist.
const sample = {
  pan: ["ZZZZZ", "9999", "Z"].join(""),
  aadhaar: ["2345", "6789", "0123"].join(" "),
  account: ["31415926", "53589793"].join(""),
  ifsc: ["ZZZZ", "0", "999999"].join(""),
  email: ["person", "real-bank.example"].join("@"),
  phone: ["98765", "01234"].join(""),
  tollFree: ["1800", "765", "4321"].join(""),
  fd: ["123456", "DP", "789"].join(""),
};

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function run(command, args, cwd) {
  try {
    return {
      status: 0,
      output: execFileSync(command, args,
        { cwd, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout || ""}${error.stderr || ""}`,
    };
  }
}

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "bp-privacy-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args,
    { cwd: dir, stdio: "ignore", env: cleanEnv() });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "README.md"), "clean\n");
  git("add", "README.md");
  git("commit", "-qm", "base");
  return dir;
}

test("every requested identifier shape is caught", () => {
  for (const [name, value, kind] of [
    ["pan", sample.pan, "PAN"],
    ["aadhaar", sample.aadhaar, "Aadhaar-shaped number"],
    ["account", sample.account, "account/demat-shaped number"],
    ["ifsc", sample.ifsc, "IFSC"],
    ["email", sample.email, "email address"],
    ["phone", sample.phone, "phone number"],
    ["tollFree", sample.tollFree, "toll-free phone number"],
    ["fd", sample.fd, "FD deposit number"],
  ]) {
    const findings = scanText(`value: ${value}`);
    assert.ok(findings.some((finding) => finding.kind === kind),
      `${name} should be reported as ${kind}, got ${findings.map((f) => f.kind).join(", ")}`);
  }
});

test("the committed synthetic allowlist clears fixtures and the 9999 namespace", () => {
  for (const value of [
    "ABCDE1234F",
    "XXXXX1234F",
    "9999 0048 2193",
    "999900000001",
    "one@example.test",
    "HDFC0001234",
    "18001802222",
    "1200000012345678",
    "test@example.invalid",
  ]) {
    assert.equal(scanText(value).length, 0, `${value} should be allowlisted`);
    assert.equal(isAllowed(value), true);
  }
});

test("vendored and binary paths are skipped, source paths are not", () => {
  assert.equal(skipPath("web/vendor/pdfjs/pdf.worker.min.mjs"), "vendored");
  assert.equal(skipPath("assets/readme/hero.svg"), "vendored");
  assert.equal(skipPath("web/logos/sbi.svg"), "vendored");
  assert.equal(skipPath("web/fixtures/banks/sbi-savings-2026-07.xlsx"), null);
  assert.equal(skipPath("docs/PUBLIC-REPO.md"), null);
  assert.equal(skipPath("web/fixtures/import/pdf/cas-sold.pdf"), "binary");
});

test("the staged guard blocks a new file with a personal-data shape", (t) => {
  const dir = scratchRepo(t);
  writeFileSync(join(dir, "new-leak.txt"), `PAN ${sample.pan}\n`);
  execFileSync("git", ["add", "new-leak.txt"], { cwd: dir, env: cleanEnv() });

  const result = run(process.execPath, [TREE_CHECK, "--staged"], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /new-leak\.txt/);
  assert.match(result.output, /PAN/);
  assert.doesNotMatch(result.output, new RegExp(sample.pan));
});

test("the staged guard lets an allowlisted synthetic fixture through", (t) => {
  const dir = scratchRepo(t);
  writeFileSync(join(dir, "new-fixture.txt"), "PAN ABCDE1234F\n");
  execFileSync("git", ["add", "new-fixture.txt"], { cwd: dir, env: cleanEnv() });

  const result = run(process.execPath, [TREE_CHECK, "--staged"], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /privacy: clean/);
});

test("the tracked tree is clean under the same checker CI runs", () => {
  const result = run(process.execPath, [TREE_CHECK], ROOT);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /privacy: clean/);
});

test("the history checker names the offending commit and path", (t) => {
  const dir = scratchRepo(t);
  writeFileSync(join(dir, "leak.txt"), `PAN ${sample.pan}\n`);
  execFileSync("git", ["add", "leak.txt"], { cwd: dir, env: cleanEnv() });
  execFileSync("git", ["commit", "-qm", "leak"], { cwd: dir, env: cleanEnv() });

  const result = run(process.execPath, [HISTORY_CHECK], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /leak\.txt/);
  assert.match(result.output, /commit [0-9a-f]{40}/);
  assert.match(result.output, /PAN/);
});

test("the history checker says clean when every blob is clean", (t) => {
  const dir = scratchRepo(t);
  const result = run(process.execPath, [HISTORY_CHECK], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /^clean:/);
});

test("--messages catches a leak that only lives in a commit message", (t) => {
  const dir = scratchRepo(t);
  writeFileSync(join(dir, "note.txt"), "clean\n");
  execFileSync("git", ["add", "note.txt"], { cwd: dir, env: cleanEnv() });
  execFileSync("git", ["commit", "-qm", `add ${sample.pan}`],
    { cwd: dir, env: cleanEnv() });

  const quiet = run(process.execPath, [HISTORY_CHECK], dir);
  assert.equal(quiet.status, 0, quiet.output);

  const loud = run(process.execPath, [HISTORY_CHECK, "--messages"], dir);
  assert.equal(loud.status, 1, loud.output);
  assert.match(loud.output, /commit message/);
  assert.match(loud.output, /PAN/);
});
