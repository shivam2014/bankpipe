// Incremental automatic backups.
//
// A manual snapshot is one immutable file, which is the right shape for a
// monthly archive and the wrong shape for a copy that refreshes every five
// minutes. A 10 MB database is 1–3 MB gzipped, and uploading all of it because
// one transaction changed is waste.
//
// So the automatic copy is split into fixed 64 KiB blocks and every block is
// named by HMAC-SHA256(DEK, block). The name is the content: same bytes, same
// name, so a block that has not changed is already in storage and is not
// uploaded again. A manifest lists the blocks in order and carries the size and
// SHA-256 of the whole plaintext. The manifest is the commit point: blocks go
// up first, the manifest second, and blocks that the new manifest does not
// mention are deleted only after it has been read back and opened.
//
// Everything is encrypted before it leaves the device. The manifest is a small
// encrypted JSON file; each block is encrypted on its own. Neither can be read,
// reordered, or swapped for another block without the data key.

import {
  encryptWithKey, decryptWithKey, sha256, toHex, hmacSha256,
} from "./crypto.js";

export const CHUNK_SIZE = 64 * 1024;
export const MANIFEST_NAME = "bankpipe-auto.manifest";
export const BLOCK_PREFIX = "block-";
export const BLOCK_SUFFIX = ".bpblk";

const ID_RE = /^[0-9a-f]{64}$/;
const BLOCK_RE = /^block-([0-9a-f]{64})\.bpblk$/;
const encoder = new TextEncoder();

export class AutoBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutoBackupError";
    this.code = code;
  }
}

export const blockName = (id) => `${BLOCK_PREFIX}${id}${BLOCK_SUFFIX}`;

// The id is a MAC, not a hash: it names the block, and it also proves the block
// was produced by someone holding the data key. A block from another vault, or
// one byte flipped in storage, fails to match its own name on the way back.
export async function blockId(dek, bytes) {
  return toHex(await hmacSha256(dek, bytes));
}

export function splitBlocks(plain) {
  const out = [];
  for (let at = 0; at < plain.length; at += CHUNK_SIZE) {
    out.push(plain.subarray(at, Math.min(at + CHUNK_SIZE, plain.length)));
  }
  return out;
}

function checkManifest(m) {
  if (!m || typeof m !== "object") {
    throw new AutoBackupError("bad_manifest", "the automatic copy's manifest is not an object");
  }
  if (m.v !== 1) {
    throw new AutoBackupError("unsupported_version", `automatic copy version ${m.v} is not supported`);
  }
  if (!Number.isInteger(m.size) || m.size < 0) {
    throw new AutoBackupError("bad_manifest", "the automatic copy has no valid size");
  }
  if (!Number.isInteger(m.chunkSize) || m.chunkSize <= 0) {
    throw new AutoBackupError("bad_manifest", "the automatic copy has no valid chunk size");
  }
  if (typeof m.digest !== "string" || !ID_RE.test(m.digest)) {
    throw new AutoBackupError("bad_manifest", "the automatic copy has no valid digest");
  }
  if (!Array.isArray(m.chunks) || !m.chunks.every((id) => ID_RE.test(String(id)))) {
    throw new AutoBackupError("bad_manifest", "the automatic copy lists an invalid block");
  }
  if (m.chunks.length !== Math.ceil(m.size / m.chunkSize)) {
    throw new AutoBackupError("bad_manifest", "the automatic copy's block list does not match its size");
  }
  return m;
}

async function openManifest(sealed, dek) {
  const plain = await decryptWithKey(sealed, dek);
  let parsed = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new AutoBackupError("bad_manifest", "the automatic copy's manifest is not valid JSON");
  }
  return checkManifest(parsed);
}

const findManifest = (files) => files.find((f) => f.name === MANIFEST_NAME) || null;

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Reads the manifest only. The Drive card uses this to show the latest copy
// without downloading a database to draw a row.
export async function autoBackupInfo({ storage, dek }) {
  if (!storage) throw new AutoBackupError("no_storage", "no storage to read from");
  if (!dek) throw new AutoBackupError("locked", "the vault is locked");
  const file = findManifest(await storage.list());
  if (!file) throw new AutoBackupError("no_manifest", "there is no automatic copy in this storage");
  return openManifest(await storage.get(file.id), dek);
}

