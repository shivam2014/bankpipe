#!/usr/bin/env node
// Renders a demat whose bond lots arrived cost-only, at 390 and 1280 in both
// themes. The page asserts one measure across the account: the hero says held
// at cost, every bond card names that cost and its source, and no card asks for
// a market value it deliberately does not have. Synthetic rows only.
//
//   node scripts/render-bond-cost.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-cost.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const COST_ROWS = [
  {
    security_id: "INE000000131", label: "7.15% TEST INFRA 15 May 2031",
    issuer: "TEST INFRA", category: "bond", quantity: 1000,
    cost_paise: 100000000, value_paise: null, face_paise: 100000,
    purchase_date: "2025-05-15", interest_date: "2027-05-15",
    frequency: "Half-yearly", rating: "AAA", rating_at_purchase: "AA+",
    yield_bps: 715, coupon_pct: 7.15, coupon_source: "report",
    maturity: "2031-05-15", maturity_source: "report",
  },
  {
    security_id: "INE000000132", label: "8.10% TEST FINANCE 20 Nov 2028",
    issuer: "TEST FINANCE", category: "bond", quantity: 500,
    cost_paise: 50000000, value_paise: null, face_paise: 100000,
    purchase_date: "2024-11-20", interest_date: "2027-05-20",
    frequency: "Annual", rating: "AA", rating_at_purchase: "AA",
    yield_bps: 810, coupon_pct: 8.1, coupon_source: "report",
    maturity: "2028-11-20", maturity_source: "report",
  },
  {
    security_id: "INE000000133", label: "7.40% TEST BOND 3 10 Feb 2030",
    issuer: "TEST BOND 3", category: "bond", quantity: 800,
    cost_paise: 80000000, value_paise: null, face_paise: 100000,
    purchase_date: "2024-11-05", interest_date: "2027-02-10",
    frequency: "Half-yearly", rating: "AA", rating_at_purchase: "AA",
    yield_bps: 740, coupon_pct: 7.4, coupon_source: "report",
    maturity: "2030-02-10", maturity_source: "report",
  },
];

// The costs the fixture carries, so the check compares the render with the
// rows rather than with another copy of the renderer.
const COSTS = ["₹ 10,00,000.00", "₹ 5,00,000.00", "₹ 8,00,000.00"];
const HELD = "₹ 23,00,000.00";

