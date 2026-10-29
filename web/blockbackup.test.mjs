import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "./storage.js";
import { randomBytes, DEK_BYTES, sha256, toHex } from "./crypto.js";
import {
  writeAutoBackup, readAutoBackup, autoBackupInfo, removeAutoBackup,
  CHUNK_SIZE, MANIFEST_NAME, blockName,
} from "./blockbackup.js";

// Deterministic bytes, so a block id is stable across runs and a "one byte
// changed" test really changes one byte. Real SQLite pages look nothing like
// this, but the block layer never looks inside a block.
function synthetic(n, seed = 7) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const fakeStore = (bytes) => ({ exportBytes: () => bytes });

const BLOCK_NAME_RE = /^block-[0-9a-f]{64}\.bpblk$/;

// Counts what crosses the wire, not just what the module says it did. Reads
// matter too: the manifest lookup must not drag every block down.
function counting(inner) {
  const stats = { puts: 0, updates: 0, gets: 0, removes: 0, bytes: 0, blockPuts: 0 };
  return {
    stats,
    describe: () => inner.describe(),
    async list() { return inner.list(); },
    async get(id) { stats.gets += 1; return inner.get(id); },
    async remove(id) { stats.removes += 1; return inner.remove(id); },
    async put(name, bytes) {
      stats.puts += 1;
      stats.bytes += bytes.length;
      if (BLOCK_NAME_RE.test(name)) stats.blockPuts += 1;
      return inner.put(name, bytes);
    },
    async update(id, bytes) {
      stats.updates += 1;
      stats.bytes += bytes.length;
      return inner.update(id, bytes);
    },
  };
}

test("the first write uploads every block and the manifest, and reads back byte for byte", async (t) => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(1024 * 1024);
  const storage = counting(memoryStorage());

  const res = await writeAutoBackup({ storage, store: fakeStore(data), dek, deviceId: "mac1" });

  assert.equal(res.size, data.length);
  assert.equal(res.digest, toHex(await sha256(data)));
  assert.equal(res.uploaded, 16);
  assert.equal(res.reused, 0);
  assert.equal(res.removed, 0);
  assert.equal(res.manifest.v, 1);
  assert.equal(res.manifest.size, data.length);
  assert.equal(res.manifest.chunkSize, CHUNK_SIZE);
  assert.equal(res.manifest.chunks.length, 16);
  assert.deepEqual(Object.keys(res.manifest).sort(),
    ["chunkSize", "chunks", "created", "digest", "size", "v"]);
  assert.equal(res.created, res.manifest.created);

  const files = await storage.list();
  const names = files.map((f) => f.name).sort();
  assert.equal(names.length, 17);
  assert.ok(names.includes(MANIFEST_NAME));
  assert.equal(names.filter((n) => BLOCK_NAME_RE.test(n)).length, 16);
  assert.equal(storage.stats.blockPuts, 16);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(data));
  assert.equal(read.manifest.digest, res.digest);

  t.diagnostic(`first 1 MB write uploaded ${res.bytesUploaded} bytes `
    + `(${res.uploaded} blocks + manifest)`);
});

test("a one-byte change uploads at most two blocks", async (t) => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(1024 * 1024);
  const storage = counting(memoryStorage());
  const first = await writeAutoBackup({ storage, store: fakeStore(data), dek });

  const changed = new Uint8Array(data);
  changed[5 * CHUNK_SIZE + 100] ^= 0xff;
  storage.stats.bytes = 0;
  storage.stats.blockPuts = 0;
  storage.stats.gets = 0;
  const res = await writeAutoBackup({ storage, store: fakeStore(changed), dek });

  assert.ok(storage.stats.gets <= 4, "unchanged blocks are not downloaded to compare");
  assert.ok(res.uploaded <= 2, `uploaded ${res.uploaded} blocks for a one-byte change`);
  assert.equal(res.uploaded, 1);
  assert.equal(res.reused, first.manifest.chunks.length - 1);
  assert.equal(storage.stats.blockPuts, 1);
  assert.ok(res.bytesUploaded < 2 * CHUNK_SIZE + 64 * 1024,
    `uploaded ${res.bytesUploaded} bytes`);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(changed));

  t.diagnostic(`one-byte change in 1 MB uploaded ${res.bytesUploaded} bytes`);
});

