#!/usr/bin/env node
// Proves the three claims a manifest and a service worker make, in a real
// browser:
//
//   1. the app is installable (Chrome's own installability check, not ours);
//   2. a reload with the network off still opens the app;
//   3. after a deploy the next load shows the new build, not the cached one.
//
//   bash scripts/build-pages.sh
//   node scripts/probe-pwa.mjs --dir build/pages/public
//
// The bundle is copied to a temp directory, so the simulated deploy changes the
// copy and never the build output. Chrome is the same one render-shot uses.

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import {
  chromePath, connection, devtoolsTarget, freePort, sleep,
} from "./render-shot.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const source = resolve(opt("--dir", "build/pages/public"));
const keep = args.includes("--keep");

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function serve(root) {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const file = join(root, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file.startsWith(root + sep) || pathname.includes("..")) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] || "application/octet-stream",
        "Content-Length": body.length,
        // A realistic static host: HTML revalidates, assets may sit in the
        // HTTP cache. What is under test is the worker, not the HTTP cache.
        "Cache-Control": extname(file) === ".html"
          ? "no-cache, must-revalidate"
          : "public, max-age=60",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  });
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({ server, port: server.address().port }));
  });
}

async function browser() {
  const free = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "bankpipe-pwa-"));
  const child = spawn(chromePath(), [
    "--headless=new", "--disable-gpu", "--mute-audio",
    `--remote-debugging-port=${free}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  const target = await devtoolsTarget(free);
  const link = connection(target.webSocketDebuggerUrl);
  await link.ready;
  return { child, profile, ...link };
}

async function main() {
  readFileSync(join(source, "manifest.webmanifest"), "utf8");
  const root = mkdtempSync(join(tmpdir(), "bankpipe-pwa-bundle-"));
  cpSync(source, root, { recursive: true });

  const { server, port } = await serve(root);
  const base = `http://127.0.0.1:${port}`;
  let session = null;

  try {
    session = await browser();
    const { send, close } = session;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");

    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description
          || result.exceptionDetails.text || "page script failed");
      }
      return result.result?.value;
    };

    const waitFor = async (expression, label, timeout = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression).catch(() => false)) return true;
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const open = async () => {
      await send("Page.navigate", { url: `${base}/` });
      await waitFor('document.readyState === "complete"', "the page to load");
    };

    // A reload keeps the old document until the new one commits, so wait for a
    // window global that the old document set and the new one cannot have.
    const reload = async () => {
      await evaluate("window.__bpProbePrevious = true").catch(() => {});
      await send("Page.reload");
      await waitFor('document.readyState === "complete" && !window.__bpProbePrevious',
        "the reload to commit");
    };

    await open();
    await evaluate("navigator.serviceWorker.ready.then((r) => !!r.active)");
    await waitFor("!!navigator.serviceWorker.controller", "the worker to control the page");
    check("the worker is active and controls the page", true);

    // beforeinstallprompt is the browser's own "this can be installed" signal;
    // it is the same event the Settings button spends.
    await waitFor("!!window.bpInstallPrompt", "the install prompt", 20000);
    check("the browser offered the install prompt", true);

    const bugs = await send("Page.getInstallabilityErrors");
    const errors = (bugs.installabilityErrors || []).map((e) => e.errorId);
    check("Chrome finds no installability error", errors.length === 0, errors.join(", "));

    const manifestInfo = await send("Page.getAppManifest");
    const manifestErrors = (manifestInfo.errors || []).map((e) => e.message || e);
    check("the browser parsed the manifest", manifestErrors.length === 0,
      manifestErrors.join("; "));

    const cacheReport = await evaluate(`(async () => {
      const names = await caches.keys();
      const urls = [];
      for (const name of names) {
        for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
      }
      return { names, urls };
    })()`);
    check("at least one cache exists", cacheReport.names.length > 0, cacheReport.names.join(", "));
    const privateUrls = cacheReport.urls.filter((url) => {
      const path = new URL(url).pathname;
      return /\.(bpk|db|db-wal|db-shm|sqlite3?)$/i.test(path)
        || /\/(private|db)\//i.test(path);
    });
    check("no database or vault path is in a cache", privateUrls.length === 0,
      privateUrls.join(", "));

    // --- offline ------------------------------------------------------------
    await send("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await reload();
    await waitFor('document.querySelector(".brand")?.textContent === "BankPipe"',
      "the shell to render offline");
    const offlineCards = await evaluate('document.querySelectorAll("#view .card").length');
    check("an offline reload renders the app", offlineCards > 0, `${offlineCards} cards`);

    await evaluate('window.go("settings")');
    await waitFor('!!document.getElementById("storage-state")', "the settings card offline");
    await waitFor(
      '/^Storage: (protected|can be cleared)/.test('
        + 'document.getElementById("storage-state")?.textContent || "")',
      "the storage answer offline",
    );
    const offlineStorage = await evaluate(
      'document.getElementById("storage-state")?.textContent || ""',
    );
    check("the offline build reaches Settings", offlineStorage.startsWith("Storage:"),
      offlineStorage);

    // --- deploy -------------------------------------------------------------
    await send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    const indexPath = join(root, "index.html");
    const before = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, before.replace("</head>",
      '<meta name="bp-probe-build" content="deploy-2"></head>'));
    const versionFile = join(root, "version.json");
    const previous = JSON.parse(readFileSync(versionFile, "utf8"));
    writeFileSync(versionFile, JSON.stringify({
      version: "probe-2", commit: "probe", built: new Date().toISOString(),
    }));

    await reload();
    const deployState = await evaluate(`(async () => ({
      marker: document.querySelector("meta[name=bp-probe-build]")?.content || "",
      head: document.head.innerHTML.includes("bp-probe-build"),
      fetched: (await (await fetch("index.html", { cache: "no-store" })).text())
        .includes("bp-probe-build"),
      controlled: !!navigator.serviceWorker.controller,
      href: location.href,
    }))()`);
    check("a deploy replaces index.html on the next load", deployState.marker === "deploy-2",
      JSON.stringify(deployState));

    await evaluate('window.go("settings")');
    await waitFor('!!document.querySelector(".pwa-install")', "the install button");
    check("Settings shows the install button when installable", true);
    await waitFor(
      '(document.getElementById("about-version")?.textContent || "").includes("probe-2")',
      "the new version on Settings",
    );
    const shown = await evaluate(
      'document.getElementById("about-version")?.textContent || ""',
    );
    check("Settings shows the new version, not the old one",
      shown.includes("probe-2") && !shown.includes(previous.version), shown.trim());

    await waitFor(
      '/^Storage: (protected|can be cleared)/.test('
        + 'document.getElementById("storage-state")?.textContent || "")',
      "the storage answer after the deploy",
    );
    const storageLine = await evaluate(
      'document.getElementById("storage-state")?.textContent || ""',
    );
    check("the storage result is shown", /^Storage: (protected|can be cleared)/.test(storageLine),
      storageLine);
    const backupTruth = await evaluate(
      'document.body.textContent.includes("Clearing site data still deletes everything. '
        + 'A backup is the only copy that survives.")',
    );
    check("the backup truth is on Settings", backupTruth === true);

    // --- a new worker -------------------------------------------------------
    // The deploy stamp is what makes the browser install a new worker. Prove
    // that the previous cache is gone, not merely that a second one exists.
    const swPath = join(root, "sw.js");
    writeFileSync(swPath, readFileSync(swPath, "utf8")
      .replace(/export const BUILD = "[^"]*";/, 'export const BUILD = "probe-3";'));
    await reload();
    await waitFor(`(async () => {
      const names = await caches.keys();
      return names.includes("bankpipe-shell-probe-3")
        && ${JSON.stringify(cacheReport.names)}.every((old) => !names.includes(old));
    })()`, "the new worker to replace the old cache", 20000);
    check("a new worker deletes the previous cache", true, "bankpipe-shell-probe-3");

    // --- hard reload --------------------------------------------------------
    // The control must refetch the document and drop the shell, while the two
    // things a person cannot recreate (the database and their settings) stay.
    await evaluate(`(async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("bp-probe", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("sentinel");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("sentinel", "readwrite");
          tx.objectStore("sentinel").put("still here", "key");
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      localStorage.setItem("bp.theme", "dark");
      const stale = await caches.open("bankpipe-shell-stale");
      await stale.put("/stale.txt", new Response("old build"));
      const keep = await caches.open("probe-keep");
      await keep.put("/keep.txt", new Response("unrelated"));
    })()`);

    await evaluate("window.__bpProbePrevious = true");
    await evaluate('document.getElementById("reload-app").click()');
    await waitFor('document.readyState === "complete" && !window.__bpProbePrevious',
      "the hard reload to commit");

    const hard = await evaluate(`(async () => {
      const dbValue = await new Promise((resolve) => {
        const open = indexedDB.open("bp-probe", 1);
        open.onerror = () => resolve("db-error");
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction("sentinel").objectStore("sentinel").get("key");
          req.onsuccess = () => { const value = req.result; db.close(); resolve(value); };
          req.onerror = () => { db.close(); resolve("read-error"); };
        };
      });
      const names = await caches.keys();
      return {
        href: location.href,
        busted: new URL(location.href).searchParams.has("bp_reload"),
        theme: localStorage.getItem("bp.theme"),
        dbValue,
        marker: document.querySelector("meta[name=bp-probe-build]")?.content || "",
        stale: names.includes("bankpipe-shell-stale"),
        keep: names.includes("probe-keep"),
      };
    })()`);
    check("a hard reload refetches the document with a cache-busting query",
      hard.busted && hard.marker === "deploy-2", hard.href);
    check("a hard reload loads the latest build", hard.marker === "deploy-2", hard.marker);
    check("a hard reload leaves IndexedDB alone", hard.dbValue === "still here", hard.dbValue);
    check("a hard reload leaves the theme setting alone", hard.theme === "dark", hard.theme);
    check("a hard reload deletes the stale shell cache", hard.stale === false);
    check("a hard reload leaves an unrelated cache alone", hard.keep === true);
  } finally {
    try { session?.close?.(); } catch { /* already closed */ }
    try { session?.child?.kill(); } catch { /* already gone */ }
    try { server.close(); } catch { /* already closed */ }
    if (session?.profile) {
      try { rmSync(session.profile, { recursive: true, force: true, maxRetries: 5 }); }
      catch { /* Chrome may still hold it; the OS temp dir can keep it */ }
    }
    if (!keep) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
      catch { /* same */ }
    } else {
      console.log(`bundle kept at ${root}`);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.error(`\n${failed.length} of ${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`\nall ${checks.length} checks passed`);
}

await main();
