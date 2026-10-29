import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage.js";
import { acquireLease, renewLease, releaseLease, readLease, canEdit,
         leaseValid, makeLease, DEFAULT_LEASE_MS } from "./sync.js";

const T0 = 1_000_000;

test("the first device gets the lease", async () => {
  const s = memoryStorage();
  const res = await acquireLease(s, "mac", T0);
  assert.equal(res.granted, true);
  assert.equal((await readLease(s)).device, "mac");
});

test("a second device is refused while the lease is valid", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0);
  const res = await acquireLease(s, "phone", T0 + 1000);
  assert.equal(res.granted, false);
  assert.equal(res.holder, "mac");
});

test("the same device can re-acquire and extend", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0);
  const res = await acquireLease(s, "mac", T0 + 2000);
  assert.equal(res.granted, true);
  assert.equal((await readLease(s)).expires, T0 + 2000 + DEFAULT_LEASE_MS);
});

test("an expired lease can be taken over", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0, 1000);
  const res = await acquireLease(s, "phone", T0 + 5000);
  assert.equal(res.granted, true);
  assert.equal((await readLease(s)).device, "phone");
});

test("renewal by the holder extends it", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0, 1000);
  const res = await renewLease(s, "mac", T0 + 500, 1000);
  assert.equal(res.renewed, true);
  assert.equal(leaseValid(await readLease(s), T0 + 1200), true);
});

test("renewal by a non-holder is refused", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0, 1000);
  const res = await renewLease(s, "phone", T0 + 100, 1000);
  assert.equal(res.renewed, false);
});

test("release only works for the holder", async () => {
  const s = memoryStorage();
  await acquireLease(s, "mac", T0);
  assert.equal(await releaseLease(s, "phone"), false);
  assert.equal(await releaseLease(s, "mac"), true);
  assert.equal(await readLease(s), null);
});

test("canEdit is true when the lease is free, or yours, or expired", () => {
  const lease = makeLease("mac", T0, 1000);
  assert.equal(canEdit("phone", null, T0), true);
  assert.equal(canEdit("mac", lease, T0 + 10), true);
  assert.equal(canEdit("phone", lease, T0 + 10), false);
  assert.equal(canEdit("phone", lease, T0 + 5000), true);
});
