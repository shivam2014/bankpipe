#!/usr/bin/env node
// Renders the bond book at 390, 768 and 1280 in both themes, once at the live
// cards and once at the matured card. The page script asserts the two-card
// grid, the inline fact set, the summary bar and the deleted ledger from the
// live DOM. Synthetic rows only.
//
//   node scripts/render-bond-book.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-book.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const SECTIONS = ["Returns", "Market value", "Purchase"];
const LIVE_KEYS = [
  "total-if-held", "principal-returned", "principal-left", "next-interest",
  "gain-if-sold", "interest-progress",
  "market-value", "per-unit", "current-yield", "current-rating",
  "invested", "units", "purchase-date", "face-at-issue", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];
const MATURED_KEYS = [
  "value-in-net-worth", "principal-returned", "principal-left",
  "invested", "units", "purchase-date", "face-value", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];

const LIVE_ROWS = [
  {
    security_id: "INE000000121", label: "7.15% TEST INFRA 15 May 2031",
    issuer: "TEST INFRA", category: "bond", quantity: 1000,
    cost_paise: 100000000, value_paise: 104000000, value_source: "BSE",
    as_of: "2026-10-31", face_paise: 100000, purchase_date: "2025-05-15",
    interest_date: "2027-05-15", frequency: "Half-yearly", rating: "AAA",
    rating_at_purchase: "AA+", yield_bps: 715,
    future_principal_paise: 100000000, future_interest_paise: 43000000,
  },
  {
    security_id: "INE000000122", label: "8.10% TEST FINANCE 20 Nov 2028",
    issuer: "TEST FINANCE", category: "bond", quantity: 500,
    cost_paise: 50000000, value_paise: 54250000, value_source: "BSE",
    as_of: "2026-10-31", face_paise: 100000, purchase_date: "2024-11-20",
    interest_date: "2027-05-20", frequency: "Annual", rating: "AA",
    rating_at_purchase: "AA", yield_bps: 810,
    future_principal_paise: 50000000, future_interest_paise: 20250000,
  },
  {
    security_id: "INE000000123", label: "7.40% TEST BOND 3 10 Feb 2030",
    issuer: "TEST BOND 3", category: "bond", quantity: 800,
    cost_paise: 80000000, value_paise: 81440000, value_source: "BSE",
    as_of: "2026-10-31", face_paise: 100000, purchase_date: "2024-11-05",
    interest_date: "2027-02-10", frequency: "Half-yearly", rating: "AA",
    rating_at_purchase: "AA", yield_bps: 740,
    returned_paise: 8000000, returned_at: "2026-04-10",
    returned_source: "bank", redemption_dates: "2026-04-10",
    future_principal_paise: 72000000, future_interest_paise: 18648000,
  },
  {
    security_id: "INE000000125", label: "9.25% TEST CREDIT 30 Jun 2029",
    issuer: "TEST CREDIT", category: "bond", quantity: 250,
    cost_paise: 25000000, value_paise: 26125000, value_source: "BSE",
    as_of: "2026-10-31", face_paise: 100000, purchase_date: "2025-07-01",
    interest_date: "2027-01-01", frequency: "Quarterly", rating: "BBB",
    rating_at_purchase: "A", yield_bps: 925,
    future_principal_paise: 25000000, future_interest_paise: 11562500,
  },
  {
    security_id: "INE000000126",
    label: "8.25% NATIONAL TEST HIGHWAYS AUTHORITY TAX-FREE BOND 15 Mar 2032 SERIES II",
    issuer: "NATIONAL TEST HIGHWAYS AUTHORITY", category: "bond", quantity: 1200,
    cost_paise: 120000000, value_paise: null, face_paise: 100000,
    purchase_date: "2023-02-15", interest_date: "2027-02-15",
    frequency: "Annual", rating: "AAA", rating_at_purchase: "AAA",
    yield_bps: 825, future_principal_paise: 120000000,
    future_interest_paise: 59400000,
  },
];

const MATURED_ROW = {
  security_id: "INE000000999", label: "8.25% TEST MATURED BOND 15 May 2020",
  issuer: "TEST MATURED ISSUER", category: "bond", quantity: 250,
  cost_paise: 25000000, value_paise: 25000000, face_paise: 100000,
  purchase_date: "2015-05-15", interest_date: "2020-05-15",
  frequency: "Annual", rating: "AA", rating_at_purchase: "AA", yield_bps: 825,
};

