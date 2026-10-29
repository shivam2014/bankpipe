import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PORT = 8899;
const ROOT = fileURLToPath(new URL(".", import.meta.url));

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: PORT, path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    req.on("error", reject);
  });
}

test("static server exposes the app but not private files or dotfiles", async (t) => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.once("error", reject);
    child.stdout.on("data", (buf) => {
      if (String(buf).includes("BankPipe web")) { clearTimeout(timer); resolve(); }
    });
  });

  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers["content-type"], /text\/html/);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["x-frame-options"], "DENY");
  assert.match(home.headers["content-security-policy"], /frame-ancestors 'none'/);

  assert.equal((await request("/private/account-meta.json")).status, 404);
  assert.equal((await request("/server.mjs")).status, 404);
  assert.equal((await request("/.DS_Store")).status, 404);
  assert.equal((await request("/%2e%2e/package.json")).status, 404);
  assert.equal((await request("/", { Host: "evil.example" })).status, 421);
  assert.equal((await request("/", { Host: `127.0.0.1:${PORT}` })).status, 200);
  // A malformed ISIN is refused before any network call is made.
  assert.equal((await request("/__market/bond?isin=NOPE")).status, 400);
  assert.equal((await request("/__market/bond")).status, 400);
});
