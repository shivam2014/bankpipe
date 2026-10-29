import test from "node:test";
import assert from "node:assert/strict";

// The module only touches localStorage through getItem/setItem/removeItem.
// Node has no localStorage, so give it the smallest one that behaves.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const m = await import("./autobackup.js");

test("automatic backup is off until it is turned on", () => {
  store.clear();
  assert.equal(m.autoBackupOn(), false);
  m.setAutoBackup(true);
  assert.equal(m.autoBackupOn(), true);
  assert.equal(m.lastAutoBackupBytes(), 0);
  m.setAutoBackup(false);
  assert.equal(m.autoBackupOn(), false);
});

test("turning it off clears a previous failure", () => {
  store.clear();
  store.set("bankpipe.autobackup.error", "drive 403");
  assert.equal(m.autoBackupError(), "drive 403");
  m.setAutoBackup(false);
  assert.equal(m.autoBackupError(), "");
});

test("the last-copy time reads as a number", () => {
  store.clear();
  assert.equal(m.lastAutoBackup(), 0);
  store.set("bankpipe.autobackup.last", "1700000000000");
  assert.equal(m.lastAutoBackup(), 1700000000000);
});

test("deleting the copy forgets the digest, the time and the last upload size", () => {
  store.clear();
  store.set("bankpipe.autobackup.digest", "abc");
  store.set("bankpipe.autobackup.last", "1700000000000");
  store.set("bankpipe.autobackup.bytes", "4096");
  store.set("bankpipe.autobackup.file", "old-file-id");
  m.forgetAutoCopy();
  assert.equal(store.has("bankpipe.autobackup.digest"), false);
  assert.equal(store.has("bankpipe.autobackup.last"), false);
  assert.equal(store.has("bankpipe.autobackup.bytes"), false);
  assert.equal(store.has("bankpipe.autobackup.file"), false);
});
