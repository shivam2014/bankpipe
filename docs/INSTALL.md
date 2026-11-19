# Install, the service worker, and what neither protects

BankPipe can be installed from the browser as an app. Installed or not, the database
lives in IndexedDB on the device, and a manual site-data clear deletes it. This page
records what the install surface does, so a later change does not quietly promise more.

## What an install gives you

- A home-screen icon and a standalone window, with no address bar. On iOS the icon comes
  from `icons/apple-touch-icon-180.png`; everywhere else from the manifest.
- A better chance that the browser treats the origin's storage as worth keeping. Chrome
  counts an installed app as engaged, so it is more likely to grant persistent storage.
- The app shell loads from a cache when the network is slow or absent.

## What it does not give you

**It is not a backup.** A manual "clear site data", a browser reset, or Settings → Erase
deletes IndexedDB. A site cannot refuse that, and no manifest field changes it.
`navigator.storage.persist()` raises the browser's own eviction from *best effort* to
*protected* and the Settings card reports which one the browser gave, but the person
clearing the browser still wins.

The Settings card says this in one line next to the install button, and links to
`backup.html`. That link is the deliverable; the install is the convenience.

## The files

| File | Job |
|---|---|
| `manifest.webmanifest` | Name, `start_url: "./"`, `display: standalone`, theme `#0b6b4f`, background `#f5f3ee`, 192/512/maskable icons |
| `web/icons/` | The header mark — green gradient, white rupee — rendered at 192, 512, a maskable 512 and a 180 touch icon. No personal data |
| `sw.js` | Module worker. Network-first for the shell's HTML, cache-first for the rest |
| `web/pwa.js` | Install state, the storage request, and the card copy. No DOM, so it is testable |

The icons are generated from `web/icons/icon.svg`, `icon-maskable.svg` and
`apple-touch-icon.svg` with `rsvg-convert`. The mark is the one in the page header
(`linear-gradient(140deg, #0a5741, #12a077)`), not a new brand.

## The caching rule

`strategyFor(request, origin)` returns one of three answers, and the fetch handler does
nothing else:

| Request | Rule | Why |
|---|---|---|
| Navigation, `index.html`, `version.json`, `manifest.webmanifest` | network-first, cache only on failure | A deploy is visible on the next load. A cached page cannot hide a new build |
| Other same-origin `GET`s | cache-first | A cold launch with no network opens instantly |
| Non-GET, cross-origin, `Authorization`, `/__market/*`, `/oauth/*`, `/token`, `/health` | bypass | Prices and broker answers are never cached |
| `.bpk`, `.db`, `.sqlite`, `/private/`, `/db/`, the denylist | bypass | The database is IndexedDB and never a request; this is the second fence |

`db.js` and `vault.js` are app modules and stay in the cache. The deny list matches data
file *suffixes* and routes, not names that merely start with `db` or `vault`.

## The update path

The cache name is `bankpipe-shell-<build>`. `scripts/version-assets.mjs` replaces
`__BP_BUILD__` in the deployed `sw.js` with the build stamp, so every deploy ships a
byte-different worker: the browser installs it, `activate` deletes every
`bankpipe-shell-*` cache that is not the current one, and the page registers with
`updateViaCache: "none"` so the HTTP cache cannot hand back the old worker.

The build stamp includes the UTC time (`2026.11.19.0802`), not just the date, so two
deploys on one day do not share a cache name.

The page asks `HEAD version.json` before registering. A local checkout has no
`version.json`, so a dev server never installs a worker that would hide edits behind a
cache — and a checkout that has no build stamp cannot claim to be a build.

## Verifying it

```bash
bash scripts/build-pages.sh
node scripts/probe-pwa.mjs --dir build/pages/public
```

The probe drives real Chrome over the DevTools Protocol and checks what a person would:
Chrome's own installability errors are empty, the manifest parses, the worker controls
the page, a reload with the network off still renders Settings, a deploy changes
`index.html` on the next load, Settings shows the new version, no database path is in a
cache, and a second worker deletes the first worker's cache.
