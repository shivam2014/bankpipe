import test from "node:test";
import assert from "node:assert/strict";
import {
  decide, currentMode, setMode, isConnected, welcomeSeen, markWelcomeSeen, MODE,
  databaseOnDevice, deferStorageChoice, storageDeferred, screenFor,
} from "./onboarding.js";

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

// The two outcomes the database probe has to tell apart, without a browser.
// open() lands its events on a later microtask, the way IndexedDB does.
function fakeIndexedDb({ exists = false, keys = [] } = {}) {
  let aborted = false;
  let opened = "";
  const factory = {
    open(name) {
      opened = name;
      const request = {};
      queueMicrotask(() => {
        if (!exists) {
          request.transaction = { abort: () => { aborted = true; request.onerror?.(); } };
          request.onupgradeneeded?.();
          return;
        }
        request.result = {
          objectStoreNames: { contains: (storeName) => storeName === "blobs" },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              count: (key) => {
                const read = {};
                queueMicrotask(() => {
                  read.result = keys.includes(key) ? 1 : 0;
                  read.onsuccess?.();
                });
                return read;
              },
            }),
          }),
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory, opened: () => opened, aborted: () => aborted };
}

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

test("a new device still gets the welcome", async () => {
  const s = store();
  const out = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams(""),
    dbPresent: async () => false,
  });
  assert.equal(out.show, true);
  assert.equal(out.reason, "first-run");
  assert.equal(welcomeSeen(s), false);
  assert.equal(screenFor(out, s), "welcome");
});

test("a device that holds a database never puts the chooser over the unlock screen", async () => {
  const s = store({ "bankpipe.welcome.seen": "1" });
  const out = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams(""),
    dbPresent: async () => true,
  });
  assert.equal(out.show, false);
  assert.equal(out.mode, MODE.LOCAL);
  assert.equal(out.reason, "database");
  // Nothing mounts, so the unlock screen the app draws is not covered.
  assert.equal(screenFor(out, s), null);
  // The answer is inferred from the data, not written over a later choice.
  assert.equal(currentMode(s), null);
});

test("Decide later records the dismissal and a reload does not ask again", async () => {
  const s = store();
  const first = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams(""),
    dbPresent: async () => false,
  });
  assert.equal(first.show, true);
  assert.equal(screenFor(first, s), "welcome");

  markWelcomeSeen(s);
  deferStorageChoice(s);
  const reload = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams(""),
    dbPresent: async () => false,
  });
  assert.equal(reload.show, false);
  assert.equal(reload.reason, "deferred");
  assert.equal(storageDeferred(s), true);
  assert.equal(screenFor(reload, s), null);
});

test("choosing a mode clears an earlier dismissal", () => {
  const s = store({ "bankpipe.storage.deferred": "1" });
  setMode(MODE.LOCAL, s);
  assert.equal(storageDeferred(s), false);
});

test("?reset=1 brings the question back only when there is no database", async () => {
  const s = store({ "bankpipe.storage.deferred": "1", "bankpipe.welcome.seen": "1" });
  const out = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams("reset=1"),
    dbPresent: async () => false,
  });
  assert.equal(out.show, true);
  assert.equal(storageDeferred(s), false);
  assert.equal(screenFor(out, s), "welcome");
});

test("?reset=1 on a device with a database still mounts nothing", async () => {
  const s = store({ "bankpipe.welcome.seen": "1" });
  const out = await decide({
    storage: s, fetchImpl: tokenFetch(false), params: new URLSearchParams("reset=1"),
    dbPresent: async () => true,
  });
  assert.equal(out.show, false);
  assert.equal(out.reason, "database");
  assert.equal(screenFor(out, s), null);
});

test("the database probe looks for the stored blob and reports it", async () => {
  const { factory, opened } = fakeIndexedDb({ exists: true, keys: ["bankpipe.db.v1"] });
  assert.equal(await databaseOnDevice(factory), true);
  assert.equal(opened(), "bankpipe");
});

test("the database probe reports false when the blob is absent", async () => {
  const { factory } = fakeIndexedDb({ exists: true, keys: ["snapshot.other"] });
  assert.equal(await databaseOnDevice(factory), false);
});

test("the database probe aborts an upgrade instead of creating an empty database", async () => {
  const { factory, aborted } = fakeIndexedDb({ exists: false });
  assert.equal(await databaseOnDevice(factory), false);
  assert.equal(aborted(), true);
});

test("the database probe is safe with no IndexedDB at all", async () => {
  assert.equal(await databaseOnDevice(null), false);
  assert.equal(await databaseOnDevice(), false);
});
