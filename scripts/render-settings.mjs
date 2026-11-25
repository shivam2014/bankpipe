#!/usr/bin/env node
// Settings at 390 and 1280, light and dark: the top of the page, the Advanced
// disclosure closed, and the same disclosure open.
//
//   node scripts/render-settings.mjs [--out-dir build/renders]
//
// The script fails when Backup and restore is not the first card, when the
// Advanced contents are in the wrong order, when the disclosure starts open,
// when a Verify an import card is still present, or when the page scrolls
// sideways. Every check is read from the live page.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort, sleep } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-settings.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const ORDER = [
  "Backup and restore",
  "Light or dark",
  "This device",
  "Erase this browser's data",
  "Bank logins",
  "What is local and what is not",
  "About",
];
const ADVANCED = ["Audit data", "Diagnostics", "Workbook metadata"];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--out-dir") {
      args.outDir = argv[++i];
      if (!args.outDir) throw new Error("render-settings: --out-dir needs a value");
      continue;
    }
    throw new Error(`render-settings: unknown flag ${flag}`);
  }
  return args;
}

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
  throw new Error("render-settings: web/server.mjs did not answer.");
}

// The page script opens Settings through its own nav, then reads the rendered
// text. It never reaches into a module: the app's click path is the test.
function pageScript({ state }) {
  return `(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const nav = document.querySelector('#nav button[data-v="settings"]')
      || document.querySelector('#tabbar button[data-v="settings"]');
    if (!nav) throw new Error("Settings nav button is missing");
    nav.click();
    await wait(900);
    const view = document.getElementById("view");
    if (!view) throw new Error("Settings view is missing");
    const details = view.querySelector("details.settings-advanced");
    if (!details) throw new Error("the Advanced disclosure is missing");
    if (${state === "open" ? "true" : "false"}) {
      details.querySelector("summary").click();
      await wait(250);
    }
    if (${state === "top" ? "true" : "false"}) {
      window.scrollTo(0, 0);
    } else if (details) {
      details.scrollIntoView({ block: "start" });
    }
    await wait(150);
    const html = view.innerHTML;
    const text = (el) => (el ? el.textContent.trim().replace(/\\s+/g, " ") : "");
    const headings = [...view.querySelectorAll(":scope > .card h2, :scope > details > summary")]
      .map(text);
    const advancedHeadings = details
      ? [...details.querySelectorAll(".card h2")].map(text)
      : [];
    const verifyCard = [...view.querySelectorAll(".card h2")]
      .some((h) => text(h) === "Verify an import");
    const expectedOrder = ${JSON.stringify(ORDER)};
    const positions = expectedOrder.map((label) => html.indexOf(label));
    const ordered = positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1]));
    const advancedAfterAbout = details
      ? html.indexOf("Advanced") > html.indexOf("About") : false;
    return JSON.stringify({
      width: window.innerWidth,
      state: ${JSON.stringify(state)},
      headings,
      ordered,
      advanced: !!details,
      advancedOpen: !!details?.open,
      advancedHeadings,
      advancedAfterAbout,
      verifyCard,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    });
  })()`;
}

function wrong(state) {
  const problems = [];
  const backupAt = state.headings.indexOf("Backup and restore");
  if (backupAt < 0 || backupAt > 1) {
    problems.push(`Backup and restore is heading ${backupAt}, not the first content card`);
  }
  if (!state.ordered) problems.push("a Settings card moved out of order");
  if (state.scrollWidth > state.clientWidth + 1) {
    problems.push(`page scrolls sideways: ${state.scrollWidth} > ${state.clientWidth}`);
  }
  if (!state.advanced) problems.push("the Advanced disclosure is missing");
  if (state.state === "closed" && state.advancedOpen) {
    problems.push("Advanced starts open");
  }
  if (state.state === "open" && !state.advancedOpen) {
    problems.push("Advanced did not open");
  }
  if (!state.advancedAfterAbout) problems.push("Advanced is not at the bottom");
  if (state.advancedHeadings.join(" → ") !== ADVANCED.join(" → ")) {
    problems.push(`Advanced order is ${state.advancedHeadings.join(" → ")}`);
  }
  if (state.verifyCard) problems.push("Verify an import still has a Settings card");
  return problems;
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-settings-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
const themes = ["light", "dark"];
const widths = [390, 1280];
const states = ["top", "closed", "open"];
try {
  for (const width of widths) {
    for (const theme of themes) {
      for (const state of states) {
        const script = join(dir, `settings-${state}-${width}-${theme}.js`);
        writeFileSync(script, pageScript({ state }));
        const out = join(args.outDir, `settings-${state}-${width}-${theme}.png`);
        const result = await capture({
          page, out, script, wait: 1600,
          width, height: state === "top" ? 1000 : 900, theme,
        });
        const seen = JSON.parse(result.value);
        const problems = wrong(seen);
        if (problems.length) {
          throw new Error(`${out}: ${problems.join("; ")}`);
        }
        console.log(out);
      }
    }
  }
  console.log("settings: Backup and restore first, Advanced at the bottom closed by default · "
    + "Audit data → Diagnostics → Workbook metadata · 390 and 1280, light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
