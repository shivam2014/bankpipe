#!/usr/bin/env node
// The import inbox copy, rendered from the page's own resolver and renderer.
//
// Two synthetic states, one file each: a Zerodha holdings report that needs an
// account choice, and the same report already attached to its account. The shots
// carry the batch bar, the page status line and the card at 390 and 1280, light
// and dark. Every name, ISIN and number here is invented.
//
//   node scripts/render-import-copy.mjs [--out-dir build/renders] [--no-verify]
//
// --no-verify shoots the before copy without asserting the new lines.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-copy.mjs [--out-dir build/renders] [--no-verify]

  --out-dir    where the PNGs go, default build/renders
  --no-verify  shoot the current copy without asserting the new lines
`;

const AS_OF = "2026-11-12";
const BO = "1200000012348054";
const CLIENT_ID = "AB1234567";
const OTHER_CLIENT_ID = "ZZ9999999";
const COUNT = 28;

const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const rows = Array.from({ length: COUNT }, (_, at) => ({
  isin: isin(600 + at), label: `TEST EQUITY ${at + 1}`, category: "equity",
  quantity: 10 + at, valuePaise: 100000 * (at + 1), costPaise: null,
  purchaseDate: "", sourceRow: at,
}));

const account = ({ clientId = "" } = {}) => ({
  id: "demat-zerodha", label: "Demat · Zerodha · …8054", bank: "Zerodha",
  category: "demat", subtype: "equity", type: "equity", number: BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({
    depository: "CDSL", dp: "Zerodha Broking Ltd",
    ...(clientId ? { client_id: clientId } : {}),
    holdings_source: "cas", holdings_as_of: "2026-09-30",
  }),
  rows: [],
});

const entry = ({ accountKey = OTHER_CLIENT_ID } = {}) => ({
  id: `inbox-render-copy-${accountKey || "none"}`,
  name: "holdings-AB1234567.xlsx", size: 2048, status: "ready",
  kind: "zerodha-holdings", broker: "zerodha", asOf: AS_OF,
  accountKey, accountKind: accountKey ? "client" : "",
  rows, firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [], error: "", file: null,
});

const SCENARIOS = [
  {
    name: "choice",
    account: account(),
    entry: entry(),
    checks: (state) => {
      const wrong = [];
      if (state.batchState !== "1 plan needs a choice") {
        wrong.push(`batch state: ${JSON.stringify(state.batchState)}`);
      }
      if (!state.goToIt) wrong.push("the batch has no Go to it button");
      if (state.importAll) wrong.push("Import all is offered before the plan can run");
      if (state.status !== "Choose an account for Zerodha holdings.") {
        wrong.push(`status: ${JSON.stringify(state.status)}`);
      }
      if (state.sub !== "28 equities · as on 12 Nov 2026") {
        wrong.push(`metric line: ${JSON.stringify(state.sub)}`);
      }
      if (!/^Choose an account$/.test(state.pill)) {
        wrong.push(`state line: ${JSON.stringify(state.pill)}`);
      }
      if (state.visibleWords > 40) {
        wrong.push(`the card shows ${state.visibleWords} words outside More`);
      }
      if (/Selection order does not matter|Import all appears when/.test(state.batchText)) {
        wrong.push(`self-description in the batch: ${JSON.stringify(state.batchText)}`);
      }
      if (/No CAS is needed/.test(state.cardText)) {
        wrong.push("self-description on the card");
      }
      return wrong;
    },
  },
  {
    name: "ready",
    account: account({ clientId: CLIENT_ID }),
    entry: entry({ accountKey: CLIENT_ID }),
    checks: (state) => {
      const wrong = [];
      if (state.batchState !== "Ready to import") {
        wrong.push(`batch state: ${JSON.stringify(state.batchState)}`);
      }
      if (state.goToIt) wrong.push("Go to it is offered when every plan is ready");
      if (!state.importAll) wrong.push("Import all is missing on a ready plan");
      if (state.status !== "Ready to import 1 plan.") {
        wrong.push(`status: ${JSON.stringify(state.status)}`);
      }
      if (state.pill !== "Ready") wrong.push(`state line: ${JSON.stringify(state.pill)}`);
      if (state.visibleWords > 40) {
        wrong.push(`the card shows ${state.visibleWords} words outside More`);
      }
      return wrong;
    },
  },
];

const SHOTS = [
  { width: 390, height: 1800, theme: "dark" },
  { width: 390, height: 1800, theme: "light" },
  { width: 1280, height: 1400, theme: "dark" },
  { width: 1280, height: 1400, theme: "light" },
];

function pageScript(scenario, { openMore = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(scenario.account)};
  const { rows: seedRows, ...fields } = seed;
  await store.createAccount(fields);
  if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-09-30");
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = {};
  state.acceptAsk = {};
  state.accountRows = null;
  state.entries.push(${JSON.stringify(scenario.entry)});
  // The planner is module-scoped; dropping a plan that does not exist is the
  // smallest public control that re-runs it, unchanged.
  window.bpImportDropPlan("__render__");
  await sleep(900);
  // The real add path settles the page line after a plan lands; the drop above
  // only re-runs the planner.
  if (typeof bpImportInboxSettleStatus === "function") bpImportInboxSettleStatus();
  await sleep(100);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const words = (value) => (String(value || "").replace(/[·—–]/g, " ")
    .match(/[^\\s]+/g) || []).length;
  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => /Zerodha/.test(item.querySelector(".import-title")?.textContent || ""));
  if (!card) throw new Error("the Zerodha card is missing");
  const batch = document.querySelector(".import-batch");
  const status = document.getElementById("import-inbox-status");
  const primary = card.querySelector(".btn.primary");
  const details = card.querySelector("details");
  if (${openMore} && details) details.open = true;
  // Visible words are everything a person reads before opening More: clone the
  // card, drop the disclosure, count the rest.
  const clone = card.cloneNode(true);
  clone.querySelectorAll("details").forEach((node) => node.remove());
  const visibleWords = words(text(clone));
  const batchClone = batch?.cloneNode(true);
  batchClone?.querySelectorAll("button").forEach((node) => node.remove());
  const statusWords = words(text(status));
  const bar = { width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  card.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify({
    title: text(card.querySelector(".import-title")),
    sub: text(card.querySelector(".import-sub")),
    pill: text(card.querySelector(".import-pill")),
    primary: text(primary),
    primaryDisabled: !!primary?.disabled,
    batchText: text(batchClone),
    batchState: text(batchClone?.querySelector(".muted")),
    goToIt: !!batch?.querySelector("button") &&
      [...batch.querySelectorAll("button")].some((node) => /^Go to it$/.test(text(node))),
    importAll: !!batch &&
      [...batch.querySelectorAll("button")].some((node) => /^Import all$/.test(text(node))),
    status: text(status),
    visibleWords,
    barWords: words(text(batchClone)),
    statusWords,
    cardText: text(clone),
    moreWords: words(text(card.querySelector("details"))),
    bar,
  });
})()`;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders"), verify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--no-verify") { args.verify = false; continue; }
    if (flag !== "--out-dir") throw new Error(`render-import-copy: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-copy: --out-dir needs a value");
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
  throw new Error("render-import-copy: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-copy-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const scenario of SCENARIOS) {
    const pageFile = join(dir, `${scenario.name}.js`);
    writeFileSync(pageFile, pageScript(scenario));
    for (const shot of SHOTS) {
      const out = join(args.outDir, `import-copy-${scenario.name}-${shot.width}-${shot.theme}.png`);
      const result = await capture({
        page, out, script: pageFile, wait: 2200,
        width: shot.width, height: shot.height, theme: shot.theme,
      });
      const state = JSON.parse(result.value);
      if (args.verify) {
        const wrong = scenario.checks(state);
        if (wrong.length) {
          throw new Error(`render-import-copy: the ${scenario.name} state is not the copy `
            + `that was asked for.\n  ${wrong.join("\n  ")}\n  full state: `
            + JSON.stringify(state));
        }
      }
      console.log(`${out}  card ${state.visibleWords}w  bar ${state.barWords}w  `
        + `status ${state.statusWords}w`);
    }
  }
  // One shot with More open, to show the detail moved rather than disappeared.
  const openFile = join(dir, "choice-more.js");
  writeFileSync(openFile, pageScript(SCENARIOS[0], { openMore: true }));
  const openOut = join(args.outDir, "import-copy-choice-more-390-light.png");
  await capture({
    page, out: openOut, script: openFile, wait: 2200,
    width: 390, height: 2400, theme: "light",
  });
  console.log(openOut);
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
