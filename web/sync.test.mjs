import test from "node:test";
import assert from "node:assert/strict";
import { makeOp, merge, reduce, pending, segment, opId } from "./sync.js";

test("the same op from two devices is applied once", () => {
  const o = makeOp("mac", 1, "account", "icici", "city", "Pune", 1000);
  assert.equal(merge([o], [o]).length, 1);
});

test("arrival order does not change the result", () => {
  const ops = [
    makeOp("mac", 1, "account", "a", "city", "Pune", 10),
    makeOp("phone", 1, "account", "a", "number", "1234", 20),
    makeOp("mac", 2, "position", "fd1", "value", 500000, 30),
  ];
  const a = reduce(ops);
  const b = reduce([...ops].reverse());
  assert.deepEqual(a, b);
});

test("concurrent edits to different fields both survive", () => {
  const mac = makeOp("mac", 1, "account", "a", "city", "Pune", 100);
  const phone = makeOp("phone", 1, "account", "a", "number", "9999", 100);
  assert.deepEqual(reduce([mac, phone])["account/a"], { city: "Pune", number: "9999" });
});

test("the same field resolves last-writer-wins", () => {
  const early = makeOp("mac", 1, "account", "a", "city", "Pune", 100);
  const late = makeOp("phone", 1, "account", "a", "city", "Mumbai", 200);
  assert.equal(reduce([early, late])["account/a"].city, "Mumbai");
});

test("a clock tie resolves by device, deterministically", () => {
  const mac = makeOp("mac", 1, "account", "a", "city", "Pune", 100);
  const phone = makeOp("phone", 1, "account", "a", "city", "Mumbai", 100);
  assert.equal(reduce([mac, phone])["account/a"].city, "Mumbai");
  assert.deepEqual(reduce([mac, phone]), reduce([phone, mac]));
});

test("re-merging a full history is idempotent", () => {
  const h = [makeOp("mac", 1, "account", "a", "city", "Pune", 10),
             makeOp("mac", 2, "account", "a", "city", "Mumbai", 20)];
  assert.deepEqual(reduce(h), reduce([...h, ...h, ...h]));
});

test("only ops the remote lacks are offered for upload", () => {
  const local = [makeOp("mac", 1, "a", "1", "x", 1, 10), makeOp("mac", 2, "a", "1", "x", 2, 20)];
  assert.equal(pending(local, [opId(local[0])]).length, 1);
});

test("a segment carries exactly the unsynced ops for that device", () => {
  const ops = [makeOp("mac", 1, "a", "1", "x", 1, 10), makeOp("mac", 2, "a", "1", "x", 2, 20),
               makeOp("phone", 1, "a", "1", "x", 3, 30)];
  const seg = segment("mac", 1, ops);
  assert.equal(seg.ops.length, 1);
  assert.equal(seg.to, 2);
});

import { reduceDetailed, nextLamport, compact, segmentName, parseSegmentName, syncOnce } from "./sync.js";
import { memoryStorage } from "./storage.js";

test("edits from two devices to different rows both survive", () => {
  const mac = makeOp("mac", 1, "account", "a", "city", "Pune", 10);
  const phone = makeOp("phone", 1, "account", "b", "city", "Mumbai", 11);
  assert.deepEqual(reduce([mac, phone]), { "account/a": { city: "Pune" },
                                           "account/b": { city: "Mumbai" } });
});

test("two devices setting the same money field produce a conflict, not a silent overwrite", () => {
  const mac = makeOp("mac", 1, "fact", "9", "amount", -1000, 10);
  const phone = makeOp("phone", 1, "fact", "9", "amount", -2000, 20);
  const { state, conflicts } = reduceDetailed([mac, phone]);
  assert.equal(state["fact/9"].amount, -1000);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kept, -1000);
  assert.equal(conflicts[0].rejected, -2000);
});

test("a non-money field resolves last writer wins", () => {
  const a = makeOp("mac", 1, "account", "a", "city", "Pune", 10);
  const b = makeOp("phone", 1, "account", "a", "city", "Mumbai", 20);
  assert.equal(reduce([a, b])["account/a"].city, "Mumbai");
  assert.equal(reduceDetailed([a, b]).conflicts.length, 0);
});

test("append-only transactions from both devices coexist", () => {
  const a = makeOp("mac", 1, "fact", "1", "amount", -500, 10);
  const b = makeOp("phone", 1, "fact", "2", "amount", -700, 11);
  assert.deepEqual(Object.keys(reduce([a, b])).sort(), ["fact/1", "fact/2"]);
});

test("a tombstone removes a row and cannot be resurrected by a replay", () => {
  const add = makeOp("mac", 1, "account", "a", "city", "Pune", 10);
  const del = makeOp("mac", 2, "account", "a", "city", null, 20, { deleted: true });
  assert.deepEqual(reduce([add, del, add]), {});
});

test("compaction keeps tombstones", () => {
  const add = makeOp("mac", 1, "a", "1", "x", 1, 10);
  const del = makeOp("mac", 2, "a", "1", "x", null, 20, { deleted: true });
  const later = makeOp("mac", 3, "a", "2", "x", 2, 30);
  const kept = compact([add, del, later], 25);
  assert.ok(kept.some((o) => o.deleted));
  assert.ok(kept.some((o) => o.lamport === 30));
  assert.ok(!kept.some((o) => o.lamport === 10));
});

test("lamport clock never goes backwards", () => {
  assert.equal(nextLamport(100, 50), 101);
  assert.equal(nextLamport(100, 500), 500);
});

test("segment names round trip", () => {
  const name = segmentName("mac-1", 3, 9);
  assert.deepEqual(parseSegmentName(name), { device: "mac-1", from: 3, to: 9 });
});

test("two devices converge through a shared storage adapter", async () => {
  const store = memoryStorage();
  const aOps = [makeOp("mac", 1, "account", "a", "city", "Pune", 10)];
  const bOps = [makeOp("phone", 1, "account", "a", "nominee", "mom", 11)];
  const seenA = [], seenB = [];
  await syncOnce({ storage: store, device: "mac", ops: aOps,
                   loadRemote: () => [], apply: (o) => { seenA.push(...o); return o.length; } });
  await syncOnce({ storage: store, device: "phone", ops: bOps,
                   loadRemote: () => [], apply: (o) => { seenB.push(...o); return o.length; } });
  await syncOnce({ storage: store, device: "mac", ops: aOps, apply: (o) => { seenA.push(...o); return o.length; } });
  const merged = reduce([...aOps, ...bOps]);
  assert.deepEqual(merged["account/a"], { city: "Pune", nominee: "mom" });
  assert.equal(seenB.length, 1);
});