function pageScript({ focus }) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  for (const row of await store.listHoldings(demat.id)) await store.deleteHolding(row.id);
  for (const row of ${JSON.stringify(LIVE_ROWS)}) await store.upsertHolding(demat.id, row);
  await store.upsertHolding(demat.id, ${JSON.stringify(MATURED_ROW)});
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1800);

  const cardsEl = document.querySelector(".bond-cards");
  if (!cardsEl) throw new Error("the bond card grid is missing");
  const cards = [...cardsEl.querySelectorAll(".bond-card")];
  const live = cards.filter((card) => card.dataset.matured === "false");
  const matured = cards.filter((card) => card.dataset.matured === "true");
  if (live.length !== ${LIVE_ROWS.length}) {
    throw new Error(\`expected ${LIVE_ROWS.length} live cards, got \${live.length}\`);
  }
  if (matured.length !== 1) throw new Error(\`expected one matured card, got \${matured.length}\`);

  const state = {
    width: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    cardsDisplay: getComputedStyle(cardsEl).display,
    columns: getComputedStyle(cardsEl).gridTemplateColumns,
    gap: getComputedStyle(cardsEl).columnGap,
    maxWidth: getComputedStyle(cardsEl).maxWidth,
    liveWidths: live.map((card) => Math.round(card.getBoundingClientRect().width * 10) / 10),
    live: live.map((card) => ({
      sections: [...card.querySelectorAll(".bond-section-title")].map((el) => el.textContent.trim()),
      facts: [...card.querySelectorAll("[data-fact]")].map((el) => el.dataset.fact),
      details: card.querySelectorAll("details").length,
      progress: card.querySelectorAll(".bond-progress").length,
      anchor: card.querySelector(".bond-fact-anchor")?.dataset.fact || "",
      actions: [...card.querySelectorAll("[data-bond-action]")]
        .map((el) => el.textContent.trim()).filter(Boolean),
    })),
    matured: matured.map((card) => ({
      sections: [...card.querySelectorAll(".bond-section-title")].map((el) => el.textContent.trim()),
      facts: [...card.querySelectorAll("[data-fact]")].map((el) => el.dataset.fact),
      progress: card.querySelectorAll(".bond-progress").length,
      badge: card.querySelector(".bond-matured-badge")?.textContent.trim() || "",
      carried: card.querySelector('[data-fact="value-in-net-worth"] .sub')?.textContent.trim() || "",
    })),
    enterIt: document.querySelectorAll('[data-bond-action="enter-value"]').length,
    remnants: document.querySelectorAll(
      ".bond-ledger, .bl-row, .bl-band, .bond-anchor, .bond-breakdown, .matured-bonds").length,
  };

  const header = document.querySelector("header");
  const bar = document.querySelector(".bond-summary");
  if (bar && getComputedStyle(bar).display !== "none") {
    window.scrollTo(0, cardsEl.getBoundingClientRect().top + window.scrollY + 120);
    await sleep(150);
    const rect = bar.getBoundingClientRect();
    state.summary = {
      height: Math.round(rect.height * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      headerBottom: Math.round(header.getBoundingClientRect().bottom * 10) / 10,
      rowTops: [...bar.children].map((el) => Math.round(el.getBoundingClientRect().top)),
      sortTops: [...bar.querySelectorAll(".sortbtn")]
        .map((el) => Math.round(el.getBoundingClientRect().top)),
      overflow: bar.scrollWidth > bar.clientWidth + 1,
    };
  }

  const target = ${JSON.stringify(focus)} === "matured"
    ? document.querySelector(".bond-matured-divider")
    : document.getElementById("bond-holdings");
  if (!target) throw new Error("there is no " + ${JSON.stringify(focus)} + " anchor");
  window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 72);
  await sleep(250);
  return JSON.stringify(state);
})()`;
}

const SHOTS = [
  { width: 320, height: 1200, theme: "light", focus: "live" },
  { width: 390, height: 1400, theme: "light", focus: "live" },
  { width: 390, height: 1400, theme: "dark", focus: "live" },
  { width: 768, height: 1400, theme: "light", focus: "live" },
  { width: 768, height: 1400, theme: "dark", focus: "live" },
  { width: 1280, height: 1400, theme: "light", focus: "live" },
  { width: 1280, height: 1400, theme: "dark", focus: "live" },
  { width: 390, height: 1400, theme: "light", focus: "matured" },
  { width: 768, height: 1400, theme: "light", focus: "matured" },
  { width: 1280, height: 1400, theme: "light", focus: "matured" },
  { width: 1280, height: 1400, theme: "dark", focus: "matured" },
  { width: 1000, height: 1200, theme: "light", focus: "live" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-bond-book: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-book: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

function verify(state, { width, theme }) {
  const where = `${width} ${theme}`;
  const fail = (message) => { throw new Error(`render-bond-book (${where}): ${message}`); };
  if (state.width !== width) fail(`asked for ${width}px, got ${state.width}px`);
  if (state.pageOverflow) fail("the page scrolls horizontally");
  if (state.remnants !== 0) fail(`${state.remnants} ledger, anchor or disclosure nodes remain`);

  const tracks = state.columns.split(" ").map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const atDesktop = width >= 1000;
  if (atDesktop) {
    if (state.cardsDisplay !== "grid") fail(`the cards are ${state.cardsDisplay}, want grid`);
    if (tracks.length !== 2) fail(`the grid has ${tracks.length} tracks: ${state.columns}`);
    if (Math.abs(tracks[0] - tracks[1]) > 0.5) {
      fail(`the tracks are unequal: ${state.columns}`);
    }
    if (Number.parseFloat(state.gap) !== 16) fail(`the gap is ${state.gap}, want 16px`);
    if (state.maxWidth !== "none") fail(`the grid max-width is ${state.maxWidth}, want none`);
    for (const cardWidth of state.liveWidths) {
      if (cardWidth <= 380) fail(`a desktop card is ${cardWidth}px wide, want over 380`);
    }
  } else {
    if (state.cardsDisplay !== "grid") fail(`the cards are ${state.cardsDisplay}, want grid`);
    if (tracks.length !== 1) fail(`the narrow grid has ${tracks.length} tracks`);
    for (const cardWidth of state.liveWidths) {
      if (cardWidth > 720.5) fail(`a narrow card is ${cardWidth}px wide, want at most 720`);
    }
  }

  for (const card of state.live) {
    if (!same(card.sections, SECTIONS)) {
      fail(`the live sections are ${card.sections.join("|")}, want ${SECTIONS.join("|")}`);
    }
    if (!same(card.facts, LIVE_KEYS)) {
      fail(`the live facts are ${card.facts.join("|")}, want ${LIVE_KEYS.join("|")}`);
    }
    if (card.details !== 0) fail("a live card still has a disclosure");
    if (card.progress !== 1) fail(`a live card has ${card.progress} progress blocks`);
    if (card.anchor !== "total-if-held") fail(`the live anchor is ${card.anchor}`);
    for (const action of ["SMEST ↗", "Refresh", "Edit", "Remove"]) {
      if (!card.actions.includes(action)) fail(`a live card is missing ${action}`);
    }
  }
  if (state.enterIt !== 1) fail(`${state.enterIt} Enter it actions, want one`);

  const card = state.matured[0];
  if (!same(card.sections, ["Returns", "Purchase"])) {
    fail(`the matured sections are ${card.sections.join("|")}`);
  }
  if (!same(card.facts, MATURED_KEYS)) {
    fail(`the matured facts are ${card.facts.join("|")}, want ${MATURED_KEYS.join("|")}`);
  }
  if (card.progress !== 0) fail("the matured card has an interest progress");
  if (!card.badge.includes("Matured")) fail(`the matured badge is ${card.badge}`);
  if (!card.carried.includes("bank credit is matched")) {
    fail(`the matured carried note is ${card.carried}`);
  }

  if (atDesktop) {
    if (!state.summary) fail("the summary bar is missing at desktop");
    const { rowTops, sortTops, top, headerBottom, overflow, height } = state.summary;
    if (new Set(rowTops).size !== 1) fail(`the bar wraps: item tops ${rowTops.join(",")}`);
    if (new Set(sortTops).size !== 1) fail(`the sort controls wrap: tops ${sortTops.join(",")}`);
    if (height > 52) fail(`the bar is ${height}px tall, so it is not one line`);
    if (overflow) fail("the summary bar overflows horizontally");
    if (top < headerBottom - 1) fail(`the bar top ${top} sits under the header ${headerBottom}`);
    console.log(`${where}: bar ${height}px, one row, top ${top} under header ${headerBottom}`);
  } else if (state.summary) {
    fail("the desktop summary bar is visible below 1000");
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
  throw new Error("render-bond-book: web/server.mjs did not answer.");
}

mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-book-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.focus}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript({ focus: shot.focus }));
    const out = join(args.outDir,
      `bond-book-${shot.focus}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    verify(JSON.parse(result.value), shot);
    console.log(out);
  }
  console.log("bond book: two cards per row at desktop, one below 1000 · every fact inline · "
    + "no ledger, anchor or disclosure · 390/768/1000/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
