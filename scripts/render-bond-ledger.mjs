#!/usr/bin/env node
// Renders the bond ledger at 390, 768 and 1280 in both themes, once live and
// once with a matured lot, and asserts the resize handoff in one page.
//
//   node scripts/render-bond-ledger.mjs [--out-dir build/renders]
//
// Every shot reads the card's own fact keys and fails unless the ledger row
// and band partition them exactly. Synthetic data only.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { BOND_CARD_FACTS, BOND_MATURED_FACTS } from "../web/bond-book.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-ledger.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const LIVE_HEADER = ["Bond", "Total if held", "Market value", "Invested",
  "Current yield", "Next interest", "Maturity"];
const MATURED_HEADER = ["Bond", "Value in net worth", "Maturity", "Invested",
  "Units", "Purchase date", "Face value"];
const MATURED_LABEL = "8.25% MATURED TEST BOND 15 May 2020";
const MATURED_ID = "INE000000999";

function pageScript({ matured, resize }) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  await store.upsertHolding(demat.id, {
    security_id: "INE000000124",
    label: "7.40% TEST BOND 3 10 Feb 2030",
    category: "bond", quantity: 800, cost_paise: 80000000,
    value_paise: 81440000, value_source: "BSE", as_of: "2026-10-31",
    face_paise: 100000, purchase_date: "2024-11-05",
    maturity: "2030-02-10", interest_date: "2027-02-10",
    frequency: "Half-yearly", rating: "AA", rating_at_purchase: "AA",
    yield_bps: 740, issuer: "TEST BOND 3", source: "report",
    returned_paise: 8000000, returned_at: "2026-04-10",
    returned_source: "bank", redemption_dates: "2026-04-10",
    future_principal_paise: 72000000, future_interest_paise: 18648000,
  });
  if (${JSON.stringify(matured)}) {
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
  }
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1800);
  const wide = window.matchMedia("(min-width:1000px)").matches;
  const liveRows = [...document.querySelectorAll('.bl-row[data-matured="false"]')];
  const maturedRows = [...document.querySelectorAll('.bl-row[data-matured="true"]')];
  if (liveRows.length < 3) throw new Error("the sample needs three live bonds");
  const targetRow = ${JSON.stringify(matured)} ? maturedRows[0] : liveRows[2];
  if (!targetRow) throw new Error("there is no row to select");
  const id = targetRow.dataset.bondId;
  const openBand = () => document.querySelector(".bl-band:not([hidden])");
  if (!${JSON.stringify(resize)}) {
    liveRows[1].click();
    await sleep(80);
    if (openBand()?.dataset.bandId !== liveRows[1].dataset.bondId) {
      throw new Error("clicking a row did not switch the band");
    }
    targetRow.click();
    await sleep(80);
    if (openBand()?.dataset.bandId !== id) throw new Error("the band did not follow the target");
    targetRow.click();
    await sleep(80);
    if (document.querySelectorAll(".bl-band:not([hidden])").length !== 1
      || openBand()?.dataset.bandId !== id) {
      throw new Error("pressing the open row closed the band");
    }
  } else {
    targetRow.click();
    await sleep(80);
  }
  window.bpBondSelect(demat.id, id);
  await sleep(120);
  const card = document.querySelector('.bond-cards .bond-card[data-bond-card="'
    + CSS.escape(id) + '"], .matured-cards .bond-card[data-bond-card="' + CSS.escape(id) + '"]');
  if (!card) throw new Error("the selected card is missing");
  const row = document.querySelector('.bl-row[data-bond-id="' + CSS.escape(id) + '"]');
  const band = openBand();
  if (!row || !band) throw new Error("the selected row or band is missing");
  const target = wide ? row : card;
  window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 220);
  await sleep(250);

  const keys = (root, selector, name) => [...root.querySelectorAll(selector)]
    .map((el) => el.dataset[name]).filter(Boolean);
  const cardRow = keys(card, '[data-surface="row"][data-fact]', "fact");
  const cardBand = keys(card, '[data-surface="band"][data-fact]', "fact");
  const rowKeys = keys(row, '[data-surface="row"][data-row-fact]', "rowFact");
  const bandKeys = keys(band, '[data-surface="band"][data-fact]', "fact");
  const visibleKeys = keys(card, ".bond-facts .bond-fact", "fact");
  const progress = card.querySelector('[data-fact="interest-progress"]');
  const disclosure = card.querySelector(".bond-breakdown");
  const progressInBody = !!progress && !!disclosure && !disclosure.contains(progress);
  const bandSections = [...band.querySelectorAll(".bl-col h3")]
    .map((el) => el.textContent.trim());
  const cardSections = [...card.querySelectorAll(".bond-breakdown .bond-section-title")]
    .map((el) => el.textContent.trim());
  const actionLabels = (root) => [...root.querySelectorAll("[data-bond-action]")]
    .map((el) => el.textContent.trim()).filter(Boolean);
  const headerOf = (selector) => [...(document.querySelector(selector)?.children || [])]
    .map((el) => el.textContent.trim());
  const liveHeader = headerOf(".bl-table:not(.bl-matured) .bl-head");
  const maturedHeader = headerOf(".bl-matured .bl-head");
  const note = document.querySelector(".bl-matured .bl-note")?.textContent
    .replace(/\\s+/g, " ").trim() || "";
  const anchorSub = row.querySelector(".bl-anchor .bl-sub")?.textContent.trim() || "";
  const expanded = [...document.querySelectorAll('.bl-row[aria-expanded="true"]')]
    .map((el) => el.dataset.bondId);
  const state = {
    id, width: document.documentElement.clientWidth, wide,
    ledgerDisplay: getComputedStyle(document.querySelector(".bond-ledger")).display,
    cardsDisplay: getComputedStyle(document.querySelector(".bond-cards")).display,
    cardWidth: card.getBoundingClientRect().width,
    detailsOpen: card.querySelector(".bond-breakdown")?.open === true,
    selected: (window.bpBondSelected || {})[demat.id] === id,
    cardRow, cardBand, rowKeys, bandKeys, visibleKeys, progressInBody,
    liveHeader, maturedHeader, bandSections, cardSections,
    cardActions: actionLabels(card), bandActions: actionLabels(band),
    openBandCount: document.querySelectorAll(".bl-band:not([hidden])").length,
    expanded, note, anchorSub,
    liveCount: liveRows.length, maturedCount: maturedRows.length,
    hasMaturedTable: !!document.querySelector(".bl-matured"),
  };
  if (${JSON.stringify(resize)}) {
    window.__bpResize = { id, top: row.getBoundingClientRect().top };
    window.__bpAsset = demat.id;
  }
  return JSON.stringify(state);
})()`;
}

const RESIZE_SCRIPT = `(() => {
  const saved = window.__bpResize;
  if (!saved) throw new Error("the resize probe was not set");
  const id = saved.id;
  const card = document.querySelector('.bond-cards .bond-card[data-bond-card="'
    + CSS.escape(id) + '"], .matured-cards .bond-card[data-bond-card="' + CSS.escape(id) + '"]');
  if (!card) throw new Error("the selected card is missing after the resize");
  const details = card.querySelector(".bond-breakdown");
  const top = card.getBoundingClientRect().top;
  return JSON.stringify({
    id, width: document.documentElement.clientWidth,
    selected: (window.bpBondSelected || {})[window.__bpAsset] === id,
    detailsOpen: !!details && details.open,
    before: saved.top, after: top, delta: top - saved.top,
  });
})()`;

const SHOTS = [
  { width: 390, height: 1400, theme: "light", matured: false },
  { width: 390, height: 1400, theme: "dark", matured: false },
  { width: 768, height: 1200, theme: "light", matured: false },
  { width: 768, height: 1200, theme: "dark", matured: false },
  { width: 1280, height: 1000, theme: "light", matured: false },
  { width: 1280, height: 1000, theme: "dark", matured: false },
  { width: 390, height: 1400, theme: "light", matured: true },
  { width: 390, height: 1400, theme: "dark", matured: true },
  { width: 1280, height: 1000, theme: "light", matured: true },
  { width: 1280, height: 1000, theme: "dark", matured: true },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-bond-ledger: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-ledger: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sorted = (values) => [...values].sort();
const sameSet = (a, b) => a.length === b.length
  && sorted(a).join("|") === sorted(b).join("|");
const overlap = (a, b) => a.filter((value) => b.includes(value));

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
  throw new Error("render-bond-ledger: web/server.mjs did not answer.");
}

function verify(state, { matured, theme, width }) {
  const where = `${width} ${theme}`;
  const fail = (message) => { throw new Error(`render-bond-ledger (${where}): ${message}`); };
  if (state.width !== width) fail(`asked for ${width}px, got ${state.width}px`);
  if (width >= 1000) {
    if (state.cardsDisplay !== "none") fail("the card list is visible at 1000 and wider");
    if (state.ledgerDisplay === "none") fail("the ledger is hidden at 1000 and wider");
    if (state.openBandCount !== 1) fail(`${state.openBandCount} bands open, want one`);
  } else {
    if (state.ledgerDisplay !== "none") fail("the ledger is visible below 1000");
    if (state.cardsDisplay === "none") fail("the card list is hidden below 1000");
    if (state.cardWidth > 720.5) {
      fail(`the phone card is ${state.cardWidth}px wide, want at most 720`);
    }
    if (!state.detailsOpen) fail("the selected card's Full breakdown is not open");
  }
  if (!state.selected) fail("the selected id did not survive");
  if (state.expanded.join("|") !== state.id) fail("a different row is expanded");
  if (overlap(state.rowKeys, state.bandKeys).length) {
    fail(`a fact is in both row and band: ${overlap(state.rowKeys, state.bandKeys)}`);
  }
  if (!sameSet(state.rowKeys, state.cardRow)) {
    fail(`the row keys are ${state.rowKeys}, the card's row keys are ${state.cardRow}`);
  }
  if (!sameSet(state.bandKeys, state.cardBand)) {
    fail(`the band keys are ${state.bandKeys}, the card's band keys are ${state.cardBand}`);
  }
  if (!sameSet([...state.rowKeys, ...state.bandKeys],
    [...state.cardRow, ...state.cardBand])) {
    fail("the row and band union is not the card's fact set");
  }
  const expectedVisible = (matured ? BOND_MATURED_FACTS : BOND_CARD_FACTS)
    .map((fact) => fact.key);
  if (state.visibleKeys.join("|") !== expectedVisible.join("|")) {
    fail(`the visible facts are ${state.visibleKeys}, want ${expectedVisible}`);
  }
  if (matured) {
    if (state.progressInBody) fail("a matured card renders interest progress");
    if (state.bandSections.join("|") !== "Purchase|Returns") {
      fail(`the matured band sections are ${state.bandSections}`);
    }
    if (state.maturedHeader.join("|") !== MATURED_HEADER.join("|")) {
      fail(`the matured header is ${state.maturedHeader}`);
    }
    if (state.liveHeader.includes("Value in net worth")) {
      fail("the live table borrowed the matured anchor");
    }
    if (state.anchorSub !== "carried until matched") {
      fail(`the matured anchor sub is ${state.anchorSub}`);
    }
    if (!/bank credit is matched/.test(state.note)) fail("the matured note is missing");
    if (!state.hasMaturedTable) fail("the matured table is missing");
  } else {
    if (!state.progressInBody) fail("the interest progress is not in the card body");
    if (state.bandSections.join("|") !== "Purchase|Market|Returns") {
      fail(`the live band sections are ${state.bandSections}`);
    }
    if (state.liveHeader.join("|") !== LIVE_HEADER.join("|")) {
      fail(`the live header is ${state.liveHeader}`);
    }
    if (state.visibleKeys.includes("interest-progress")) {
      fail("the progress block counted as one of the six visible facts");
    }
  }
  if (state.cardSections.join("|") !== state.bandSections.join("|")) {
    fail(`the band sections ${state.bandSections} differ from the card ${state.cardSections}`);
  }
  if (!sameSet(state.cardActions, state.bandActions)) {
    fail(`the actions differ: card ${sorted(state.cardActions)}, band ${sorted(state.bandActions)}`);
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-ledger-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.matured ? "matured" : "live"}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript({ matured: shot.matured, resize: false }));
    const out = join(args.outDir,
      `bond-ledger-${shot.matured ? "matured" : "live"}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    verify(state, shot);
    console.log(out);
  }

  const resizeScript = join(dir, "page-resize-1280.js");
  const thenScript = join(dir, "page-resize-390.js");
  writeFileSync(resizeScript, pageScript({ matured: false, resize: true }));
  writeFileSync(thenScript, RESIZE_SCRIPT);
  const resized = await capture({
    page, out: join(args.outDir, "bond-ledger-resize-1280.png"),
    script: resizeScript, thenScript, wait: 2200,
    width: 1280, height: 1000, theme: "light", thenWidth: 390,
  });
  const probe = JSON.parse(resized.thenValue);
  if (probe.width !== 390) throw new Error(`resize: got ${probe.width}px, want 390px`);
  if (!probe.selected) throw new Error("resize: the selected id did not survive");
  if (!probe.detailsOpen) throw new Error("resize: the selected card's breakdown is closed");
  if (Math.abs(probe.delta) > 8) {
    throw new Error(`resize: the selected card moved ${probe.delta}px, want at most 8px`);
  }
  console.log(`resize: ${probe.id} kept ${probe.before.toFixed(1)}px -> `
    + `${probe.after.toFixed(1)}px (${probe.delta.toFixed(1)}px)`);
  console.log("bond ledger: row and band partition every card fact · one open band · "
    + "390/768/1280 light and dark · matured table · resize handoff within 8px");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
