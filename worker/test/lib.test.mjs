import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  buildAuthUrl, readCookie, seal, unseal, pkce, cookie, clearCookie,
  STATE_COOKIE, TOKEN_COOKIE,
} from "../src/lib.js";

const KEY = "test-key-not-a-real-secret";
const ENV = {
  CLIENT_ID: "cid.apps.googleusercontent.com",
  CLIENT_SECRET: "shh",
  COOKIE_KEY: KEY,
  ALLOWED_ORIGINS: "http://localhost:8801",
  APP_RETURN: "http://localhost:8801/",
};

const call = (path, init = {}) =>
  worker.fetch(new Request("https://auth.example.com" + path, init), ENV);

test("pkce challenge is S256 of the verifier", async () => {
  const { verifier, challenge } = await pkce();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const expected = Buffer.from(new Uint8Array(digest)).toString("base64url");
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
});

test("seal roundtrips and rejects tampering", async () => {
  const sealed = await seal({ refresh_token: "1//abc" }, KEY);
  assert.deepEqual(await unseal(sealed, KEY), { refresh_token: "1//abc" });
  assert.equal(await unseal(sealed, "different-key"), null);
  assert.equal(await unseal(sealed.slice(0, -4) + "AAAA", KEY), null);
  assert.equal(await unseal("", KEY), null);
});

test("auth url asks for offline access with consent", () => {
  const u = new URL(buildAuthUrl({
    clientId: "cid", redirectUri: "https://x/cb", state: "s", challenge: "c",
  }));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x/cb");
});

test("cookies are HttpOnly, Secure, SameSite=Lax", () => {
  const c = cookie("a", "b", 60);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(clearCookie("a"), /Max-Age=0/);
});

test("readCookie finds the right value", () => {
  assert.equal(readCookie("x=1; bp_rt=abc; y=2", "bp_rt"), "abc");
  assert.equal(readCookie("x=1", "bp_rt"), null);
  assert.equal(readCookie(null, "bp_rt"), null);
});

test("/oauth/start redirects to Google and sets a short-lived state cookie", async () => {
  const res = await call("/oauth/start");
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.host, "accounts.google.com");
  assert.equal(loc.searchParams.get("access_type"), "offline");
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, new RegExp(`^${STATE_COOKIE}=`));
  assert.match(setCookie, /Max-Age=600/);
});

test("/oauth/callback sends a stale state back to the app, not raw JSON", async () => {
  const res = await call("/oauth/callback?code=abc&state=nope");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://localhost:8801/?error=state_mismatch");
  assert.match(res.headers.get("set-cookie") || "", /^bp_oauth=;/, "the stale state cookie is cleared");
});

test("/token without a cookie is 401 not_connected", async () => {
  const res = await call("/token", { method: "POST" });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /not_connected/);
});

test("/token returns an access token when the refresh succeeds", async (t) => {
  const sealed = await seal({ refresh_token: "1//rt" }, KEY);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.match(String(init.body), /grant_type=refresh_token/);
    assert.match(String(init.body), /refresh_token=1%2F%2Frt/);
    return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3599, scope: "drive.file" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await call("/token", {
    method: "POST",
    headers: { cookie: `${TOKEN_COOKIE}=${sealed}`, origin: "http://localhost:8801" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.access_token, "ya29.x");
  assert.equal(body.expires_in, 3599);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:8801");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("/token clears the cookie and asks for reconnect when Google says invalid_grant", async (t) => {
  const sealed = await seal({ refresh_token: "1//dead" }, KEY);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await call("/token", {
    method: "POST",
    headers: { cookie: `${TOKEN_COOKIE}=${sealed}` },
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /reconnect_required/);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

test("disconnect revokes and clears the cookie", async (t) => {
  const sealed = await seal({ refresh_token: "1//rt" }, KEY);
  let revoked = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { revoked = String(init.body); return new Response("{}", { status: 200 }); };
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await call("/disconnect", {
    method: "POST",
    headers: { cookie: `${TOKEN_COOKIE}=${sealed}` },
  });
  assert.equal(res.status, 200);
  assert.match(revoked, /token=1%2F%2Frt/);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

test("root redirects a human to the app instead of showing JSON", async () => {
  const res = await call("/");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://localhost:8801/");
});

test("health check answers", async () => {
  const res = await call("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "bankpipe-auth" });
});
