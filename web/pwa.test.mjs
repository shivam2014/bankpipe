// The install surface, tested without a browser.
//
// The worker and the manifest are files a person's phone trusts; these tests are
// the only thing between a typo and a home-screen icon that never updates. They
// read the files as shipped, not a copy.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installState, isIOS, storageLabel, ensurePersistence, pwaCard,
  INSTALL_LABEL, INSTALLED_LINE, IOS_HINT, STORAGE_PROTECTED, STORAGE_CLEARABLE, BACKUP_TRUTH,
} from "./pwa.js";
import {
  BUILD, CACHE_PREFIX, CACHE_NAME, cacheName, PRECACHE, isPrivatePath, strategyFor,
} from "./sw.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, file), "utf8");
const manifest = JSON.parse(read("manifest.webmanifest"));
const ORIGIN = "https://bankpipe.example";

const get = (path, init = {}) => new Request(`${ORIGIN}${path}`, init);

test("the manifest is valid JSON with every field a launcher needs", () => {
  assert.equal(manifest.name, "BankPipe");
  assert.equal(manifest.short_name, "BankPipe");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0b6b4f");
  assert.equal(manifest.background_color, "#f5f3ee");
  assert.ok(manifest.description.length > 0);
});

test("the manifest has 192, 512 and a maskable icon, and each file exists", () => {
  const icons = manifest.icons || [];
  const sizes = icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"), "a 192px icon");
  assert.ok(sizes.includes("512x512"), "a 512px icon");
  assert.ok(icons.some((icon) => String(icon.purpose).split(/\s+/).includes("maskable")),
    "one maskable icon");
  for (const icon of icons) {
    assert.equal(icon.type, "image/png", `${icon.src} is a png`);
    assert.ok(existsSync(join(here, icon.src)), `${icon.src} is in the bundle`);
  }
});

test("the manifest and icons carry no personal identifier", () => {
  const text = read("manifest.webmanifest");
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, "no email address");
  assert.doesNotMatch(text, /\b\d{10,}\b/, "no account, phone or Aadhaar number");
  assert.doesNotMatch(text, /\b[A-Z]{5}\d{4}[A-Z]\b/, "no PAN");
});

