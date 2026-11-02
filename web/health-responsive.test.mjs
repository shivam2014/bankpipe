// Layout guard for the stacked Health tables and the wide transactions table.
// It drives the real page in headless Chrome at 390 and 640 CSS px, seeds the
// fixture statement with the app's own selftest route, and measures the three
// acceptance rules: the document does not scroll sideways, no card overflows,
// and no table cell clips its text. Skipped when Chrome is not installed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const CHROME = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !existsSync(CHROME) || typeof WebSocket !== "function";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, ms = 15000, label = "") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("timeout: " + label);
}

test("Health and transactions fit at 390 and 640 px", { skip, timeout: 90000 }, async () => {
  let server = null;
  let chrome = null;
  let profile = "";
  let ws = null;
  try {
    const port = await freePort();
    let serverLog = "";
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: WEB,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (d) => { serverLog += d; });
    server.stderr.on("data", (d) => { serverLog += d; });
    await waitFor(() => serverLog.includes("BankPipe web"), 15000,
      "web server: " + serverLog);

    profile = mkdtempSync(join(tmpdir(), "bp-layout-"));
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

    const devtools = await (async () => {
      const file = join(profile, "DevToolsActivePort");
      await waitFor(() => existsSync(file), 15000, "DevToolsActivePort");
      return readFileSync(file, "utf8").split("\n")[0];
    })();
    const target = await (await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`,
      { method: "PUT" })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let nextId = 0;
    const pending = new Map();
    const waiters = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        if (message.error) p.reject(new Error(JSON.stringify(message.error)));
        else p.resolve(message.result);
        return;
      }
      for (const fn of waiters.get(message.method) || []) fn(message.params);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const once = (method, ms = 15000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout " + method)), ms);
      const fn = (params) => {
        clearTimeout(timer);
        waiters.set(method, (waiters.get(method) || []).filter((x) => x !== fn));
        resolve(params);
      };
      if (!waiters.has(method)) waiters.set(method, []);
      waiters.get(method).push(fn);
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const measure = async () => {
      const raw = await evaluate(`(() => {
        const de = document.documentElement;
        return {
          root: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth },
          cards: [...document.querySelectorAll('.card')].map((c) => ({
            sw: c.scrollWidth, cw: c.clientWidth, cls: String(c.className).slice(0, 60) })),
          cells: [...document.querySelectorAll('td')].map((td) => ({
            sw: td.scrollWidth, cw: td.clientWidth,
            text: String(td.textContent || '').trim().slice(0, 40) })),
        };
      })()`);
      return {
        root: { sw: raw.root.scrollWidth, cw: raw.root.clientWidth },
        cards: raw.cards.filter((c) => c.sw > c.cw + 1),
        cells: raw.cells.filter((c) => c.sw > c.cw + 1),
      };
    };
    const view = (name) => `document.getElementById('view').innerHTML`;
    const waitForTable = (name) => waitFor(() => evaluate(
      `!!document.querySelector('[data-table="${name}"]')`), 10000, name);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride",
      { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    const loaded = once("Page.loadEventFired");
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?selftest=seed` });
    await loaded;
    await waitFor(async () => {
      const text = await evaluate(view());
      if (text.includes("SEEDED")) return true;
      if (text.includes("ERR ")) throw new Error(text);
      return false;
    }, 20000, "seed");
    await evaluate("localStorage.setItem('bp.mode','real')");

    await evaluate("go('gaps')");
    await waitForTable("health-statements");
    const health390 = await measure();

    await evaluate("go('transactions')");
    await waitForTable("transactions");
    const tx390 = await measure();

    await send("Emulation.setDeviceMetricsOverride",
      { width: 640, height: 900, deviceScaleFactor: 1, mobile: true });
    await evaluate("go('gaps')");
    await waitForTable("health-statements");
    const health640 = await measure();

    await evaluate("go('transactions')");
    await waitForTable("transactions");
    const tx640 = await measure();

    for (const [label, m] of Object.entries({
      "Health 390": health390, "Transactions 390": tx390,
      "Health 640": health640, "Transactions 640": tx640,
    })) {
      assert.equal(m.root.sw, m.root.cw,
        `${label}: document ${JSON.stringify(m.root)}`);
      assert.deepEqual(m.cards, [],
        `${label}: card overflow ${JSON.stringify(m.cards)}`);
      assert.deepEqual(m.cells, [],
        `${label}: cell overflow ${JSON.stringify(m.cells)}`);
    }
  } finally {
    try { ws?.close(); } catch (e) {}
    chrome?.kill("SIGKILL");
    server?.kill("SIGKILL");
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
});
