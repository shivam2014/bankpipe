#!/usr/bin/env node
// Renders the bond book at 390 and 1280 in both themes, once with a live lot
// selected and once with a matured lot. The page is the real app on the sample
// portfolio; the matured lot is written through db.js before the shot, not
// painted into the DOM by hand.
//
//   node scripts/render-bond-dossier.mjs [--out-dir build/renders]
//
// The runner refuses a shot unless the phone card and the desktop dossier carry
// the same six facts, the matured badge, and labelled actions. Synthetic data
// only.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { BOND_CARD_FACTS, BOND_MATURED_FACTS, BOND_INDEX_FACTS }
  from "../web/bond-book.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-dossier.mjs [--out-dir build/renders]

  --out-dir  where the eight PNGs go, default build/renders
`;

const LIVE_LABEL = "7.15% TEST BOND 1";
const MATURED_LABEL = "8.25% MATURED TEST BOND 15 May 2020";
const MATURED_ID = "INE000000999";

function pageScript({ matured }) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  let wanted = ${JSON.stringify(LIVE_LABEL)};
  if (${matured}) {
    await store.upsertHolding(demat.id, {
      security_id: ${JSON.stringify(MATURED_ID)},
      label: ${JSON.stringify(MATURED_LABEL)},
      category: "bond", quantity: 250, cost_paise: 25000000,
      value_paise: 25000000, face_paise: 100000,
      purchase_date: "2015-05-15", maturity: "2020-05-15",
      interest_date: "2020-05-15", frequency: "Annual", rating: "AA",
      rating_at_purchase: "AA", yield_bps: 825, issuer: "MATURED TEST ISSUER",
      source: "manual",
    });
    wanted = ${JSON.stringify(MATURED_LABEL)};
  }
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1600);
  const rows = await store.listHoldings(demat.id);
  const lot = rows.find((row) => String(row.label || "").startsWith(wanted));
  if (!lot) throw new Error("the sample portfolio has no lot " + wanted);
  const book = document.querySelector(".bond-book");
  const phone = getComputedStyle(document.querySelector(".bond-cards")).display !== "none";
  const card = document.querySelector('.bond-cards .bond-card[data-bond-card="' + lot.id + '"]');
  const maturedPanel = document.querySelector(".matured-bonds");
  if (${matured} && maturedPanel) maturedPanel.open = true;
  const target = phone ? (${matured}
    ? (maturedPanel || card) : card) : book;
  const top = target ? target.getBoundingClientRect().top + window.scrollY - 160 : 0;
  window.scrollTo(0, Math.max(0, top));
  await sleep(300);
  const scrollBefore = window.scrollY;
  if (!phone) {
    const row = document.querySelector('.bond-index-row[data-bond-id="' + lot.id + '"]');
    if (!row) throw new Error("the index has no row for " + wanted);
    row.click();
    await sleep(160);
  }
  const scrollAfter = window.scrollY;
  window.bpBondSelect(demat.id, String(lot.id));
  await sleep(40);
  const shown = phone ? (${matured}
    ? document.querySelector('.matured-cards .bond-card[data-bond-card="' + lot.id + '"]')
    : card) : document.querySelector(".bond-dossier .bond-card");
  const facts = shown ? [...shown.querySelectorAll(".bond-facts .bond-fact")] : [];
  const actions = shown ? [...shown.querySelectorAll(".bond-card-actions .mini-btn")] : [];
  return JSON.stringify({
    id: String(lot.id),
    width: document.documentElement.clientWidth,
    phone,
    desktop: getComputedStyle(book).display === "grid",
    table: !!document.querySelector(".bond-table"),
    cardBond: shown?.dataset.bondCard || "",
    dossierBond: document.querySelector(".bond-dossier .bond-card")?.dataset.bondCard || "",
    bookSame: book === document.querySelector(".bond-book"),
    scrollBefore,
    scrollAfter,
    factKeys: facts.map((el) => el.dataset.fact),
    factLabels: facts.map((el) => el.querySelector(".k")?.textContent.trim() || ""),
    anchor: shown?.querySelector(".bond-anchor .k")?.textContent.trim() || "",
    badge: shown?.querySelector(".bond-matured-badge")?.textContent.trim() || "",
    actions: actions.map((el) => el.textContent.trim()),
    glyphAction: /✎/.test(shown?.innerHTML || ""),
    indexHeaders: [...document.querySelectorAll(".bond-index-head span")]
      .map((el) => el.textContent.trim()),
  });
})()`;
}

