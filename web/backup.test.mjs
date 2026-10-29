import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeStore } from "./db.js";
import { memoryStorage } from "./storage.js";
import { createVault, openVault } from "./vault.js";
import { encryptWithKey } from "./crypto.js";
import {
  backupNow, restoreNow, inspectSnapshot, listSnapshots, readVaultKey,
  ensureVaultKey, planPrune, lineage, snapshotName, parseSnapshotName, VerifyFailed,
  snapshotName as snapName,
} from "./backup.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("./vendor/sql-wasm.js");
const SQL = await initSqlJs({
  locateFile: (f) => new URL(`./vendor/${f}`, import.meta.url).pathname,
});

const PASS = "a long family passphrase";
const FAST = { iterations: 10_000 };

const rows = [
  { date: "2024-04-02", amount: 149525, balance: 12149525, description: "ZZMARKERZZ" },
  { date: "2024-04-03", amount: -120000, balance: 12029525, description: "UPI MERCHANT" },
  { date: "2024-04-04", amount: -50000, balance: 11979525, description: "ATM" },
];

async function seededStore(account = "hdfc-dad") {
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows(account, rows);
  return store;
}

async function vault() {
  const v = await createVault(PASS, { label: "dad", ...FAST });
  return v;
}

const base = (v, storage, over = {}) => ({
  store: over.store, dek: v.dek, deviceId: "mac1", storage,
  keyFile: v.keyFile, keyName: v.name, now: new Date("2026-10-21T06:00:00Z"),
  ...over,
});

test("a backup uploads the key file and one snapshot, then proves it can be read back", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();

  const res = await backupNow(base(v, storage, { store }));

  assert.equal(res.verified, true);
  assert.equal(res.keyState.uploaded, true);
  assert.match(res.name, /^bankpipe-2026-10-21T060000Z-mac1\.bpdb$/);
  const names = (await storage.list()).map((f) => f.name).sort();
  assert.deepEqual(names, ["bankpipe-2026-10-21T060000Z-mac1.bpdb", "vault-key-0001.bpk"]);
});

test("a snapshot is compressed before it is encrypted", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = makeStore(SQL, null);
  await store.open();
  store.importRows("acct", Array.from({ length: 2000 }, (_, i) => ({
    date: "2024-04-02", amount: -100, balance: 1000000 - i,
    description: "UPI MERCHANT SAME TEXT EVERY ROW",
  })));

  const res = await backupNow(base(v, storage, { store }));
  assert.ok(res.cipherBytes < res.plainBytes,
    `compressed ${res.cipherBytes} should be smaller than ${res.plainBytes}`);
  assert.equal(res.verified, true);
});

test("a snapshot written before compression still opens", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();
  const plain = store.exportBytes();
  const old = await encryptWithKey(plain, v.dek);
  const put = await storage.put(snapshotName(new Date("2026-10-20T06:00:00Z"), "mac1"), old);
  const seen = await inspectSnapshot({ storage, fileId: put.id, dek: v.dek, SQLlib: SQL });
  assert.equal(seen.ok, true);
  assert.deepEqual([...seen.plain.subarray(0, 16)], [...plain.subarray(0, 16)]);
});

test("the snapshot on the remote is ciphertext in the keyed format", async () => {  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();
  const res = await backupNow(base(v, storage, { store }));

  const remote = await storage.get(res.file.id);
  const text = new TextDecoder("latin1").decode(remote);
  assert.equal(new TextDecoder().decode(remote.slice(0, 4)), "BPK2");
  assert.equal(text.includes("SQLite format 3"), false);
  assert.equal(text.includes("ZZMARKERZZ"), false);
});

test("a second backup reuses the existing key file instead of duplicating it", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();

  await backupNow(base(v, storage, { store, now: new Date("2026-10-21T06:00:00Z") }));
  const two = await backupNow(base(v, storage, { store, now: new Date("2026-10-21T07:00:00Z") }));

  assert.equal(two.keyState.uploaded, false);
  const keys = (await storage.list()).filter((f) => f.name.startsWith("vault-key-"));
  assert.equal(keys.length, 1);
});

