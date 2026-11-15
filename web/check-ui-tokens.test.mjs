import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintDiff } from "../scripts/check-ui-tokens.mjs";

const CHECKER = new URL("../scripts/check-ui-tokens.mjs", import.meta.url).pathname;

// A pre-commit hook runs this suite with GIT_DIR and GIT_INDEX_FILE pointing at
// the real repository, so a scratch repository must not inherit them.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

const BASE = `<!doctype html><style>
:root{--control-font:16px;--r:16px}
label.field input{font-size:var(--control-font)}
.card{border-radius:var(--r)}
</style>
`;

function repo(t, html = BASE) {
  const dir = mkdtempSync(join(tmpdir(), "bp-tokens-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web/index.html"), html);
  const git = (...args) => execFileSync("git", args,
    { cwd: dir, stdio: "ignore", env: cleanEnv() });
  git("init", "-q");
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"],
    { cwd: dir, encoding: "utf8", env: cleanEnv() }).trim();
  assert.equal(realpathSync(top), realpathSync(dir),
    "the scratch repo is its own, not the one the hook runs in");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "web/index.html");
  git("commit", "-qm", "base");
  return dir;
}

function check(dir, html) {
  writeFileSync(join(dir, "web/index.html"), html);
  try {
    const output = execFileSync(
      process.execPath, [CHECKER, "--file", "web/index.html"],
      { cwd: dir, encoding: "utf8", env: cleanEnv() },
    );
    return { status: 0, output };
  } catch (error) {
    return { status: error.status, output: String(error.stderr || "") };
  }
}

test("a control token used for a form control passes", (t) => {
  const dir = repo(t);
  const result = check(dir, BASE + ".hint{font-size:var(--control-font)}\n");
  assert.equal(result.status, 0, result.output);
});

test("editing --control-font to 13px fails the checker", (t) => {
  const dir = repo(t);
  const result = check(dir, BASE.replace("--control-font:16px", "--control-font:13px"));
  assert.equal(result.status, 1);
  assert.match(result.output, /--control-font:13px/);
  assert.match(result.output, /policy says 16px for a control/);
});

test("a use of a token that resolves off-policy fails even when the declaration is unchanged", () => {
  const text = ":root{--control-font:13px}\na{font-size:var(--control-font)}\n";
  const findings = lintDiff("@@ -1,1 +1,2 @@\n+a{font-size:var(--control-font)}\n", text);
  assert.match(findings.join("\n"), /resolves to 13px; policy says 16px/);
});

test("a var() that is not declared fails instead of passing as opaque", (t) => {
  const dir = repo(t);
  const result = check(dir, BASE + ".hint{font-size:var(--body-size)}\n");
  assert.equal(result.status, 1);
  assert.match(result.output, /var\(--body-size\) is not declared/);
});

test("the policy declaration line is not read as a font shorthand", (t) => {
  const dir = repo(t, BASE.replace(":root{--control-font:16px;--r:16px}", ":root{--r:16px}"));
  const result = check(dir, BASE);
  assert.equal(result.status, 0, result.output);
});

test("a literal off-scale size still fails", (t) => {
  const dir = repo(t);
  const result = check(dir, BASE + ".hint{font-size:13px}\n");
  assert.equal(result.status, 1);
  assert.match(result.output, /font-size:13px\s+off-scale/);
});

test("a radius token is resolved, not trusted", (t) => {
  const clean = repo(t);
  assert.equal(check(clean, BASE + ".wide{border-radius:var(--r)}\n").status, 0);

  const dirty = repo(t);
  const result = check(dirty, BASE.replace("--r:16px", "--r:18px")
    + ".wide{border-radius:var(--r)}\n");
  assert.equal(result.status, 1);
  assert.match(result.output, /border-radius:var\(--r\) resolves to 18px\s+off-scale/);
});

test("an inline font-size in markup is still caught", (t) => {
  const dir = repo(t);
  const result = check(dir, BASE + "<textarea style=\"font-size:12px\"></textarea>\n");
  assert.equal(result.status, 1);
  assert.match(result.output, /inline style sets type, colour or spacing/);
});
