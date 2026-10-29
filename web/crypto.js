// Snapshot and key-file encryption. Browser and Node.
//
// Two formats, because they answer different questions.
//
//   BPK2 — a snapshot. Encrypted with a random 32-byte data key (DEK). No KDF,
//          no salt, no passphrase. Fast to open, and the key can change without
//          re-encrypting the archive.
//
//   BPK1 — the key file. A small JSON payload (the DEK, a label, a date)
//          encrypted with a passphrase-derived key. This is the only place a
//          passphrase is ever used, and it is the only file that has to be
//          rewritten when the passphrase changes.
//
// Both headers are passed to AES-GCM as additional authenticated data, so the
// version, the algorithm and the vault fingerprint cannot be edited without the
// file failing to open.
//
// BPK2 layout:  4 magic | 1 version | 1 alg | 12 iv | 4 vault fingerprint
// BPK1 layout:  4 magic | 1 version | 1 kdf | 4 iterations | 16 salt | 12 iv

export const DEK_BYTES = 32;

const MAGIC_KEY = [0x42, 0x50, 0x4b, 0x32]; // "BPK2"
const MAGIC_PASS = [0x42, 0x50, 0x4b, 0x31]; // "BPK1"

const VERSION = 1;
const ALG_AES_GCM = 1;
const KDF_PBKDF2 = 1;

export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const FP_BYTES = 4;
export const HEADER_KEY_BYTES = 4 + 1 + 1 + IV_BYTES + FP_BYTES; // 22
export const HEADER_PASS_BYTES = 4 + 1 + 1 + 4 + SALT_BYTES + IV_BYTES; // 38

// 600k is the current OWASP floor for PBKDF2-HMAC-SHA256. WebCrypto has no
// Argon2, and a WASM implementation is not worth the dependency here: this cost
// is paid once per unlock, not once per snapshot.
export const DEFAULT_ITERATIONS = 600_000;

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new SnapshotError("no_webcrypto", "WebCrypto unavailable");
  return c.subtle;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

// Used to name the blocks of an automatic backup: the MAC says which bytes a
// block holds, and only someone with the data key can produce it.
export async function hmacSha256(key, bytes) {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const imported = await subtle().importKey(
    "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", imported, bytes));
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A short, non-secret public name for a vault. It lets the UI say "this snapshot
// belongs to a different vault" instead of "the file is corrupt", which are very
// different messages to receive after a restore.
export async function fingerprint(dek) {
  const d = await sha256(dek);
  return d.slice(0, FP_BYTES);
}

function u32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

