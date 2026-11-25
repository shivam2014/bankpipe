#!/usr/bin/env node
// A CAS that names four demats, one already on file and three new, is one
// press: the match attaches and the three new accounts are created.
//
// The synthetic statement is the whole input. The seed is a single demat with
// two of the first account's ISINs and its BO ID. The page's own inbox planner
// and writer run; the check reads the store after the press.
//
// The card's first read is "1 matched · 3 new". Each account line says which it
// is, and the row's summary names the match and the creates. A tie between two
// existing accounts is not in this statement: that question is covered by the
// test, and the chooser stays untouched.
//
//   node scripts/render-import-cas-mixed.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-cas-mixed.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-10-31";
const EXISTING_BO = "IN99990001344321";
const NEW_BOS = ["9999000012345678", "9999000098765432", "9999000043218765"];

const isin = (n) => `INE${String(n).padStart(9, "0")}`;
const equity = (n, bo) => ({
  isin: isin(n), label: `TEST EQUITY ${n}`, kind: "equity",
  quantity: 10, valuePaise: 100000, costPaise: null, purchaseDate: "",
  couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
  account: bo, folio: "", amc: "", amcFull: "",
});

const ACCOUNT_ROWS = [
  [101, 102, 103],
  [201, 202],
  [301, 302],
  [401],
];
const BOS = [EXISTING_BO, ...NEW_BOS];

function statement() {
  const accounts = BOS.map((bo, at) => ({
    boId: bo, dpName: ["Test DP One", "Test DP Two", "Test DP Three", "Test DP Four"][at],
    holdings: ACCOUNT_ROWS[at].map((n) => equity(n, bo)),
  }));
  const holdings = accounts.flatMap((account) => account.holdings);
  return {
    depository: "CDSL", demat: EXISTING_BO, asOf: AS_OF, accounts, holdings,
    transactions: [], counts: { rows: holdings.length, quarantined: 0 },
    printedTotalPaise: holdings.reduce((total, row) => total + row.valuePaise, 0),
  };
}

function row(holding) {
  return {
    isin: holding.isin, label: holding.label, category: holding.kind,
    quantity: holding.quantity, valuePaise: holding.valuePaise, costPaise: null,
    purchaseDate: "", couponPct: null, frequency: "", maturity: "",
    facePaise: null, account: holding.account, folio: "", amc: "",
    amcFull: "", sourceRow: 0,
  };
}

function entry() {
  const parsed = statement();
  return {
    id: "inbox-render-cas-mixed", name: "cdsl-cas-synthetic.pdf", size: 2048,
    status: "ready", kind: "cas", broker: "", asOf: AS_OF,
    accountKey: EXISTING_BO, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName,
      rows: account.holdings.map(row),
    })),
    file: null,
  };
}

// The demat already on file. Its two rows are the first two ISINs of the
// statement's first account, at the same units, so the only question the
// statement raises is which account is new.
const SEED = {
  id: "demat-existing", label: "Demat · Test DP One · …4321", bank: "Test DP One",
  category: "demat", subtype: "equity", type: "equity", number: EXISTING_BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "Test DP One",
    holdings_source: "cas", holdings_as_of: AS_OF }),
  rows: [101, 102].map((n) => ({
    security_id: isin(n), label: `TEST EQUITY ${n}`, category: "equity",
    quantity: 10, cost_paise: null, value_paise: 100000, purchase_date: "",
    as_of: AS_OF, value_source: "cas", source: "report",
  })),
};

