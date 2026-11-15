#!/usr/bin/env node
// The import card for a CDSL CAS whose mutual-fund SIP has no demat account.
//
// A consolidated statement prints a fund movement with no BO ID because the
// folio owns it. The demat movements beside it name their BO. The card must be
// Ready, name the fund purchase with the folio's movements, and never list it
// under a demat. Import must create both demats and the folio, write all three,
// and leave the fund at the statement's units rather than adding the SIP twice.
//
// Every name, ISIN and number here is invented. The page's own inbox resolver
// and renderer produce the card; the write check presses its Import button and
// reads the store back.
//
//   node scripts/render-import-folio.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-folio.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-09-30";
const BO_FIRST = "1200000012345678";
const BO_SECOND = "1200000098765432";
const FOLIO = "91062983856/0";
const FUND_ISIN = "INF000000901";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const equity = (n) => ({
  isin: isin(100 + n), label: `TEST EQUITY ${n}`, kind: "equity",
  quantity: 10 + n, valuePaise: 100000 * (n + 1),
});
const bond = (n) => ({
  isin: isin(300 + n), label: `9.25% TEST BOND ${n} 31 Dec 2028`, kind: "bond",
  quantity: 10 + (n % 5), valuePaise: 100000, couponPct: 9.25,
  maturity: "2028-12-31",
});
const fund = {
  isin: FUND_ISIN, label: "TEST FUND GROWTH PLAN", kind: "mf",
  quantity: 103.394, valuePaise: 500000, folio: FOLIO,
  amc: "TESTMUTUAL", amcFull: "Test Mutual Fund",
};

// Two demats, 13 and 20 rows, as a consolidated statement prints them. The fund
// row sits under the second demat because that is the page owner; its folio is
// what actually owns it.
const first = [...Array.from({ length: 12 }, (_, at) => equity(at + 1)), bond(1)];
const second = [...Array.from({ length: 19 }, (_, at) => bond(at + 2)), fund];
const SOLD_TWO = new Map([
  [first[0].isin, first[0].quantity - 2], [first[1].isin, first[1].quantity - 2],
  [second[0].isin, second[0].quantity - 2], [second[1].isin, second[1].quantity - 2],
]);
const afterSales = (holding) => (SOLD_TWO.has(holding.isin)
  ? { ...holding, quantity: SOLD_TWO.get(holding.isin) } : holding);
const firstRows = first.map(afterSales);
const secondRows = second.map(afterSales);

const sale = (bo, holding) => ({
  isin: holding.isin, security: holding.label, account: bo,
  date: "2026-09-14", type: "SALE", description: "SALE", quantity: 2,
  creditPaise: 0, debitPaise: 20000, openingPaise: (holding.quantity + 2) * 100,
  closingPaise: holding.quantity * 100,
});
const sales = [
  sale(BO_FIRST, firstRows[0]), sale(BO_FIRST, firstRows[1]),
  sale(BO_SECOND, secondRows[0]), sale(BO_SECOND, secondRows[1]),
];
// The SIP has no balance columns and no BO ID. Its ISIN is the fund's, and the
// statement's own holding row is the post-period snapshot that already includes
// it, so the writer must record the movement without adding the units twice.
const sip = {
  isin: FUND_ISIN, security: "TEST FUND GROWTH PLAN", date: "2026-09-16",
  type: "Systematic Investment", description: "Systematic Investment",
  side: "credit", quantity: 3.394, openingPaise: null, creditPaise: null,
  debitPaise: null, closingPaise: null, stampDutyPaise: null, account: "",
};

function statement() {
  const accounts = [
    { boId: BO_FIRST, dpName: "Test DP One",
      holdings: firstRows.map((row) => ({ ...row, account: BO_FIRST })) },
    { boId: BO_SECOND, dpName: "Test DP Two",
      holdings: secondRows.map((row) => ({ ...row, account: BO_SECOND })) },
  ];
  const holdings = accounts.flatMap((account) => account.holdings);
  return {
    depository: "CDSL", demat: BO_FIRST, asOf: AS_OF, accounts, holdings,
    transactions: [...sales, sip],
    counts: { rows: holdings.length, quarantined: 0 },
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
    id: "inbox-render-folio", name: "cdsl-cas-synthetic.pdf", size: 2048,
    status: "ready", kind: "cas", broker: "", asOf: AS_OF,
    accountKey: BO_FIRST, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName, rows: account.holdings.map(row),
    })),
    file: null,
  };
}

