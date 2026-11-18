#!/usr/bin/env node
// Scan every blob reachable from every ref for personal-data shapes, then map
// an offending blob to a commit and path. This is the post-rewrite gate. It
// uses the same patterns as check-privacy.mjs and never reads web/private/.
//
//   node scripts/check-history-privacy.mjs
//   node scripts/check-history-privacy.mjs --messages
//
// Blobs are read in batches so a large history does not have to fit in memory
// at once. Vendored libraries, binary files and known synthetic workbooks are
// skipped exactly as in the tree check. Values are never printed.
import { execFileSync, spawnSync } from "node:child_process";

import { MAX_BYTES, scanBuffer, scanText, skipPath } from "./privacy-rules.mjs";

const args = new Set(process.argv.slice(2));
const scanMessages = args.has("--messages");
const BATCH = 50;

function gitText(argv) {
  return execFileSync("git", argv,
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function refs() {
  return gitText(["for-each-ref", "--format=%(refname) %(objectname)", "refs/"])
    .split("\n").filter(Boolean);
}

function objects() {
  const rows = [];
  for (const line of gitText(["rev-list", "--objects", "--all"]).split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    rows.push(space < 0
      ? { oid: line, path: null }
      : { oid: line.slice(0, space), path: line.slice(space + 1) });
  }
  return rows;
}

function checkObjects(oids) {
  const result = spawnSync("git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: `${oids.join("\n")}\n`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch-check failed: ${result.stderr}`);
  }
  const meta = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [oid, type, size] = line.split(" ");
    meta.set(oid, { type, size: Number(size) });
  }
  return meta;
}

function readBlobs(oids) {
  const result = spawnSync("git", ["cat-file", "--batch"], {
    input: `${oids.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${result.stderr}`);
  }
  const out = new Map();
  const buffer = result.stdout;
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) break;
    const header = buffer.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    const [oid, type, size] = header.split(" ");
    if (type !== "blob") continue;
    const bytes = Number(size);
    out.set(oid, buffer.subarray(offset, offset + bytes));
    offset += bytes + 1;
  }
  return out;
}

function commitFor(oid) {
  const result = spawnSync("git",
    ["log", "--all", `--find-object=${oid}`, "--format=%H", "--no-patch", "--reverse"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter(Boolean)[0] || null;
}

const refList = refs();
const objectRows = objects();
const pathsByOid = new Map();
for (const row of objectRows) {
  if (!row.path) continue;
  if (!pathsByOid.has(row.oid)) pathsByOid.set(row.oid, new Set());
  pathsByOid.get(row.oid).add(row.path);
}

const meta = checkObjects([...new Set(objectRows.map((row) => row.oid))]);
const candidates = [...pathsByOid.keys()].filter((oid) => {
  const info = meta.get(oid);
  return info && info.type === "blob" && info.size <= MAX_BYTES
    && !skipPath([...pathsByOid.get(oid)][0]);
});

const offenders = [];
let scanned = 0;
let skipped = 0;

for (let index = 0; index < candidates.length; index += BATCH) {
  const batch = candidates.slice(index, index + BATCH);
  const blobs = readBlobs(batch);
  for (const oid of batch) {
    const bytes = blobs.get(oid);
    if (!bytes) {
      skipped += 1;
      continue;
    }
    const paths = [...pathsByOid.get(oid)];
    const path = paths[0];
    const result = scanBuffer(bytes, path);
    if (result.skipped) skipped += 1;
    else scanned += 1;
    if (result.findings.length) {
      offenders.push({ oid, paths, findings: result.findings });
    }
  }
}

const messageOffenders = [];
if (scanMessages) {
  const log = gitText(["log", "--all", "--format=%H%x00%B%x00"]);
  const parts = log.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const sha = parts[index].trim();
    if (!sha) continue;
    const findings = scanText(parts[index + 1]);
    if (findings.length) messageOffenders.push({ sha, findings });
  }
}

if (offenders.length || messageOffenders.length) {
  console.error("privacy history: offending content found");
  for (const item of offenders) {
    const commit = commitFor(item.oid);
    const where = commit ? `commit ${commit}` : `blob ${item.oid.slice(0, 12)}`;
    for (const finding of item.findings) {
      const line = finding.line ? ` at ${finding.line}` : "";
      console.error(`  ${where} path ${item.paths.join(", ")}: ${finding.kind}${line}`);
    }
  }
  for (const item of messageOffenders) {
    for (const finding of item.findings) {
      console.error(`  commit ${item.sha} path <commit message>: ${finding.kind} at line ${finding.line}`);
    }
  }
  console.error(`\n${offenders.length} offending blob(s), ${messageOffenders.length} offending commit message(s).`);
  process.exit(1);
}

console.log(`clean: ${refList.length} ref(s), ${scanned} blob(s) scanned, ${skipped} skipped as vendored or binary`);