function readU32(b, at) {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

const startsWith = (b, magic) => magic.every((v, i) => b[i] === v);

// Reads only the header. Never derives a key, so it is safe to call on an
// untrusted file before the user has typed anything.
export function inspect(blob) {
  if (!blob || blob.length < HEADER_PASS_BYTES) {
    throw new SnapshotError("truncated", "file is too short to be a BankPipe file");
  }
  if (startsWith(blob, MAGIC_KEY)) {
    if (blob[4] !== VERSION) {
      throw new SnapshotError("unsupported_version", `snapshot version ${blob[4]} is not supported`);
    }
    if (blob[5] !== ALG_AES_GCM) {
      throw new SnapshotError("unsupported_alg", `algorithm ${blob[5]} is not supported`);
    }
    return {
      format: "key",
      version: blob[4],
      iv: blob.slice(6, 6 + IV_BYTES),
      fp: blob.slice(6 + IV_BYTES, HEADER_KEY_BYTES),
      header: blob.slice(0, HEADER_KEY_BYTES),
      body: blob.slice(HEADER_KEY_BYTES),
    };
  }
  if (startsWith(blob, MAGIC_PASS)) {
    if (blob[4] !== VERSION) {
      throw new SnapshotError("unsupported_version", `key file version ${blob[4]} is not supported`);
    }
    if (blob[5] !== KDF_PBKDF2) {
      throw new SnapshotError("unsupported_kdf", `kdf ${blob[5]} is not supported`);
    }
    return {
      format: "passphrase",
      version: blob[4],
      iterations: readU32(blob, 6),
      salt: blob.slice(10, 10 + SALT_BYTES),
      iv: blob.slice(10 + SALT_BYTES, HEADER_PASS_BYTES),
      header: blob.slice(0, HEADER_PASS_BYTES),
      body: blob.slice(HEADER_PASS_BYTES),
    };
  }
  throw new SnapshotError("not_a_snapshot", "not a BankPipe file");
}

async function importDek(dek) {
  const raw = dek instanceof Uint8Array ? dek : new Uint8Array(dek);
  if (raw.length !== DEK_BYTES) {
    throw new SnapshotError("bad_key", `a data key must be ${DEK_BYTES} bytes`);
  }
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptWithKey(plain, dek) {
  const key = await importDek(dek);
  const iv = randomBytes(IV_BYTES);
  const header = new Uint8Array(HEADER_KEY_BYTES);
  header.set(MAGIC_KEY, 0);
  header[4] = VERSION;
  header[5] = ALG_AES_GCM;
  header.set(iv, 6);
  header.set(await fingerprint(dek instanceof Uint8Array ? dek : new Uint8Array(dek)),
    6 + IV_BYTES);

  const body = new Uint8Array(await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: header }, key, plain));

  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export async function decryptWithKey(blob, dek) {
  const h = inspect(blob);
  if (h.format !== "key") {
    throw new SnapshotError("needs_passphrase",
      "this file is protected by a passphrase, not a vault key");
  }
  if (!h.body.length) throw new SnapshotError("truncated", "snapshot has no ciphertext");

  const raw = dek instanceof Uint8Array ? dek : new Uint8Array(dek);
  const want = await fingerprint(raw);
  if (toHex(want) !== toHex(h.fp)) {
    throw new SnapshotError("wrong_vault",
      "this snapshot was written by a different vault key");
  }

  const key = await importDek(raw);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: h.iv, additionalData: h.header }, key, h.body);
    return new Uint8Array(plain);
  } catch {
    throw new SnapshotError("corrupt", "the snapshot is damaged or was modified");
  }
}

export async function deriveKey(passphrase, salt, iterations) {
  if (typeof passphrase !== "string" || !passphrase) {
    throw new SnapshotError("no_passphrase", "a passphrase is required");
  }
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2_000_000) {
    throw new SnapshotError("bad_iterations", "iteration count is implausible");
  }
  const base = await subtle().importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]);
}

export async function encryptWithPassphrase(plain, passphrase, opts = {}) {
  const iterations = opts.iterations || DEFAULT_ITERATIONS;
  const salt = opts.salt || randomBytes(SALT_BYTES);
  const iv = opts.iv || randomBytes(IV_BYTES);

  const header = new Uint8Array(HEADER_PASS_BYTES);
  header.set(MAGIC_PASS, 0);
  header[4] = VERSION;
  header[5] = KDF_PBKDF2;
  header.set(u32(iterations), 6);
  header.set(salt, 10);
  header.set(iv, 10 + SALT_BYTES);

  const key = await deriveKey(passphrase, salt, iterations);
  const body = new Uint8Array(await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: header }, key, plain));

  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export async function decryptWithPassphrase(blob, passphrase) {
  const h = inspect(blob);
  if (h.format !== "passphrase") {
    throw new SnapshotError("needs_key", "this file is encrypted with a vault key, not a passphrase");
  }
  if (!h.body.length) throw new SnapshotError("truncated", "file has no ciphertext");

  const key = await deriveKey(passphrase, h.salt, h.iterations);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: h.iv, additionalData: h.header }, key, h.body);
    return new Uint8Array(plain);
  } catch {
    // GCM cannot distinguish a wrong key from a modified ciphertext, and neither
    // can we. Both mean the same thing to the user.
    throw new SnapshotError("bad_passphrase", "wrong passphrase, or the file was modified");
  }
}
