// Database-at-rest sealing. The SQLite bytes are encrypted with the user's
// passphrase before they reach IndexedDB, so the browser profile on disk holds
// ciphertext, not a readable ledger.
//
// This is the same BPK1 envelope as the backup key file. The cost is paid on
// every save, so it is intentionally the OWASP floor rather than higher.

import { encryptWithPassphrase, decryptWithPassphrase } from "./crypto.js";

const MAGIC = [0x42, 0x50, 0x4b, 0x31]; // "BPK1"
export const DB_ITERATIONS = 600_000;

export function isSealed(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

export async function sealBytes(bytes, passphrase) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error("the database passphrase must be at least 8 characters");
  }
  return encryptWithPassphrase(new Uint8Array(bytes), passphrase,
    { iterations: DB_ITERATIONS });
}

export async function openBytes(blob, passphrase) {
  return decryptWithPassphrase(blob, passphrase);
}
