#!/usr/bin/env node
// The import card when one tradebook arrives twice, when it has no holdings
// report, when it has work, and when the only account on file is a demat for
// the same broker.
//
// Every card is rendered from the page's own inbox resolver and renderer at 390
// and 1280, light and dark. The tradebook is parsed by the page's parser on the
// way in, so the CSV and XLSX lines are the same rows, not a fixture that says
// they are. Every name, ISIN and number here is invented.
//
//   node scripts/render-import-tradebook.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTradebook, parseTradebookMatrix,
} from "../web/import-flow.js";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-tradebook.mjs [--out-dir build/renders]

  --out-dir    where the PNGs go, default build/renders
  --no-verify  shoot the cards without asserting the current copy (before shots)
`;

const AS_OF = "2026-10-26";
const BO = "1200000012348054";
const CLIENT_ID = "AB1234567";
const OTHER_CLIENT_ID = "ZZ9999999";
const ISIN = "INE000000010";

const TRADEBOOK = `symbol,isin,trade_date,exchange,trade_type,quantity,price
TESTSTOCKIND,${ISIN},2025-11-13,NSE,buy,5,3811.50
TESTSTOCKIND,${ISIN},2025-11-14,NSE,buy,4,3900
TESTSTOCKIND,${ISIN},2025-11-15,NSE,sell,2,4000`;

const TRADEBOOK_MATRIX = [
  ["Symbol", "ISIN", "Trade Date", "Exchange", "Trade Type", "Quantity", "Price"],
  ["TESTSTOCKIND", ISIN, "2025-11-13", "NSE", "buy", 5, 3811.5],
  ["TESTSTOCKIND", ISIN, "2025-11-14", "NSE", "buy", 4, 3900],
  ["TESTSTOCKIND", ISIN, "2025-11-15", "NSE", "sell", 2, 4000],
];

const parsedCsv = parseTradebook(TRADEBOOK);
const parsedXlsx = parseTradebookMatrix(TRADEBOOK_MATRIX);
if (parsedCsv.error || parsedXlsx.error) {
  throw new Error("render-import-tradebook: the synthetic tradebook did not parse");
}

const holdingRow = (over = {}) => ({
  isin: ISIN, label: "TESTSTOCKIND", category: "equity", quantity: 5,
  valuePaise: null, costPaise: 1905750, purchaseDate: "", sourceRow: 0, ...over,
});

function holdingsEntry({ accountKey = CLIENT_ID, purchaseDate = "" } = {}) {
  return {
    id: `inbox-render-holdings-${accountKey || "none"}`,
    name: "holdings-AB1234567.xlsx", size: 2048, status: "ready",
    kind: "zerodha-holdings", broker: "zerodha", asOf: AS_OF,
    accountKey, accountKind: accountKey ? "client" : "",
    rows: [holdingRow({ purchaseDate })], firstBuyByIsin: {},
    termsByIsin: [], termsByLabel: [], error: "", file: null,
  };
}

function tradebookEntry({ id, name, parsed }) {
  return {
    id, name, size: 1024, status: "ready", kind: "zerodha-tradebook",
    broker: "zerodha", asOf: "", accountKey: "", accountKind: "", rows: [],
    firstBuyByIsin: parsed.firstBuyByIsin,
    firstBuyBySymbol: parsed.firstBuyBySymbol,
    termsByIsin: [], termsByLabel: [], error: "", parsed, file: null,
  };
}

const csvEntry = (id = "inbox-render-tradebook-csv") => tradebookEntry({
  id, name: "tradebook-XXX002-EQ.csv", parsed: parsedCsv,
});
const xlsxEntry = (id = "inbox-render-tradebook-xlsx") => tradebookEntry({
  id, name: "tradebook-XXX002-EQ.xlsx", parsed: parsedXlsx,
});

const zerodhaDemat = ({ clientId = "", rows = [] } = {}) => ({
  id: "demat-zerodha", label: "Demat · Zerodha · …8054", bank: "Zerodha",
  category: "demat", subtype: "equity", type: "equity", number: BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({
    depository: "CDSL", dp: "Zerodha Broking Ltd",
    ...(clientId ? { client_id: clientId } : {}),
    holdings_source: "cas", holdings_as_of: "2026-09-30",
  }),
  rows,
});

const existingHolding = (isin, over = {}) => ({
  security_id: isin, label: "TESTSTOCKIND", category: "equity", quantity: 5,
  cost_paise: 1905750, value_paise: null, purchase_date: "",
  as_of: "2026-09-30", value_source: "CAS", source: "report", ...over,
});

const SCENARIOS = [
  {
    name: "zero-work",
    account: zerodhaDemat(),
    entries: [csvEntry(), xlsxEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.title !== "Zerodha tradebook") wrong.push(`title: ${state.title}`);
      if (state.files.length !== 1) wrong.push(`files: ${JSON.stringify(state.files)}`);
      if (state.files[0]?.meta !== "CSV and XLSX of the same tradebook") {
        wrong.push(`file meta: ${state.files[0]?.meta}`);
      }
      if (state.pill !== "Nothing to import yet") wrong.push(`pill: ${state.pill}`);
      if (state.primary !== "Nothing to import yet") wrong.push(`primary: ${state.primary}`);
      if (!state.primaryDisabled) wrong.push("the zero-work primary is enabled");
      if (state.accountChoices.length) {
        wrong.push(`the card offers an account it cannot use: ${JSON.stringify(state.accountChoices)}`);
      }
      if (!state.lines.includes("This tradebook only fills dates on holdings that are not "
        + "on file. Import the holdings report first.")) {
        wrong.push(`state line: ${JSON.stringify(state.lines)}`);
      }
      if (state.reviewButton) wrong.push("Review differences is offered on a zero-work card");
      if (!state.more?.detail.some((line) => /Attach to Demat · Zerodha · …8054 is already on file/.test(line))) {
        wrong.push(`account note: ${JSON.stringify(state.more?.detail)}`);
      }
      if (state.more?.detail.some((line) => /Nothing is written until you press Import/.test(line))) {
        wrong.push("the zero-work card still says to press Import");
      }
      return wrong;
    },
  },
  {
    name: "duplicate-file",
    account: zerodhaDemat({ clientId: CLIENT_ID, rows: [existingHolding(ISIN)] }),
    entries: [holdingsEntry(), csvEntry(), xlsxEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.title !== "Zerodha holdings") wrong.push(`title: ${state.title}`);
      if (state.files.length !== 2) wrong.push(`files: ${JSON.stringify(state.files)}`);
      if (!state.files.some((file) => file.meta === "CSV and XLSX of the same tradebook")) {
        wrong.push(`the duplicate line is missing: ${JSON.stringify(state.files)}`);
      }
      if (state.primary !== "Import 1 equity") wrong.push(`primary: ${state.primary}`);
      if (state.primaryDisabled) wrong.push("the import is disabled although it fills a date");
      if (state.pill !== "Ready") wrong.push(`pill: ${state.pill}`);
      if (!state.changeLines.includes("Update 1: TESTSTOCKIND")) {
        wrong.push(`change lines: ${JSON.stringify(state.changeLines)}`);
      }
      if (!state.more?.summary) wrong.push("the More disclosure is missing");
      return wrong;
    },
  },
  {
    name: "normal",
    account: zerodhaDemat({ clientId: CLIENT_ID, rows: [existingHolding(ISIN)] }),
    entries: [holdingsEntry(), csvEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.files.length !== 2) wrong.push(`files: ${JSON.stringify(state.files)}`);
      if (!state.files.some((file) =>
        /Zerodha tradebook · Fills first purchase dates/.test(file.meta))) {
        wrong.push(`the tradebook line is missing: ${JSON.stringify(state.files)}`);
      }
      if (state.primary !== "Import 1 equity") wrong.push(`primary: ${state.primary}`);
      if (state.primaryDisabled) wrong.push("the normal import is disabled");
      if (!state.changeLines.includes("Update 1: TESTSTOCKIND")) {
        wrong.push(`change lines: ${JSON.stringify(state.changeLines)}`);
      }
      return wrong;
    },
  },
  {
    name: "attach",
    account: zerodhaDemat(),
    entries: [holdingsEntry({ accountKey: OTHER_CLIENT_ID })],
    checks: (state) => {
      const wrong = [];
      if (!state.accountChoices.some((line) =>
        /Attach to Demat · Zerodha · …8054/.test(line) && /No client ID or ISIN matches yet/.test(line))) {
        wrong.push(`attach choice: ${JSON.stringify(state.accountChoices)}`);
      }
      if (state.accountChoices.some((line) => /Create broker-only account/.test(line))) {
        wrong.push("a duplicate broker-only account is still offered");
      }
      if (state.pill !== "Choose an account") wrong.push(`pill: ${state.pill}`);
      if (!state.primaryDisabled) wrong.push("the import runs before an account is chosen");
      return wrong;
    },
  },
];

const SHOTS = [
  { width: 390, height: 2200, theme: "dark" },
  { width: 390, height: 2200, theme: "light" },
  { width: 1280, height: 1500, theme: "dark" },
  { width: 1280, height: 1500, theme: "light" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders"), verify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--no-verify") { args.verify = false; continue; }
    if (flag !== "--out-dir") throw new Error(`render-import-tradebook: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-tradebook: --out-dir needs a value");
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
  throw new Error("render-import-tradebook: web/server.mjs did not answer.");
}

