import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles } from "./privacy-scan.mjs";

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

test("the scan skips binary extensions and files over 512 KB", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-privacy-scan-"));
  try {
    const sentinel = "SENTINEL-PRIVACY-12345";
    const image = join(dir, "image.png");
    const large = join(dir, "large.txt");
    writeFileSync(image, sentinel);
    writeFileSync(large, `${sentinel}\n${"x".repeat(513 * 1024)}`);
    assert.deepEqual(scanFiles([image, large], [sentinel]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
