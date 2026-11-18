#!/usr/bin/env node
// The import inbox copy, rendered from the page's own resolver and renderer.
//
// Four synthetic states, one file each: a Zerodha holdings report that needs an
// account choice, the same report already attached to its account, ten pending
// decisions, and two updates beside sixteen new rows. The shots carry the batch
// bar, the page status line and the card at 390 and 1280, light and dark. The
// intro list gets its own top-of-page shot. Every name, ISIN and number here is
// invented.
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

const account = ({ clientId = "", accountRows = [], source = "cas" } = {}) => ({
  id: "demat-zerodha", label: "Demat · Zerodha · …8054", bank: "Zerodha",
  category: "demat", subtype: "equity", type: "equity", number: BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({
    depository: "CDSL", dp: "Zerodha Broking Ltd",
    ...(clientId ? { client_id: clientId } : {}),
    holdings_source: source, holdings_as_of: "2026-09-30",
  }),
  rows: accountRows,
});

const entry = ({ accountKey = OTHER_CLIENT_ID, entryRows = rows } = {}) => ({
  id: `inbox-render-copy-${accountKey || "none"}`,
  name: "holdings-AB1234567.xlsx", size: 2048, status: "ready",
  kind: "zerodha-holdings", broker: "zerodha", asOf: AS_OF,
  accountKey, accountKind: accountKey ? "client" : "",
  rows: entryRows, firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [],
  error: "", file: null,
});

// The owner's shape: a CAS snapshot at 16 units, then a newer broker report at
// 50 with the cost, purchase date and label the CAS does not carry. Each row is
// a decision because the report disagrees with a quantity the CAS set.
const DECISION_EXISTING = Array.from({ length: 10 }, (_, at) => ({
  security_id: isin(700 + at), label: `TEST EQUITY ${at + 1}`, category: "equity",
  quantity: 16, cost_paise: null, value_paise: null, purchase_date: "",
  as_of: "2026-09-30", value_source: "CAS", source: "report",
}));
const DECISION_ROWS = DECISION_EXISTING.map((row, at) => ({
  isin: row.security_id, label: `TESTEQ${at + 1}`, category: "equity",
  quantity: 50, valuePaise: null, costPaise: 8849750,
  purchaseDate: "2026-08-25", sourceRow: at,
}));

