#!/usr/bin/env node
// Fail when tracked content contains a personal-data shape.
//
//   node scripts/check-privacy.mjs            # tracked files
//   node scripts/check-privacy.mjs --staged   # index only
//
// The patterns live in privacy-rules.mjs. Synthetic fixtures are allowed by
// privacy-allowlist.json, so the check works on a fresh clone and in CI, where
// the private denylist does not exist. Values are never printed: a CI log on a
// private repository must not become the next leak.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { scanBuffer, skipPath } from "./privacy-rules.mjs";

const staged = process.argv.slice(2).includes("--staged");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"],
  { encoding: "utf8" }).trim();

function listFiles() {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "-z"];
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter(Boolean);
}

function read(path) {
  if (staged) {
    return execFileSync("git", ["show", `:${path}`],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  }
  return readFileSync(resolve(root, path));
}

const findings = [];
let scanned = 0;
let skipped = 0;

for (const path of listFiles()) {
  if (skipPath(path)) {
    skipped += 1;
    continue;
  }
  let buffer;
  try {
    buffer = read(path);
  } catch {
    findings.push({ path, line: 0, kind: "unreadable file (not verified)" });
    continue;
  }
  const result = scanBuffer(buffer, path);
  if (result.skipped) skipped += 1;
  else scanned += 1;
  for (const finding of result.findings) findings.push({ path, ...finding });
}

if (findings.length) {
  console.error(`privacy: ${findings.length} personal-data shape(s) in tracked content`);
  for (const finding of findings) {
    const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    console.error(`  ${where}: ${finding.kind}`);
  }
  console.error("\nReplace the value with a placeholder or a 9999-prefixed synthetic value.");
  console.error("Only synthetic fixtures may be added to scripts/privacy-allowlist.json.");
  process.exit(1);
}

console.log(`privacy: clean (${scanned} file(s) scanned, ${skipped} skipped as vendored or binary)`);
