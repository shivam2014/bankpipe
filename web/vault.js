// The key envelope.
//
// One random data key (DEK) encrypts every snapshot. The DEK is wrapped by a
// passphrase-derived key and stored as a small file in the backup folder, so:
//
//   - a new device can bootstrap from the folder alone (download the key file,
//     type the passphrase, unwrap);
//   - changing the passphrase rewrites one ~200-byte file, not the archive;
//   - several key files can coexist if two offline devices each started one,
//     which is the same problem Joplin solves with multiple master keys.
//
// The DEK never leaves the device except wrapped. That is the whole point: the
// key file is safe to store next to the snapshots, because without the
// passphrase it is noise.

import {
  DEK_BYTES, SnapshotError, randomBytes, fingerprint, toBase64Url, fromBase64Url,
  encryptWithPassphrase, decryptWithPassphrase, inspect, DEFAULT_ITERATIONS, toHex,
} from "./crypto.js";

export const KEY_FILE_PREFIX = "vault-key-";
export const KEY_FILE_SUFFIX = ".bpk";
export const KEY_FORMAT = 1;
export const KEY_FILE_RE = /^vault-key-(\d{4})\.bpk$/;

export function keyFileName(seq = 1) {
  return `${KEY_FILE_PREFIX}${String(seq).padStart(4, "0")}${KEY_FILE_SUFFIX}`;
}

export function parseKeyFileName(name) {
  const m = KEY_FILE_RE.exec(String(name || ""));
  return m ? { seq: Number(m[1]), name: m[0] } : null;
}

const enc = (s) => new TextEncoder().encode(s);

function validate(payload) {
  if (!payload || typeof payload !== "object") {
    throw new SnapshotError("bad_key_file", "the key file is not readable");
  }
  if (payload.v !== KEY_FORMAT) {
    throw new SnapshotError("bad_key_file", `key file version ${payload.v} is not supported`);
  }
  if (payload.alg !== "AES-256-GCM") {
    throw new SnapshotError("bad_key_file", `unsupported key algorithm ${payload.alg}`);
  }
  let dek;
  try { dek = fromBase64Url(payload.dek); } catch { dek = null; }
  if (!dek || dek.length !== DEK_BYTES) {
    throw new SnapshotError("bad_key_file", "the key file does not contain a usable key");
  }
  return dek;
}

export async function createVault(passphrase, opts = {}) {
  const dek = randomBytes(DEK_BYTES);
  const created = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const iterations = opts.iterations || DEFAULT_ITERATIONS;
  const label = String(opts.label || "").slice(0, 64);

  const payload = {
    v: KEY_FORMAT,
    alg: "AES-256-GCM",
    label,
    created,
    dek: toBase64Url(dek),
  };
  const keyFile = await encryptWithPassphrase(enc(JSON.stringify(payload)), passphrase, { iterations });

  return {
    dek,
    keyFile,
    name: keyFileName(1),
    meta: { label, created, iterations },
    fingerprint: toHex(await fingerprint(dek)),
  };
}

export async function openVault(keyFileBytes, passphrase) {
  const plain = await decryptWithPassphrase(keyFileBytes, passphrase);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(plain)); }
  catch { throw new SnapshotError("bad_key_file", "the key file is not valid JSON"); }

  const dek = validate(payload);
  return {
    dek,
    meta: { label: payload.label || "", created: payload.created || null },
    fingerprint: toHex(await fingerprint(dek)),
  };
}

// The passphrase changes; the data key does not. Every snapshot stays readable
// and this one small file is replaced.
export async function changePassphrase(keyFileBytes, oldPassphrase, newPassphrase, opts = {}) {
  if (typeof newPassphrase !== "string" || newPassphrase.length < 12) {
    throw new SnapshotError("weak_passphrase", "use at least 12 characters");
  }
  const plain = await decryptWithPassphrase(keyFileBytes, oldPassphrase);
  const payload = JSON.parse(new TextDecoder().decode(plain));
  validate(payload);
  payload.rewrapped = (opts.now instanceof Date ? opts.now : new Date()).toISOString();

  return {
    keyFile: await encryptWithPassphrase(
      enc(JSON.stringify(payload)), newPassphrase,
      { iterations: opts.iterations || DEFAULT_ITERATIONS }),
    fingerprint: toHex(await fingerprint(fromBase64Url(payload.dek))),
  };
}

// What a new device sees before it has the passphrase: no secrets, just enough
// to tell the user what they are unlocking.
export async function describeKeyFile(blob) {
  try {
    const h = inspect(blob);
    if (h.format !== "passphrase") {
      throw new SnapshotError("bad_key_file", "this file is not a vault key");
    }
    return { looksValid: true, iterations: h.iterations, bytes: blob.length };
  } catch (e) {
    return { looksValid: false, reason: e.message };
  }
}