test("an unchanged write uploads no blocks", async (t) => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(400 * 1024);
  const storage = counting(memoryStorage());
  await writeAutoBackup({ storage, store: fakeStore(data), dek });

  storage.stats.blockPuts = 0;
  storage.stats.bytes = 0;
  storage.stats.gets = 0;
  const res = await writeAutoBackup({ storage, store: fakeStore(data), dek });

  assert.ok(storage.stats.gets <= 2, "an unchanged write reads the manifest, not the blocks");
  assert.equal(res.uploaded, 0);
  assert.equal(res.reused, Math.ceil(data.length / CHUNK_SIZE));
  assert.equal(storage.stats.blockPuts, 0);
  assert.ok(res.bytesUploaded < CHUNK_SIZE, "only the manifest should be written");
  t.diagnostic(`unchanged write uploaded ${res.bytesUploaded} bytes (manifest only)`);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(data));
});

test("repeated blocks inside one database are stored once", async () => {
  const dek = randomBytes(DEK_BYTES);
  const block = synthetic(CHUNK_SIZE, 3);
  const data = new Uint8Array(CHUNK_SIZE * 3);
  data.set(block, 0);
  data.set(block, CHUNK_SIZE);
  data.set(block, CHUNK_SIZE * 2);

  const storage = memoryStorage();
  const res = await writeAutoBackup({ storage, store: fakeStore(data), dek });

  assert.equal(res.manifest.chunks.length, 3);
  assert.equal(new Set(res.manifest.chunks).size, 1);
  assert.equal(res.uploaded, 1);
  assert.equal(res.reused, 2);
  const blocks = (await storage.list()).filter((f) => BLOCK_NAME_RE.test(f.name));
  assert.equal(blocks.length, 1);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(data));
});

test("a damaged previous manifest does not stop the next write", async () => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(200 * 1024);
  const storage = memoryStorage();
  await writeAutoBackup({ storage, store: fakeStore(data), dek });

  const manifest = (await storage.list()).find((f) => f.name === MANIFEST_NAME);
  const bytes = await storage.get(manifest.id);
  bytes[bytes.length - 1] ^= 0xff;
  await storage.update(manifest.id, bytes);

  // The blocks are still content-addressed, so none of them need to be sent
  // again; only the manifest has to be replaced.
  const res = await writeAutoBackup({ storage, store: fakeStore(data), dek });
  assert.equal(res.uploaded, 0);
  assert.equal(res.reused, 4);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(data));
});

test("old blocks are collected after the commit, and files that are not blocks are kept", async () => {
  const dek = randomBytes(DEK_BYTES);
  const userFile = {
    id: "user-snap", name: "bankpipe-2026-01-01T000000Z-5AAM.bpdb",
    bytes: new Uint8Array([1, 2, 3]), modifiedTime: "2026-01-01T00:00:00Z",
  };
  const keyFile = {
    id: "user-key", name: "vault-key-0001.bpk",
    bytes: new Uint8Array([4, 5, 6]), modifiedTime: "2026-01-01T00:00:00Z",
  };
  const storage = memoryStorage([userFile, keyFile]);

  const first = await writeAutoBackup({ storage, store: fakeStore(synthetic(300 * 1024, 1)), dek });
  const second = await writeAutoBackup({ storage, store: fakeStore(synthetic(128 * 1024, 2)), dek });

  assert.equal(second.uploaded, 2);
  const stale = first.manifest.chunks.filter((id) => !second.manifest.chunks.includes(id));
  assert.equal(second.removed, stale.length, "every block the new manifest drops is collected");

  const names = new Set((await storage.list()).map((f) => f.name));
  for (const id of first.manifest.chunks) {
    if (second.manifest.chunks.includes(id)) assert.ok(names.has(blockName(id)));
    else assert.equal(names.has(blockName(id)), false, `stale block ${id} survived`);
  }
  for (const id of second.manifest.chunks) assert.ok(names.has(blockName(id)));

  assert.ok(names.has(userFile.name), "a manual snapshot must not be deleted");
  assert.ok(names.has(keyFile.name), "the key file must not be deleted");
  assert.ok(names.has(MANIFEST_NAME));

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(synthetic(128 * 1024, 2)));
});