test("backing up twice creates two snapshots and keeps the first readable", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();

  const one = await backupNow(base(v, storage, { store, now: new Date("2026-10-21T06:00:00Z") }));
  await backupNow(base(v, storage, { store, now: new Date("2026-10-21T07:00:00Z") }));

  const snaps = await listSnapshots({ storage });
  assert.equal(snaps.length, 2);
  const seen = await inspectSnapshot({ storage, fileId: one.file.id, dek: v.dek, SQLlib: SQL });
  assert.equal(seen.ok, true);
});

test("two devices backing up at once both keep their data", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const a = await seededStore("hdfc-dad");
  const b = await seededStore("icici-mom");

  await backupNow(base(v, storage, { store: a, deviceId: "mac1", now: new Date("2026-10-21T06:00:00Z") }));
  await backupNow(base(v, storage, { store: b, deviceId: "win1", now: new Date("2026-10-21T06:00:05Z") }));

  const snaps = await listSnapshots({ storage });
  assert.equal(snaps.length, 2);
  assert.deepEqual(new Set(snaps.map((s) => s.parsed.device)), new Set(["mac1", "win1"]));
});

test("a new device can bootstrap from the folder: key file, passphrase, restore", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const source = await seededStore();
  const made = await backupNow(base(v, storage, { store: source }));

  // What a fresh device has: the folder, and a passphrase the user types.
  const key = await readVaultKey({ storage });
  assert.ok(key, "the key file is in the folder");
  const opened = await openVault(key.bytes, PASS);
  assert.equal(opened.fingerprint, v.fingerprint);

  const target = makeStore(SQL, null);
  await target.open();
  const out = await restoreNow({ store: target, storage, fileId: made.file.id, dek: opened.dek, SQLlib: SQL });

  assert.equal(out.ok, true);
  assert.equal(out.facts, 3);
  assert.equal(target.summary().facts, 3);
  assert.equal(target.heldRows("hdfc-dad")[0].date, "2024-04-02");
});

test("restore refuses to replace a device that already holds transactions", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const source = await seededStore();
  const made = await backupNow(base(v, storage, { store: source }));

  const target = await seededStore("other-bank");
  await assert.rejects(
    () => restoreNow({ store: target, storage, fileId: made.file.id, dek: v.dek, SQLlib: SQL }),
    (e) => e.code === "not_empty");
  assert.ok(target.summary().facts >= 3);
});

test("a corrupted snapshot fails verification at upload time", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();

  const realPut = storage.put.bind(storage);
  storage.put = async (name, bytes) => {
    const put = await realPut(name, bytes);
    if (name.endsWith(".bpdb")) {
      const rec = storage._files.get(put.id);
      rec.bytes[rec.bytes.length - 1] ^= 0xff;
    }
    return put;
  };

  await assert.rejects(
    () => backupNow(base(v, storage, { store })),
    (e) => e instanceof VerifyFailed);
});

test("a snapshot from another vault is rejected, and nothing is written locally", async () => {
  const mine = await vault();
  const theirs = await vault();
  const storage = memoryStorage();
  const store = await seededStore();
  const made = await backupNow(base(mine, storage, { store }));

  const target = makeStore(SQL, null);
  await target.open();
  await assert.rejects(
    () => restoreNow({ store: target, storage, fileId: made.file.id, dek: theirs.dek, SQLlib: SQL }),
    (e) => e.code === "wrong_vault");
  assert.equal(target.summary().facts, 0);
});

test("the restore drill reads and verifies without adopting", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const source = await seededStore();
  const made = await backupNow(base(v, storage, { store: source }));

  const target = makeStore(SQL, null);
  await target.open();
  const drill = await inspectSnapshot({ storage, fileId: made.file.id, dek: v.dek, SQLlib: SQL });

  assert.equal(drill.ok, true);
  assert.equal(drill.facts, 3);
  assert.equal(drill.accounts, 1);
  assert.equal(target.summary().facts, 0);
});

test("a database with no transactions still produces a restorable snapshot", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = makeStore(SQL, null);
  await store.open();

  const made = await backupNow(base(v, storage, { store }));
  const seen = await inspectSnapshot({ storage, fileId: made.file.id, dek: v.dek, SQLlib: SQL });
  assert.equal(seen.ok, true);
  assert.equal(seen.facts, 0);
});

