#!/usr/bin/env node
// Every source guide is a numbered file list, with the download path on each
// line. This opens each of the five guides in the real Import screen at 390 and
// 604, light and dark, and fails when a line loses its path, the check line
// disappears, the format chip disappears, a link is not a 44px primary button,
// or the guide runs past its card.
//
//   node scripts/render-import-guides.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-guides.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;
const GUIDES = {
  cas: {
    format: "PDF",
    files: ["Depository statement PDF — NSDL or CDSL → CAS, after month end."],
    check: "Password is your PAN in capitals.",
    links: ["Open CDSL CAS ↗", "Open NSDL CAS ↗"],
  },
  zerodha: {
    format: "XLSX",
    files: ["Holdings XLSX — Console → Holdings → XLSX, top right of the list."],
    check: "A snapshot from the date chip, not a date range, and not the Tradebook.",
    links: ["Open Holdings ↗"],
  },
  motilal: {
    format: "PDF",
    files: ["Holding Summary PDF — Profile → Reports → Holding Summary - All Assets → Get Reports → Download from Report Status."],
    check: "Password is your PAN in capitals.",
    links: ["Open Reports ↗"],
  },
  icici: {
    format: "CSV",
    files: ["Demat holdings CSV — Stocks → Demat holdings → Download CSV."],
    check: "Not the tradebook.",
    links: ["Open Demat Holdings ↗"],
  },
  digifinn: {
    format: "CSV",
    files: ["Portfolio Report CSV — Reports & Documents.",
      "[Optional] Payouts CSV — adds interest dates."],
    check: "",
    links: ["Open DigiFinn ↗"],
  },
};
const SHOTS = [{ width: 390, height: 900 }, { width: 604, height: 900 }];
const THEMES = ["light", "dark"];

const pageScript = (key) => `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  go("import");
  await sleep(800);
  bpImportTypeToggle(${JSON.stringify(key)});
  await sleep(150);
  const guide = document.querySelector('.import-type-guide[data-guide="${key}"]:not([hidden])');
  if (!guide) throw new Error("${key} guide did not open");
  guide.scrollIntoView({ block: "start" });
  window.scrollBy(0, -20);
  await sleep(150);
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: +r.left.toFixed(1), right: +r.right.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
  };
  const items = [...guide.querySelectorAll(".eq-guide-steps > li")].map(text);
  const muted = [...guide.querySelectorAll(":scope > .muted")].map(text)
    .filter((line) => line !== "Then drop it above.");
  const links = [...guide.querySelectorAll(".import-type-links a")].map((node) => ({
    label: text(node), box: box(node), primary: node.classList.contains("primary"),
  }));
  const chip = document.querySelector('.import-type[data-type="${key}"] .import-type-note');
  const card = guide.closest(".card") || guide.parentElement;
  return JSON.stringify({
    key: ${JSON.stringify(key)},
    visible: [...document.querySelectorAll(".import-type-guide:not([hidden])")]
      .map((node) => node.dataset.guide),
    title: text(guide.querySelector(":scope > b")),
    format: text(chip),
    items,
    check: muted[0] || "",
    links,
    guide: box(guide),
    card: box(card),
    bar: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
  });
})()`;

function check(state, want) {
  const wrong = [];
  if (state.visible.join(",") !== state.key) {
    wrong.push(`open guides: ${JSON.stringify(state.visible)}`);
  }
  if (!state.title) wrong.push("the guide has no title");
  if (state.format !== want.format) {
    wrong.push(`format chip: ${JSON.stringify(state.format)}, want ${JSON.stringify(want.format)}`);
  }
  if (JSON.stringify(state.items) !== JSON.stringify(want.files)) {
    wrong.push(`files: ${JSON.stringify(state.items)}`);
  }
  if (state.check !== want.check) {
    wrong.push(`check line: ${JSON.stringify(state.check)}`);
  }
  if (JSON.stringify(state.links.map((link) => link.label)) !== JSON.stringify(want.links)) {
    wrong.push(`links: ${JSON.stringify(state.links.map((link) => link.label))}`);
  }
  for (const link of state.links) {
    if (!link.primary) wrong.push(`${link.label} is not a primary button`);
    if (link.box.height < 44) wrong.push(`${link.label} is ${link.box.height}px tall`);
  }
  if (state.guide.width < 250) wrong.push(`the guide is only ${state.guide.width}px wide`);
  if (state.guide.left < state.card.left - 0.5
    || state.guide.right > state.card.right + 0.5) {
    wrong.push(`the guide runs past its card: ${JSON.stringify(state.guide)} vs `
      + JSON.stringify(state.card));
  }
  if (state.bar.scrollWidth > state.bar.width) {
    wrong.push(`the page scrolls sideways: ${JSON.stringify(state.bar)}`);
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-guides: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-guides: --out-dir needs a value");
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
  throw new Error("render-import-guides: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-guides-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const [key, want] of Object.entries(GUIDES)) {
    const script = join(dir, `${key}.js`);
    writeFileSync(script, pageScript(key));
    for (const shot of SHOTS) {
      for (const theme of THEMES) {
        const out = join(args.outDir, `import-guides-${key}-${shot.width}-${theme}.png`);
        const result = await capture({
          page, out, script, wait: 1600,
          width: shot.width, height: shot.height, theme,
        });
        const state = JSON.parse(result.value);
        const wrong = check(state, want);
        if (wrong.length) {
          throw new Error(`render-import-guides: ${key} at ${shot.width} ${theme}\n  `
            + `${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
        }
        console.log(`${out}  ${state.items.length} file${state.items.length === 1 ? "" : "s"}`);
      }
    }
  }
  console.log("import guides: numbered files with paths, format chips, check lines and "
    + "44px primary links · 390/604 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