test("a small change to a 10 MB database uploads far less than 5% of it", async (t) => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(10 * 1024 * 1024);
  const storage = counting(memoryStorage());
  const first = await writeAutoBackup({ storage, store: fakeStore(data), dek });
  assert.equal(first.uploaded, 160);

  const changed = new Uint8Array(data);
  changed[4 * 1024 * 1024 + 1234] ^= 0xff;
  storage.stats.bytes = 0;
  const res = await writeAutoBackup({ storage, store: fakeStore(changed), dek });

  assert.ok(res.uploaded <= 2, `uploaded ${res.uploaded} blocks`);
  assert.ok(res.bytesUploaded < data.length * 0.05,
    `uploaded ${res.bytesUploaded} bytes for a ${data.length}-byte database`);
  t.diagnostic(`10 MB database, one-byte change: ${res.bytesUploaded} bytes uploaded `
    + `(${(100 * res.bytesUploaded / data.length).toFixed(2)}% of the database)`);

  const read = await readAutoBackup({ storage, dek });
  assert.equal(toHex(read.plain), toHex(changed));
});

test("info reads the manifest and nothing else", async () => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(200 * 1024);
  const storage = counting(memoryStorage());
  await writeAutoBackup({ storage, store: fakeStore(data), dek, deviceId: "mac1" });

  storage.stats.gets = 0;
  const info = await autoBackupInfo({ storage, dek });
  assert.equal(info.size, data.length);
  assert.equal(info.chunks.length, 4);
  assert.equal(storage.stats.gets, 1, "info must not download the blocks");
});

test("a wrong key is refused", async () => {
  const dek = randomBytes(DEK_BYTES);
  const storage = memoryStorage();
  await writeAutoBackup({ storage, store: fakeStore(synthetic(70 * 1024)), dek });

  await assert.rejects(
    () => readAutoBackup({ storage, dek: randomBytes(DEK_BYTES) }),
    (e) => e.code === "wrong_vault" || e.code === "corrupt");
});

test("a tampered block is refused instead of being returned", async () => {
  const dek = randomBytes(DEK_BYTES);
  const data = synthetic(200 * 1024);
  const storage = memoryStorage();
  const made = await writeAutoBackup({ storage, store: fakeStore(data), dek });

  const block = (await storage.list())
    .find((f) => f.name === blockName(made.manifest.chunks[1]));
  const bytes = await storage.get(block.id);
  bytes[bytes.length - 1] ^= 0xff;
  await storage.update(block.id, bytes);

  await assert.rejects(
    () => readAutoBackup({ storage, dek }),
    (e) => e.code === "corrupt" || e.code === "bad_block");
});

test("a missing block is refused", async () => {
  const dek = randomBytes(DEK_BYTES);
  const storage = memoryStorage();
  const made = await writeAutoBackup({
    storage, store: fakeStore(synthetic(200 * 1024)), dek,
  });
  const block = (await storage.list())
    .find((f) => f.name === blockName(made.manifest.chunks[0]));
  await storage.remove(block.id);

  await assert.rejects(() => readAutoBackup({ storage, dek }), /incomplete|missing/);
});

test("removing the automatic copy deletes the manifest and every block", async () => {
  const dek = randomBytes(DEK_BYTES);
  const storage = memoryStorage([{
    id: "keep", name: "bankpipe-2026-01-01T000000Z.bpdb",
    bytes: new Uint8Array([1]), modifiedTime: "2026-01-01T00:00:00Z",
  }]);
  await writeAutoBackup({ storage, store: fakeStore(synthetic(200 * 1024)), dek });

  const gone = await removeAutoBackup({ storage });
  assert.equal(gone.removed, 5);              // four blocks and the manifest
  const names = (await storage.list()).map((f) => f.name);
  assert.deepEqual(names, ["bankpipe-2026-01-01T000000Z.bpdb"]);
  await assert.rejects(() => readAutoBackup({ storage, dek }), /no automatic copy/);
});
