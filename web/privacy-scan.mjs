import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

export const MAX_BYTES = 512 * 1024;

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

export function scanFiles(paths, denylist, { root = process.cwd() } = {}) {
  const secrets = cleanDenylist(denylist);
  const findings = [];
  if (!secrets.length) return findings;
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    let stat;
    try { stat = statSync(absolute); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    if (SKIP_EXTENSIONS.has(extname(absolute).toLowerCase())) continue;
    let text;
    try { text = readFileSync(absolute, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      for (const secret of secrets) {
        if (lines[index].includes(secret)) {
          findings.push({ path, line: index + 1 });
          break;
        }
      }
    }
  }
  return findings;
}
