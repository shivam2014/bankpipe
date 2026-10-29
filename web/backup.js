// Backup and restore through a storage adapter.
//
// The properties this is built to hold:
//
//   1. Nothing ever overwrites a backup. Every snapshot is a new immutable file,
//      so two devices backing up at the same time cannot destroy each other's
//      data. The worst case is two visible lineages, not one lost month.
//   2. A backup is only reported as successful after it has been downloaded
//      again and decrypted. "Uploaded" and "recoverable" are different claims.
//   3. Restore verifies before it replaces. A corrupt or truncated file leaves
//      the local database untouched.
//   4. The passphrase and the plaintext never leave the device.

import { encryptWithKey, decryptWithKey, sha256, toHex, SnapshotError } from "./crypto.js";
import { KEY_FILE_RE } from "./vault.js";

const NAME_RE = /^bankpipe-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-([A-Za-z0-9]{1,8}))?\.bpdb$/;
const SNAPSHOT_NAME_RE = /^bankpipe-\d{4}-\d{2}-\d{2}T\d{6}Z(?:-[A-Za-z0-9]{1,8})?\.bpdb$/;

export function snapshotName(now, device) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const tag = device ? `-${String(device).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}` : "";
  return `bankpipe-${stamp}${tag}.bpdb`;
}

export function parseSnapshotName(name) {
  const m = NAME_RE.exec(String(name || ""));
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return { at: when, iso, device: m[5] || null };
}

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isKeyFile = (name) => KEY_FILE_RE.test(String(name || ""));

// SQLite pages hold a lot of text, so gzip typically takes a 10 MB database to
// 2–3 MB before it is encrypted. Old snapshots are not compressed and start
// with "SQLite"; new ones start with the gzip magic, so both restore.
async function packPlain(bytes) {
  if (typeof CompressionStream === "undefined") return bytes;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}