function pageScript({ write = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
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
  // The page keeps its planner module-scoped; dropping a plan that does not
  // exist is the smallest public control that re-runs it, unchanged.
  window.bpImportDropPlan("__render__");
  await sleep(900);

  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "CDSL CAS");
  if (!card) throw new Error("the CDSL card is missing");
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const plan = (state.plans || [])[0] || {};
  const bundle = plan.head || {};
  const targets = bundle.casTargets || [];
  const folioTarget = targets.find((target) => target.folio);
  const summary = {
    ready: !!plan.ready,
    pill: text(card.querySelector(".import-pill")),
    primaryLabel: text(card.querySelector(".btn.primary")),
    primaryDisabled: !!card.querySelector(".btn.primary")?.disabled,
    accountLines: [...card.querySelectorAll(".import-account-choice")].map(text),
    eventLines: [...(card.querySelector(".cas-sales")?.querySelectorAll("li") || [])].map(text),
    warnings: [...card.querySelectorAll(".import-note")].map(text),
    changeLines: [...card.querySelectorAll(".import-change ul li")].map(text),
    dematEvents: targets.filter((target) => !target.folio)
      .flatMap((target) => (target.eventPlan?.events || []).map((event) => event.isin)),
    folioHasFund: !!folioTarget?.rows?.some((row) => row.isin === ${JSON.stringify(FUND_ISIN)}),
  };
  if (${write}) {
    const button = card.querySelector(".btn.primary");
    if (!button || button.disabled) throw new Error("the import button is not available");
    button.click();
    const clean = (value) => String(value || "").replace(/[^0-9a-z]/gi, "").toUpperCase();
    let stored = null;
    for (let attempt = 0; attempt < 48 && !stored; attempt += 1) {
      await sleep(250);
      const accounts = await store.listAccounts();
      stored = [${JSON.stringify(BO_FIRST)}, ${JSON.stringify(BO_SECOND)},
        ${JSON.stringify(FOLIO)}].every((number) =>
        accounts.some((account) => clean(account.number) === clean(number)))
        ? accounts : null;
    }
    const accounts = stored || await store.listAccounts();
    const byNumber = (value) => accounts.find((account) =>
      clean(account.number) === clean(value));
    const rowsOf = async (id) => (await store.listHoldings(id)).map((holding) => ({
      isin: holding.security_id, quantity: holding.quantity,
      disposed: holding.disposed_at || "",
      disposedQuantity: holding.disposed_quantity ?? null,
    }));
    const firstAccount = byNumber(${JSON.stringify(BO_FIRST)});
    const secondAccount = byNumber(${JSON.stringify(BO_SECOND)});
    const folioAccount = byNumber(${JSON.stringify(FOLIO)});
    summary.status = document.getElementById("import-inbox-status")?.textContent?.trim() || "";
    summary.first = firstAccount
      ? { number: firstAccount.number, holdings: await rowsOf(firstAccount.id) } : null;
    summary.second = secondAccount
      ? { number: secondAccount.number, holdings: await rowsOf(secondAccount.id) } : null;
    summary.folio = folioAccount
      ? { number: folioAccount.number, subtype: folioAccount.subtype,
        holdings: await rowsOf(folioAccount.id) } : null;
    summary.accounts = accounts.map((account) => ({ number: account.number,
      label: account.label, category: account.category, subtype: account.subtype }));
  }
  card.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify(summary);
})()`;
}

const SHOTS = [
  { width: 390, height: 3000 },
  { width: 1280, height: 2100 },
];

function verifyCard(state) {
  const wrong = [];
  const want = { ready: true, pill: "Ready", primaryLabel: "Import 33 holdings",
    primaryDisabled: false };
  for (const [key, value] of Object.entries(want)) {
    if (state[key] !== value) {
      wrong.push(`${key}: want ${JSON.stringify(value)}, got ${JSON.stringify(state[key])}`);
    }
  }
  const bought = "Bought 3.394 units of " + FUND_ISIN
    + " on 2026-09-16: 103.394 still held";
  if (!state.eventLines.includes(bought)) {
    wrong.push(`the fund purchase is not with the folio's movements: `
      + JSON.stringify(state.eventLines));
  }
  if (state.dematEvents.includes(FUND_ISIN)) {
    wrong.push(`the fund purchase is in a demat movement list: ${JSON.stringify(state.dematEvents)}`);
  }
  if (!state.folioHasFund) wrong.push("the fund row did not route to a folio");
  for (const line of ["Add 33 holdings", "Record 4 sales or transfers as sold"]) {
    if (!state.changeLines.includes(line)) {
      wrong.push(`summary line ${JSON.stringify(line)} missing from `
        + JSON.stringify(state.changeLines));
    }
  }
  if (state.warnings.some((line) => /No account on file|No demat on file/.test(line))) {
    wrong.push(`the card still refuses the statement: ${JSON.stringify(state.warnings)}`);
  }
  if (!state.accountLines.some((line) => /…5678/.test(line))
    || !state.accountLines.some((line) => /…5432/.test(line))
    || !state.accountLines.some((line) => /mutual fund · folio/.test(line))) {
    wrong.push(`the statement's three accounts are not offered: `
      + JSON.stringify(state.accountLines));
  }
  return wrong;
}