// The owner's other shape: two holdings move, sixteen are new. The account's
// latest snapshot is a broker report, not a CAS, so the newer report updates
// the two without asking.
const UPDATE_EXISTING = [0, 1].map((at) => ({
  security_id: isin(800 + at), label: `TESTEQ${at + 1}`, category: "equity",
  quantity: 10, cost_paise: null, value_paise: null, purchase_date: "",
  as_of: "2026-09-30", value_source: "CAS", source: "report",
}));
const UPDATE_ROWS = [
  ...UPDATE_EXISTING.map((row, at) => ({
    isin: row.security_id, label: row.label, category: "equity", quantity: 12,
    valuePaise: null, costPaise: 5000000, purchaseDate: "2026-08-25", sourceRow: at,
  })),
  ...Array.from({ length: 16 }, (_, at) => ({
    isin: isin(820 + at), label: `TESTNEW${at + 1}`, category: "equity", quantity: 5,
    valuePaise: null, costPaise: 1000000, purchaseDate: "2026-09-01", sourceRow: at + 2,
  })),
];

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
  {
    name: "decisions",
    account: account({ clientId: CLIENT_ID, accountRows: DECISION_EXISTING }),
    entry: entry({ accountKey: CLIENT_ID, entryRows: DECISION_ROWS }),
    checks: (state) => {
      const wrong = [];
      const reason = "Same date, or the report disagrees with a CAS quantity.";
      if (state.primary !== "Use the file's values · 10") {
        wrong.push(`primary: ${JSON.stringify(state.primary)}`);
      }
      if (state.primaryDisabled) wrong.push("the decision primary is disabled");
      if (!state.buttons.includes("Review differences")) {
        wrong.push(`Review differences is missing: ${JSON.stringify(state.buttons)}`);
      }
      if (state.buttons.some((label) => /^Import /.test(label))) {
        wrong.push(`the card offers an Import while a decision is pending: ${JSON.stringify(state.buttons)}`);
      }
      if (state.reason !== reason) {
        wrong.push(`reason line: ${JSON.stringify(state.reason)}`);
      }
      if (state.decisionRows.length !== 10) {
        wrong.push(`decision rows: ${state.decisionRows.length}`);
      }
      for (const line of state.decisionRows) {
        if (!/qty 16\s*→\s*50/.test(line) || !/cost —\s*→\s*₹88,497/.test(line)
          || !/date →\s*25 Aug 26/.test(line)) {
          wrong.push(`decision line is not structured: ${JSON.stringify(line)}`);
          break;
        }
      }
      if (state.notChange) wrong.push("What will not change is still on the card");
      if (/Other accounts with overlapping ISINs/.test(state.cardText)) {
        wrong.push("the other-accounts reassurance is still on the card");
      }
      if (state.consent !== "Nothing is written until you press Import.") {
        wrong.push(`consent line: ${JSON.stringify(state.consent)}`);
      }
      if (state.status !== "Use the file's values for 10 differences in Zerodha holdings.") {
        wrong.push(`status: ${JSON.stringify(state.status)}`);
      }
      return wrong;
    },
  },
  {
    name: "two-updates",
    account: account({ clientId: CLIENT_ID, accountRows: UPDATE_EXISTING,
      source: "zerodha" }),
    entry: entry({ accountKey: CLIENT_ID, entryRows: UPDATE_ROWS }),
    checks: (state) => {
      const wrong = [];
      if (state.primary !== "Import 18 equities") {
        wrong.push(`primary: ${JSON.stringify(state.primary)}`);
      }
      if (state.primaryDisabled) wrong.push("the import is disabled although it has work");
      if (state.pill !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pill)}`);
      if (!state.changeLines.includes("Add 16 holdings")) {
        wrong.push(`add line: ${JSON.stringify(state.changeLines)}`);
      }
      if (!state.changeLines.includes("Update 2: TESTEQ1, TESTEQ2")) {
        wrong.push(`update line: ${JSON.stringify(state.changeLines)}`);
      }
      if (state.hasAsk) wrong.push("a newer broker report should not ask");
      return wrong;
    },
  },
  {
    name: "decisions-resolved",
    account: account({ clientId: CLIENT_ID, accountRows: DECISION_EXISTING }),
    entry: entry({ accountKey: CLIENT_ID, entryRows: DECISION_ROWS }),
    resolve: true,
    checks: (state) => {
      const wrong = [];
      if (state.hasAsk) wrong.push("the decision block survived accepting its values");
      if (state.decisionRows.length) wrong.push("the decision rows survived accepting");
      if (!/^Import 10 equities$/.test(state.primary)) {
        wrong.push(`primary after accepting: ${JSON.stringify(state.primary)}`);
      }
      if (state.primaryDisabled) wrong.push("Import is disabled after accepting");
      if (state.buttons.includes("Use the file's values · 10")) {
        wrong.push("the accept button survived accepting");
      }
      if (state.pill !== "Ready") wrong.push(`pill after accepting: ${JSON.stringify(state.pill)}`);
      if (state.notChange) wrong.push("What will not change is still on the card");
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

function pageScript(scenario, { openMore = false, resolve = false } = {}) {
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
  let card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => /Zerodha/.test(item.querySelector(".import-title")?.textContent || ""));
  if (!card) throw new Error("the Zerodha card is missing");
  if (${resolve}) {
    card.querySelector(".import-actions .btn.primary")?.click();
    await sleep(1200);
    card = [...document.querySelectorAll(".import-bundle")]
      .find((item) => /Zerodha/.test(item.querySelector(".import-title")?.textContent || ""));
    if (!card) throw new Error("the Zerodha card is missing after accepting");
  }
  const batch = document.querySelector(".import-batch");
  const status = document.getElementById("import-inbox-status");
  const primary = card.querySelector(".import-actions .btn.primary");
  const details = card.querySelector("details.import-change-more");
  if (${openMore} && details) details.open = true;
  // The old ask list lived behind More. Open it for a measurement even when the
  // shot keeps the card closed, so before and after heights are comparable.
  const measureMore = card.querySelector("details.import-change-more");
  if (measureMore) measureMore.open = true;
  const askListHeight = card.querySelector(".import-ask-list")
    ?.getBoundingClientRect().height || 0;
  const bulletHeight = card.querySelector(".import-ask-list li")
    ?.getBoundingClientRect().height || 0;
  const decisionHeight = card.querySelector(".import-decisions")
    ?.getBoundingClientRect().height || 0;
  const changeLines = [...card.querySelectorAll(".import-change ul li")].map(text);
  const firstDecision = card.querySelector(".import-decision");
  const decisionFactWidths = [...(firstDecision?.querySelectorAll(".import-decision-facts span")
    || [])].map((node) => Math.round(node.getBoundingClientRect().width));
  const decisionFactsWidth = Math.round(firstDecision
    ?.querySelector(".import-decision-facts")?.getBoundingClientRect().width || 0);
  const decisionNameWidth = Math.round(firstDecision
    ?.querySelector(".import-decision-name")?.getBoundingClientRect().width || 0);
  if (measureMore && !${openMore}) measureMore.open = false;
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
    buttons: [...card.querySelectorAll(".import-actions button")].map(text),
    reason: text(card.querySelector(".import-reason")),
    hasAsk: !!card.querySelector(".import-wrong"),
    changeLines,
    decisionRows: [...card.querySelectorAll(".import-decision-line")].map(text),
    decisionHeight,
    decisionFactWidths,
    decisionFactsWidth,
    decisionNameWidth,
    askListHeight,
    bulletHeight,
    notChange: /What will not change/.test(card.textContent || ""),
    consent: text(card.querySelector(".import-consent")),
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
    writeFileSync(pageFile, pageScript(scenario, { resolve: !!scenario.resolve }));
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
      if (scenario.name === "decisions") {
        console.log(`  decisions ${state.decisionRows.length} rows, block `
          + `${state.decisionHeight.toFixed(0)}px, old ask list `
          + `${state.askListHeight.toFixed(0)}px, one old bullet `
          + `${state.bulletHeight.toFixed(0)}px, primary ${JSON.stringify(state.primary)} `
          + `(facts ${state.decisionNameWidth}+${state.decisionFactsWidth}px `
          + `[${state.decisionFactWidths.join(", ")}])`);
        if (process.env.RENDER_DEBUG) console.log(JSON.stringify(state, null, 2));
      }
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
  const decisionMoreFile = join(dir, "decisions-more.js");
  writeFileSync(decisionMoreFile, pageScript(SCENARIOS[2], { openMore: true }));
  const decisionMoreOut = join(args.outDir, "import-copy-decisions-more-390-light.png");
  await capture({
    page, out: decisionMoreOut, script: decisionMoreFile, wait: 2200,
    width: 390, height: 2600, theme: "light",
  });
  console.log(decisionMoreOut);
  const updateMoreFile = join(dir, "two-updates-more.js");
  writeFileSync(updateMoreFile, pageScript(SCENARIOS[3], { openMore: true }));
  const updateMoreOut = join(args.outDir, "import-copy-two-updates-more-390-light.png");
  await capture({
    page, out: updateMoreOut, script: updateMoreFile, wait: 2200,
    width: 390, height: 2200, theme: "light",
  });
  console.log(updateMoreOut);
  // The page intro is above the drop zone and the card, so it needs its own
  // top-of-page shot. It is one list of the three file types, nothing else.
  const introFile = join(dir, "intro.js");
  writeFileSync(introFile, `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  go("import");
  await sleep(900);
  scrollTo(0, 0);
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const intro = document.querySelector(".import-intro");
  const help = document.querySelector(".import-help");
  return JSON.stringify({
    intro: text(intro),
    items: [...(intro?.querySelectorAll("li") || [])].map(text),
    help: text(help),
  });
})()`);
  for (const shot of [
    { width: 390, height: 900, theme: "dark" },
    { width: 390, height: 900, theme: "light" },
    { width: 1280, height: 900, theme: "dark" },
    { width: 1280, height: 900, theme: "light" },
  ]) {
    const out = join(args.outDir, `import-intro-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script: introFile, wait: 1600,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    if (args.verify) {
      const expected = [
        "Depository statement (CAS) — CDSL or NSDL, after month end",
        "Broker holdings report — Zerodha, Motilal Oswal, DigiFInn",
        "Bank statement — CSV, XLSX or PDF",
      ];
      const wrong = [];
      if (JSON.stringify(state.items) !== JSON.stringify(expected)) {
        wrong.push(`the intro list is not the three file types: ${JSON.stringify(state.items)}`);
      }
      if (/logins, OTPs and PINs/i.test(state.intro)) {
        wrong.push("the login reassurance is back in the intro");
      }
      if (/Nothing is saved until you confirm/i.test(state.intro)) {
        wrong.push("the drop-zone reassurance is back in the intro");
      }
      if (!/logins, OTPs and PINs/i.test(state.help)) {
        wrong.push("the login reassurance is not in What can I add?");
      }
      if (wrong.length) {
        throw new Error(`render-import-copy: the Import intro is not the copy that `
          + `was asked for.\n  ${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
      }
    }
    console.log(out);
  }
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