function pageScript({ focus }) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  for (const row of await store.listHoldings(demat.id)) await store.deleteHolding(row.id);
  await store.replaceHoldings(demat.id, ${JSON.stringify(COST_ROWS)}, "2026-10-31");
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1800);

  const text = (el) => el ? el.textContent.replace(/\\s+/g, " ").trim() : "";
  const cardsEl = document.querySelector(".bond-cards");
  if (!cardsEl) throw new Error("the bond card grid is missing");
  const cards = [...cardsEl.querySelectorAll(".bond-card")];
  const state = {
    width: document.documentElement.clientWidth,
    theme: document.documentElement.dataset.theme || "",
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    hero: text(document.querySelector(".hero")),
    cardsEl: {
      display: getComputedStyle(cardsEl).display,
      columns: getComputedStyle(cardsEl).gridTemplateColumns,
      gap: getComputedStyle(cardsEl).columnGap,
    },
    cards: cards.map((card) => ({
      name: text(card.querySelector(".bond-name")),
      sections: [...card.querySelectorAll(".bond-section-title")].map(text),
      value: text(card.querySelector('[data-fact="market-value"]')),
      gain: text(card.querySelector('[data-fact="gain-if-sold"]')),
      perUnit: text(card.querySelector('[data-fact="per-unit"]')),
      currentYield: text(card.querySelector('[data-fact="current-yield"]')),
      actions: [...card.querySelectorAll("[data-bond-action]")]
        .map((el) => el.textContent.trim()).filter(Boolean),
    })),
    enterValue: document.querySelectorAll('[data-bond-action="enter-value"]').length,
  };
  // The account shot carries the hero and the ring; the card shot carries the
  // live cards. Both measures are in the same run so they cannot drift apart.
  const target = ${JSON.stringify(focus)} === "cards"
    ? document.getElementById("bond-holdings")
    : (document.querySelector(".hero") || document.getElementById("bond-holdings"));
  if (target) {
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 72);
    await sleep(250);
  }
  return JSON.stringify(state);
})()`;
}

const SHOTS = [
  { width: 390, height: 1500, theme: "light", focus: "account" },
  { width: 390, height: 1500, theme: "dark", focus: "account" },
  { width: 390, height: 1500, theme: "light", focus: "cards" },
  { width: 390, height: 1500, theme: "dark", focus: "cards" },
  { width: 1280, height: 1500, theme: "light", focus: "account" },
  { width: 1280, height: 1500, theme: "dark", focus: "account" },
  { width: 1280, height: 1500, theme: "light", focus: "cards" },
  { width: 1280, height: 1500, theme: "dark", focus: "cards" },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-bond-cost: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-cost: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  return args;
}

function verify(state, { width, theme }) {
  const where = `${width} ${theme}`;
  const fail = (message) => {
    throw new Error(`render-bond-cost (${where}): ${message}`);
  };
  if (state.width !== width) fail(`asked for ${width}px, got ${state.width}px`);
  if (state.theme !== theme) fail(`theme is ${state.theme}, want ${theme}`);
  if (state.pageOverflow) fail("the page scrolls horizontally");
  if (!state.hero.includes("held at cost")) fail(`the hero is ${state.hero}`);
  if (!state.hero.includes(HELD)) {
    fail(`the hero value is not ${HELD}: ${state.hero}`);
  }
  if (state.cards.length !== COST_ROWS.length) {
    fail(`${state.cards.length} bond cards, want ${COST_ROWS.length}`);
  }
  if (state.enterValue !== state.cards.length) {
    fail(`${state.enterValue} value entries, want ${state.cards.length}`);
  }
  if (state.cardsEl.display !== "grid") fail(`the cards are ${state.cardsEl.display}`);
  const tracks = state.cardsEl.columns.split(" ").map(Number.parseFloat)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (width >= 1000) {
    if (tracks.length !== 2) fail(`the desktop grid has ${tracks.length} tracks`);
    if (Math.abs(tracks[0] - tracks[1]) > 0.5) {
      fail(`the desktop tracks are unequal: ${state.cardsEl.columns}`);
    }
  } else if (tracks.length !== 1) {
    fail(`the narrow grid has ${tracks.length} tracks`);
  }

  const costs = COSTS.slice().sort();
  const seen = state.cards.map((card) => card.value.match(/₹ [\d,]+\.\d\d/)?.[0] || "")
    .sort();
  if (JSON.stringify(seen) !== JSON.stringify(costs)) {
    fail(`the card values are ${seen.join("|")}, want ${costs.join("|")}`);
  }
  for (const card of state.cards) {
    if (!card.value.includes("Value now")) fail(`${card.name}: ${card.value}`);
    if (!card.value.includes("held at cost")) {
      fail(`${card.name} does not say the value is the cost: ${card.value}`);
    }
    if (/cost from the report/.test(card.value)) {
      fail(`${card.name} prints a bare report as the cost's source: ${card.value}`);
    }
    if (!card.gain.includes("no market value yet")) {
      fail(`${card.name} gain is ${card.gain}`);
    }
    for (const [label, fact] of [["per unit", card.perUnit],
      ["current yield", card.currentYield]]) {
      if (!fact.includes("no market value yet")) {
        fail(`${card.name} ${label} says ${fact}`);
      }
    }
    if (!card.actions.includes("Enter market value")) {
      fail(`${card.name} has no way to enter a market value`);
    }
    if (card.sections.includes("Market value")) {
      fail(`${card.name} names the cost under a MARKET VALUE heading`);
    }
    if (/not recorded|needs a market value/.test(card.value + card.gain
      + card.perUnit + card.currentYield)) {
      fail(`${card.name} still phrases cost as a missing market value`);
    }
  }
  console.log(`${where}: hero at cost, ${state.cards.length} cards read held at cost`);
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
  throw new Error("render-bond-cost: web/server.mjs did not answer.");
}

mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-cost-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.focus}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript({ focus: shot.focus }));
    const out = join(args.outDir,
      `bond-cost-${shot.focus}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    verify(JSON.parse(result.value), shot);
    console.log(out);
  }
  console.log("bond cost: one measure at 390 and 1280, light and dark · "
    + "every card says the value is the cost, the gain waits for a price");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
