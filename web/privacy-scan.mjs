import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { extname, isAbsolute, join } from "node:path";

export const MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export const SKIP_EXTENSIONS = new Set([
  ".pdf", ".xlsx", ".xls", ".xlsm", ".zip", ".bpk", ".db", ".db-wal",
  ".db-shm", ".sqlite", ".wasm", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".ico", ".bmp", ".tif", ".tiff", ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".mov", ".webm", ".wav", ".gz", ".tgz", ".7z", ".rar",
  ".jar", ".class", ".so", ".dylib", ".dll", ".exe",
]);

export function cleanDenylist(denylist) {
  return [...new Set((Array.isArray(denylist) ? denylist : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value && !value.startsWith("#")))];
}

function scanFile(absolute, path, secrets) {
  const fd = openSync(absolute, "r");
  const findings = [];
  let line = 0;
  const check = (text) => {
    const value = text.endsWith("\r") ? text.slice(0, -1) : text;
    for (const secret of secrets) {
      if (value.includes(secret)) {
        findings.push({ path, line });
        return;
      }
    }
  };
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = "";
    for (;;) {
      const bytes = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (!bytes) break;
      const text = carry + decoder.write(buffer.subarray(0, bytes));
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const value of lines) {
        line += 1;
        check(value);
      }
    }
    carry += decoder.end();
    if (carry) {
      line += 1;
      check(carry);
    }
  } finally {
    closeSync(fd);
  }
  return findings;
}

export function scanFilesWithStats(paths, denylist, { root = process.cwd() } = {}) {
  const secrets = cleanDenylist(denylist);
  const stats = { scanned: 0, skippedBinary: 0, skippedLarge: 0, missing: 0, unreadable: 0 };
  const findings = [];
  if (!secrets.length) return { findings, stats };
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    let stat;
    try { stat = statSync(absolute); } catch { stats.missing += 1; continue; }
    if (!stat.isFile()) continue;
    if (SKIP_EXTENSIONS.has(extname(absolute).toLowerCase())) {
      stats.skippedBinary += 1;
      continue;
    }
    if (stat.size > MAX_BYTES) {
      stats.skippedLarge += 1;
      continue;
    }
    try {
      findings.push(...scanFile(absolute, path, secrets));
      stats.scanned += 1;
    } catch {
      stats.unreadable += 1;
    }
  }
  return { findings, stats };
}

export function scanFiles(paths, denylist, options) {
  return scanFilesWithStats(paths, denylist, options).findings;
}
