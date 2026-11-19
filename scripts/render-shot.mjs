#!/usr/bin/env node
// One screenshot at an exact CSS width, through the Chrome DevTools Protocol.
//
// Headless Chrome on macOS clamps --window-size to 500px, so a 390 window is a
// 500px layout cropped at 390. This sets the width with
// Emulation.setDeviceMetricsOverride and fails if the width it got is not the
// width it asked for, so a phone render is never a cropped desktop one.
//
//   node scripts/render-shot.mjs --page http://127.0.0.1:8801/?demo=1 \
//     --width 390 --theme dark --out build/renders/shot.png
//
// --page takes a URL or a file path. --script is a JS file evaluated in the page
// after load and before the shot; its returned value is printed.
//
// Chrome is found through CHROME, then the two macOS app paths, then PATH.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `usage: node scripts/render-shot.mjs --page <url|file> --width <px> --out <png>
       [--theme light|dark] [--height 900] [--wait 800] [--script <file>]
       [--then-width <px>] [--then-script <file>] [--scale 2]

  --page         URL, or a path to an HTML file
  --width        CSS pixels; the run fails if the page is not exactly this wide
  --theme        sets data-theme on <html> before the shot
  --out          PNG path
  --script       JS file run in the page after load; print what it returns
  --then-width   second CSS width applied after the first shot, for a resize check
  --then-script  JS file run after --then-width; print what it returns
  --height       CSS pixels, default 900
  --wait         ms to settle after load, default 800
  --scale        device pixel ratio, default 2
`;

const CHROME_PATHS = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export function chromePath() {
  for (const path of CHROME_PATHS) {
    if (path && existsSync(path)) return path;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      const found = execFileSync("/bin/sh", ["-c", `command -v ${name}`],
        { encoding: "utf8" }).trim();
      if (found) return found;
    } catch { /* try the next binary */ }
  }
  throw new Error("render-shot: no Chrome found. Set CHROME=/path/to/chrome.");
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function devtoolsTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((item) => item.type === "page");
      if (target) return target;
    } catch { /* chrome is still starting */ }
  }
  throw new Error("render-shot: Chrome did not open a devtools target.");
}

export function connection(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const slot = pending.get(message.id);
    if (slot) { pending.delete(message.id); slot(message); }
  });
  const ready = new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = nextId++;
    pending.set(id, (message) => {
      if (message.error) fail(new Error(`render-shot: ${method} failed: ${message.error.message}`));
      else done(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => socket.close() };
}

const isUrl = (value) => /^(https?|file):/i.test(value);
const pageUrl = (page) => (isUrl(page) ? page : pathToFileURL(resolve(page)).href);

/**
 * Screenshot one page at one exact CSS width.
 * @param {{page: string, width: number|string, out: string, height?: number,
 *   theme?: string, wait?: number, script?: string, scale?: number,
 *   thenWidth?: number|string, thenScript?: string}} options
 *   `script` is a path to a JS file evaluated in the page after load.
 *   `thenWidth` applies a second width after the first shot and `thenScript`
 *   runs there, so a resize handoff can be asserted in the same page.
 */
export async function capture(options = {}) {
  const { page, out, theme = "", script = "", thenScript = "" } = options;
  const width = Number(options.width);
  const thenWidth = options.thenWidth ? Number(options.thenWidth) : 0;
  const height = Number(options.height ?? 900);
  const wait = Number(options.wait ?? 800);
  const scale = Number(options.scale ?? 2);
  if (typeof WebSocket !== "function") {
    throw new Error("render-shot: needs Node 22 or newer (global WebSocket).");
  }
  if (!page) throw new Error("render-shot: --page is required.");
  if (!out) throw new Error("render-shot: --out is required.");
  if (!Number.isFinite(width) || width < 200) {
    throw new Error(`render-shot: --width must be at least 200, got ${options.width}.`);
  }
  if (thenWidth && (!Number.isFinite(thenWidth) || thenWidth < 200)) {
    throw new Error(`render-shot: --then-width must be at least 200, got ${options.thenWidth}.`);
  }
  if (thenScript && !thenWidth) {
    throw new Error("render-shot: --then-script needs --then-width.");
  }
  if (!Number.isFinite(height) || height < 200) {
    throw new Error(`render-shot: --height must be at least 200, got ${options.height}.`);
  }

  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "bankpipe-render-"));
  const child = spawn(chromePath(), [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  let link = null;
  try {
    const target = await devtoolsTarget(port);
    link = connection(target.webSocketDebuggerUrl);
    await link.ready;
    const { send } = link;
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: scale, mobile: false,
    });
    await send("Page.navigate", { url: pageUrl(page) });
    await sleep(wait);
    if (theme) {
      await send("Runtime.evaluate",
        { expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}` });
    }
    const evaluate = async (source) => {
      const result = await send("Runtime.evaluate", {
        expression: source, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text || "unknown error";
        throw new Error(`render-shot: script threw: ${detail}`);
      }
      return String(result.result?.value ?? "");
    };
    const measure = async () => {
      const measured = await send("Runtime.evaluate", {
        expression: "[document.documentElement.clientWidth, window.innerWidth]",
        returnByValue: true,
      });
      const [clientWidth, innerWidth] = measured.result?.value || [];
      return { clientWidth, innerWidth };
    };
    const value = script ? await evaluate(readFileSync(script, "utf8")) : "";
    // The clamp is the reason this script exists: never hand back a cropped
    // desktop as if it were a phone.
    const first = await measure();
    if (first.clientWidth !== width || first.innerWidth !== width) {
      throw new Error(`render-shot: asked for ${width}px, the page is `
        + `${first.clientWidth}px (inner ${first.innerWidth}px). The window was clamped; width `
        + "must come from Emulation.setDeviceMetricsOverride.");
    }
    const shot = await send("Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    let thenValue = "";
    if (thenWidth) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: thenWidth, height, deviceScaleFactor: scale, mobile: false,
      });
      await sleep(wait);
      if (thenScript) thenValue = await evaluate(readFileSync(thenScript, "utf8"));
      const after = await measure();
      if (after.clientWidth !== thenWidth || after.innerWidth !== thenWidth) {
        throw new Error(`render-shot: asked for ${thenWidth}px after the resize, the page is `
          + `${after.clientWidth}px (inner ${after.innerWidth}px).`);
      }
    }
    return { out, width, height, theme, value, thenWidth: thenWidth || null, thenValue };
  } finally {
    try { link?.close(); } catch { /* the socket may already be gone */ }
    child.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* Chrome still holds its cache; the OS temp dir can keep it */ }
  }
}

function parseArgs(argv) {
  const args = { width: "", height: 900, wait: 800, scale: 2, theme: "",
    script: "", thenWidth: "", thenScript: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!flag.startsWith("--")) throw new Error(`render-shot: unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!["page", "width", "out", "height", "wait", "scale", "theme", "script",
      "then-width", "then-script"].includes(key)) {
      throw new Error(`render-shot: unknown flag ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`render-shot: ${flag} needs a value`);
    const name = key === "then-width" ? "thenWidth"
      : key === "then-script" ? "thenScript" : key;
    args[name] = value;
    index += 1;
  }
  return args;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  try {
    const result = await capture(args);
    if (result.value) console.log(result.value);
    if (result.thenValue) console.log(result.thenValue);
    console.log(result.out);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
