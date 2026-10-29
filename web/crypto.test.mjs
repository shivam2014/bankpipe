import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptWithKey, decryptWithKey, encryptWithPassphrase, decryptWithPassphrase,
  inspect, randomBytes, sha256, hmacSha256, toHex, toBase64Url, fromBase64Url, fingerprint,
  deriveKey, DEK_BYTES, HEADER_KEY_BYTES, HEADER_PASS_BYTES, DEFAULT_ITERATIONS,
} from "./crypto.js";

const PASS = "correct horse battery staple";
const FAST = 10_000;
const bytes = (s) => new TextEncoder().encode(s);
const flip = (b, i) => { const c = new Uint8Array(b); c[i] ^= 0xff; return c; };

async function codeOf(fn) {
  try { await fn(); return "no_error"; } catch (e) { return e.code || e.name; }
}

test("a keyed snapshot round-trips byte for byte", async () => {
  const dek = randomBytes(DEK_BYTES);
  const plain = bytes("SQLite format 3\0 pretend this is a ledger");
  const blob = await encryptWithKey(plain, dek);
  assert.equal(toHex(await decryptWithKey(blob, dek)), toHex(plain));
});

test("a keyed snapshot has no KDF cost, so it opens immediately", async () => {
  const dek = randomBytes(DEK_BYTES);
  const blob = await encryptWithKey(bytes("x"), dek);
  const h = inspect(blob);
  assert.equal(h.format, "key");
  assert.equal(blob.length, HEADER_KEY_BYTES + h.body.length);
  assert.equal(h.iterations, undefined);
  assert.equal(new TextDecoder().decode(blob.slice(0, 4)), "BPK2");
});

test("the snapshot records which vault wrote it, and a foreign key is refused precisely", async () => {
  const mine = randomBytes(DEK_BYTES);
  const theirs = randomBytes(DEK_BYTES);
  const blob = await encryptWithKey(bytes("data"), mine);
  assert.equal(toHex(inspect(blob).fp), toHex(await fingerprint(mine)));
  assert.equal(await codeOf(() => decryptWithKey(blob, theirs)), "wrong_vault");
});

test("the header is authenticated: a snapshot cannot be relabelled", async () => {
  const dek = randomBytes(DEK_BYTES);
  const blob = await encryptWithKey(bytes("data"), dek);
  assert.equal(await codeOf(() => decryptWithKey(flip(blob, 6 + 12), dek)), "wrong_vault");
  assert.equal(await codeOf(() => decryptWithKey(flip(blob, blob.length - 1), dek)), "corrupt");
});

test("a passphrase file round-trips and reports its cost", async () => {
  const blob = await encryptWithPassphrase(bytes("key payload"), PASS, { iterations: FAST });
  const h = inspect(blob);
  assert.equal(h.format, "passphrase");
  assert.equal(h.iterations, FAST);
  assert.equal(h.salt.length, 16);
  assert.equal(blob.length, HEADER_PASS_BYTES + h.body.length);
  assert.equal(new TextDecoder().decode(blob.slice(0, 4)), "BPK1");
  assert.equal(new TextDecoder().decode(await decryptWithPassphrase(blob, PASS)), "key payload");
});

test("a wrong passphrase is refused", async () => {
  const blob = await encryptWithPassphrase(bytes("key"), PASS, { iterations: FAST });
  assert.equal(await codeOf(() => decryptWithPassphrase(blob, "nope")), "bad_passphrase");
});

test("the KDF cost cannot be downgraded in a stored file", async () => {
  const blob = await encryptWithPassphrase(bytes("key"), PASS, { iterations: FAST });
  assert.equal(await codeOf(() => decryptWithPassphrase(flip(blob, 6), PASS)), "bad_passphrase");
});

test("the two formats refuse each other instead of failing obscurely", async () => {
  const dek = randomBytes(DEK_BYTES);
  const keyed = await encryptWithKey(bytes("x"), dek);
  const sealed = await encryptWithPassphrase(bytes("x"), PASS, { iterations: FAST });
  assert.equal(await codeOf(() => decryptWithPassphrase(keyed, PASS)), "needs_key");
  assert.equal(await codeOf(() => decryptWithKey(sealed, dek)), "needs_passphrase");
});

test("ciphertext carries no plaintext, and each file is unique", async () => {
  const dek = randomBytes(DEK_BYTES);
  const plain = bytes("ZZMARKERZZ narration that must never appear");
  const a = await encryptWithKey(plain, dek);
  const b = await encryptWithKey(plain, dek);
  assert.notEqual(toHex(a), toHex(b));
  const text = new TextDecoder("latin1").decode(a);
  assert.equal(text.includes("ZZMARKERZZ"), false);
  assert.equal(text.includes("SQLite format 3"), false);
});

test("truncated and foreign files are named, not guessed at", async () => {
  const dek = randomBytes(DEK_BYTES);
  const blob = await encryptWithKey(bytes("x"), dek);
  assert.equal(await codeOf(() => decryptWithKey(blob.slice(0, 10), dek)), "truncated");
  assert.equal(await codeOf(() => decryptWithKey(new Uint8Array(80), dek)), "not_a_snapshot");
});

test("a data key must be exactly 32 bytes", async () => {
  assert.equal(await codeOf(() => encryptWithKey(bytes("x"), randomBytes(16))), "bad_key");
});

test("the default passphrase cost is the OWASP floor", async () => {
  assert.ok(DEFAULT_ITERATIONS >= 600_000);
  const blob = await encryptWithPassphrase(bytes("x"), PASS);
  assert.equal(inspect(blob).iterations, DEFAULT_ITERATIONS);
});

test("an implausible KDF iteration count is refused before work starts", async () => {
  await assert.rejects(() => deriveKey(PASS, randomBytes(16), 4_000_000),
    (e) => e.code === "bad_iterations");
  await assert.rejects(() => deriveKey(PASS, randomBytes(16), 999),
    (e) => e.code === "bad_iterations");
});

test("base64url survives every byte value", async () => {
  const raw = new Uint8Array(256);
  for (let i = 0; i < 256; i++) raw[i] = i;
  assert.equal(toHex(fromBase64Url(toBase64Url(raw))), toHex(raw));
  assert.equal(toBase64Url(new Uint8Array([251, 255, 190])).includes("="), false);
});

test("sha256 is stable and 32 bytes", async () => {
  const a = await sha256(bytes("x"));
  assert.equal(a.length, 32);
  assert.equal(toHex(a), toHex(await sha256(bytes("x"))));
});

test("HMAC-SHA256 matches the published vector", async () => {
  const key = bytes("Jefe");
  const data = bytes("what do ya want for nothing?");
  assert.equal(
    toHex(await hmacSha256(key, data)),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});