test("the cache name is versioned, and the deploy stamps the build", () => {
  assert.equal(cacheName("a"), `${CACHE_PREFIX}a`);
  assert.notEqual(cacheName("2026.11.19"), cacheName("2026.11.20"));
  assert.equal(CACHE_NAME, cacheName(BUILD));
  assert.ok(BUILD, "a build stamp is present");
  assert.match(read("sw.js"), /__BP_BUILD__/, "the placeholder the deploy replaces");
  assert.match(read("../scripts/version-assets.mjs"), /replaceAll\("__BP_BUILD__"/,
    "the build replaces the placeholder in sw.js");
});

test("the precache list is the shell, never a database or a vault key", () => {
  assert.ok(PRECACHE.includes("./index.html"));
  assert.ok(PRECACHE.includes("./version.json"));
  for (const url of PRECACHE) {
    assert.equal(isPrivatePath(new URL(url, ORIGIN).pathname), false, url);
  }
});

test("database and vault paths are never cacheable", () => {
  for (const path of [
    "/bankpipe.db", "/bankpipe.db-wal", "/vault-key-0001.bpk",
    "/private/hdfc.xlsx", "/db/rows", "/import-denylist.txt", "/backup.sqlite3",
  ]) {
    assert.equal(isPrivatePath(path), true, `${path} is private`);
    assert.equal(strategyFor(get(path), ORIGIN), "bypass", `${path} is bypassed`);
  }
});

test("the app's own db.js and vault.js modules stay in the shell", () => {
  // The deny list must not confuse a module with a data file.
  assert.equal(strategyFor(get("/db.js"), ORIGIN), "cache-first");
  assert.equal(strategyFor(get("/vault.js"), ORIGIN), "cache-first");
  assert.equal(strategyFor(get("/vendor/sql-wasm.wasm"), ORIGIN), "cache-first");
});

test("index.html, version.json and navigations are network-first", () => {
  assert.equal(strategyFor(get("/index.html"), ORIGIN), "network-first");
  assert.equal(strategyFor(get("/version.json"), ORIGIN), "network-first");
  assert.equal(strategyFor({
    url: `${ORIGIN}/?demo=1`, method: "GET", mode: "navigate",
  }, ORIGIN), "network-first");
});

test("live prices, the broker and unsafe requests bypass the worker", () => {
  assert.equal(strategyFor(get("/__market/bond?isin=INE1"), ORIGIN), "bypass");
  assert.equal(strategyFor(get("/token"), ORIGIN), "bypass");
  assert.equal(strategyFor(get("/oauth/google"), ORIGIN), "bypass");
  assert.equal(strategyFor(get("/health"), ORIGIN), "bypass");
  assert.equal(strategyFor(get("/", { method: "POST" }), ORIGIN), "bypass");
  assert.equal(strategyFor(get("/api", { headers: { Authorization: "Bearer x" } }), ORIGIN),
    "bypass");
  assert.equal(strategyFor(new Request("https://drive.googleapis.com/x"), ORIGIN), "bypass");
});

test("install state follows what the device can actually do", () => {
  assert.equal(installState({ standalone: true, prompt: true }), "installed");
  assert.equal(installState({ prompt: true, userAgent: "Mozilla/5.0 (iPhone)" }), "prompt");
  assert.equal(installState({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }), "ios");
  assert.equal(installState({ userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5 }), "ios");
  assert.equal(installState({ userAgent: "Mozilla/5.0 (X11; Linux)" }), "none");
  assert.equal(installState(), "none");
  assert.equal(isIOS("Mozilla/5.0 (iPad)"), true);
});

test("the install card offers a button only when the browser offered one", () => {
  const prompted = pwaCard({ state: "prompt" });
  assert.match(prompted, new RegExp(INSTALL_LABEL));
  assert.match(prompted, /onclick="bpInstall\(\)"/);

  const ios = pwaCard({ state: "ios" });
  assert.ok(ios.includes(IOS_HINT));
  assert.doesNotMatch(ios, /bpInstall/);

  const none = pwaCard({ state: "none" });
  assert.doesNotMatch(none, /bpInstall/);
  assert.ok(!none.includes(IOS_HINT));
});

test("an installed app is not sold to itself", () => {
  const card = pwaCard({ state: "installed" });
  assert.doesNotMatch(card, /bpInstall/);
  assert.ok(!card.includes(`>${INSTALL_LABEL}<`), "no install button");
  assert.ok(card.includes(INSTALLED_LINE));
  assert.match(card, /App and storage/);
});

test("every install card states the storage result and the backup truth", () => {
  for (const state of ["prompt", "ios", "installed", "none"]) {
    const card = pwaCard({ state });
    assert.ok(card.includes('id="storage-state"'), `${state} has the storage line`);
    assert.ok(card.includes(BACKUP_TRUTH), `${state} states the backup truth`);
    assert.ok(card.includes('href="backup.html"'), `${state} links the backup`);
  }
});

test("the storage line is one line with one of two outcomes", () => {
  assert.equal(storageLabel(true), "Storage: protected");
  assert.equal(storageLabel(false), "Storage: can be cleared by the browser");
  assert.equal(STORAGE_PROTECTED, "Storage: protected");
  assert.equal(STORAGE_CLEARABLE, "Storage: can be cleared by the browser");
});

test("persistence is requested once, and a later grant is still seen", async () => {
  let calls = 0;
  let granted = false;
  const storage = {
    persisted: async () => granted,
    persist: async () => { calls += 1; granted = true; return true; },
  };

  const first = await ensurePersistence({ storage, asked: false });
  assert.equal(first.persisted, true);
  assert.equal(calls, 1);

  const second = await ensurePersistence({ storage, asked: true });
  assert.equal(second.persisted, true);
  assert.equal(calls, 1, "a second visit does not ask again");

  // Installing the app can grant persistence later; the read notices even
  // though persist() is never called again.
  granted = false;
  const later = await ensurePersistence({ storage, asked: true });
  assert.equal(later.persisted, false);
  assert.equal(calls, 1);
});

test("a browser without the storage API is reported, not crashed", async () => {
  const result = await ensurePersistence({ storage: null });
  assert.equal(result.persisted, false);
  assert.equal(result.supported, false);
});

test("the shell links the manifest and registers the worker", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon-180\.png">/);
  assert.match(html, /serviceWorker\.register\("sw\.js"/);
  assert.match(html, /updateViaCache: "none"/);
  assert.match(html, /pwaCard\(/);
});
