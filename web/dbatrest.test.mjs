import test from "node:test";
import assert from "node:assert/strict";
import { isSealed, sealBytes, openBytes, DB_ITERATIONS } from "./dbatrest.js";

const plain = new TextEncoder().encode("SQLite format 3\u0000ACCOUNT-5010-SECRET-NAME");

test("the sealed database uses the 600k PBKDF2 floor", () => {
  assert.ok(DB_ITERATIONS >= 600_000);
});

test("a sealed database round-trips", async () => {
  const blob = await sealBytes(plain, "correct horse battery");
  assert.equal(isSealed(blob), true);
  const opened = await openBytes(blob, "correct horse battery");
  assert.deepEqual([...opened], [...plain]);
});

test("a sealed database has no readable SQLite header", async () => {
  const blob = await sealBytes(plain, "correct horse battery");
  const text = Buffer.from(blob).toString("latin1");
  assert.equal(text.includes("SQLite format 3"), false);
  assert.equal(text.includes("ACCOUNT-5010-SECRET-NAME"), false);
  assert.equal(isSealed(blob), true);
});

test("the wrong passphrase does not open the database", async () => {
  const blob = await sealBytes(plain, "correct horse battery");
  await assert.rejects(() => openBytes(blob, "wrong passphrase"));
});

test("a short passphrase is refused", async () => {
  await assert.rejects(() => sealBytes(plain, "short"), /at least 8/);
});

test("plain bytes are not mistaken for a sealed database", () => {
  assert.equal(isSealed(plain), false);
  assert.equal(isSealed(new Uint8Array()), false);
});