// Writes one automatic copy, uploading only the blocks that changed. Returns a
// summary a caller can show: how many blocks were new, how many were already
// there, and how many bytes actually left the device.
export async function writeAutoBackup({
  storage, store, dek, deviceId = null, now = new Date(),
}) {
  // deviceId is accepted so a caller can use the same call shape as backupNow.
  // The automatic copy's manifest has a fixed shape and is shared by every
  // device pointed at the folder, so there is nothing device-specific to store.
  void deviceId;

  if (!storage) throw new AutoBackupError("no_storage", "no storage to write to");
  if (!store) throw new AutoBackupError("no_store", "no database to back up");
  if (!dek) throw new AutoBackupError("locked", "the vault is locked");

  const exported = store.exportBytes();
  const plain = exported instanceof Uint8Array ? exported : new Uint8Array(exported);
  if (!plain.length) throw new AutoBackupError("empty", "the local database is empty");

  const size = plain.length;
  const digest = toHex(await sha256(plain));
  const parts = splitBlocks(plain);
  const ids = [];
  for (const part of parts) ids.push(await blockId(dek, part));

  // One listing answers everything: which blocks are already in storage and
  // whether a manifest from an earlier run is waiting to be replaced.
  const files = await storage.list();
  const inStorage = new Set(
    files.filter((f) => BLOCK_RE.test(f.name)).map((f) => f.name));

  const manifestFile = findManifest(files);
  let previous = null;
  let previousSealed = null;
  if (manifestFile) {
    try {
      previousSealed = await storage.get(manifestFile.id);
      previous = await openManifest(previousSealed, dek);
    } catch {
      // A manifest from another vault, or one that is damaged, is no reason to
      // refuse to write a new copy. It only means this run cannot lean on it,
      // and must not delete blocks it cannot account for. The raw bytes are
      // kept so a failed commit can still put the old manifest back.
      previous = null;
    }
  }

  let uploaded = 0;
  let reused = 0;
  let bytesUploaded = 0;
  const fresh = [];                        // { id, fileId } for the verify pass

  for (let i = 0; i < parts.length; i++) {
    const id = ids[i];
    const name = blockName(id);
    // The name is the content. A file with this name already holds these exact
    // bytes, so there is nothing to send. The check is the listing, not the
    // previous manifest: a run interrupted before its manifest was committed
    // left blocks behind, and reusing them is better than uploading a second
    // copy under the same name.
    //
    // Repeated blocks inside one export (a run of blank SQLite pages, say)
    // share an id, so the first copy serves the rest of the run.
    if (inStorage.has(name)) {
      reused += 1;
      continue;
    }
    const sealed = await encryptWithKey(parts[i], dek);
    const file = await storage.put(name, sealed);
    bytesUploaded += sealed.length;
    uploaded += 1;
    inStorage.add(name);
    fresh.push({ id, fileId: file.id });
  }

  // Prove the new blocks before they become part of the committed copy. A
  // failed read here leaves the previous manifest and its blocks untouched.
  for (const { id, fileId } of fresh) {
    let back = null;
    try {
      back = await decryptWithKey(await storage.get(fileId), dek);
    } catch (e) {
      throw new AutoBackupError("verify_failed",
        `a new block could not be read back: ${e.message}`);
    }
    if (toHex(await hmacSha256(dek, back)) !== id) {
      throw new AutoBackupError("verify_failed", "a new block did not match its name");
    }
  }

  const manifest = {
    v: 1,
    size,
    digest,
    chunkSize: CHUNK_SIZE,
    chunks: ids,
    created: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const sealedManifest = await encryptWithKey(manifestBytes, dek);
  bytesUploaded += sealedManifest.length;

  // The commit point. Until this succeeds, the previous manifest still names a
  // complete set of blocks, so an interrupted run cannot break the copy.
  let manifestId = null;
  if (manifestFile) {
    await storage.update(manifestFile.id, sealedManifest);
    manifestId = manifestFile.id;
  } else {
    const made = await storage.put(MANIFEST_NAME, sealedManifest);
    manifestId = made.id;
  }

  try {
    const back = await decryptWithKey(await storage.get(manifestId), dek);
    if (!equalBytes(back, manifestBytes)) {
      throw new AutoBackupError("verify_failed", "the manifest did not read back unchanged");
    }
  } catch (e) {
    // Put the previous manifest back when we can. The blocks it names were
    // never touched, so the older copy stays restorable.
    if (previousSealed) {
      try { await storage.update(manifestId, previousSealed); } catch {}
    }
    throw e instanceof AutoBackupError ? e
      : new AutoBackupError("verify_failed", `the manifest could not be read back: ${e.message}`);
  }

  // Garbage collection, after the commit and never before it: remove the block
  // files from the starting listing that the new manifest no longer references.
  // Files that are not blocks — manual snapshots, the key file, anything the
  // user put there — are left alone. So is a block another writer added during
  // this run, because it was not in the listing we started from.
  //
  // An unreadable previous manifest means this folder may belong to another
  // vault whose blocks we cannot identify, so we do not collect at all.
  const keep = new Set(ids.map(blockName));
  let removed = 0;
  if (!manifestFile || previous) {
    for (const f of files) {
      if (!BLOCK_RE.test(f.name) || keep.has(f.name)) continue;
      try { await storage.remove(f.id); removed += 1; } catch {}
    }
  }

  return {
    uploaded, reused, bytesUploaded, manifest, digest, size,
    created: manifest.created, removed,
  };
}

// Downloads the automatic copy, checks every block against its name, and only
// then checks the size and digest of the whole database. A corrupt copy throws;
// it never returns bytes that look plausible.
export async function readAutoBackup({ storage, dek }) {
  if (!storage) throw new AutoBackupError("no_storage", "no storage to read from");
  if (!dek) throw new AutoBackupError("locked", "the vault is locked");

  const files = await storage.list();
  const file = findManifest(files);
  if (!file) throw new AutoBackupError("no_manifest", "there is no automatic copy in this storage");
  const manifest = await openManifest(await storage.get(file.id), dek);

  const byName = new Map(files.map((f) => [f.name, f]));
  const plain = new Uint8Array(manifest.size);
  let at = 0;
  for (const id of manifest.chunks) {
    const block = byName.get(blockName(id));
    if (!block) {
      throw new AutoBackupError("missing_block",
        "the automatic copy is incomplete: a block is missing");
    }
    let part = null;
    try {
      part = await decryptWithKey(await storage.get(block.id), dek);
    } catch (e) {
      throw new AutoBackupError("bad_block", `a block could not be opened: ${e.message}`);
    }
    if (toHex(await hmacSha256(dek, part)) !== id) {
      throw new AutoBackupError("bad_block", "a block does not match its name");
    }
    if (at + part.length > plain.length) {
      throw new AutoBackupError("size_mismatch", "the automatic copy is larger than its manifest says");
    }
    plain.set(part, at);
    at += part.length;
  }
  if (at !== manifest.size) {
    throw new AutoBackupError("size_mismatch", "the automatic copy is shorter than its manifest says");
  }
  if (toHex(await sha256(plain)) !== manifest.digest) {
    throw new AutoBackupError("digest_mismatch", "the automatic copy does not match its digest");
  }
  return { plain, manifest };
}

// Deletes the automatic copy and every block. The manifest goes first: a
// half-finished delete leaves orphan blocks, never a manifest that points at
// blocks that are gone. Manual snapshots are not touched.
export async function removeAutoBackup({ storage }) {
  if (!storage) throw new AutoBackupError("no_storage", "no storage to write to");
  const files = await storage.list();
  let removed = 0;
  const manifest = findManifest(files);
  if (manifest) {
    await storage.remove(manifest.id);
    removed += 1;
  }
  for (const f of files) {
    if (!BLOCK_RE.test(f.name)) continue;
    try { await storage.remove(f.id); removed += 1; } catch {}
  }
  return { removed };
}
