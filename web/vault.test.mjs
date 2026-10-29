import test from "node:test";
import assert from "node:assert/strict";
import {
  createVault, openVault, changePassphrase, keyFileName, parseKeyFileName,
  describeKeyFile, KEY_FILE_RE,
} from "./vault.js";
import { decryptWithKey, inspect, toHex } from "./crypto.js";

const PASS = "a long family passphrase";
const FAST = { iterations: 10_000 };
const other = (s) => new TextEncoder().encode(s);

test("creating a vault returns a data key and a sealed key file", async () => {
  const v = await createVault(PASS, { label: "dad", ...FAST });
  assert.equal(v.dek.length, 32);
  assert.equal(v.name, "vault-key-0001.bpk");
  assert.equal(v.fingerprint.length, 8);        // 4 bytes, hex
  assert.ok(v.keyFile.length > 100);
  assert.equal(new TextDecoder().decode(v.keyFile.slice(0, 4)), "BPK1");
});

test("the key file does not contain the data key in the clear", async () => {
  const v = await createVault(PASS, FAST);
  const text = new TextDecoder("latin1").decode(v.keyFile);
  assert.equal(text.includes("dek"), false);
  assert.equal(text.includes(toHex(v.dek)), false);
});

test("a key file opens with the right passphrase and yields the same key", async () => {
  const made = await createVault(PASS, { label: "dad", ...FAST });
  const opened = await openVault(made.keyFile, PASS);
  assert.equal(toHex(opened.dek), toHex(made.dek));
  assert.equal(opened.meta.label, "dad");
  assert.equal(opened.fingerprint, made.fingerprint);
});

test("a key file does not open with the wrong passphrase", async () => {
  const made = await createVault(PASS, FAST);
  await assert.rejects(() => openVault(made.keyFile, "wrong"), (e) => e.code === "bad_passphrase");
});

test("a snapshot written before a passphrase change still opens after it", async () => {
  const made = await createVault(PASS, FAST);
  const snapshot = await (await import("./crypto.js")).encryptWithKey(other("ledger"), made.dek);

  const rotated = await changePassphrase(made.keyFile, PASS, "an entirely new passphrase", FAST);
  assert.notEqual(toHex(rotated.keyFile), toHex(made.keyFile));
  assert.equal(rotated.fingerprint, made.fingerprint, "the data key is unchanged");

  await assert.rejects(() => openVault(rotated.keyFile, PASS), (e) => e.code === "bad_passphrase");
  const reopened = await openVault(rotated.keyFile, "an entirely new passphrase");
  assert.equal(toHex(reopened.dek), toHex(made.dek));
  assert.equal(new TextDecoder().decode(await decryptWithKey(snapshot, reopened.dek)), "ledger");
});

test("a passphrase change refuses a short new passphrase", async () => {
  const made = await createVault(PASS, FAST);
  await assert.rejects(
    () => changePassphrase(made.keyFile, PASS, "short", FAST),
    (e) => e.code === "weak_passphrase");
});

test("a tampered key file is refused rather than yielding a wrong key", async () => {
  const made = await createVault(PASS, FAST);
  const bad = new Uint8Array(made.keyFile);
  bad[bad.length - 1] ^= 0xff;
  await assert.rejects(() => openVault(bad, PASS), (e) => e.code === "bad_passphrase");
});

test("a key file name is recognised and a snapshot name is not", () => {
  assert.ok(KEY_FILE_RE.test(keyFileName(1)));
  assert.ok(KEY_FILE_RE.test(keyFileName(42)));
  assert.equal(parseKeyFileName("vault-key-0003.bpk").seq, 3);
  assert.equal(parseKeyFileName("bankpipe-2026-10-21T060000Z-mac1.bpdb"), null);
  assert.equal(parseKeyFileName("notes.txt"), null);
});

test("describeKeyFile reports a plausible file without opening it", async () => {
  const made = await createVault(PASS, FAST);
  const d = await describeKeyFile(made.keyFile);
  assert.equal(d.looksValid, true);
  assert.equal(d.iterations, 10_000);
  const bad = await describeKeyFile(other("not a key file at all"));
  assert.equal(bad.looksValid, false);
});

test("two vaults created separately do not share a key", async () => {
  const a = await createVault(PASS, FAST);
  const b = await createVault(PASS, FAST);
  assert.notEqual(toHex(a.dek), toHex(b.dek));
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(inspect(a.keyFile).format, "passphrase");
});
