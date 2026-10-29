import test from "node:test";
import assert from "node:assert/strict";
import { decide, currentMode, setMode, isConnected, welcomeSeen, markWelcomeSeen, MODE } from "./onboarding.js";

// Minimal localStorage stand-in.
const store = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

const tokenFetch = (ok) => async () => ({ ok, status: ok ? 200 : 401 });

test("?reset=1 forgets the answer and asks again", async () => {
  const s = store({ "bankpipe.mode": "local" });
  const out = await decide({ storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams("reset=1") });
  assert.equal(out.show, true);
  assert.equal(out.reason, "first-run");
  assert.equal(currentMode(s), null);
});

test("?demo=1 opens the app without asking and without touching the broker", async () => {
  const s = store();
  const out = await decide({
    storage: s,
    fetchImpl: async () => { throw new Error("should not probe"); },
    params: new URLSearchParams("demo=1"),
  });
  assert.equal(out.show, false);
  assert.equal(out.mode, MODE.LOCAL);
  assert.equal(currentMode(s), MODE.LOCAL);
});

test("a first visit asks the question", async () => {
  const out = await decide({ storage: store(), fetchImpl: tokenFetch(false), params: new URLSearchParams("") });
  assert.equal(out.show, true);
  assert.equal(out.reason, "first-run");
  assert.equal(out.mode, null);
});

test("returning from Google with ?connected=1 records drive mode and does not ask", async () => {
  const s = store();
  const out = await decide({ storage: s, fetchImpl: tokenFetch(true), params: new URLSearchParams("connected=1") });
  assert.equal(out.show, false);
  assert.equal(out.mode, MODE.DRIVE);
  assert.equal(currentMode(s), MODE.DRIVE);
});

test("local mode never probes and never asks", async () => {
  const s = store({ "bankpipe.mode": "local" });
  let probed = false;
  const out = await decide({
    storage: s,
    fetchImpl: async () => { probed = true; return { ok: false }; },
    params: new URLSearchParams(""),
  });
  assert.equal(out.show, false);
  assert.equal(out.mode, MODE.LOCAL);
  assert.equal(probed, false);
});

test("drive mode with a live token opens silently", async () => {
  const s = store({ "bankpipe.mode": "drive" });
  const out = await decide({ storage: s, fetchImpl: tokenFetch(true), params: new URLSearchParams("") });
  assert.equal(out.show, false);
});

test("drive mode with a dead token asks to reconnect", async () => {
  const s = store({ "bankpipe.mode": "drive" });
  const out = await decide({ storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams("") });
  assert.equal(out.show, true);
  assert.equal(out.reason, "reconnect");
});

test("a broken broker does not block a local user", async () => {
  assert.equal(await isConnected(async () => { throw new Error("offline"); }), false);
  const out = await decide({
    storage: store({ "bankpipe.mode": "drive" }),
    fetchImpl: async () => { throw new Error("offline"); },
    params: new URLSearchParams(""),
  });
  assert.equal(out.show, true);
  assert.equal(out.reason, "reconnect");
});

test("setMode round-trips", () => {
  const s = store();
  setMode(MODE.LOCAL, s);
  assert.equal(currentMode(s), MODE.LOCAL);
  setMode(MODE.DRIVE, s);
  assert.equal(currentMode(s), MODE.DRIVE);
});

test("an unknown stored value is treated as unset", () => {
  assert.equal(currentMode(store({ "bankpipe.mode": "wat" })), null);
});

test("the welcome is shown once and remembered", () => {
  const s = store();
  assert.equal(welcomeSeen(s), false);
  markWelcomeSeen(s);
  assert.equal(welcomeSeen(s), true);
});

test("?reset=1 forgets the welcome too, so a demo replays from the start", async () => {
  const s = store({ "bankpipe.mode": "local", "bankpipe.welcome.seen": "1" });
  const out = await decide({ storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams("reset=1") });
  assert.equal(out.show, true);
  assert.equal(welcomeSeen(s), false);
});
