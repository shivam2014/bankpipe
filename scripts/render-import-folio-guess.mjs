#!/usr/bin/env node
// The import card when a value-only mutual fund account looks like the
// statement's folio by fund house, not by folio number.
//
// The stored account's number is a reference note ("Payment From …"), so the
// statement's NSDL folio is not on file. The card must say the match is a guess,
// compare the manual total with the statement, and wait for Adopt or Keep both.
//
// Every name, ISIN and number here is invented. The page's own inbox resolver
// and renderer produce the card.
//
//   node scripts/render-import-folio-guess.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-folio-guess.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-09-30";
const DEMAT = "1200000012345678";
const FOLIO = "91062983856";
const ISIN = "INF000000901";
const MANUAL_PAISE = 32167800;
const STATEMENT_PAISE = 31357941;
const COST_PAISE = 24000000;

const fund = {
  isin: ISIN, label: "TEST FUND TAX SAVER - REGULAR GROWTH", kind: "mf",
  quantity: 100, valuePaise: STATEMENT_PAISE, costPaise: COST_PAISE,
  folio: FOLIO, amc: "TESTMUTUAL", amcFull: "Test Mutual Fund",
};

function statement() {
  const holdings = [{ ...fund, account: DEMAT }];
  return {
    depository: "NSDL", demat: DEMAT, asOf: AS_OF,
    accounts: [{ boId: DEMAT, dpName: "Test DP", holdings }],
    holdings, transactions: [],
    counts: { rows: holdings.length, quarantined: 0 },
    printedTotalPaise: STATEMENT_PAISE,
  };
}

function row(holding) {
  return {
    isin: holding.isin, label: holding.label, category: holding.kind,
    quantity: holding.quantity, valuePaise: holding.valuePaise,
    costPaise: holding.costPaise, purchaseDate: "", couponPct: null,
    frequency: "", maturity: "", facePaise: null, account: holding.account || "",
    folio: holding.folio || "", amc: holding.amc || "",
    amcFull: holding.amcFull || "", sourceRow: 0,
  };
}

function entry() {
  const parsed = statement();
  return {
    id: "inbox-render-folio-guess", name: "nsdl-cas-synthetic.pdf", size: 2048,
    status: "ready", kind: "cas", broker: "", asOf: AS_OF,
    accountKey: DEMAT, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName, rows: account.holdings.map(row),
    })),
    file: null,
  };
}

function pageScript() {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  await store.createAccount({
    id: "axis-value", label: "Test Mutual Fund", bank: "Test Mutual Fund",
    category: "demat", subtype: "mutual fund", type: "mf",
    number: "Payment From 000000000000",
    meta: JSON.stringify({ amc: "testmutual", amc_full: "Test Mutual Fund",
      current_value_paise: ${MANUAL_PAISE} }),
  });
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = {};
  state.acceptAsk = {};
  state.accountRows = null;
  state.entries.push(${JSON.stringify(entry())});
  // Force the resolver to read the store again, so the seeded manual account is
  // one of the accounts the offer is computed from.
  window.bpImportDropPlan("__render__");
  await sleep(1200);

  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "CDSL CAS"
      || item.querySelector(".import-title")?.textContent.trim() === "NSDL CAS");
  if (!card) throw new Error("the CAS card is missing");
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const planOf = () => (state.plans || [])[0] || {};
  const folioTargetOf = () => (planOf().head?.casTargets || []).find((target) => target.folio);
  const folio = folioTargetOf();
  const offerNode = () => card.querySelector(".import-folio");
  const buttons = () => [...(offerNode()?.querySelectorAll("button") || [])].map(text);
  const rect = offerNode()?.getBoundingClientRect();
  const summary = {
    ready: !!planOf().ready,
    pill: text(card.querySelector(".import-pill")),
    statusLines: [...card.querySelectorAll(".import-account-choice .import-choice-meta")].map(text),
    offer: text(offerNode()),
    offerButtons: buttons(),
    offerHeight: rect ? Math.round(rect.height * 10) / 10 : 0,
    offerWidth: rect ? Math.round(rect.width * 10) / 10 : 0,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    folioAction: folio?.action || "",
    folioBasis: folio?.offer?.basis || "",
    folioTargetId: folio?.targetId || "",
  };
  card.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify(summary);
})()`;
}

const SHOTS = [
  { width: 320, height: 2400 },
  { width: 390, height: 2400 },
  { width: 1280, height: 1800 },
];

function verifyCard(state) {
  const wrong = [];
  if (state.ready) wrong.push("the card is Ready before the adopt-or-keep choice");
  if (state.pageOverflow) wrong.push("the page scrolls sideways");
  if (state.pill !== "Choose an account") {
    wrong.push(`pill: want "Choose an account", got ${JSON.stringify(state.pill)}`);
  }
  if (!state.statusLines.some((line) => line.includes("Similar account · choose below"))) {
    wrong.push(`status lines: ${JSON.stringify(state.statusLines)}`);
  }
  if (state.folioAction !== "decide") {
    wrong.push(`folio action: want "decide", got ${JSON.stringify(state.folioAction)}`);
  }
  if (state.folioBasis !== "guess") {
    wrong.push(`folio basis: want "guess", got ${JSON.stringify(state.folioBasis)}`);
  }
  if (state.folioTargetId) wrong.push(`a target exists without a choice: ${state.folioTargetId}`);
  if (!state.offerButtons.includes("Adopt into Test Mutual Fund")) {
    wrong.push(`Adopt button: ${JSON.stringify(state.offerButtons)}`);
  }
  if (!state.offerButtons.includes("Keep both")) {
    wrong.push(`Keep button: ${JSON.stringify(state.offerButtons)}`);
  }
  if (state.offerButtons.some((line) => /Keep the manual total|Create/i.test(line))) {
    wrong.push(`the guess still carries an exact-only answer: ${JSON.stringify(state.offerButtons)}`);
  }
  for (const want of ["Same fund?", "TEST FUND TAX SAVER - REGULAR GROWTH · folio …3856",
    "The existing row has no folio on file.", "Existing Test Mutual Fund", "3,21,678.00",
    "This statement", "3,13,579.41", "Difference", "−₹ 8,098.59", "2.5%",
    "Adopt replaces the manual total.", "Keep both counts both."]) {
    if (!state.offer.includes(want)) {
      wrong.push(`offer is missing ${JSON.stringify(want)}: ${JSON.stringify(state.offer)}`);
    }
  }
  for (const stale of ["current value with no units", "looks like your existing",
    "by fund house, not by folio"]) {
    if (state.offer.includes(stale)) {
      wrong.push(`the guess still carries ${JSON.stringify(stale)}: ${JSON.stringify(state.offer)}`);
    }
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-folio-guess: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-folio-guess: --out-dir needs a value");
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
    } catch {
      // still starting
    }
  }
  child.kill();
  throw new Error("render-import-folio-guess: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-folio-guess-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const script = join(dir, "page-card.js");
      writeFileSync(script, pageScript());
      const out = join(args.outDir,
        `import-folio-guess-${shot.width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2600,
        width: shot.width, height: shot.height, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = verifyCard(state);
      if (wrong.length) {
        throw new Error("render-import-folio-guess: the card is not the card that was "
          + "asked for.\n  " + wrong.join("\n  ")
          + "\n  full state: " + JSON.stringify(state));
      }
      console.log(`${out} · offer ${state.offerWidth}×${state.offerHeight}`);
    }
  }
  console.log("import folio guess: the question names the fund and folio, labels the match "
    + "as a guess, compares the manual total with the statement and waits for Adopt or "
    + "Keep both · 320/390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
