import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEEP_DEFAULT, clampKeep, readKeep, keysToPrune, selectedKeys,
  allSelected, toggleKey, deletableKeys } from "./snapshots.js";

const list = [{ key: "s4" }, { key: "s3" }, { key: "s2" }, { key: "s1" }];

test("an unset or unknown limit falls back to twelve", () => {
  assert.equal(clampKeep(null), KEEP_DEFAULT);
  assert.equal(clampKeep(""), KEEP_DEFAULT);
  assert.equal(clampKeep("99"), KEEP_DEFAULT);
  assert.equal(clampKeep(undefined), KEEP_DEFAULT);
});

test("only the offered limits are accepted", () => {
  assert.equal(clampKeep(3), 3);
  assert.equal(clampKeep("4"), 4);
  assert.equal(clampKeep(24), 24);
});

test("the stored limit is read, and a blocked storage falls back", () => {
  const store = { getItem: (k) => (k === "bp.snapshots.keep" ? "4" : null) };
  assert.equal(readKeep(store), 4);
  const blocked = { getItem: () => { throw new Error("denied"); } };
  assert.equal(readKeep(blocked), KEEP_DEFAULT);
  assert.equal(readKeep(null), KEEP_DEFAULT);
});

test("pruning keeps the newest and names the rest", () => {
  assert.deepEqual(keysToPrune(list, 3), ["s1"]);
  assert.deepEqual(keysToPrune(list, 12), []);
  assert.deepEqual(keysToPrune([], 3), []);
});

test("a limit that is not offered falls back instead of cutting to one", () => {
  assert.deepEqual(keysToPrune(list, 99), []);
  assert.deepEqual(keysToPrune(list, 1), []);
  assert.deepEqual(keysToPrune(list, 3), [{ key: "s1" }].map((x) => x.key));
});

test("a stale selection cannot delete a key that is gone", () => {
  assert.deepEqual(selectedKeys(list, new Set(["s2", "gone"])), ["s2"]);
});

test("select all needs every row and at least one row", () => {
  assert.equal(allSelected(list, new Set(["s1", "s2", "s3", "s4"])), true);
  assert.equal(allSelected(list, new Set(["s1"])), false);
  assert.equal(allSelected([], new Set()), false);
});

test("toggling returns a new set and does not mutate the old one", () => {
  const before = new Set(["a"]);
  const after = toggleKey(before, "b");
  assert.deepEqual([...after].sort(), ["a", "b"]);
  assert.deepEqual([...before], ["a"]);
  assert.deepEqual([...toggleKey(after, "a")].sort(), ["b"]);
});

test("a partial selection deletes only what was picked", () => {
  const res = deletableKeys(list, new Set(["s2", "s4"]));
  assert.deepEqual(res.keys.sort(), ["s2", "s4"]);
  assert.equal(res.kept, "");
});

test("selecting everything still keeps the newest snapshot", () => {
  const res = deletableKeys(list, new Set(["s1", "s2", "s3", "s4"]));
  assert.deepEqual(res.keys.sort(), ["s1", "s2", "s3"]);
  assert.equal(res.kept, "s4");
});

test("a single snapshot is never deleted by a bulk action", () => {
  const one = [{ key: "only" }];
  const res = deletableKeys(one, new Set(["only"]));
  assert.deepEqual(res.keys, []);
  assert.equal(res.kept, "only");
});

test("a selection with nothing in it deletes nothing", () => {
  const res = deletableKeys(list, new Set());
  assert.deepEqual(res.keys, []);
  assert.equal(res.kept, "");
});

// The live database and the versions live in the same object store, so the only
// thing separating them is the key. If these two ever overlap, a bulk delete
// could reach the database the app is running on.
test("the live database key can never look like a snapshot", () => {
  const src = readFileSync(new URL("./db.js", import.meta.url), "utf8");
  const dbKey = (src.match(/const DB_KEY = "([^"]+)"/) || [])[1];
  const prefix = (src.match(/const SNAPSHOT_PREFIX = "([^"]+)"/) || [])[1];
  assert.equal(dbKey, "bankpipe.db.v1");
  assert.equal(prefix, "snapshot.");
  assert.equal(dbKey.startsWith(prefix), false);
});
