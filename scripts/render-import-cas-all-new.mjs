#!/usr/bin/env node
// A CAS whose accounts are all new must be one press, not a chooser.
//
// Two synthetic statements, one difference:
//
// - empty: no account on file, four accounts in the statement (two demats and
//   two mutual-fund folios). Nothing can be chosen, so the row says the count
//   and one press creates all four and writes every row.
// - near: one demat on file holds two of the first demat's three ISINs. That is
//   a candidate, so the chooser stays exactly as it was, beside the new
//   accounts the statement also names.
//
// Every name, ISIN and number here is invented. The page's own inbox resolver
// and renderer produce each row; the empty state's press reads the store back.
//
//   node scripts/render-import-cas-all-new.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-cas-all-new.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-11-20";
const BO_ONE = "9999000012345678";
const BO_TWO = "9999000098765432";
const FOLIO_ONE = "999900000001/0";
const FOLIO_TWO = "999900000002/0";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const equity = (n) => ({
  isin: isin(700 + n), label: `TEST EQUITY ${n}`, kind: "equity",
  quantity: 10 + n, valuePaise: 100000 * (n + 1),
});
const bond = (n) => ({
  isin: isin(800 + n), label: `9.25% TEST BOND ${n} 31 Dec 2028`,
  kind: "bond", quantity: 10, valuePaise: 100000, couponPct: 9.25,
  maturity: "2028-12-31",
});
const fund = (n, folio, amc) => ({
  isin: isin(900 + n), label: `TEST FUND ${n} GROWTH PLAN`, kind: "mf",
  quantity: 100 + n, valuePaise: 500000, folio, amc, amcFull: `Test Fund ${n}`,
});

const ONE_ROWS = [equity(1), equity(2), equity(3)];
const TWO_ROWS = [bond(1), bond(2), fund(1, FOLIO_ONE, "TESTMUTUAL"),
  fund(2, FOLIO_TWO, "OTHERFUND")];

function statement() {
  const accounts = [
    { boId: BO_ONE, dpName: "Test DP One",
      holdings: ONE_ROWS.map((row) => ({ ...row, account: BO_ONE })) },
    { boId: BO_TWO, dpName: "Test DP Two",
      holdings: TWO_ROWS.map((row) => ({ ...row, account: BO_TWO })) },
  ];
  const holdings = accounts.flatMap((account) => account.holdings);
  return {
    depository: "CDSL", demat: BO_ONE, asOf: AS_OF, accounts, holdings,
    transactions: [], counts: { rows: holdings.length, quarantined: 0 },
    printedTotalPaise: holdings.reduce((total, row) => total + row.valuePaise, 0),
  };
}

function row(holding) {
  return {
    isin: holding.isin, label: holding.label, category: holding.kind,
    quantity: holding.quantity, valuePaise: holding.valuePaise, costPaise: null,
    purchaseDate: "", couponPct: holding.couponPct || null,
    frequency: holding.frequency || "", maturity: holding.maturity || "",
    facePaise: holding.faceValuePaise ?? null, account: holding.account || "",
    folio: holding.folio || "", amc: holding.amc || "",
    amcFull: holding.amcFull || "", sourceRow: 0,
  };
}

function entry() {
  const parsed = statement();
  return {
    id: "inbox-render-cas-all-new", name: "cdsl-cas-synthetic.pdf", size: 2048,
    status: "ready", kind: "cas", broker: "", asOf: AS_OF,
    accountKey: BO_ONE, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName,
      rows: account.holdings.map(row),
    })),
    file: null,
  };
}

// A demat that already holds two of the three ISINs of the first statement
// account. It is a candidate, not an automatic match: the share is below the
// 80 percent attach rule, so the person must choose.
const NEAR_ROWS = ONE_ROWS.slice(0, 2).map((holding) => ({
  security_id: holding.isin, label: holding.label, category: "equity",
  quantity: 1, cost_paise: null, value_paise: 100000, purchase_date: "",
  as_of: "2026-10-31", value_source: "cas", source: "report",
}));
const NEAR = {
  id: "demat-near", label: "Demat · Test DP Near · …1111", bank: "Test DP Near",
  category: "demat", subtype: "equity", type: "equity", number: "9999000011111111",
  holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "Test DP Near",
    holdings_source: "cas", holdings_as_of: "2026-10-31" }),
  rows: NEAR_ROWS,
};

