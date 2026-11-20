#!/usr/bin/env node
// Renders four synthetic bond lots with the four provenance states the card
// has to name: a demat statement, the same row enriched by SMEST, a lot entered
// by hand, and a lot with no nameable source. Asserts the foot text and the gap
// line from the rendered page, then shoots 390 and 1280 in both themes.
//
//   node scripts/render-bond-provenance.mjs [--out-dir DIR]
//
// Synthetic rows only.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-provenance.mjs [--out-dir DIR]

  --out-dir  where the PNGs go, default build/renders/bond-provenance
`;

const AS_OF = "2026-11-20";

const ROWS = [
  {
    // The owner's shape: the demat file supplied the quantity and the statement
    // value; cost and terms are still missing.
    security_id: "INE000000201",
    label: "TEST DEMAT IMPORT 15 May 2031",
    issuer: "TEST DEMAT ISSUER",
    category: "bond", quantity: 10, value_paise: 5015050,
    value_source: "ICICI Direct holdings", as_of: AS_OF, source: "report",
  },
  {
    // The same row after a SMEST lookup stored the terms.
    security_id: "INE000000202",
    label: "7.40% TEST SMEST 10 Feb 2030",
    issuer: "TEST SMEST ISSUER",
    category: "bond", quantity: 10, cost_paise: 1000000,
    value_paise: 1010000, value_source: "ICICI Direct holdings", as_of: AS_OF,
    coupon_pct: 7.4, maturity: "2030-02-10", frequency: "Annual",
    purchase_date: "2026-01-05",
    coupon_source: "SMEST", coupon_as_of: AS_OF,
    maturity_source: "SMEST", maturity_as_of: AS_OF,
    face_source: "SMEST", face_as_of: AS_OF, source: "report",
  },
  {
    // Typed into the form: no file to name.
    security_id: "INE000000203",
    label: "7.40% TEST MANUAL 10 Feb 2030",
    issuer: "TEST MANUAL ISSUER",
    category: "bond", quantity: 10,
    value_paise: 1010000, value_source: "Manual", as_of: AS_OF,
    coupon_pct: 7.4, maturity: "2030-02-10", frequency: "Annual",
    purchase_date: "2026-01-05", source: "manual",
  },
  {
    // A legacy row with neither a file nor a value: the foot stays empty.
    security_id: "INE000000204",
    label: "TEST NO SOURCE 15 May 2031",
    issuer: "TEST UNSOURCED ISSUER",
    category: "bond", quantity: 10, source: "",
  },
];

const EXPECTED = {
  "TEST DEMAT IMPORT 15 May 2031": {
    foot: "from ICICI Direct holdings · 20 Nov 2026",
    gap: "No cost or terms yet. Your dealer's report has both. Import",
  },
  "7.40% TEST SMEST 10 Feb 2030": {
    foot: "value from ICICI Direct holdings · 20 Nov 2026"
      + " · terms from SMEST · 20 Nov 2026 · interest estimated",
    gap: "",
  },
  "7.40% TEST MANUAL 10 Feb 2030": {
    foot: "entered by hand",
    gap: "Cost not known yet Import",
  },
  "TEST NO SOURCE 15 May 2031": {
    foot: "",
    gap: "No cost, terms or value yet. Your dealer's report has the cost and terms. Import",
  },
};

function pageScript() {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  for (const row of await store.listHoldings(demat.id)) await store.deleteHolding(row.id);
  for (const row of ${JSON.stringify(ROWS)}) await store.upsertHolding(demat.id, row);
  store.query("UPDATE holding SET source='report' WHERE security_id IN (?,?)",
    ["INE000000201", "INE000000202"]);
  store.query("UPDATE holding SET source='' WHERE security_id=?", ["INE000000204"]);
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1800);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const grid = document.querySelector(".bond-cards");
  if (!grid) throw new Error("the bond card grid is missing");
  window.scrollTo(0, grid.getBoundingClientRect().top + window.scrollY - 64);
  await sleep(250);
  const cards = [...document.querySelectorAll(".bond-cards .bond-card")];
  const states = cards.map((card) => ({
    name: text(card.querySelector(".bond-name")),
    foot: text(card.querySelector('[data-fact="sources"]')),
    gap: text(card.querySelector(".bond-gap-line")),
  }));
  return JSON.stringify({
    width: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth
      > document.documentElement.clientWidth + 1,
    cards: states.length,
    states,
  });
})()`;
}

const SHOTS = [
  { width: 390, height: 2400, theme: "light" },
  { width: 390, height: 2400, theme: "dark" },
  { width: 1280, height: 1800, theme: "light" },
  { width: 1280, height: 1800, theme: "dark" },
];

function parseArgs(argv) {
  const args = { outDir: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { args.help = true; continue; }
    if (flag !== "--out-dir") {
      throw new Error(`render-bond-provenance: unknown flag ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-provenance: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  if (!args.outDir) args.outDir = join(ROOT, "build/renders/bond-provenance");
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function verify(state, { width, theme }) {
  const where = `${width} ${theme}`;
  const fail = (message) => {
    throw new Error(`render-bond-provenance (${where}): ${message}`);
  };
  if (state.width !== width) fail(`asked for ${width}px, got ${state.width}px`);
  if (state.pageOverflow) fail("the page scrolls horizontally");
  if (state.cards !== ROWS.length) {
    fail(`expected ${ROWS.length} cards, got ${state.cards}`);
  }
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = state.states.find((card) => card.name === name);
    if (!got) { fail(`no card named ${name}`); continue; }
    if (got.foot !== want.foot) {
      fail(`${name} foot is ${JSON.stringify(got.foot)}, want ${JSON.stringify(want.foot)}`);
    }
    if (got.gap !== want.gap) {
      fail(`${name} gap is ${JSON.stringify(got.gap)}, want ${JSON.stringify(want.gap)}`);
    }
    if (/\breport\b/.test(got.foot)) {
      fail(`${name} prints a bare report in its foot: ${JSON.stringify(got.foot)}`);
    }
  }
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
  throw new Error("render-bond-provenance: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-provenance-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript());
    const out = join(args.outDir,
      `bond-provenance-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    verify(state, shot);
    console.log(`${out} · ${state.states.map((card) => `${card.name}: ${card.foot || "(none)"}`)
      .join(" · ")}`);
  }
  console.log(`bond provenance: ${ROWS.length} states · 390/1280 light and dark`);
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