function pageScript({ press = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(SEED)};
  {
    const { rows, ...fields } = seed;
    await store.createAccount(fields);
    await store.replaceHoldings(fields.id, rows, "${AS_OF}");
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
  // Re-entering the page runs the real planner over the staged statement.
  go("import");
  await sleep(1400);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const host = document.getElementById("import-inbox-host");
  const row = host.querySelector(".import-row");
  if (!row) throw new Error("the CAS row is missing");
  const account = row.querySelector("details.import-row-account-control");
  // The split and the per-account lines are the proof of the card's shape, so
  // the shot opens the account section. The row summary is read before the
  // click and stays visible either way.
  if (account) account.open = true;
  const accountPanel = account?.querySelector(".import-row-account-menu") || account;
  const summary = {
    width: innerWidth,
    pill: text(row.querySelector(".import-row-pill")),
    facts: text(row.querySelector(".import-row-facts")),
    note: text(row.querySelector(".import-row-note")),
    accountControl: text(row.querySelector(".import-row-account")),
    split: text(accountPanel?.querySelector(".import-account-split")),
    accountLines: [...(accountPanel?.querySelectorAll(".import-account-choice") || [])]
      .map(text).filter(Boolean),
    choiceLines: [...(accountPanel?.querySelectorAll(".import-account-choice") || [])]
      .map(text).filter((line) => /__create__/.test(line)),
    chooser: !!account,
    rowPrimary: text(row.querySelector(".import-row-actions .btn.primary")),
    barPrimary: text(host.querySelector(".import-batchbar .btn.primary")),
    docWidth: document.documentElement.scrollWidth,
  };
  row.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);

  if (${press ? "true" : "false"}) {
    const button = host.querySelector(".import-batchbar .btn.primary")
      || row.querySelector(".import-row-actions .btn.primary");
    if (!button || button.disabled) throw new Error("the import button is not available");
    button.click();
    let receipts = 0;
    for (let attempt = 0; attempt < 48 && !receipts; attempt += 1) {
      await sleep(250);
      receipts = host.querySelectorAll(".import-row-receipt").length;
    }
    const accounts = await store.listAccounts();
    const holdings = {};
    for (const item of accounts) {
      const rows = await store.listHoldings(item.id);
      holdings[String(item.number || "")] = rows
        .filter((holding) => !holding.disposed_at && Number(holding.quantity) > 0)
        .map((holding) => holding.security_id).sort();
    }
    summary.receipts = receipts;
    summary.status = text(document.getElementById("import-inbox-status"));
    summary.accounts = accounts.map((item) => ({
      id: item.id, label: item.label, number: item.number,
      category: item.category, subtype: item.subtype,
    }));
    summary.holdings = holdings;
    summary.rowsLeft = host.querySelectorAll(".import-row").length;
  }
  return JSON.stringify(summary);
})()`;
}

function verifyCard(state) {
  const wrong = [];
  if (state.pill !== "Ready") {
    wrong.push(`pill: want "Ready", got ${JSON.stringify(state.pill)}`);
  }
  if (!/1 matched · 3 new/.test(state.facts)) {
    wrong.push(`the row does not state the split: ${JSON.stringify(state.facts)}`);
  }
  if (state.split !== "1 matched · 3 new") {
    wrong.push(`account split: want "1 matched · 3 new", got ${JSON.stringify(state.split)}`);
  }
  if (!/1 matched · 3 new/.test(state.accountControl)) {
    wrong.push(`the row's account summary does not name the match and the creates: `
      + JSON.stringify(state.accountControl));
  }
  if (!state.accountLines.some((line) => /Matched Demat · Test DP One/.test(line))) {
    wrong.push(`no line names the matched account: ${JSON.stringify(state.accountLines)}`);
  }
  const creates = state.accountLines.filter((line) => /New demat account/.test(line));
  if (creates.length !== 3) {
    wrong.push(`want 3 new-account lines, got ${creates.length}: `
      + JSON.stringify(state.accountLines));
  }
  if (state.choiceLines.length) {
    wrong.push(`the card still asks for a create: ${JSON.stringify(state.choiceLines)}`);
  }
  if (state.rowPrimary) {
    wrong.push(`a second primary sits on the row: ${JSON.stringify(state.rowPrimary)}`);
  }
  if (!state.barPrimary || state.barPrimary.disabled) {
    wrong.push(`the one press is not available: ${JSON.stringify(state.barPrimary)}`);
  }
  if (state.docWidth > state.width) {
    wrong.push(`the page scrolls sideways: ${state.docWidth}px at ${state.width}px`);
  }
  return wrong;
}

function verifyWrite(state) {
  const wrong = [];
  if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
  if (state.rowsLeft !== 0) wrong.push(`rows left in the queue: ${state.rowsLeft}`);
  if (!/imported/i.test(state.status)) {
    wrong.push(`status: ${JSON.stringify(state.status)}`);
  }
  if (state.accounts.length !== 4) {
    wrong.push(`accounts: want 4, got ${state.accounts.length} `
      + JSON.stringify(state.accounts));
  }
  const numbers = state.accounts.map((item) => String(item.number || "")).sort();
  if (numbers.join() !== [...BOS].sort().join()) {
    wrong.push(`account numbers: ${JSON.stringify(numbers)}`);
  }
  if (state.accounts.filter((item) => item.number === EXISTING_BO).length !== 1) {
    wrong.push("the matched demat was duplicated");
  }
  const expected = new Map(BOS.map((bo, at) => [bo, ACCOUNT_ROWS[at].map(isin).sort()]));
  for (const bo of BOS) {
    const got = state.holdings[bo] || [];
    if (got.join() !== expected.get(bo).join()) {
      wrong.push(`holdings for ${bo}: want ${expected.get(bo).join()}, got ${got.join()}`);
    }
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-cas-mixed: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-cas-mixed: --out-dir needs a value");
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
  throw new Error("render-import-cas-mixed: web/server.mjs did not answer.");
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

const SHOTS = [390, 1280];
mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-cas-mixed-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const width of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const script = join(dir, `shot-${width}-${theme}.js`);
      writeFileSync(script, pageScript());
      const out = join(args.outDir, `import-cas-mixed-${width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2400, width, height: 1400, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = verifyCard(state);
      if (wrong.length) {
        throw new Error(`render-import-cas-mixed: the ${width} ${theme} card is not the `
          + `card that was asked for.\n  ${wrong.join("\n  ")}\n  full state: `
          + JSON.stringify(state));
      }
      console.log(`${out}  ${width} ${theme}`);
    }
  }
  // The real proof: one press on the statement creates the three accounts and
  // attaches the fourth, then leaves the queue empty.
  const writeScript = join(dir, "write.js");
  writeFileSync(writeScript, pageScript({ press: true }));
  const writeOut = join(args.outDir, "import-cas-mixed-written-390-light.png");
  const written = await capture({
    page, out: writeOut, script: writeScript, wait: 2400,
    width: 390, height: 1400, theme: "light",
  });
  const writeState = JSON.parse(written.value);
  const writeWrong = verifyWrite(writeState);
  if (writeWrong.length) {
    throw new Error("render-import-cas-mixed: the one press did not write what it "
      + `promised.\n  ${writeWrong.join("\n  ")}\n  full state: ${JSON.stringify(writeState)}`);
  }
  console.log(writeOut);
  console.log("cas mixed: 1 matched · 3 new is Ready; each account line says Matched or New; "
    + "one press attaches the existing demat and creates the three, and the store holds 4 "
    + "accounts · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
