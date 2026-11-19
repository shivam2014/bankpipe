#!/usr/bin/env node
// The rebuilt Import screen in its six required states, at 390 and 1280, light
// and dark. Every name, ISIN, number and amount here is invented.
//
//   node scripts/render-import-queue.mjs [--out-dir build/renders]
//
// The page's own reader and planner build each state through the public inbox
// state. The script fails when a row is missing, a pill says the wrong thing,
// the bar counts a file that cannot run, a control is under 44px, or the page
// scrolls sideways.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { PDF_PASSWORD_WRONG } from "../web/import-password.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-queue.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-11-12";
const BO = "1200000012348054";
const CLIENT_ID = "AB1234567";
const UNMATCHED_ID = "ZZ9999999";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const rows = Array.from({ length: 17 }, (_, at) => ({
  isin: isin(600 + at), label: `TEST EQUITY ${at + 1}`, category: "equity",
  quantity: 10 + at, valuePaise: 100000 * (at + 1), costPaise: null,
  purchaseDate: "", sourceRow: at,
}));

const account = {
  id: "demat-zerodha", label: "Demat · Zerodha · …8054", bank: "Zerodha",
  category: "demat", subtype: "equity", type: "equity", number: BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "Zerodha Broking Ltd",
    client_id: CLIENT_ID, holdings_source: "cas", holdings_as_of: "2026-09-30" }),
  rows: [],
};

const holding = (over = {}) => ({
  isin: isin(600), label: "TEST EQUITY 1", kind: "equity", quantity: 10,
  valuePaise: 100000, costPaise: null, purchaseDate: "",
  couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
  account: BO, folio: "", amc: "", amcFull: "", ...over,
});

const brokerEntry = (accountKey = CLIENT_ID, entryRows = rows) => ({
  id: `inbox-render-${accountKey}`,
  name: "holdings-AB1234567.xlsx", size: 2048, status: "ready",
  kind: "zerodha-holdings", broker: "zerodha", asOf: AS_OF,
  accountKey, accountKind: accountKey ? "client" : "", rows: entryRows,
  firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [], error: "", file: null,
});

// A one-account CAS. The holdings table is what the planner reads; no movement
// rows, so this statement groups with the broker file that lands on the same
// account.
const CAS_HOLDINGS = rows.slice(0, 12).map((row, at) => holding({
  isin: row.isin, label: row.label, quantity: row.quantity,
  valuePaise: row.valuePaise, account: BO,
}));
const casEntry = () => {
  const parsed = {
    depository: "CDSL", demat: BO, asOf: "2026-10-31",
    accounts: [{ boId: BO, dpName: "Zerodha Broking Ltd", holdings: CAS_HOLDINGS }],
    holdings: CAS_HOLDINGS, transactions: [],
    counts: { rows: CAS_HOLDINGS.length, quarantined: 0 },
    printedTotalPaise: CAS_HOLDINGS.reduce((total, row) => total + row.valuePaise, 0),
  };
  return {
    id: "inbox-render-cas", name: "cdsl-cas-oct-2026.pdf", size: 4096,
    status: "ready", kind: "cas", broker: "", asOf: parsed.asOf,
    accountKey: BO, accountKind: "bo",
    rows: CAS_HOLDINGS.map((row) => ({
      isin: row.isin, label: row.label, category: row.kind,
      quantity: row.quantity, valuePaise: row.valuePaise, costPaise: null,
      purchaseDate: "", couponPct: null, frequency: "", maturity: "",
      facePaise: null, account: row.account, folio: "", amc: "", amcFull: "",
      sourceRow: 0,
    })),
    firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((item) => ({
      boId: item.boId, dpName: item.dpName,
      rows: item.holdings.map((row) => ({
        isin: row.isin, label: row.label, category: row.kind,
        quantity: row.quantity, valuePaise: row.valuePaise, costPaise: null,
        purchaseDate: "", couponPct: null, frequency: "", maturity: "",
        facePaise: null, account: row.account, folio: "", amc: "", amcFull: "",
        sourceRow: 0,
      })),
    })),
    file: null,
  };
};

