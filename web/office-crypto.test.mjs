import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  aesCbcDecrypt, isEncryptedOffice, hasEncryptionStreams, readCfb, parseEncryptionInfo, decryptOffice,
} from "./office-crypto.js";

const FILE = new URL("./fixtures/encrypted/example_password.xlsx", import.meta.url).pathname;
const PASSWORD = "Password1234_";
const PLAIN_SHA = "4dd9dd0ccbfc7fb8769f1f3307830d3cc4c5042e32d619f4b2835fada89d13c6";
const bytes = new Uint8Array(readFileSync(FILE));

test("AES-CBC decryption matches node:crypto at every key size", () => {
  for (const bits of [128, 192, 256]) {
    const key = randomBytes(bits / 8), iv = randomBytes(16), plain = randomBytes(64);
    const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const out = aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(encrypted));
    assert.equal(Buffer.from(out).toString("hex"), plain.toString("hex"), `AES-${bits}`);
  }
});

test("the OLE2 container exposes both encryption streams", () => {
  assert.equal(isEncryptedOffice(bytes), true);
  assert.equal(isEncryptedOffice(new Uint8Array([0x50, 0x4b, 3, 4])), false);
  const streams = readCfb(bytes);
  assert.ok(streams.EncryptionInfo.length > 100);
  assert.ok(streams.EncryptedPackage.length > 1000);
  const info = parseEncryptionInfo(streams.EncryptionInfo);
  assert.equal(info.encryptedKey.spinCount, "100000");
  assert.equal(info.keyData.hashAlgorithm, "SHA512");
  // The two salts are different and must not be swapped: the password salt is
  // on <p:encryptedKey>, the package salt on <keyData>.
  assert.notEqual(info.keyData.saltValue, info.encryptedKey.saltValue);
});

test("a legacy .xls container is not an encrypted package", () => {
  // Every .xls is OLE2. Only the two OOXML encryption streams mean a password
  // is needed; a plain .xls holds a Workbook stream instead.
  assert.equal(hasEncryptionStreams({ Workbook: new Uint8Array(4) }), false);
  assert.equal(hasEncryptionStreams({}), false);
  assert.equal(hasEncryptionStreams({
    EncryptionInfo: new Uint8Array(1), EncryptedPackage: new Uint8Array(1),
  }), true);
});

test("a password-protected workbook opens with its password", async () => {
  const zip = await decryptOffice(bytes, PASSWORD);
  assert.deepEqual([zip[0], zip[1]], [0x50, 0x4b]);
  assert.equal(createHash("sha256").update(zip).digest("hex"), PLAIN_SHA);
});

test("a wrong password is refused, not silently opened", async () => {
  await assert.rejects(() => decryptOffice(bytes, "0000"), /wrong password/);
  await assert.rejects(() => decryptOffice(bytes, PASSWORD + "x"), /wrong password/);
});

test("a file that is not an OLE2 container is rejected early", () => {
  assert.throws(() => readCfb(new Uint8Array([1, 2, 3, 4])), /not an OLE2 file/);
});
