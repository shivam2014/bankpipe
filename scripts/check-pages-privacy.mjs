#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || "build/pages/public";
const FORBIDDEN = [
  /(^|\/)private\//i,
  /(^|\/)fixtures\//i,
  /\.test\.mjs$/i,
  /\.pdf$/i,
  /\.bpk$/i,
  /\.db(?:-wal|-shm)?$/i,
  /\.sqlite$/i,
  /(^|\/)import-denylist\.txt$/i,
];

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`missing bundle directory: ${root}`);
  process.exit(1);
}

const bad = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    const rel = relative(root, path).split("\\").join("/");
    if (FORBIDDEN.some((pattern) => pattern.test(rel))) bad.push(rel);
  }
}
walk(root);

if (bad.length) {
  console.error("refusing to publish private files:");
  for (const path of bad) console.error(`  ${path}`);
  process.exit(1);
}
console.log(`pages privacy: ${root} clean`);