function verifyWrite(state) {
  const wrong = [];
  const live = (rows) => rows.filter((row) => !row.disposed && Number(row.quantity) > 0);
  const disposed = (rows) => rows.filter((row) => !!row.disposed);
  if (!state.first) wrong.push("the first demat was not created");
  else {
    if (live(state.first.holdings).length !== 13) {
      wrong.push(`first demat live rows: ${live(state.first.holdings).length}`);
    }
    if (disposed(state.first.holdings).length !== 2) {
      wrong.push(`first demat disposals: ${disposed(state.first.holdings).length}`);
    }
  }
  if (!state.second) wrong.push("the second demat was not created");
  else {
    if (live(state.second.holdings).length !== 19) {
      wrong.push(`second demat live rows: ${live(state.second.holdings).length}`);
    }
    if (disposed(state.second.holdings).length !== 2) {
      wrong.push(`second demat disposals: ${disposed(state.second.holdings).length}`);
    }
  }
  if (!state.folio) wrong.push("the folio account was not created");
  else {
    if (state.folio.subtype !== "mutual fund") {
      wrong.push(`the folio subtype is ${JSON.stringify(state.folio.subtype)}`);
    }
    const fund = state.folio.holdings.find((holding) => holding.isin === FUND_ISIN);
    if (!fund || Math.abs(Number(fund.quantity) - 103.394) > 1e-9) {
      wrong.push(`the fund row is ${JSON.stringify(fund)}`);
    }
  }
  for (const account of [state.first, state.second]) {
    if (!account) continue;
    if (account.holdings.some((holding) => holding.isin === FUND_ISIN)) {
      wrong.push("the fund row was written into a demat");
    }
  }
  if (!/4 sales or transfers recorded as sold/.test(state.status || "")) {
    wrong.push(`status: ${JSON.stringify(state.status)}`);
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-folio: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-folio: --out-dir needs a value");
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
  throw new Error("render-import-folio: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-folio-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const script = join(dir, "page-card.js");
      writeFileSync(script, pageScript());
      const out = join(args.outDir,
        `import-folio-${shot.width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2400,
        width: shot.width, height: shot.height, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = verifyCard(state);
      if (wrong.length) {
        throw new Error("render-import-folio: the card is not the card that was "
          + "asked for.\n  " + wrong.join("\n  ")
          + "\n  full state: " + JSON.stringify(state));
      }
      console.log(out);
    }
  }
  // The real proof: press the button the card leaves enabled and read the store.
  const writeScript = join(dir, "page-write.js");
  writeFileSync(writeScript, pageScript({ write: true }));
  const writeOut = join(args.outDir, "import-folio-written-390-light.png");
  const written = await capture({
    page, out: writeOut, script: writeScript, wait: 2400,
    width: 390, height: 1800, theme: "light",
  });
  const writeState = JSON.parse(written.value);
  const writeWrong = verifyWrite(writeState);
  if (writeWrong.length) {
    throw new Error("render-import-folio: the card did not write what it promised.\n  "
      + writeWrong.join("\n  ") + "\n  full state: " + JSON.stringify(writeState));
  }
  console.log(writeOut);
  console.log("import folio: the card is ready, the fund purchase sits with the folio's "
    + "movements and no demat claims it · import creates two demats and the folio, "
    + "keeps the fund at 103.394 and records four disposals · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