test("a locked vault cannot start a backup", async () => {
  const storage = memoryStorage();
  const store = await seededStore();
  await assert.rejects(
    () => backupNow({ store, dek: null, deviceId: "mac1", storage }),
    /locked/);
});

test("pruning keeps 14 daily snapshots plus one per older month", () => {
  const files = [];
  for (let d = 1; d <= 20; d++) {
    files.push({ id: `d${d}`, name: `bankpipe-2026-10-${String(d).padStart(2, "0")}T060000Z-mac1.bpdb` });
  }
  for (let m = 1; m <= 9; m++) {
    files.push({ id: `m${m}`, name: `bankpipe-2026-0${m}-01T060000Z-mac1.bpdb` });
  }
  const drop = planPrune(files, { keepDaily: 14, keepMonthly: 12 });
  const kept = files.filter((f) => !drop.includes(f.id)).map((f) => f.id);

  assert.equal(kept.length, 23);
  assert.ok(kept.includes("d20"));
  assert.ok(kept.includes("d7"));
  assert.equal(kept.includes("d6"), false, "October is already covered by the daily window");
  assert.ok(kept.includes("m9"));
  assert.ok(kept.includes("m1"));
  assert.deepEqual(drop.sort(), ["d1", "d2", "d3", "d4", "d5", "d6"]);
});

test("a kept snapshot survives pruning and does not use a daily slot", () => {
  const files = [];
  for (let d = 1; d <= 20; d++) {
    files.push({ id: `d${d}`, name: `bankpipe-2026-10-${String(d).padStart(2, "0")}T060000Z-mac1.bpdb` });
  }
  const drop = planPrune(files, { keepDaily: 14, keepMonthly: 0, pins: ["d5"] });

  assert.equal(drop.includes("d5"), false, "a kept snapshot is never pruned");
  assert.equal(files.filter((f) => !drop.includes(f.id)).length, 15,
    "the kept file is extra, not a replacement for one in the daily window");
  assert.ok(drop.includes("d6"), "the window still starts at the newest 14");
});

test("the key file and any unknown file are never pruned", async () => {
  const v = await vault();
  const storage = memoryStorage();
  const store = await seededStore();
  await ensureVaultKey({ storage, keyFile: v.keyFile, name: v.name });
  await storage.put("notes.txt", new Uint8Array([1, 2, 3]));

  await backupNow(base(v, storage, { store, keepDaily: 0, keepMonthly: 0 }));

  const names = (await storage.list()).map((f) => f.name);
  assert.ok(names.includes("vault-key-0001.bpk"), "the key file survives an aggressive prune");
  assert.ok(names.includes("notes.txt"), "a file we did not write is left alone");
});

test("lineage says when another device wrote more recently", () => {
  const snaps = [
    { parsed: { at: new Date("2026-10-21T09:00:00Z"), device: "win1" } },
    { parsed: { at: new Date("2026-10-21T08:00:00Z"), device: "mac1" } },
  ];
  const foreign = lineage({ snapshots: snaps, deviceId: "mac1", lastBackupAt: Date.parse("2026-10-21T08:00:00Z") });
  assert.equal(foreign.foreign, true);
  assert.equal(foreign.device, "win1");

  const mine = lineage({ snapshots: snaps, deviceId: "win1", lastBackupAt: 0 });
  assert.equal(mine.foreign, false, "our own snapshot is not foreign");

  const empty = lineage({ snapshots: [], deviceId: "mac1" });
  assert.equal(empty.foreign, false);
  assert.equal(empty.newest, null);
});

test("snapshot names sort by time and parse back", () => {
  const a = snapName(new Date("2026-10-21T06:00:00Z"), "mac1");
  const b = snapName(new Date("2026-10-21T07:00:00Z"), "mac1");
  assert.ok(a < b);
  assert.equal(parseSnapshotName(b).iso, "2026-10-21T07:00:00Z");
  assert.equal(parseSnapshotName(b).device, "mac1");
  assert.equal(parseSnapshotName("bankpipe-nope.bpdb"), null);
  assert.equal(parseSnapshotName("vault-key-0001.bpk"), null);
});
