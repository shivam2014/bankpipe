import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { choosePdfBlock, duplicateFile, accountLabel } from "./batch.js";

const block = (number, count) => ({
  number,
  rows: Array.from({ length: count }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}` })),
});

test("a PDF with no transaction block is refused", () => {
  assert.deepEqual(choosePdfBlock([]), { error: "No transactions found in this PDF." });
  assert.deepEqual(choosePdfBlock([{ number: "7585", rows: [] }]),
    { error: "No transactions found in this PDF." });
});

test("a PDF with exactly one block of transactions is accepted", () => {
  const one = block("7585", 2);
  assert.deepEqual(choosePdfBlock([one]), { block: one });
  // An empty summary block does not count as a second account.
  assert.deepEqual(choosePdfBlock([{ number: "9999", rows: [] }, one]), { block: one });
});

test("a PDF with two accounts of transactions is refused whole", () => {
  assert.deepEqual(choosePdfBlock([block("7585", 1), block("9911", 3)]), {
    error: "This PDF has transactions for more than one account. Split it per account and import one file per account.",
  });
});

test("duplicateFile marks later copies and clears stale marks", () => {
  const entries = [
    { name: "a.csv", sha256: "aa" },
    { name: "b.csv", sha256: "bb" },
    { name: "copy-of-a.csv", sha256: "aa" },
    { name: "no-hash.csv", sha256: "" },
  ];
  assert.equal(duplicateFile(entries), entries);
  assert.equal(entries[0].duplicateOf, 0);
  assert.equal(entries[1].duplicateOf, 0);
  assert.equal(entries[2].duplicateOf, 1);
  assert.equal(entries[3].duplicateOf, 0);

  entries.splice(0, 1);
  duplicateFile(entries);
  assert.equal(entries[0].duplicateOf, 0, "the remaining copy is no longer a duplicate");
  assert.equal(entries[1].duplicateOf, 0, "an empty hash never duplicates");
});

test("accountLabel names the destination with its last four digits", () => {
  const accounts = [
    { id: "pnb-savings", label: "PNB savings", number: "001234567585" },
    { id: "hdfc", label: "HDFC salary", number: "" },
  ];
  assert.equal(accountLabel({ accountId: "pnb-savings" }, accounts), "PNB savings · …7585");
  assert.equal(accountLabel({ accountId: "hdfc" }, accounts), "HDFC salary");
  assert.equal(accountLabel({ guessId: "pnb-savings" }, accounts), "PNB savings · …7585");
  assert.equal(accountLabel({ accountId: "__new__" }, accounts), "");
  assert.equal(accountLabel({ accountId: "missing" }, accounts), "");
});

test("the inline module still parses as JavaScript", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "the inline module is present");
  const dir = mkdtempSync(join(tmpdir(), "bankpipe-inline-"));
  const file = join(dir, "module.mjs");
  try {
    writeFileSync(file, match[1]);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
