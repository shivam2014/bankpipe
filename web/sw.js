// The app shell, cached per build.
//
// Three rules decide everything here:
//
//   1. index.html and version.json are network-first, so a deploy is visible on
//      the next load. A cached page can never hide a new build.
//   2. Everything else in the shell is cache-first, so a cold launch with no
//      network is instant.
//   3. This worker never sees the database, a statement or a vault key. The
//      database is IndexedDB, which is not a request at all; the deny list is
//      the second fence for anything that would ever be served as a file.
//
// The cache name carries the build stamp. scripts/version-assets.mjs replaces
// __BP_BUILD__ in the deployed copy, so a new deploy installs a byte-different
// worker, activates a new cache and deletes the old one. The page loads sw.js
// with updateViaCache:"none", so the browser never trusts a stale HTTP copy.

export const BUILD = "__BP_BUILD__";
export const CACHE_PREFIX = "bankpipe-shell-";
// A precache entry that never settles must not hold install, and therefore
// activation and every navigation to the scope, open forever.
export const PRECACHE_TIMEOUT_MS = 3000;

/** One cache per build. A constant name would keep stale files forever. */
export function cacheName(build = BUILD) {
  return `${CACHE_PREFIX}${build || "dev"}`;
}

export const CACHE_NAME = cacheName();

export const PRECACHE = [
  "./",
  "./index.html",
  "./backup.html",
  "./manifest.webmanifest",
  "./version.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png",
];

// A path that must never enter a cache, whatever its extension.
const PRIVATE_PATH = [
  /(^|\/)private(\/|$)/i,
  /(^|\/)db(\/|$)/i,
  /(^|\/)import-denylist\.txt$/i,
  /\.(?:bpk|db|db-wal|db-shm|sqlite|sqlite3)$/i,
];

// Answers that depend on the network, a cookie or live prices. Caching one
// would show yesterday's price as today's, or replay an OAuth answer.
const LIVE_PATH = [
  /^\/__market\//,
  /^\/oauth\//,
  /^\/(?:token|disconnect|health)$/,
];

// Always ask the network first, and fall back to the cache only when offline.
const NETWORK_FIRST = [
  /\/index\.html$/,
  /\/version\.json$/,
  /\/manifest\.webmanifest$/,
];

/** True for a path that must never be cached or served from a cache. */
export function isPrivatePath(pathname) {
  const path = String(pathname || "");
  return PRIVATE_PATH.some((pattern) => pattern.test(path));
}

export function isLivePath(pathname) {
  const path = String(pathname || "");
  return LIVE_PATH.some((pattern) => pattern.test(path));
}

/**
 * The rule for one request: "network-first", "cache-first" or "bypass".
 * `origin` is the app's own origin; pass it so a test needs no service worker.
 */
export function strategyFor(request, origin) {
  if (!request || String(request.method || "GET").toUpperCase() !== "GET") {
    return "bypass";
  }
  let url;
  try { url = new URL(request.url); } catch { return "bypass"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "bypass";
  if (origin && url.origin !== origin) return "bypass";
  if (isPrivatePath(url.pathname)) return "bypass";
  if (isLivePath(url.pathname)) return "bypass";
  if (request.headers && typeof request.headers.has === "function"
      && request.headers.has("authorization")) return "bypass";
  if (request.mode === "navigate") return "network-first";
  if (NETWORK_FIRST.some((pattern) => pattern.test(url.pathname))) {
    return "network-first";
  }
  return "cache-first";
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // Built from the URL rather than the Request: a navigate request cannot
    // carry init options, and this one must skip the HTTP cache. A cached
    // index.html is exactly the stale build this worker exists to avoid.
    const response = await fetch(request.url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: request.headers,
    });
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html") || await cache.match("./");
      if (shell) return shell;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.status === 200) await cache.put(request, response.clone());
  return response;
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // One missing file must not fail the install: version.json only exists in a
  // built bundle, and a local checkout must still work offline. One slow file
  // must not stall it either, because install blocks activation and activation
  // blocks navigations.
  await Promise.all(PRECACHE.map(async (url) => {
    const slow = new Promise((resolve) => setTimeout(resolve, PRECACHE_TIMEOUT_MS));
    try {
      await Promise.race([cache.add(new Request(url, { cache: "reload" })), slow]);
    } catch { /* optional */ }
  }));
}

async function activate() {
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map((name) => caches.delete(name)));
  // Deliberately not awaited: a client that never settles would keep the worker
  // in "activating", and Chrome holds every navigation to the scope until it
  // finishes. Claim in the background instead.
  self.clients.claim();
}

const scope = typeof self !== "undefined" && typeof self.addEventListener === "function"
  ? self
  : null;

if (scope) {
  scope.addEventListener("install", (event) => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(activate());
  });

  scope.addEventListener("fetch", (event) => {
    const strategy = strategyFor(event.request, self.location.origin);
    if (strategy === "bypass") return;
    event.respondWith(strategy === "network-first"
      ? networkFirst(event.request)
      : cacheFirst(event.request));
  });
}