const SHOTS = [
  { width: 390, height: 1500, theme: "light" },
  { width: 390, height: 1500, theme: "dark" },
  { width: 1280, height: 1000, theme: "light" },
  { width: 1280, height: 1000, theme: "dark" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-bond-dossier: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-dossier: --out-dir needs a value");
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
  throw new Error("render-bond-dossier: web/server.mjs did not answer.");
}

function verify(state, { matured, theme }) {
  const where = `${state.width} ${theme}`;
  const fail = (message) => { throw new Error(`render-bond-dossier (${where}): ${message}`); };
  if (state.width !== (state.width < 1000 ? 390 : 1280)) fail(`unexpected width ${state.width}`);
  if (state.table) fail("the old bond table is still in the DOM");
  if (state.glyphAction) fail("a glyph-only action survived");
  if (state.width < 1000) {
    if (!state.phone || state.desktop) fail("the phone should show cards, not the book");
  } else {
    if (!state.desktop || state.phone) fail("desktop should show the book, not the card list");
    if (state.dossierBond !== state.id) fail("the dossier is not the selected lot");
    if (state.indexHeaders.join("|") !== BOND_INDEX_FACTS.map((f) => f.label).join("|")) {
      fail(`the index columns are ${state.indexHeaders.join("|")}`);
    }
  }
  if (state.cardBond !== state.id) fail("the visible card is not the selected lot");
  if (!state.phone && !state.bookSame) {
    fail("selecting a row replaced the whole book instead of the dossier");
  }
  if (!state.phone && Math.abs(state.scrollAfter - state.scrollBefore) > 80) {
    fail(`selecting a row jumped the page by ${state.scrollAfter - state.scrollBefore}px`);
  }
  const expected = (matured ? BOND_MATURED_FACTS : BOND_CARD_FACTS).map((f) => f.label);
  if (state.factLabels.join("|") !== expected.join("|")) {
    fail(`the visible facts are ${state.factLabels.join("|")}, want ${expected.join("|")}`);
  }
  if (state.factKeys.length !== 6) fail(`${state.factKeys.length} visible facts, want 6`);
  if (matured) {
    if (state.badge !== "Matured · awaiting payment") fail(`matured badge is ${state.badge}`);
    if (state.anchor !== "Value in net worth") fail(`matured anchor is ${state.anchor}`);
    for (const label of ["Edit", "Remove"]) {
      if (!state.actions.includes(label)) fail(`matured action ${label} is missing`);
    }
  } else {
    if (state.badge) fail("a live lot carries a matured badge");
    if (state.anchor !== "Total if held") fail(`live anchor is ${state.anchor}`);
    for (const label of ["SMEST ↗", "Refresh", "Edit", "Remove"]) {
      if (!state.actions.includes(label)) fail(`live action ${label} is missing`);
    }
  }
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
const seen = { live: { phone: null, desktop: null }, matured: { phone: null, desktop: null } };
try {
  for (const matured of [false, true]) {
    for (const shot of SHOTS) {
      const script = join(dir, `page-${matured ? "matured" : "live"}-${shot.width}-${shot.theme}.js`);
      writeFileSync(script, pageScript({ matured }));
      const out = join(args.outDir,
        `bond-${matured ? "matured" : "live"}-${shot.width}-${shot.theme}.png`);
      const result = await capture({
        page, out, script, wait: 2200,
        width: shot.width, height: shot.height, theme: shot.theme,
      });
      const state = JSON.parse(result.value);
      if (shot.width !== state.width) {
        throw new Error(`render-bond-dossier: asked for ${shot.width}px, got ${state.width}px`);
      }
      verify(state, { matured, theme: shot.theme });
      const side = shot.width < 1000 ? "phone" : "desktop";
      const bucket = seen[matured ? "matured" : "live"];
      if (bucket[side] && bucket[side].factLabels.join("|") !== state.factLabels.join("|")) {
        throw new Error("render-bond-dossier: phone and desktop disagree on the card facts");
      }
      bucket[side] = state;
      console.log(out);
    }
  }
  console.log("bond dossier: six facts on both surfaces · index columns "
    + BOND_INDEX_FACTS.length + " · matured badge on card and dossier · no table");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
