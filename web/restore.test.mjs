import test from "node:test";
import assert from "node:assert/strict";
import { vaultDestination } from "./restore.js";

test("an existing vault opens the restore door", () => {
  assert.equal(vaultDestination({ ok: true, hasKey: true, snapshots: 3 }), "/backup?restore=1");
});

test("no vault opens the create door", () => {
  assert.equal(vaultDestination({ ok: true, hasKey: false, snapshots: 0 }), "/backup?create=1");
});

test("a probe failure falls back to the plain page rather than guessing", () => {
  assert.equal(vaultDestination({ ok: false, error: "reconnect_required" }), "/backup");
  assert.equal(vaultDestination(null), "/backup");
});

test("a key with no snapshots still counts as an existing vault", () => {
  // The key is the thing that must not be replaced; snapshots can be rebuilt.
  assert.equal(vaultDestination({ ok: true, hasKey: true, snapshots: 0 }), "/backup?restore=1");
});