const SCENARIOS = [
  {
    name: "empty",
    seed: null,
    entries: [],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 0) wrong.push(`rows: ${state.rows}`);
      if (state.bar !== "Import 0 ready files") wrong.push(`bar: ${state.bar}`);
      if (!state.barDisabled) wrong.push("the empty bar is enabled");
      if (state.emptyText !== "No files yet. Add a statement above to see where it goes.") {
        wrong.push(`empty copy: ${JSON.stringify(state.emptyText)}`);
      }
      return wrong;
    },
  },
  {
    name: "one-file",
    seed: account,
    entries: [brokerEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/17 holdings/.test(state.facts[0] || "")) {
        wrong.push(`consequence: ${JSON.stringify(state.facts)}`);
      }
      if (!/Matches Demat · Zerodha · …8054/.test(state.accounts[0] || "")) {
        wrong.push(`account: ${JSON.stringify(state.accounts)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.barDisabled) wrong.push("the ready bar is disabled");
      return wrong;
    },
  },
  {
    name: "cas-one-file",
    seed: account,
    entries: [casEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/NSDL\/CDSL \(CAS\)/.test(state.facts[0] || "")) {
        wrong.push(`the row type is not NSDL/CDSL (CAS): ${JSON.stringify(state.facts)}`);
      }
      if (!/12 holdings/.test(state.facts[0] || "")) {
        wrong.push(`consequence: ${JSON.stringify(state.facts)}`);
      }
      if (!/Matches Demat · Zerodha · …8054/.test(state.accounts[0] || "")) {
        wrong.push(`account: ${JSON.stringify(state.accounts)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "locked",
    seed: null,
    entries: [{
      id: "inbox-render-locked", name: "cdsl-cas-oct-2026.pdf", size: 4096,
      status: "locked", kind: "cas", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [], error: PDF_PASSWORD_WRONG, file: null,
    }],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Needs password") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!state.passwordInput) wrong.push("the password field is not in the row");
      if (!/Usually your PAN in capitals · used once, not stored/.test(state.passwordHint || "")) {
        wrong.push(`hint: ${JSON.stringify(state.passwordHint)}`);
      }
      if (state.accounts.length) wrong.push("a locked file named an account before it opened");
      if (state.bar !== "Import 0 ready files") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "no-account",
    seed: null,
    entries: [brokerEntry(UNMATCHED_ID)],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Needs an account") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/Create Zerodha demat …9999/.test(state.proposals.join(" "))) {
        wrong.push(`proposal: ${JSON.stringify(state.proposals)}`);
      }
      if (state.accounts.length) wrong.push("an unresolved file named a target account");
      if (state.bar !== "Import 0 ready files") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "two-files",
    seed: account,
    entries: [casEntry(), brokerEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 2) wrong.push(`rows: ${state.rows}`);
      if (state.plans !== 1) wrong.push(`plans: ${state.plans}`);
      if (state.pills.some((pill) => pill !== "Ready")) {
        wrong.push(`pills: ${JSON.stringify(state.pills)}`);
      }
      if (state.groups[0] !== "Goes with the NSDL/CDSL (CAS) above") {
        wrong.push(`group: ${JSON.stringify(state.groups)}`);
      }
      if (state.bar !== "Import 2 ready files") wrong.push(`bar: ${state.bar}`);
      if (state.barDisabled) wrong.push("the two-file bar is disabled");
      return wrong;
    },
  },
  {
    name: "failure",
    seed: null,
    entries: [{
      id: "inbox-render-failure", name: "notes.txt", size: 128,
      status: "error", kind: "", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [],
      error: "This file is not a CAS, broker holdings report or bank statement. Nothing was read.",
      file: null,
    }],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Couldn't read") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/not a CAS, broker holdings report or bank statement/.test(state.notes[0] || "")) {
        wrong.push(`note: ${JSON.stringify(state.notes)}`);
      }
      if (state.bar !== "Import 0 ready files") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
];

