import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, scanFilesWithStats } from "./privacy-scan.mjs";

test("the scan reports the file and line, never the matched value", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-privacy-scan-"));
  try {
    const denylistPath = join(dir, "denylist.txt");
    const planted = join(dir, "planted.txt");
    const sentinel = "SENTINEL-PRIVACY-12345";
    writeFileSync(denylistPath, `${sentinel}\n`);
    writeFileSync(planted, `clean line\nthis line has ${sentinel} in it\n`);
    const denylist = readFileSync(denylistPath, "utf8").split(/\r?\n/).filter(Boolean);
    const findings = scanFiles([planted], denylist);
    assert.deepEqual(findings, [{ path: planted, line: 2 }]);
    assert.equal(JSON.stringify(findings).includes(sentinel), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a text file larger than 512 KB is still scanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-privacy-scan-"));
  try {
    const denylistPath = join(dir, "denylist.txt");
    const large = join(dir, "large.txt");
    const sentinel = "SENTINEL-PRIVACY-12345";
    writeFileSync(denylistPath, `${sentinel}\n`);
    writeFileSync(large, `${"x".repeat(600 * 1024)}\n${sentinel}\n`);
    const denylist = readFileSync(denylistPath, "utf8").split(/\r?\n/).filter(Boolean);
    const findings = scanFiles([large], denylist);
    assert.deepEqual(findings, [{ path: large, line: 2 }]);
    assert.equal(JSON.stringify(findings).includes(sentinel), false);
    assert.equal(scanFilesWithStats([large], denylist).stats.scanned, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binary extensions are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-privacy-scan-"));
  try {
    const sentinel = "SENTINEL-PRIVACY-12345";
    const image = join(dir, "image.png");
    writeFileSync(image, sentinel);
    assert.deepEqual(scanFiles([image], [sentinel]), []);
    assert.equal(scanFilesWithStats([image], [sentinel]).stats.skippedBinary, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