function pageScript(scenario) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(scenario.account)};
  const { rows, ...fields } = seed;
  await store.createAccount(fields);
  if (rows.length) await store.replaceHoldings(fields.id, rows, "2026-09-30");
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = {};
  state.acceptAsk = {};
  state.accountRows = null;
  state.entries.push(...${JSON.stringify(scenario.entries)});
  // The planner is module-scoped; dropping a plan that does not exist is the
  // smallest public control that re-runs it, unchanged.
  window.bpImportDropPlan("__render__");
  await sleep(900);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => /Zerodha/.test(item.querySelector(".import-title")?.textContent || ""));
  if (!card) throw new Error("the Zerodha card is missing");
  const more = card.querySelector("details");
  const primary = card.querySelector(".btn.primary");
  const lines = [...card.querySelectorAll(".import-nowork .import-note")].map(text);
  const result = {
    title: text(card.querySelector(".import-title")),
    sub: text(card.querySelector(".import-sub")),
    pill: text(card.querySelector(".import-pill")),
    files: [...card.querySelectorAll(".import-file")].map((file) => ({
      name: text(file.querySelector(".import-file-name")),
      meta: text(file.querySelector(".import-file-meta")),
    })),
    accountChoices: [...card.querySelectorAll(".import-account-choice")].map(text),
    lines,
    changeLines: [...card.querySelectorAll(".import-change > b, .import-change li")]
      .map(text).filter(Boolean),
    more: more ? {
      summary: text(more.querySelector("summary")),
      detail: [...more.querySelectorAll("li")].map(text),
    } : null,
    primary: text(primary),
    primaryDisabled: !!primary?.disabled,
    reviewButton: [...card.querySelectorAll(".btn")]
      .some((button) => /^Review differences$/.test(text(button))),
    buttons: [...card.querySelectorAll(".btn")].map(text),
  };
  card.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify(result);
})()`;
}

function verify(scenario, state) {
  const wrong = scenario.checks(state);
  if (wrong.length) {
    throw new Error(`render-import-tradebook: ${scenario.name} is not the card that was asked for.\n  `
      + `${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-tradebook-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const scenario of SCENARIOS) {
    const pageFile = join(dir, `${scenario.name}.js`);
    writeFileSync(pageFile, pageScript(scenario));
    for (const shot of SHOTS) {
      const out = join(args.outDir,
        `import-${scenario.name}-${shot.width}-${shot.theme}.png`);
      const result = await capture({
        page, out, script: pageFile, wait: 2200,
        width: shot.width, height: shot.height, theme: shot.theme,
      });
      if (args.verify) verify(scenario, JSON.parse(result.value));
      console.log(out);
    }
    console.log(`${scenario.name}: ${args.verify ? "card verified" : "shot"}`);
  }
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
