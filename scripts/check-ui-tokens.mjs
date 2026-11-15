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
//
// A var() is not a pass. Declared tokens are resolved to their value and the
// value is checked, so a token cannot smuggle 13px past the scale. Tokens with
// a role in TOKEN_POLICY are checked against that role instead of the prose
// scale: --control-font is 16px because iOS zooms a form control below 16px,
// not because the prose scale grew a seventh step.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FONT_SIZES = new Set(["11", "12", "13.5", "15", "17", "24"]);
export const RADII = new Set(["8", "9", "10", "16", "99", "999", "50%"]);

// A token with a role is checked against this table, both where it is declared
// and where it is used. `control` exists to hold the 16px iOS zoom floor
// outside the prose scale.
export const TOKEN_POLICY = {
  "--control-font": { value: "16px", role: "control" },
};

const BANNED_INLINE =
  /\b(font-size|font|font-family|font-weight|color|background|background-color|padding|padding-[a-z]+|margin|margin-[a-z]+|border-radius|border|border-color)\s*:/;
const DECLARATION = /(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi;
const VAR = /var\(\s*(--[a-z0-9-]+)/i;

/**
 * Every custom property declared in the file, name to its last value. The last
 * one wins the way the cascade would for a later, equally specific rule.
 */
export function declaredTokens(text) {
  const tokens = new Map();
  for (const m of text.matchAll(DECLARATION)) {
    tokens.set(m[1].toLowerCase(), m[2].trim());
  }
  return tokens;
}

/**
 * The value a token holds, following a var() chain. Returns `{ error }` when
 * the token is undeclared, chains deeper than four, or resolves to something
 * this check cannot read as one length.
 */
export function resolveToken(tokens, name, seen = new Set()) {
  if (seen.has(name)) return { error: `var(${name}) is circular` };
  const value = tokens.get(name);
  if (value === undefined) return { error: `var(${name}) is not declared` };
  const inner = value.match(VAR);
  if (inner) {
    const next = resolveToken(tokens, inner[1].toLowerCase(), new Set([...seen, name]));
    if (next.error) return next;
    return `${next.value} ${value.replace(inner[0], "")}`.trim();
  }
  return { value };
}

/** One px or percent length, or null when the value is not a single length. */
export function singleLength(value) {
  if (/\b(calc|env|clamp|min|max)\(/i.test(value)) return null;
  const m = value.match(/^(-?[0-9.]+)(px|%)$/);
  return m ? { number: m[1], unit: m[2] } : null;
}

function fontFinding(where, raw, tokens) {
  const inner = raw.match(VAR);
  if (!inner) return null;
  const name = inner[1].toLowerCase();
  const resolved = resolveToken(tokens, name);
  if (resolved.error) return `${where}  font-size:var(${name})  ${resolved.error}`;
  const length = singleLength(resolved.value);
  if (!length || length.unit !== "px") {
    return `${where}  font-size:var(${name}) resolves to ${resolved.value}, `
      + "so the px size cannot be checked";
  }
  const policy = TOKEN_POLICY[name];
  if (policy) {
    if (length.number !== policy.value.replace("px", "")) {
      return `${where}  font-size:var(${name}) resolves to ${length.number}px; `
        + `policy says ${policy.value} for a ${policy.role}`;
    }
    return null;
  }
  if (!FONT_SIZES.has(length.number)) {
    return `${where}  font-size:var(${name}) resolves to ${length.number}px  `
      + "off-scale — use 11 / 12 / 13.5 / 15 / 17 / 24, or a control token";
  }
  return null;
}

function radiusFinding(where, raw, tokens) {
  const inner = raw.match(VAR);
  if (!inner) return null;
  const name = inner[1].toLowerCase();
  const resolved = resolveToken(tokens, name);
  if (resolved.error) return `${where}  border-radius:var(${name})  ${resolved.error}`;
  const length = singleLength(resolved.value);
  if (!length) {
    return `${where}  border-radius:var(${name}) resolves to ${resolved.value}, `
      + "so the radius cannot be checked";
  }
  if (!RADII.has(length.number)) {
    return `${where}  border-radius:var(${name}) resolves to ${resolved.value}  `
      + "off-scale — use 8 / 9 / 10 / 16 / 99";
  }
  return null;
}

/**
 * Findings for a unified diff against the whole file text. Empty means clean.
 * `where` prefixes each finding with `file:line`.
 */
export function lintDiff(diff, text, file = "web/index.html") {
  const tokens = declaredTokens(text);
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

    // The declaration itself: a policy token may only hold its policy value.
    for (const m of line.matchAll(DECLARATION)) {
      const name = m[1].toLowerCase();
      const policy = TOKEN_POLICY[name];
      if (!policy) continue;
      const declared = m[2].trim();
      if (declared !== policy.value) {
        findings.push(
          `${where}  ${name}:${declared}  policy says ${policy.value} for a `
            + `${policy.role} — 13px zooms the page on iOS`,
        );
      }
    }

    for (const m of line.matchAll(/font-size\s*:\s*([^;"'}]+)/g)) {
      const value = m[1].trim().replace(/\s*!important$/i, "");
      const resolved = fontFinding(where, value, tokens);
      if (resolved) {
        findings.push(resolved);
        continue;
      }
      const px = value.match(/var\(/i) ? null : value.match(/^([0-9.]+)px$/);
      if (px && !FONT_SIZES.has(px[1])) {
        findings.push(
          `${where}  font-size:${px[1]}px  off-scale — use 11 / 12 / 13.5 / 15 / 17 / 24`,
        );
      }
    }
    for (const m of line.matchAll(/(?:^|[;{\s])font\s*:\s*[^;"']*?([0-9.]+)px/g)) {
      if (!FONT_SIZES.has(m[1])) {
        findings.push(
          `${where}  font shorthand ${m[1]}px  off-scale — use a token size`,
        );
      }
    }
    for (const m of line.matchAll(/border-radius\s*:\s*([^;"'}]+)/g)) {
      const value = m[1].trim().replace(/\s*!important$/i, "");
      const resolved = radiusFinding(where, value, tokens);
      if (resolved) {
        findings.push(resolved);
        continue;
      }
      if (value.match(/var\(/i)) continue;
      for (const size of value.matchAll(/([0-9.]+)(?:px|%)/g)) {
        if (!RADII.has(size[1])) {
          findings.push(
            `${where}  border-radius:${size[0]}  off-scale — use 8 / 9 / 10 / 16 / 99`,
          );
        }
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
  return findings;
}

function main() {
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

  let text = "";
  try {
    text = staged
      ? execFileSync("git", ["show", `:${file}`], { encoding: "utf8" })
      : readFileSync(file, "utf8");
  } catch {
    console.error(`check-ui-tokens: cannot read ${file}; declared tokens are not resolved`);
  }

  const findings = lintDiff(diff, text, file);

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
