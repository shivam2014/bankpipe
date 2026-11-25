// The hard reload is a sequence of browser side effects, so the checks here
// split in three: the URL it builds, the order and scope of the side effects,
// and the markup that puts a 44px control on the top bar.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SHELL_CACHE_PREFIX, RELOAD_PARAM, OFFLINE_MESSAGE, FAILED_MESSAGE,
  cacheBustedUrl, hardReload, reloadMessage,
} from "./reload.js";
import { CACHE_PREFIX } from "./sw.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("./reload.js", import.meta.url), "utf8");
const ORIGIN = "https://bankpipe.example/app/";

function browser(overrides = {}) {
  const steps = [];
  const env = {
    href: `${ORIGIN}?demo=1#assets`,
    now: () => 42,
    online: async () => { steps.push("online"); return true; },
    registrations: async () => { steps.push("registrations"); return ["sw-1", "sw-2"]; },
    unregister: async (worker) => { steps.push(`unregister:${worker}`); },
    cacheNames: async () => {
      steps.push("cacheNames");
      return ["bankpipe-shell-a", "other-app", "bankpipe-shell-b"];
    },
    deleteCache: async (name) => { steps.push(`delete:${name}`); },
    navigate: async (url) => { steps.push(`navigate:${url}`); },
    ...overrides,
  };
  return { env, steps };
}

test("the shell cache prefix is the worker's, character for character", () => {
  assert.equal(SHELL_CACHE_PREFIX, CACHE_PREFIX);
});

test("the cache-busted URL keeps the path, the query and the hash", () => {
  const url = new URL(cacheBustedUrl(`${ORIGIN}?demo=1#assets`, 42));
  assert.equal(url.pathname, "/app/");
  assert.equal(url.searchParams.get("demo"), "1");
  assert.equal(url.searchParams.get(RELOAD_PARAM), "42");
  assert.equal(url.hash, "#assets");
});

test("a second hard reload replaces the token instead of stacking it", () => {
  const once = cacheBustedUrl(`${ORIGIN}?${RELOAD_PARAM}=1`, 2);
  const twice = cacheBustedUrl(once, 3);
  const url = new URL(twice);
  assert.equal(url.searchParams.getAll(RELOAD_PARAM).length, 1);
  assert.equal(url.searchParams.get(RELOAD_PARAM), "3");
});

test("the reload unregisters, deletes only shell caches, then navigates", async () => {
  const { env, steps } = browser();
  const result = await hardReload(env);

  assert.deepEqual(steps, [
    "online",
    "registrations",
    "unregister:sw-1",
    "unregister:sw-2",
    "cacheNames",
    "delete:bankpipe-shell-a",
    "delete:bankpipe-shell-b",
    `navigate:${cacheBustedUrl(env.href, 42)}`,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.unregistered, 2);
  assert.equal(result.deletedCaches, 2);
});

test("offline deletes nothing and does not navigate", async () => {
  const { env, steps } = browser({
    online: async () => { steps.push("online"); return false; },
    registrations: async () => { steps.push("registrations"); return []; },
    cacheNames: async () => { steps.push("cacheNames"); return []; },
    navigate: async () => { steps.push("navigate"); },
  });
  const result = await hardReload(env);

  assert.deepEqual(steps, ["online"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offline");
  assert.equal(result.unregistered, 0);
  assert.equal(result.deletedCaches, 0);
});

test("a probe that throws is treated as offline", async () => {
  const { env, steps } = browser({
    online: async () => { steps.push("online"); throw new Error("network"); },
    cacheNames: async () => { steps.push("cacheNames"); return []; },
  });
  const result = await hardReload(env);
  assert.equal(result.reason, "offline");
  assert.deepEqual(steps, ["online"]);
});

test("one refused worker or cache does not stop the refetch", async () => {
  const { env, steps } = browser({
    unregister: async (worker) => {
      steps.push(`unregister:${worker}`);
      if (worker === "sw-1") throw new Error("already gone");
    },
    deleteCache: async (name) => {
      steps.push(`delete:${name}`);
      if (name === "bankpipe-shell-a") throw new Error("in use");
    },
  });
  const result = await hardReload(env);

  assert.equal(result.ok, true);
  assert.equal(result.unregistered, 1);
  assert.equal(result.deletedCaches, 1);
  assert.match(steps.at(-1), /^navigate:/);
});

test("a missing URL is refused before anything is touched", async () => {
  const { env, steps } = browser();
  const result = await hardReload({ ...env, href: "" });
  assert.equal(result.reason, "no-url");
  assert.deepEqual(steps, []);
});

test("a navigation that throws is reported, not swallowed", async () => {
  const { env } = browser({ navigate: async () => { throw new Error("blocked"); } });
  const result = await hardReload(env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "navigate");
});

test("the module never reaches for the database or settings storage", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /indexedDB|localStorage|sessionStorage/i);
});

test("the control states the offline outcome in one sentence", () => {
  assert.equal(reloadMessage({ reason: "offline" }), OFFLINE_MESSAGE);
  assert.equal(reloadMessage({ reason: "navigate" }), FAILED_MESSAGE);
  assert.match(OFFLINE_MESSAGE, /Nothing was changed/);
});

test("the top bar carries a 44px reload button with an accessible name", () => {
  assert.match(html, /id="reload-app"/);
  assert.match(html, /aria-label="Reload the app"/);
  assert.match(html, /onclick="bpHardReload\(\)"/);
  assert.match(html, /from "\.\/reload\.js"/);

  const rule = html.match(/\.reload-app\{([^}]*)\}/);
  assert.ok(rule, ".reload-app rule is in the stylesheet");
  assert.match(rule[1], /width:44px/);
  assert.match(rule[1], /height:44px/);
});

test("the reload control is wired to the browser, and the worker is not", () => {
  assert.match(html, /workers\.getRegistrations\(\)/);
  assert.match(html, /cacheNames: store \? \(\) => store\.keys\(\)/);
  assert.match(html, /deleteCache: \(name\) => store\.delete\(name\)/);
  assert.match(html, /location\.replace\(url\)/);
  assert.match(html, /aria-busy/);
});

test("on a phone the reload button and the privacy eye do not overlap", () => {
  // The bar stops 64px short of the right edge: the 44px button ends at 64,
  // and the fixed eye starts at 12 + 44 = 56 from the edge, leaving 8px.
  assert.match(html, /@media\(max-width:640px\)\{\.bar\{padding-right:64px\}\}/);
  assert.match(html, /@media\(max-width:640px\)\{\.privacy-toggle\{[^}]*right:12px/);
});
