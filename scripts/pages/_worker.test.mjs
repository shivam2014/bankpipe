import test from "node:test";
import assert from "node:assert/strict";
import worker from "./_worker.js";

const env = (body = "<!doctype html>", status = 200) => ({
  ASSETS: {
    fetch: async () => new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  },
  CLIENT_ID: "cid",
  CLIENT_SECRET: "shh",
  COOKIE_KEY: "k",
  ALLOWED_ORIGINS: "https://bankpipe.pages.dev",
  APP_RETURN: "https://bankpipe.pages.dev/",
});

const call = (path, e = env()) =>
  worker.fetch(new Request("https://bankpipe.pages.dev" + path), e);

test("an asset request is served with baseline security headers", async () => {
  const res = await call("/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(await res.text(), /doctype html/);
});

test("no Content-Security-Policy is added", async () => {
  // The app uses inline onclick handlers; a strict CSP would break every button.
  const res = await call("/");
  assert.equal(res.headers.get("content-security-policy"), null);
});

test("the market route fails as JSON, not as the HTML fallback", async () => {
  const res = await call("/__market/debt");
  assert.equal(res.status, 501);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  assert.equal(body.error, "market_data_unavailable");
});

test("the broker routes still go to the broker, not the asset fallback", async () => {
  const res = await call("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "bankpipe-auth" });
});

test("an asset 404 keeps its status", async () => {
  const res = await call("/missing.js", env("not found", 404));
  assert.equal(res.status, 404);
});
