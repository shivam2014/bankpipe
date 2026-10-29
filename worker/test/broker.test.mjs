import test from "node:test";
import assert from "node:assert/strict";

import broker from "../src/index.js";

// No network is touched on these paths: they fail before the token exchange.
const env = { COOKIE_KEY: "a-test-only-cookie-key", APP_RETURN: "https://app.test/" };

const call = (path) => broker.fetch(new Request(`https://app.test${path}`), env);

test("a missing or stale state cookie sends the browser back to the app", async () => {
  const res = await call("/oauth/callback?state=nope&code=abc");

  assert.equal(res.status, 302, "raw JSON strands the user on a blank page");
  assert.equal(res.headers.get("location"), "https://app.test/?error=state_mismatch");
  assert.match(res.headers.get("set-cookie") || "", /^bp_oauth=;/, "the stale cookie is cleared");
});

test("callback with no code also recovers instead of returning JSON", async () => {
  const res = await call("/oauth/callback");

  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /error=state_mismatch/);
});

test("health still answers JSON with 200", async () => {
  const res = await call("/health");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "bankpipe-auth" });
});