async function unpackPlain(bytes) {
  if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new SnapshotError("needs_decompression",
      "this snapshot is compressed and this browser cannot open it");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Snapshot names sort lexicographically by time, so "keep the newest N" is a
// sort, not a date parse. Month-ends get their own budget so a year of history
// survives daily pruning. Anything that is not a recognised snapshot name is
// never returned for deletion: a stray file in the folder is the user's.
export function planPrune(files, { keepDaily = 14, keepMonthly = 12, pins = [] } = {}) {
  const pinned = new Set(pins);
  const candidates = files.filter((f) => SNAPSHOT_NAME_RE.test(f.name));
  const sorted = [...candidates].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const keep = new Set();
  const months = new Set();
  let daily = 0;

  sorted.forEach((f) => {
    const month = f.name.slice(9, 16);
    // A pinned snapshot is never a prune candidate, and it does not use up a
    // daily slot: pinning one old file must not cost the user a recent one.
    if (pinned.has(f.id)) {
      keep.add(f.id);
      return;
    }
    if (daily < keepDaily) {
      keep.add(f.id);
      // Days already cover their own month, so the monthly budget only buys
      // history older than the daily window.
      months.add(month);
      daily += 1;
      return;
    }
    if (months.has(month)) return;
    if (months.size >= keepMonthly) return;
    months.add(month);
    keep.add(f.id);
  });

  return sorted.filter((f) => !keep.has(f.id)).map((f) => f.id);
}

export async function listSnapshots({ storage }) {
  const files = await storage.list();
  return files
    .map((f) => ({ ...f, parsed: parseSnapshotName(f.name) }))
    .filter((f) => f.parsed)
    .sort((a, b) => b.parsed.at - a.parsed.at);
}

export async function readVaultKey({ storage }) {
  const key = (await storage.list())
    .filter((f) => isKeyFile(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  if (!key) return null;
  return { ...key, bytes: await storage.get(key.id) };
}

export async function ensureVaultKey({ storage, keyFile, name }) {
  const existing = await readVaultKey({ storage });
  if (existing) return { ...existing, uploaded: false };
  const put = await storage.put(name, keyFile);
  return { ...put, bytes: keyFile, uploaded: true };
}

export class VerifyFailed extends Error {
  constructor(name, file, reason) {
    super(`backup ${name} could not be read back: ${reason}`);
    this.name = "VerifyFailed";
    this.file = file;
    this.reason = reason;
  }
}

export async function backupNow({
  store, dek, deviceId, storage, now = new Date(),
  keyFile = null, keyName = "vault-key-0001.bpk",
  keepDaily = 14, keepMonthly = 12, pins = [], verify = true,
}) {
  if (!store) throw new Error("no store");
  if (!dek) throw new Error("the vault is locked");
  const plain = store.exportBytes();
  if (!plain.length) throw new Error("the local database is empty");

  const digest = toHex(await sha256(plain));
  const packed = await packPlain(plain);
  const blob = await encryptWithKey(packed, dek);
  const keyState = keyFile ? await ensureVaultKey({ storage, keyFile, name: keyName }) : null;

  const name = snapshotName(now, deviceId);
  const file = await storage.put(name, blob);

  let verified = false;
  let verifyError = null;
  if (verify) {
    try {
      const remote = await storage.get(file.id);
      const back = await unpackPlain(await decryptWithKey(remote, dek));
      verified = equalBytes(await sha256(back), await sha256(plain));
      if (!verified) verifyError = "download did not match what was uploaded";
    } catch (err) {
      verifyError = err.message;
    }
    // Keep the file: a snapshot that fails verification is still evidence, and
    // deleting it would destroy the thing we are trying to prove.
    if (!verified) throw new VerifyFailed(name, file, verifyError);
  }

  let pruned = [];
  try {
    pruned = planPrune(await storage.list(), { keepDaily, keepMonthly, pins });
    for (const id of pruned) await storage.remove(id);
  } catch {
    pruned = [];
  }

  return {
    file, name, verified, verifyError, keyState, pruned,
    plainBytes: plain.length, cipherBytes: blob.length, digest,
  };
}

// Downloads, decrypts and checks the file, but never adopts it. This is the
// restore drill: it proves the backup is readable while changing nothing.
export async function inspectSnapshot({ storage, fileId, dek, SQLlib }) {
  const blob = await storage.get(fileId);
  const plain = await unpackPlain(await decryptWithKey(blob, dek));
  const digest = toHex(await sha256(plain));

  let integrity = "not checked";
  let facts = null;
  let accounts = null;
  if (SQLlib) {
    const probe = new SQLlib.Database(plain);
    try {
      const row = probe.exec("PRAGMA integrity_check");
      integrity = row.length && row[0].values.length ? String(row[0].values[0][0]) : "unknown";
      if (integrity === "ok") {
        const n = (sql) => {
          const r = probe.exec(sql);
          return r.length && r[0].values.length ? Number(r[0].values[0][0]) : 0;
        };
        facts = n("SELECT COUNT(*) FROM fact");
        accounts = n("SELECT COUNT(*) FROM account");
      }
    } finally {
      probe.close();
    }
  }

  return {
    blob, plain, digest, integrity, facts, accounts,
    ok: integrity === "ok", plainBytes: plain.length,
  };
}

export async function restoreNow({ store, storage, fileId, dek, SQLlib, force = false }) {
  const seen = await inspectSnapshot({ storage, fileId, dek, SQLlib });
  if (!seen.ok) {
    throw new SnapshotError("verify_failed", `integrity check said "${seen.integrity}"`);
  }
  if (!force && store.raw() && store.summary().facts > 0) {
    throw new SnapshotError("not_empty",
      "this device already holds transactions; restore would replace them");
  }
  await store.replaceWith(seen.plain);
  return seen;
}

// Two devices writing is not an error, because nothing is overwritten. It is
// still worth saying out loud before the user creates a second lineage.
export function lineage({ snapshots, deviceId, lastBackupAt }) {
  const newest = snapshots[0];
  if (!newest) return { foreign: false, newest: null };
  const mine = !newest.parsed.device || newest.parsed.device === deviceId;
  const newer = !lastBackupAt || newest.parsed.at.getTime() > lastBackupAt;
  return {
    foreign: !mine && newer,
    newest: newest.parsed,
    device: newest.parsed.device,
  };
}
