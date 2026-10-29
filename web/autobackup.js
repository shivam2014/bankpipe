// A copy of the database in Drive, refreshed after changes.
//
// One automatic copy is kept, not a version per edit. It is stored as fixed
// 64 KiB blocks named by their MAC, plus a manifest, so a run after a small
// edit uploads a couple of blocks instead of the whole database. The manifest
// is committed before any old block is removed. Manual versions ("Back up
// now") are untouched, so a busy day cannot push the 14-day history out of the
// folder.
//
// It is off until the user turns it on, and it never prompts: without a Drive
// connection, a database passphrase or a key, it simply does nothing.

import { ensureVaultKey, readVaultKey } from "./backup.js";
import { writeAutoBackup } from "./blockbackup.js";
import {
  createVault, openVault, changePassphrase, KEY_FILE_RE,
} from "./vault.js";
import { getToken } from "./drive.js";
import { driveStorage } from "./storage.js";
import { getDbPassphrase, currentStore, onDbSaved } from "./db.js";
import { sha256, toHex } from "./crypto.js";

const ENABLED = "bankpipe.autobackup";
const LAST = "bankpipe.autobackup.last";
const ERROR = "bankpipe.autobackup.error";
const DIGEST = "bankpipe.autobackup.digest";
const BYTES = "bankpipe.autobackup.bytes";
const DEVICE = "bankpipe.device";
const DELAY = 5 * 60_000;

let storage = null;
let tokenExpiry = 0;
let dek = null;
let keyFile = null;
let timer = null;
let running = false;
let started = false;

const read = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key, value) => {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {}
};

export const autoBackupOn = () => read(ENABLED) === "1";
export const lastAutoBackup = () => Number(read(LAST) || 0);
export const autoBackupError = () => read(ERROR) || "";
// Ciphertext uploaded by the last run, manifest included. Shown in the Drive
// card so the saving is visible instead of only claimed.
export const lastAutoBackupBytes = () => Number(read(BYTES) || 0);

export function setAutoBackup(on) {
  write(ENABLED, on ? "1" : null);
  if (!on) write(ERROR, null);
}

// The automatic copy was deleted; forget the shortcut that would otherwise skip
// the next upload because the bytes are unchanged.
export function forgetAutoCopy() {
  write(DIGEST, null);
  write(LAST, null);
  write(BYTES, null);
  write("bankpipe.autobackup.file", null);  // left behind by older versions
}

function deviceId() {
  let id = read(DEVICE);
  if (!id) {
    id = Math.random().toString(36).slice(2, 6).toUpperCase();
    write(DEVICE, id);
  }
  return id;
}

async function ensureStorage() {
  if (storage && Date.now() < tokenExpiry) return storage;
  const fresh = await getToken();
  storage = driveStorage({ token: fresh.token });
  tokenExpiry = Date.now() + Math.max(0, (fresh.expiresIn || 0) - 60) * 1000;
  return storage;
}

async function ensureKey() {
  if (dek) return;
  const pass = getDbPassphrase();
  if (!pass) throw new Error("unlock the database first");
  const s = await ensureStorage();
  const existing = await readVaultKey({ storage: s });
  if (existing) {
    dek = (await openVault(existing.bytes, pass)).dek;
    keyFile = null;
  } else {
    const v = await createVault(pass);
    dek = v.dek;
    keyFile = v.keyFile;
  }
}

export async function runAutoBackup({ force = false } = {}) {
  if (running) return { skipped: "busy" };
  running = true;
  try {
    const store = currentStore();
    if (!store) throw new Error("the database is locked");
    const plain = store.exportBytes();
    if (!plain.length) throw new Error("the database is empty");
    const digest = toHex(await sha256(plain));
    if (!force && digest === read(DIGEST)) return { skipped: "unchanged" };

    const s = await ensureStorage();
    await ensureKey();
    // The key file is written once, on the first automatic run, and never
    // touched again. Manual backups own it after that.
    if (keyFile) {
      await ensureVaultKey({ storage: s, keyFile, name: "vault-key-0001.bpk" });
      keyFile = null;
    }
    const res = await writeAutoBackup({
      storage: s, store, dek, deviceId: deviceId(),
    });

    write(DIGEST, digest);
    write(LAST, Date.now());
    write(BYTES, res.bytesUploaded);
    write(ERROR, null);
    return res;
  } catch (e) {
    write(ERROR, String((e && e.message) || e));
    throw e;
  } finally {
    running = false;
  }
}

export function scheduleAutoBackup() {
  if (!autoBackupOn()) return;
  if (read("bp.mode") !== "real") return;
  clearTimeout(timer);
  timer = setTimeout(() => { runAutoBackup().catch(() => {}); }, DELAY);
}

// Called once per app session, after the database is unlocked.
export function startAutoBackup() {
  if (started) return;
  started = true;
  onDbSaved(() => scheduleAutoBackup());
  if (autoBackupOn() && read("bp.mode") === "real") scheduleAutoBackup();
}

// The database passphrase changed. The Drive key file is sealed with it, so
// re-seal the same data key under the new passphrase and remove the old file.
// Best-effort: not being connected must not block the database change.
export async function rekeyBackup(oldPass, next) {
  if (!oldPass || !next) return false;
  try {
    const s = await ensureStorage();
    const keys = (await s.list())
      .filter((f) => KEY_FILE_RE.test(f.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!keys.length) return false;
    const current = keys[0];               // readVaultKey uses the lowest name
    const { keyFile: bytes } = await changePassphrase(await s.get(current.id), oldPass, next);
    // Same file, same name, new seal. A failure leaves the old file intact.
    await s.update(current.id, bytes);
    dek = null;                            // the next run unlocks with the new passphrase
    keyFile = null;
    return true;
  } catch {
    return false;
  }
}
