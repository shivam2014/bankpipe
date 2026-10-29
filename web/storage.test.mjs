import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, driveStorage, SNAPSHOT_MIME } from "./storage.js";

// Same shape as the real Drive responses, so the adapter is tested against the
// protocol rather than against a mock of itself.
function fakeDrive() {
  const files = new Map();
  let n = 0;
  const calls = [];
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, path: u.pathname });

    const auth = init.headers?.Authorization;
    if (!String(auth || "").startsWith("Bearer ")) return json({ error: "unauthorised" }, 401);

    if (u.pathname === "/drive/v3/files" && method === "GET") {
      const q = decodeURIComponent(u.searchParams.get("q") || "");
      if (q.includes("application/vnd.google-apps.folder")) {
        const folders = [...files.values()].filter((f) => f.folder);
        return json({ files: folders.map((f) => ({ id: f.id, name: f.name })) });
      }
      const parent = /'([^']+)' in parents/.exec(q);
      const kids = [...files.values()].filter((f) => !f.folder && f.parent === parent?.[1]);
      return json({ files: kids.map((f) => ({
        id: f.id, name: f.name, size: String(f.bytes.length), modifiedTime: f.modifiedTime })) });
    }

    if (u.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(init.body);
      const id = `id${++n}`;
      files.set(id, { id, name: meta.name, folder: true, bytes: new Uint8Array() });
      return json({ id, name: meta.name });
    }

    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      const ct = init.headers["Content-Type"];
      const boundary = /boundary=(.+)$/.exec(ct)[1];
      const buf = new Uint8Array(await init.body.arrayBuffer());
      const text = new TextDecoder("latin1").decode(buf);

      const find = (needle, from) => {
        const nd = new TextEncoder().encode(needle);
        for (let i = from; i <= buf.length - nd.length; i++) {
          let j = 0;
          while (j < nd.length && buf[i + j] === nd[j]) j++;
          if (j === nd.length) return i;
        }
        return -1;
      };
      const headEnd = find("\r\n\r\n", 0);
      const jsonStart = headEnd + 4;
      const jsonEnd = find(`\r\n--${boundary}`, jsonStart);
      const meta = JSON.parse(text.slice(jsonStart, jsonEnd));
      const bodyStart = find("\r\n\r\n", jsonEnd) + 4;
      const bodyEnd = find(`\r\n--${boundary}--`, bodyStart);
      const bytes = buf.slice(bodyStart, bodyEnd);

      const id = `id${++n}`;
      files.set(id, {
        id, name: meta.name, parent: meta.parents[0], bytes,
        modifiedTime: new Date().toISOString(),
      });
      return json({ id, name: meta.name });
    }

    const media = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (media && method === "PATCH") {
      const rec = files.get(media[1]);
      if (!rec) return json({ error: "not found" }, 404);
      const body = init.body instanceof Uint8Array
        ? init.body
        : new Uint8Array(await init.body.arrayBuffer());
      rec.bytes = body;
      rec.modifiedTime = new Date().toISOString();
      return json({ id: rec.id, name: rec.name });
    }

    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (one && method === "GET" && u.searchParams.get("alt") === "media") {
      const rec = files.get(one[1]);
      return rec ? new Response(rec.bytes, { status: 200 }) : json({ error: "not found" }, 404);
    }
    if (one && method === "DELETE") {
      files.delete(one[1]);
      return new Response(null, { status: 204 });
    }

    throw new Error(`fake drive: unhandled ${method} ${u.pathname}`);
  };

  return { fetchImpl, calls, files };
}

test("memory storage satisfies the contract", async () => {
  const s = memoryStorage();
  assert.deepEqual(await s.list(), []);
  const put = await s.put("a.bin", new Uint8Array([1, 2, 3]));
  assert.equal(put.name, "a.bin");
  assert.equal((await s.list()).length, 1);
  assert.deepEqual([...(await s.get(put.id))], [1, 2, 3]);
  await s.update(put.id, new Uint8Array([9]));
  assert.deepEqual([...(await s.get(put.id))], [9]);
  assert.equal((await s.list())[0].name, "a.bin");
  await s.remove(put.id);
  assert.equal((await s.list()).length, 0);
  await assert.rejects(() => s.get(put.id), /no such file/);
});

test("drive storage replaces a file in place for a passphrase change", async () => {
  const drive = fakeDrive();
  const s = driveStorage({ token: "t", fetchImpl: drive.fetchImpl });
  const put = await s.put("vault-key-0001.bpk", new Uint8Array([1, 2, 3]));
  const upd = await s.update(put.id, new Uint8Array([4, 5]));
  assert.equal(upd.id, put.id);
  assert.deepEqual([...(await s.get(put.id))], [4, 5]);
  assert.equal((await s.list()).length, 1, "update must not create a second file");
});

test("drive storage creates the folder once and reuses it", async () => {
  const drive = fakeDrive();
  const s = driveStorage({ token: "t", fetchImpl: drive.fetchImpl });

  await s.put("one.bin", new Uint8Array([1]));
  await s.put("two.bin", new Uint8Array([2]));

  const folderCreates = drive.calls.filter(
    (c) => c.method === "POST" && c.path === "/drive/v3/files").length;
  assert.equal(folderCreates, 1);
});

test("drive storage round-trips bytes without altering them", async () => {
  const drive = fakeDrive();
  const s = driveStorage({ token: "t", fetchImpl: drive.fetchImpl });
  const payload = new Uint8Array(2048);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) % 256;

  const put = await s.put("x.bin", payload);
  const back = await s.get(put.id);
  assert.equal(back.length, payload.length);
  assert.deepEqual([...back], [...payload]);
});

test("drive storage lists what is in the folder, not the whole Drive", async () => {
  const drive = fakeDrive();
  const s = driveStorage({ token: "t", fetchImpl: drive.fetchImpl });
  await s.put("a.bin", new Uint8Array([1]));
  await s.put("b.bin", new Uint8Array([2, 2]));

  const list = await s.list();
  assert.deepEqual(list.map((f) => f.name).sort(), ["a.bin", "b.bin"]);
});

test("drive storage deletes, and a missing file surfaces as an error", async () => {
  const drive = fakeDrive();
  const s = driveStorage({ token: "t", fetchImpl: drive.fetchImpl });
  const put = await s.put("gone.bin", new Uint8Array([1]));
  await s.remove(put.id);
  assert.equal((await s.list()).length, 0);
  await assert.rejects(() => s.get(put.id), /404/);
});

test("a missing token is refused before any request is made", () => {
  assert.throws(() => driveStorage({ token: "" }), /token is required/);
});

test("the adapter looks the same to the caller whichever backend is behind it", () => {
  const s = memoryStorage();
  assert.equal(typeof s.list, "function");
  assert.equal(typeof s.put, "function");
  assert.equal(typeof s.get, "function");
  assert.equal(typeof s.remove, "function");
  assert.equal(s.describe().kind, "memory");
  assert.equal(SNAPSHOT_MIME, "application/x-bankpipe-snapshot");
});