function pageScript(scenario) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(scenario.seed)};
  if (seed) {
    const { rows: seedRows, ...fields } = seed;
    await store.createAccount(fields);
    if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-09-30");
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
  state.entries.push(...${JSON.stringify(scenario.entries)});
  // Re-entering the page runs the real planner over the staged entries. Nothing
  // here writes a plan by hand.
  go("import");
  await sleep(1400);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const host = document.getElementById("import-inbox-host");
  const rows = [...host.querySelectorAll(".import-row")];
  const bar = host.querySelector(".import-batchbar .btn");
  const bubbles = [...document.querySelectorAll(".import-type")];
  const drop = document.getElementById("import-inbox-drop");
  const empty = host.querySelector(".import-empty");
  const controls = [...document.querySelectorAll(".import-type, .import-batchbar .btn, .import-row .btn, .import-row-pw input, .import-row-account select, .import-drop")]
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden"
        && node.getClientRects().length > 0;
    })
    .map((node) => ({ tag: node.tagName, text: text(node).slice(0, 40),
      height: Math.round(node.getBoundingClientRect().height) }));
  const short = controls.filter((item) => item.height > 0 && item.height < 44);
  // The bar sits at the bottom of the queue; bring the top of the queue into
  // view so one shot carries the drop zone, the bubbles and the first rows.
  const shell = document.querySelector(".import-shell");
  shell.scrollIntoView({ block: "start" });
  window.scrollBy(0, -60);

  return JSON.stringify({
    width: innerWidth,
    theme: document.documentElement.dataset.theme || "system",
    bubbles: bubbles.length,
    bubbleLabels: bubbles.map(text),
    drop: !!drop,
    rows: rows.length,
    plans: (state.plans || []).length,
    pills: rows.map((row) => text(row.querySelector(".import-row-pill"))),
    facts: rows.map((row) => text(row.querySelector(".import-row-facts"))),
    accounts: rows.map((row) => text(row.querySelector(".import-row-account")))
      .filter(Boolean),
    notes: rows.map((row) => text(row.querySelector(".import-row-note"))),
    groups: rows.map((row) => text(row.querySelector(".import-row-group"))).filter(Boolean),
    proposals: [...host.querySelectorAll(".import-row .btn.primary")].map(text),
    passwordInput: !!host.querySelector(".import-row-pw input[type=password]"),
    passwordHint: text(host.querySelector(".import-row-pw .import-row-note")),
    bar: text(bar),
    barDisabled: !!bar?.disabled,
    emptyText: text(empty),
    controls: controls.length,
    shortControls: short,
    docWidth: document.documentElement.scrollWidth,
  });
})()`;
}

const FLOWS = [
  {
    name: "two-files-one-plan",
    seed: account,
    entries: [casEntry(), brokerEntry()],
    body: `
      const bar = () => document.querySelector(".import-batchbar .btn");
      const before = text(bar());
      if (before !== "Import 2 ready files") throw new Error("bar before: " + before);
      bar().click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 2,
        "two receipts");
      const receipts = [...document.querySelectorAll(".import-row-receipt")]
        .map((row) => ({ name: text(row.querySelector(".import-row-name")),
          text: text(row.querySelector(".import-row-note")),
          pill: text(row.querySelector(".import-row-pill")) }));
      const holdings = (await store.listHoldings("${account.id}")).length;
      return JSON.stringify({ before, after: text(bar()), receipts, holdings,
        plans: (window.bpImportInbox.plans || []).length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.after !== "Import 0 ready files") wrong.push(`bar after: ${state.after}`);
      if (state.receipts.length !== 2) wrong.push(`receipts: ${state.receipts.length}`);
      if (state.receipts.some((item) => item.pill !== "Imported")) {
        wrong.push(`receipt pills: ${JSON.stringify(state.receipts)}`);
      }
      if (state.holdings !== 17) wrong.push(`holdings: ${state.holdings}`);
      if (state.plans !== 0) wrong.push(`plans after: ${state.plans}`);
      return wrong;
    },
  },
  {
    name: "locked-does-not-block",
    seed: account,
    entries: [brokerEntry(), {
      id: "inbox-render-locked-flow", name: "cdsl-cas-oct-2026.pdf", size: 4096,
      status: "locked", kind: "cas", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [], error: PDF_PASSWORD_WRONG, file: null,
    }],
    body: `
      const bar = () => document.querySelector(".import-batchbar .btn");
      const before = text(bar());
      if (before !== "Import 1 ready file") throw new Error("bar before: " + before);
      bar().click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "one receipt");
      const rows = [...document.querySelectorAll("#import-inbox-host .import-row")]
        .map((row) => ({ name: text(row.querySelector(".import-row-name")),
          pill: text(row.querySelector(".import-row-pill")) }));
      const holdings = (await store.listHoldings("${account.id}")).length;
      return JSON.stringify({ before, after: text(bar()), rows, holdings });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.before !== "Import 1 ready file") wrong.push(`bar before: ${state.before}`);
      if (state.after !== "Import 0 ready files") wrong.push(`bar after: ${state.after}`);
      if (!state.rows.some((row) => row.pill === "Needs password")) {
        wrong.push(`the locked row left: ${JSON.stringify(state.rows)}`);
      }
      if (state.holdings !== 17) wrong.push(`holdings: ${state.holdings}`);
      return wrong;
    },
  },
  {
    name: "cas-create-one-press",
    seed: null,
    entries: [casEntry()],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create Zerodha demat/.test(text(button)));
      if (!create) throw new Error("the CAS Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => pill() === "Ready", "the CAS row to become ready");
      const bar = text(document.querySelector(".import-batchbar .btn"));
      document.querySelector(".import-batchbar .btn").click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the CAS receipt");
      const accounts = await store.listAccounts();
      const holdings = accounts[0] ? (await store.listHoldings(accounts[0].id)).length : 0;
      return JSON.stringify({ label, bar, accounts: accounts.map((item) => item.label),
        holdings, receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.label !== "Create Zerodha demat …8054") wrong.push(`proposal: ${state.label}`);
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (state.holdings !== 12) wrong.push(`holdings: ${state.holdings}`);
      return wrong;
    },
  },
  {
    name: "bank-one-file",
    seed: null,
    entries: [],
    body: `
      const csv = [
        "HDFC Bank Statement",
        "Date,Narration,Withdrawal,Deposit,Balance",
        "01-11-2026,Salary,0,1000,5000",
        "02-11-2026,Groceries,250,0,4750",
        "03-11-2026,Interest,0,50,4800",
      ].join("\\n");
      await window.bpImportInboxAdd([
        new File([csv], "statement.csv", { type: "text/csv" }),
      ]);
      await waitFor(() => document.querySelector(".import-row[data-bank]"),
        "the bank row");
      const row = () => document.querySelector(".import-row[data-bank]");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create /.test(text(button)));
      if (!create) throw new Error("the bank Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => pill() === "Ready", "the bank row to become ready");
      const bar = text(document.querySelector(".import-batchbar .btn"));
      document.querySelector(".import-batchbar .btn").click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the bank receipt");
      const entry = (window.bpBatch?.entries || [])[0] || {};
      const accounts = await store.listAccounts();
      return JSON.stringify({ label, bar, accounts: accounts.map((item) => item.label),
        inserted: entry.result?.inserted || 0,
        receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (!/^Create HDFC/.test(state.label)) wrong.push(`proposal: ${state.label}`);
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.inserted < 3) wrong.push(`inserted: ${state.inserted}`);
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (!state.accounts.some((label) => /HDFC/.test(label))) {
        wrong.push(`accounts: ${JSON.stringify(state.accounts)}`);
      }
      return wrong;
    },
  },
  {
    name: "create-one-press",
    seed: null,
    entries: [brokerEntry(UNMATCHED_ID)],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create Zerodha demat/.test(text(button)));
      if (!create) throw new Error("the Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => pill() === "Ready", "the row to become ready");
      const bar = text(document.querySelector(".import-batchbar .btn"));
      document.querySelector(".import-batchbar .btn").click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "one receipt");
      const accounts = await store.listAccounts();
      return JSON.stringify({ label, bar, accounts: accounts.map((item) => item.label),
        receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.label !== "Create Zerodha demat …9999") {
        wrong.push(`proposal: ${state.label}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (!state.accounts.some((label) => /Zerodha/.test(label))) {
        wrong.push(`accounts: ${JSON.stringify(state.accounts)}`);
      }
      return wrong;
    },
  },
];

function flowScript(flow) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const waitFor = async (read, label) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (read()) return;
      await sleep(100);
    }
    throw new Error("timed out waiting for " + label);
  };
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(flow.seed)};
  if (seed) {
    const { rows: seedRows, ...fields } = seed;
    await store.createAccount(fields);
    if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-09-30");
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
  state.entries.push(...${JSON.stringify(flow.entries)});
  go("import");
  await sleep(1400);
  ${flow.body}
})()`;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-queue: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-queue: --out-dir needs a value");
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
  throw new Error("render-import-queue: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-queue-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
const SHOTS = [
  { width: 390, height: 1600, theme: "dark" },
  { width: 390, height: 1600, theme: "light" },
  { width: 1280, height: 1200, theme: "dark" },
  { width: 1280, height: 1200, theme: "light" },
  // The smallest phone the app supports. The brief asks for 390 and 1280;
  // this is the no-clipping check the UI skill adds.
  { width: 320, height: 1600, theme: "light" },
];
try {
  for (const scenario of SCENARIOS) {
    const pageFile = join(dir, `${scenario.name}.js`);
    writeFileSync(pageFile, pageScript(scenario));
    for (const shot of SHOTS) {
      const out = join(args.outDir,
        `import-queue-${scenario.name}-${shot.width}-${shot.theme}.png`);
      const result = await capture({
        page, out, script: pageFile, wait: 1800,
        width: shot.width, height: shot.height, theme: shot.theme,
      });
      const state = JSON.parse(result.value);
      const wrong = scenario.checks(state);
      if (state.bubbles !== 5) wrong.push(`bubbles: ${state.bubbles}`);
      if (!state.bubbleLabels.some((label) =>
        label.startsWith("NSDL/CDSL (CAS)"))) {
        wrong.push(`depository bubble: ${JSON.stringify(state.bubbleLabels)}`);
      }
      if (!state.drop) wrong.push("the drop zone is missing");
      if (state.docWidth > state.width + 1) {
        wrong.push(`sideways scroll: ${state.docWidth} > ${state.width}`);
      }
      if (state.shortControls.length) {
        wrong.push(`controls under 44px: ${JSON.stringify(state.shortControls)}`);
      }
      if (wrong.length) {
        throw new Error(`render-import-queue: ${scenario.name} ${shot.width} `
          + `${shot.theme} is not the state that was asked for.\n  ${wrong.join("\n  ")}`
          + `\n  full state: ${JSON.stringify(state)}`);
      }
      console.log(`${out}  ${state.rows} row(s)  ${state.bar}  `
        + `${state.controls} controls`);
    }
  }
  // The press itself: one plan, one receipt per file; a locked file left alone;
  // and a proposed account that becomes ready in one press.
  for (const flow of FLOWS) {
    const flowFile = join(dir, `flow-${flow.name}.js`);
    writeFileSync(flowFile, flowScript(flow));
    const out = join(args.outDir, `import-queue-flow-${flow.name}.png`);
    const result = await capture({
      page, out, script: flowFile, wait: 1500,
      width: 390, height: 1200, theme: "light",
    });
    const state = JSON.parse(result.value);
    const wrong = flow.checks(state);
    if (wrong.length) {
      throw new Error(`render-import-queue: the ${flow.name} flow is not the behaviour `
        + `that was asked for.\n  ${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
    }
    console.log(`${out}  ${flow.name}  ${JSON.stringify(state).slice(0, 160)}`);
  }
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
