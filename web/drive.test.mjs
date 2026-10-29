import test from "node:test";
import assert from "node:assert/strict";
import { makeDrive, getToken, disconnect } from "./drive.js";

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, opts);
    }
    return { ok: false, status: 404, text: async () => "no route" };
  };
  impl.calls = calls;
  return impl;
}
const json = (obj) => ({ ok: true, json: async () => obj, text: async () => "" });

test("an existing BankPipe folder is reused", async () => {
  const f = fakeFetch([["files?", () => json({ files: [{ id: "folder-1", name: "BankPipe" }] })]]);
  const drive = makeDrive(f, "token");
  assert.equal(await drive.ensureFolder(), "folder-1");
  assert.match(f.calls[0].url, /drive\/v3\/files\?q=/);
});

test("a missing folder is created once", async () => {
  const f = fakeFetch([
    ["files?", () => json({ files: [] })],
    ["upload/drive", () => json({ id: "unused" })],
    ["drive/v3/files", () => json({ id: "folder-new" })],
  ]);
  const drive = makeDrive(f, "token");
  assert.equal(await drive.ensureFolder(), "folder-new");
  const post = f.calls.find((c) => c.opts.method === "POST");
  assert.match(post.opts.body, /application\/vnd\.google-apps\.folder/);
});

test("listing follows page tokens", async () => {
  let n = 0;
  const f = fakeFetch([["files?", () => {
    n++;
    return n === 1 ? json({ files: [{ id: "a" }], nextPageToken: "p2" })
                   : json({ files: [{ id: "b" }] });
  }]]);
  const drive = makeDrive(f, "token");
  assert.deepEqual((await drive.list("folder")).map((x) => x.id), ["a", "b"]);
});

test("upload sends multipart with the ciphertext, not a filename trick", async () => {
  const f = fakeFetch([["upload/drive", () => json({ id: "file-1" })]]);
  const drive = makeDrive(f, "token");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await drive.upload("folder", "ops-mac-1-2.age", bytes), "file-1");
  const call = f.calls[0];
  assert.equal(call.opts.method, "POST");
  assert.match(call.opts.headers["Content-Type"], /multipart\/related; boundary=/);
  assert.ok(call.opts.body instanceof Blob);
});

test("download returns raw bytes", async () => {
  const f = fakeFetch([["alt=media", () => ({ ok: true,
    arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer })] ]);
  const drive = makeDrive(f, "token");
  assert.deepEqual([...(await drive.download("file-1"))], [9, 8, 7]);
});

test("every request carries the bearer token", async () => {
  const f = fakeFetch([["files?", () => json({ files: [] })],
                       ["drive/v3/files", () => json({ id: "x" })]]);
  await makeDrive(f, "secret-token").ensureFolder();
  for (const c of f.calls) assert.equal(c.opts.headers.Authorization, "Bearer secret-token");
});

test("getToken asks the same-origin broker and returns the access token", async () => {
  const f = fakeFetch([["/token", () => json({ access_token: "ya29.x", expires_in: 3599 })]]);
  const out = await getToken(f);
  assert.equal(out.token, "ya29.x");
  assert.equal(out.expiresIn, 3599);
  assert.equal(f.calls[0].opts.method, "POST");
  assert.equal(f.calls[0].opts.credentials, "same-origin");
});

test("getToken surfaces reconnect_required instead of a raw 401", async () => {
  const f = async () => ({ ok: false, status: 401, json: async () => ({ error: "not_connected" }) });
  await assert.rejects(getToken(f), (e) => e.code === "reconnect_required");
});

test("disconnect posts to the broker", async () => {
  const f = fakeFetch([["/disconnect", () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })]]);
  assert.equal(await disconnect(f), true);
  assert.equal(f.calls[0].opts.method, "POST");
});
