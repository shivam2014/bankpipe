#!/usr/bin/env node
// Fails on new off-scale type, radius and inline style in a git diff.
// No dependencies. Run from the repo root.
//
//   node scripts/check-ui-tokens.mjs                 # working tree vs HEAD
//   node scripts/check-ui-tokens.mjs --staged        # index only
//   node scripts/check-ui-tokens.mjs --range main... # branch vs main
//   node scripts/check-ui-tokens.mjs --file web/index.html
//
// It checks added lines only, so the existing drift does not block work.
// The point is to stop the number growing.

import { execFileSync } from "node:child_process";

const FONT_SIZES = new Set(["11", "12", "13.5", "15", "17", "24"]);
const RADII = new Set(["8", "9", "10", "16", "99", "999", "50%"]);
const BANNED_INLINE =
  /\b(font-size|font|font-family|font-weight|color|background|background-color|padding|padding-[a-z]+|margin|margin-[a-z]+|border-radius|border|border-color)\s*:/;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "usage: node scripts/check-ui-tokens.mjs [--staged | --range <rev>] [--file <path>]",
  );
  process.exit(0);
}

const file = opt("--file", "web/index.html");
const range = opt("--range", null);
const staged = args.includes("--staged");

const diffArgs = ["diff", "--unified=0", "--no-color", "--no-ext-diff"];
if (range) diffArgs.push(range);
else if (staged) diffArgs.push("--cached");
else diffArgs.push("HEAD");
diffArgs.push("--", file);

let diff = "";
try {
  diff = execFileSync("git", diffArgs, { encoding: "utf8" });
} catch {
  console.error("check-ui-tokens: not a git repository, or git failed");
  process.exit(2);
}
if (!diff.trim()) {
  console.log(`check-ui-tokens: no changes in ${file}`);
  process.exit(0);
}

const findings = [];
let newLine = 0;

for (const raw of diff.split("\n")) {
  if (raw.startsWith("@@")) {
    const m = raw.match(/\+(\d+)(?:,\d+)?/);
    if (m) newLine = Number(m[1]);
    continue;
  }
  if (raw.startsWith("+++") || raw.startsWith("---")) continue;
  if (raw.startsWith("-")) continue;
  if (!raw.startsWith("+")) {
    if (raw.startsWith(" ")) newLine++;
    continue;
  }

  const line = raw.slice(1);
  const where = `${file}:${newLine}`;

  for (const m of line.matchAll(/font-size\s*:\s*([0-9.]+)px/g)) {
    if (!FONT_SIZES.has(m[1])) {
      findings.push(
        `${where}  font-size:${m[1]}px  off-scale — use 11 / 12 / 13.5 / 15 / 17 / 24`,
      );
    }
  }
  for (const m of line.matchAll(/(?:font\s*:\s*[^;"']*?)([0-9.]+)px/g)) {
    if (!FONT_SIZES.has(m[1])) {
      findings.push(
        `${where}  font shorthand ${m[1]}px  off-scale — use a token size`,
      );
    }
  }
  for (const m of line.matchAll(/border-radius\s*:\s*([0-9.]+px|[0-9.]+%)/g)) {
    const value = m[1].replace("px", "");
    if (!RADII.has(value)) {
      findings.push(
        `${where}  border-radius:${m[1]}  off-scale — use 8 / 9 / 10 / 16 / 99`,
      );
    }
  }

  for (const m of line.matchAll(/style\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const style = m[2] ?? m[3] ?? "";
    let rest = style
      .replace(/background\s*:\s*(?:conic|linear|radial)-gradient\([^)]*\)/gi, "")
      .replace(/background\s*:\s*var\(--[^)]*\)/gi, "")
      .replace(
        /(?:grid-template-columns|max-width|min-width|max-height|min-height|flex-basis|width|height|left|top|right|bottom|transform|display|position|z-index|text-align|flex|gap|overflow|opacity)\s*:\s*[^;]+;?/gi,
        "",
      );
    if (BANNED_INLINE.test(rest)) {
      findings.push(
        `${where}  inline style sets type, colour or spacing — move it to a class or token`,
      );
    }
  }

  newLine++;
}

if (findings.length === 0) {
  console.log(`check-ui-tokens: ${file} clean`);
  process.exit(0);
}

console.error(`check-ui-tokens: ${findings.length} new violation(s)\n`);
for (const f of findings) console.error("  " + f);
console.error(
  "\nFix: use an existing token/class. See .opencode/skills/bankpipe-ui/references/tokens.md",
);
process.exit(1);