function pageScript({ seed = null, press = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seeds = ${JSON.stringify(seed ? [seed] : [])};
  for (const item of seeds) {
    const { rows: seedRows, ...fields } = item;
    await store.createAccount(fields);
    if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-10-31");
  }
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = {};
  state.acceptAsk = {};
  state.receipts = [];
  state.accountRows = null;
  state.entries.push(${JSON.stringify(entry())});
  // Re-entering the page runs the real planner over the staged entry. Nothing
  // here writes a plan by hand.
  go("import");
  await sleep(1400);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const host = document.getElementById("import-inbox-host");
  const row = host.querySelector(".import-row");
  if (!row) throw new Error("the CAS row is missing");
  const chooser = row.querySelector("details.import-row-account");
  const choiceLines = [...row.querySelectorAll(".import-account-choice")].map(text);
  const primary = row.querySelector(".import-row-actions .btn.primary");
  const summary = {
    width: innerWidth,
    pill: text(row.querySelector(".import-row-pill")),
    facts: text(row.querySelector(".import-row-facts")),
    note: text(row.querySelector(".import-row-note")),
    chooser: !!chooser,
    chooserSummary: text(chooser?.querySelector("summary")),
    choiceLines,
    primary: text(primary),
    primaryDisabled: !!primary?.disabled,
    accountControl: !!row.querySelector(".import-row-account-control"),
    docWidth: document.documentElement.scrollWidth,
  };
  row.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);

  if (${press ? "true" : "false"}) {
    if (!primary || primary.disabled) throw new Error("the create button is not available");
    primary.click();
    let receipts = 0;
    for (let attempt = 0; attempt < 48 && !receipts; attempt += 1) {
      await sleep(250);
      receipts = host.querySelectorAll(".import-row-receipt").length;
    }
    const accounts = await store.listAccounts();
    const holdings = {};
    for (const account of accounts) {
      holdings[String(account.number || "")] = (await store.listHoldings(account.id))
        .filter((holding) => !holding.disposed_at && Number(holding.quantity) > 0)
        .map((holding) => holding.security_id);
    }
    summary.receipts = receipts;
    summary.status = text(document.getElementById("import-inbox-status"));
    summary.planState = (window.bpImportInbox.plans || []).map((plan) => ({
      key: plan.key, ready: plan.ready, needsChoice: plan.needsChoice,
      accountCount: plan.accountCount, summary: plan.summary,
      targets: (plan.head.casTargets || []).map((target) => ({
        boId: target.boId, action: target.action, targetId: target.targetId,
        createChoice: !!target.createChoice, needsChoice: !!target.needsChoice,
        offer: !!target.offer, matches: (target.match?.matches || []).length,
        ask: target.plan?.summary?.ask, date: target.plan?.incomingDateState,
      })),
    }));
    summary.accounts = accounts.map((account) => ({
      id: account.id, label: account.label, number: account.number,
      category: account.category, subtype: account.subtype,
    }));
    summary.holdings = holdings;
    summary.rowCount = host.querySelectorAll(".import-row").length;
  }
  return JSON.stringify(summary);
})()`;
}

function verifyEmpty(state) {
  const wrong = [];
  if (state.pill !== "Needs an account") {
    wrong.push(`pill: want "Needs an account", got ${JSON.stringify(state.pill)}`);
  }
  if (state.note) {
    wrong.push(`the empty statement carries a note: ${JSON.stringify(state.note)}`);
  }
  if (state.chooser || state.chooserSummary) {
    wrong.push(`the empty statement still shows a chooser: `
      + JSON.stringify(state.chooserSummary));
  }
  if (state.choiceLines.length) {
    wrong.push(`the empty statement still lists choices: ${JSON.stringify(state.choiceLines)}`);
  }
  if (state.primary !== "Import and create 4 accounts") {
    wrong.push(`primary: want "Import and create 4 accounts", got `
      + JSON.stringify(state.primary));
  }
  if (state.primaryDisabled) wrong.push("the one-press create button is disabled");
  if (state.docWidth > state.width) {
    wrong.push(`the page scrolls sideways: ${state.docWidth}px at ${state.width}px`);
  }
  return wrong;
}

function verifyWrite(state) {
  const wrong = [];
  if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
  if (state.rowCount !== 0) wrong.push(`rows left in the queue: ${state.rowCount}`);
  if (!/imported/i.test(state.status)) {
    wrong.push(`status: ${JSON.stringify(state.status)}`);
  }
  if (state.accounts.length !== 4) {
    wrong.push(`accounts created: want 4, got ${state.accounts.length} `
      + JSON.stringify(state.accounts));
  }
  const numbers = state.accounts.map((account) => String(account.number || ""));
  for (const number of [BO_ONE, BO_TWO, FOLIO_ONE, FOLIO_TWO]) {
    if (!numbers.includes(number)) {
      wrong.push(`missing account ${number}: ${JSON.stringify(state.accounts)}`);
    }
  }
  const count = (number) => (state.holdings[number] || []).length;
  if (count(BO_ONE) !== 3) wrong.push(`demat one rows: ${count(BO_ONE)}`);
  if (count(BO_TWO) !== 2) wrong.push(`demat two rows: ${count(BO_TWO)}`);
  if (count(FOLIO_ONE) !== 1) wrong.push(`folio one rows: ${count(FOLIO_ONE)}`);
  if (count(FOLIO_TWO) !== 1) wrong.push(`folio two rows: ${count(FOLIO_TWO)}`);
  return wrong;
}

function verifyNear(state) {
  const wrong = [];
  if (state.pill !== "Needs an account") {
    wrong.push(`pill: want "Needs an account", got ${JSON.stringify(state.pill)}`);
  }
  if (!state.chooser || state.chooserSummary !== "Choose the account") {
    wrong.push(`the near match lost its chooser: ${JSON.stringify(state.chooserSummary)}`);
  }
  if (!state.choiceLines.some((line) => /…1111/.test(line))) {
    wrong.push(`the existing candidate is not offered: ${JSON.stringify(state.choiceLines)}`);
  }
  if (!state.choiceLines.some((line) => /New demat account/.test(line))) {
    wrong.push(`the statement's new demat is not named: ${JSON.stringify(state.choiceLines)}`);
  }
  if (!state.choiceLines.some((line) => /New mutual fund folio account/.test(line))) {
    wrong.push(`the statement's new folios are not named: `
      + JSON.stringify(state.choiceLines));
  }
  if (state.primary) {
    wrong.push(`the near match offered a one-press create: ${JSON.stringify(state.primary)}`);
  }
  if (/No account on file matches this file/.test(state.note)) {
    wrong.push(`the near match kept the empty sentence: ${JSON.stringify(state.note)}`);
  }
  if (state.docWidth > state.width) {
    wrong.push(`the page scrolls sideways: ${state.docWidth}px at ${state.width}px`);
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-cas-all-new: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-cas-all-new: --out-dir needs a value");
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
  throw new Error("render-import-cas-all-new: web/server.mjs did not answer.");
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

const SHOTS = [390, 604];
const SCENARIOS = [
  { name: "cas-all-new", seed: null, verify: verifyEmpty },
  { name: "cas-near-match", seed: NEAR, verify: verifyNear },
];

mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-cas-all-new-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const scenario of SCENARIOS) {
    for (const width of SHOTS) {
      for (const theme of ["light", "dark"]) {
        const script = join(dir, `${scenario.name}-${width}-${theme}.js`);
        writeFileSync(script, pageScript({ seed: scenario.seed }));
        const out = join(args.outDir, `${scenario.name}-${width}-${theme}.png`);
        const result = await capture({
          page, out, script, wait: 2400, width, height: 1200, theme,
        });
        const state = JSON.parse(result.value);
        const wrong = scenario.verify(state);
        if (wrong.length) {
          throw new Error(`render-import-cas-all-new: ${scenario.name} ${width} ${theme} `
            + "is not the state that was asked for.\n  " + wrong.join("\n  ")
            + "\n  full state: " + JSON.stringify(state));
        }
        console.log(`${out}  ${scenario.name} ${width} ${theme}`);
      }
    }
  }
  // The real proof: the empty-database row's one press creates every account
  // and writes the rows, then the queue is empty.
  const writeScript = join(dir, "cas-all-new-write.js");
  writeFileSync(writeScript, pageScript({ press: true }));
  const writeOut = join(args.outDir, "cas-all-new-written-390-light.png");
  const written = await capture({
    page, out: writeOut, script: writeScript, wait: 2400,
    width: 390, height: 1200, theme: "light",
  });
  const writeState = JSON.parse(written.value);
  const writeWrong = verifyWrite(writeState);
  if (writeWrong.length) {
    throw new Error("render-import-cas-all-new: the one press did not write what it "
      + "promised.\n  " + writeWrong.join("\n  ")
      + "\n  full state: " + JSON.stringify(writeState));
  }
  console.log(writeOut);
  console.log("cas all new: the empty statement is one press that creates 4 accounts "
    + "and writes 7 rows; the near match keeps its chooser · 390 and 604, light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
