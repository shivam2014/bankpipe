#!/usr/bin/env node
// Renders one bond whose coupon and maturity exist only in a dashed broker
// label. The same fixture is used before and after the parser change, so the
// before/after PNGs differ only by what the app reads out of the name.
//
//   node scripts/render-bond-terms.mjs --expect before --out-dir build/renders/bond-terms/before
//   node scripts/render-bond-terms.mjs --expect after  --out-dir build/renders/bond-terms/after
//
// Synthetic rows only.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-terms.mjs --expect before|after [--out-dir DIR]

  --expect   before: terms stay unknown; after: both terms are read and marked
  --out-dir  where the PNGs go, default build/renders/bond-terms/<expect>
`;

// The reported shape: coupon and maturity sit in the dashed name, and the row
// carries no separate coupon or maturity field. The frequency is on the row,
// so Next interest can be computed once the date is known.
const ROW = {
  security_id: "INE000000124",
  label: "TESTD-11.90%-3-12-26-PVT",
  issuer: "TEST DASHED ISSUER",
  category: "bond",
  quantity: 2,
  cost_paise: 20000000,
  value_paise: 21000000,
  value_source: "CAS",
  as_of: "2026-10-31",
  purchase_date: "2024-06-06",
  frequency: "Monthly",
  rating: "ICRA BBB / Stable",
  rating_at_purchase: "ICRA BBB / Stable",
  source: "report",
};

function pageScript() {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  for (const row of await store.listHoldings(demat.id)) await store.deleteHolding(row.id);
  await store.upsertHolding(demat.id, ${JSON.stringify(ROW)});
  // upsertHolding() marks a direct write manual; this fixture stands in for a
  // broker import, so record where the row came from.
  store.query("UPDATE holding SET source='report' WHERE asset_id=?", [demat.id]);
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(1800);

  const cards = [...document.querySelectorAll(".bond-cards .bond-card")];
  if (cards.length !== 1) throw new Error("expected one bond card, got " + cards.length);
  const card = cards[0];
  window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 72);
  await sleep(250);
  const fact = (key) => {
    const value = card.querySelector('[data-fact="' + key + '"] .v');
    if (!value) return { value: "", sub: "", subTone: "" };
    const copy = value.cloneNode(true);
    copy.querySelectorAll(".sub").forEach((note) => note.remove());
    const sub = value.querySelector(".sub");
    return {
      value: copy.textContent.trim(),
      sub: sub ? sub.textContent.trim() : "",
      subTone: sub ? sub.className.replace(/^sub\\s*/, "").trim() : "",
    };
  };
  return JSON.stringify({
    width: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    cards: cards.length,
    coupon: fact("coupon"),
    maturity: fact("maturity"),
    totalIfHeld: fact("total-if-held"),
    nextInterest: fact("next-interest"),
    frequency: fact("frequency"),
  });
})()`;
}

const SHOTS = [
  { width: 390, height: 1400, theme: "light" },
  { width: 390, height: 1400, theme: "dark" },
  { width: 1280, height: 1400, theme: "light" },
  { width: 1280, height: 1400, theme: "dark" },
];

function parseArgs(argv) {
  const args = { expect: "", outDir: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { args.help = true; continue; }
    if (flag !== "--expect" && flag !== "--out-dir") {
      throw new Error(`render-bond-terms: unknown flag ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`render-bond-terms: ${flag} needs a value`);
    if (flag === "--expect") args.expect = value;
    else args.outDir = value;
    index += 1;
  }
  if (!["before", "after"].includes(args.expect)) {
    throw new Error("render-bond-terms: --expect must be before or after");
  }
  if (!args.outDir) args.outDir = join(ROOT, `build/renders/bond-terms/${args.expect}`);
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function verify(state, { width, theme }, expect) {
  const where = `${expect} ${width} ${theme}`;
  const fail = (message) => { throw new Error(`render-bond-terms (${where}): ${message}`); };
  if (state.width !== width) fail(`asked for ${width}px, got ${state.width}px`);
  if (state.pageOverflow) fail("the page scrolls horizontally");
  if (state.cards !== 1) fail(`expected one card, got ${state.cards}`);

  if (expect === "before") {
    for (const key of ["coupon", "maturity", "totalIfHeld", "nextInterest"]) {
      if (state[key].value !== "—") {
        fail(`${key} is ${JSON.stringify(state[key].value)}, want a dash`);
      }
    }
    if (state.coupon.sub !== "not in the statement") fail(`coupon says ${state.coupon.sub}`);
    if (state.maturity.sub !== "not in the statement") fail(`maturity says ${state.maturity.sub}`);
    return;
  }

  const note = "read from the bond name — check it";
  if (state.coupon.value !== "11.9%") fail(`coupon is ${state.coupon.value}, want 11.9%`);
  if (state.coupon.sub !== note) fail(`coupon note is ${state.coupon.sub}`);
  if (!state.coupon.subTone.includes("amber")) fail("the coupon note is not amber");
  if (state.maturity.value !== "03 Dec 2026") fail(`maturity is ${state.maturity.value}`);
  if (state.maturity.sub !== note) fail(`maturity note is ${state.maturity.sub}`);
  if (!state.maturity.subTone.includes("amber")) fail("the maturity note is not amber");
  if (state.totalIfHeld.value === "—") fail("Total if held did not compute");
  if (state.nextInterest.value === "—") fail("Next interest did not compute");
  if (state.frequency.value !== "Monthly") fail(`frequency is ${state.frequency.value}`);
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
  throw new Error("render-bond-terms: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-terms-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript());
    const out = join(args.outDir,
      `bond-terms-${args.expect}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    verify(state, shot, args.expect);
    console.log(`${out} · coupon ${state.coupon.value} · maturity ${state.maturity.value}`
      + ` · total ${state.totalIfHeld.value} · next ${state.nextInterest.value}`);
  }
  console.log(`bond terms: ${args.expect} · 390/1280 light and dark · terms only in the name`);
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
