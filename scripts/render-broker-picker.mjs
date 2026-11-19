#!/usr/bin/env node
// Every broker in the demat picker carries a mark, and a mark that fails to load
// leaves the tile as text without moving the row.
//
// The check is a render, not a source read: it reads each tile's box, each
// image's loaded size and the tile's height after one image is pointed at a
// missing file. The shots are 390 and 1280, light and dark, normal and fallback.
//
//   node scripts/render-broker-picker.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-broker-picker.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;
const BROKERS = ["digifinn", "motilal", "zerodha", "icici"];
const SHOTS = [{ width: 390, height: 900 }, { width: 768, height: 900 }, { width: 1280, height: 900 }];

const pageScript = (breakId = "") => `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  go("import");
  await sleep(1000);
  const details = document.getElementById("import-help");
  if (details) details.open = true;
  const tiles = () => [...document.querySelectorAll(".broker-tile")];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tiles().length === 4 && tiles().every((tile) => {
      const img = tile.querySelector("img");
      return img && img.complete;
    })) break;
    await sleep(100);
  }
  ${breakId ? `{
    const broken = tiles().find((tile) => (tile.getAttribute("onclick") || "").includes("'${breakId}'"));
    const img = broken?.querySelector("img");
    if (!img) throw new Error("no ${breakId} mark to break");
    img.src = "broker-logos/__missing__.webp";
    for (let attempt = 0; attempt < 40 && img.isConnected; attempt += 1) await sleep(100);
  }` : ""}
  const tilesNow = tiles();
  tilesNow[0]?.scrollIntoView({ block: "center" });
  await sleep(300);
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { width: +r.width.toFixed(2), height: +r.height.toFixed(2), top: +r.top.toFixed(2) };
  };
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  return JSON.stringify({
    viewport: innerWidth,
    tiles: tilesNow.map((tile) => {
      const img = tile.querySelector("img");
      const spans = [...tile.querySelectorAll(":scope > span")];
      return {
        id: (tile.getAttribute("onclick") || "").replace(/.*'([^']+)'.*/, "$1"),
        box: box(tile),
        label: text(spans[0]),
        where: text(spans[1]),
        img: img ? {
          box: box(img),
          loaded: img.complete && img.naturalWidth > 0,
          natural: [img.naturalWidth, img.naturalHeight],
          src: img.getAttribute("src"),
        } : null,
      };
    }),
  });
})()`;

function check(state, { breakId = "" } = {}) {
  const wrong = [];
  if (state.tiles.length !== BROKERS.length) {
    wrong.push(`want ${BROKERS.length} tiles, got ${state.tiles.length}`);
  }
  if (state.tiles.map((tile) => tile.id).join() !== BROKERS.join()) {
    wrong.push(`tile order: ${state.tiles.map((tile) => tile.id).join()}`);
  }
  const heights = state.tiles.map((tile) => tile.box.height);
  const tallest = Math.max(...heights);
  if (tallest < 44) wrong.push(`tile height ${tallest} is under the 44px touch floor`);
  if (tallest - Math.min(...heights) > 0.5) {
    wrong.push(`tiles are not one height: ${JSON.stringify(heights)}`);
  }
  for (const tile of state.tiles) {
    if (!tile.label || !tile.where) wrong.push(`${tile.id} lost its text label`);
    if (tile.id === breakId) {
      if (tile.img) wrong.push(`${tile.id} still holds an image after the missing file`);
      if (tile.box.height !== tallest) {
        wrong.push(`${tile.id} fallback height ${tile.box.height}, row height ${tallest}`);
      }
      continue;
    }
    if (!tile.img?.loaded) {
      wrong.push(`${tile.id} mark did not load: ${JSON.stringify(tile.img)}`);
      continue;
    }
    if (!tile.img.src?.startsWith("broker-logos/")) {
      wrong.push(`${tile.id} mark is not bundled: ${tile.img.src}`);
    }
    if (tile.img.box.height !== 20) {
      wrong.push(`${tile.id} mark height ${tile.img.box.height}, want 20`);
    }
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-broker-picker: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-broker-picker: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "web/server.mjs")], {
    env: { ...process.env, PORT: String(port) }, stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return { port, child };
    } catch { /* still starting */ }
  }
  child.kill();
  throw new Error("render-broker-picker: web/server.mjs did not answer.");
}

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

mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-broker-picker-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of [
        { name: "marked", breakId: "" },
        { name: "fallback", breakId: "zerodha" },
      ]) {
        const script = join(dir, `${scenario.name}.js`);
        writeFileSync(script, pageScript(scenario.breakId));
        const out = join(args.outDir,
          `broker-picker-${scenario.name}-${shot.width}-${theme}.png`);
        const result = await capture({
          page, out, script, wait: 1600,
          width: shot.width, height: shot.height, theme,
        });
        const state = JSON.parse(result.value);
        const wrong = check(state, { breakId: scenario.breakId });
        if (wrong.length) {
          throw new Error(`render-broker-picker: ${scenario.name} at ${shot.width} ${theme}\n  `
            + `${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
        }
        console.log(out);
      }
    }
  }
  console.log("broker picker: four marks at one height, 44px tiles, text fallback keeps "
    + "the row height · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
