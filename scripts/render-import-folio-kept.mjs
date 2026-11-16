#!/usr/bin/env node
// The import card when a value-only fund account already carries the
// statement's folio and the statement also moves something else.
//
// A kept folio is a decision about its own rows, not about the demat. The card
// must still show the demat's sale, the Import button must record it, and the
// file must leave the inbox. The kept folio's own sale must not appear in the
// preview and must not land on a demat that happens to hold the same ISIN.
//
// The second pass proves the zero-unit case: a zero-unit folio row is closed
// history with no position to route, so it stays with the demat. The card's
// count and the store must agree, row for row.
//
// Three more passes prove the guards around that decision. A statement whose
// only row is zero units creates its demat and stores the row. A fund account
// that holds the same ISIN is never the demat's target. A kept folio never
// finishes while a movement (a fully redeemed fund sale) has no target that
// could record it: the file stays and nothing is written.
//
// Every name, ISIN and number here is invented. The page's own inbox resolver
// and renderer produce the card; the write checks press its buttons and read
// the store back.
//
//   node scripts/render-import-folio-kept.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-folio-kept.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-09-30";
const DEMAT = "1200000012345678";
const BASE = "99990000001";
const PRINTED = "99990001/0";
const FUND = "INF000000901";
const FUND_ZERO = "INF000000902";
const REDEEMED = "INF999900253";
const EQUITY = "INE000000101";
const MANUAL_PAISE = 31000000;

const fund = {
  isin: FUND, label: "TEST FUND GROWTH PLAN", kind: "mf", category: "mf",
  quantity: 90, valuePaise: 29000000, costPaise: 24000000, folio: PRINTED,
  amc: "TESTMUTUAL", amcFull: "Test Mutual Fund", account: DEMAT,
};
const zeroFund = {
  isin: FUND_ZERO, label: "TEST FUND CLOSED PLAN", kind: "mf", category: "mf",
  quantity: 0, valuePaise: 1200000, costPaise: null, folio: PRINTED,
  amc: "TESTMUTUAL", amcFull: "Test Mutual Fund", account: DEMAT,
};
const equity = {
  isin: EQUITY, label: "TEST EQUITY", kind: "equity", category: "equity",
  quantity: 8, valuePaise: 800000, costPaise: 640000, account: DEMAT,
};

const sale = (holding, over = {}) => ({
  isin: holding.isin, security: holding.label, account: holding.account || "",
  date: "2026-09-14", type: "SALE", description: "SALE", quantity: 2,
  side: "debit", creditPaise: 0, debitPaise: 20000,
  openingPaise: null, closingPaise: null, ...over,
});

function statement({ holdings, transactions }) {
  return {
    depository: "CDSL", demat: DEMAT, asOf: AS_OF,
    accounts: [{ boId: DEMAT, dpName: "Test DP", holdings }],
    holdings, transactions,
    counts: { rows: holdings.length, quarantined: 0 },
    printedTotalPaise: holdings.reduce((total, row) => total + row.valuePaise, 0),
  };
}

function row(holding) {
  return {
    isin: holding.isin, label: holding.label, category: holding.kind,
    quantity: holding.quantity, valuePaise: holding.valuePaise,
    costPaise: holding.costPaise ?? null, purchaseDate: "", couponPct: null,
    frequency: "", maturity: "", facePaise: null, account: holding.account || "",
    folio: holding.folio || "", amc: holding.amc || "",
    amcFull: holding.amcFull || "", sourceRow: 0,
  };
}

function entry(parsed, id) {
  return {
    id, name: "cdsl-cas-synthetic.pdf", size: 2048, status: "ready", kind: "cas",
    broker: "", asOf: AS_OF, accountKey: DEMAT, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName, rows: account.holdings.map(row),
    })),
    file: null,
  };
}

// The demat holds 10 units and the statement prints its sale but no holding
// row for it: the movement alone must reach the account. The fund sale has no
// account: the folio owns it, and the folio is kept.
const keptEntry = entry(statement({
  holdings: [fund],
  transactions: [
    sale(equity, { quantity: 2, openingPaise: 1000, closingPaise: 800 }),
    sale(fund, { quantity: 10, account: "", openingPaise: 10000, closingPaise: 9000 }),
  ],
}), "inbox-kept-movement");
const zeroEntry = entry(statement({
  holdings: [fund, zeroFund, equity],
  transactions: [],
}), "inbox-zero-unit");
// A statement whose only row is closed history. No demat is on file, so the
// import itself has to create the account before it can store the row.
const zeroOnlyEntry = entry(statement({
  holdings: [zeroFund],
  transactions: [],
}), "inbox-zero-only");
// A fund account holds the same ISIN as the zero-unit folio row. The ISIN
// overlap must not make that fund account the demat's home.
const boundaryEntry = entry(statement({
  holdings: [zeroFund],
  transactions: [],
}), "inbox-boundary");
// A fully redeemed fund folio prints a sale and no holding row, so the folio
// has no target for the movement. Keeping a different manual total must not
// turn that into a successful import.
const redeemed = {
  isin: REDEEMED, label: "TEST FUND REDEEMED", kind: "mf", category: "mf",
  account: "",
};
const unhomedEntry = entry(statement({
  holdings: [fund],
  transactions: [sale(redeemed, { quantity: 4, openingPaise: 4000, closingPaise: 0 })],
}), "inbox-unhomed");

function pageScript({ mode, write = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  await store.clearAll();
  const kept = ${mode === "kept" || mode === "unhomed"};
  if (kept) {
    await store.createAccount({
      id: "demat-1", label: "Demat · Test DP · …5678", category: "demat",
      subtype: "equity", type: "equity", number: ${JSON.stringify(DEMAT)},
    });
    await store.createAccount({
      id: "axis-value", label: "Test Mutual Fund", bank: "Test Mutual Fund",
      category: "demat", subtype: "mutual fund", type: "mf",
      number: ${JSON.stringify(BASE)},
      meta: JSON.stringify({ amc: "testmutual", amc_full: "Test Mutual Fund",
        current_value_paise: ${MANUAL_PAISE} }),
    });
    await store.replaceHoldings("demat-1", [{
      security_id: ${JSON.stringify(EQUITY)}, label: "TEST EQUITY", category: "equity",
      quantity: 10, value_paise: 1000000, cost_paise: 800000, as_of: "2026-08-31",
    }], "2026-08-31");
  }
  if (${mode === "boundary"}) {
    await store.createAccount({
      id: "axis-value", label: "Test Mutual Fund", bank: "Test Mutual Fund",
      category: "demat", subtype: "mutual fund", type: "mf",
      number: ${JSON.stringify(BASE)},
      meta: JSON.stringify({ amc: "testmutual", amc_full: "Test Mutual Fund",
        current_value_paise: ${MANUAL_PAISE} }),
    });
    await store.replaceHoldings("axis-value", [{
      security_id: ${JSON.stringify(FUND_ZERO)}, label: "TEST FUND CLOSED PLAN",
      category: "mf", quantity: 5, value_paise: 500000, as_of: "2026-08-31",
    }], "2026-08-31");
  }
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = {};
  state.acceptAsk = {};
  state.accountRows = null;
  state.entries.push(${JSON.stringify(mode === "kept" ? keptEntry
    : mode === "unhomed" ? unhomedEntry
      : mode === "boundary" ? boundaryEntry
        : mode === "zeroonly" ? zeroOnlyEntry : zeroEntry)});
  window.bpImportDropPlan("__render__");
  await sleep(1400);

  const cardOf = () => [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "CDSL CAS");
  const card = cardOf();
  if (!card) throw new Error("the CDSL card is missing");
  const planOf = () => (state.plans || [])[0] || {};
  const primary = () => [...(cardOf()?.querySelectorAll("button") || [])]
    .find((button) => !button.closest(".import-folio")
      && /^(Import \\d|Record \\d|Finish without|Choose below)/.test(text(button)));
  const summary = {
    before: {
      ready: !!planOf().ready,
      pill: text(card.querySelector(".import-pill")),
      primary: text(primary()),
      sales: text(card.querySelector(".cas-sales")),
      accountLines: [...card.querySelectorAll(".import-account-choice")].map(text),
      summary: planOf().summary || null,
    },
  };
  if (kept && ${write}) {
    const keep = [...card.querySelectorAll(".import-folio button")]
      .find((button) => /^Keep the manual total/.test(text(button)));
    if (!keep) throw new Error("the keep button is missing");
    keep.click();
    await sleep(1300);
    const afterKeepCard = cardOf();
    summary.afterKeep = {
      ready: !!planOf().ready,
      pill: text(afterKeepCard.querySelector(".import-pill")),
      primary: text(primary()),
      sales: text(afterKeepCard.querySelector(".cas-sales")),
      accountLines: [...afterKeepCard.querySelectorAll(".import-account-choice")].map(text),
      saleEvents: (planOf().head?.saleEvents || []).map((event) => event.isin),
    };
    const button = primary();
    if (!button || button.disabled) throw new Error("the movement is not offered: "
      + JSON.stringify(summary.afterKeep));
    button.click();
    for (let attempt = 0; attempt < 48; attempt += 1) {
      await sleep(250);
      if (!state.entries.length) break;
    }
    const accounts = await store.listAccounts();
    const byNumber = (value) => accounts.find((account) =>
      String(account.number || "").replace(/[^0-9a-z]/gi, "").toUpperCase()
        === String(value).replace(/[^0-9a-z]/gi, "").toUpperCase());
    const demat = byNumber(${JSON.stringify(DEMAT)});
    const manual = accounts.find((account) => account.id === "axis-value");
    summary.after = {
      status: document.getElementById("import-inbox-status")?.textContent?.trim() || "",
      entries: state.entries.length,
      demat: demat ? (await store.listHoldings(demat.id)).map((holding) => ({
        isin: holding.security_id, quantity: holding.quantity,
        disposed: holding.disposed_at || "",
        disposedQuantity: holding.disposed_quantity ?? null,
      })) : null,
      manual: manual ? { number: manual.number, meta: JSON.parse(manual.meta || "{}"),
        rows: (await store.listHoldings(manual.id)).length } : null,
    };
  }
  if (${mode === "boundary"} && ${write}) {
    const button = primary();
    if (!button || button.disabled) throw new Error("the boundary import is not available: "
      + JSON.stringify(summary.before));
    button.click();
    for (let attempt = 0; attempt < 48; attempt += 1) {
      await sleep(250);
      if (!state.entries.length) break;
    }
    const accounts = await store.listAccounts();
    const holdings = [];
    for (const account of accounts) {
      holdings.push({ id: account.id, account: account.number,
        subtype: account.subtype || "",
        meta: JSON.parse(account.meta || "{}"),
        rows: (await store.listHoldings(account.id)).map((holding) => ({
          isin: holding.security_id, quantity: holding.quantity,
          disposed: holding.disposed_at || "",
        })) });
    }
    summary.after = {
      status: document.getElementById("import-inbox-status")?.textContent?.trim() || "",
      entries: state.entries.length, accounts: accounts.length, holdings,
    };
  }
  if (${mode === "zero" || mode === "zeroonly"} && ${write}) {
    const button = primary();
    if (!button || button.disabled) throw new Error("the import button is not available: "
      + JSON.stringify(summary.before));
    button.click();
    for (let attempt = 0; attempt < 48; attempt += 1) {
      await sleep(250);
      if (!state.entries.length) break;
    }
    const accounts = await store.listAccounts();
    const holdings = [];
    for (const account of accounts) {
      holdings.push({
        account: account.number, subtype: account.subtype || "",
        rows: (await store.listHoldings(account.id)).map((holding) => ({
          isin: holding.security_id, quantity: holding.quantity,
        })),
      });
    }
    summary.after = {
      status: document.getElementById("import-inbox-status")?.textContent?.trim() || "",
      entries: state.entries.length, accounts: accounts.length, holdings,
    };
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

function verifyKeptCard(state) {
  const wrong = [];
  if (state.before.ready) wrong.push("the card is Ready before the adopt-or-keep choice");
  if (state.before.pill !== "Choose an account") {
    wrong.push(`pill: ${JSON.stringify(state.before.pill)}`);
  }
  if (!state.before.sales.includes("Sold 2 units of " + EQUITY)) {
    wrong.push(`the demat sale is missing: ${JSON.stringify(state.before.sales)}`);
  }
  if (state.before.sales.includes(FUND)) {
    wrong.push(`the kept folio's own sale is printed before any choice: ${state.before.sales}`);
  }
  return wrong;
}

function verifyKeptAfter(state) {
  const wrong = [];
  const afterKeep = state.afterKeep || {};
  if (!afterKeep.ready) wrong.push("the card is not Ready after Keep");
  if (afterKeep.pill !== "Ready") wrong.push(`after Keep pill: ${JSON.stringify(afterKeep.pill)}`);
  if (!String(afterKeep.sales || "").includes("Sold 2 units of " + EQUITY)) {
    wrong.push(`the demat sale disappeared after Keep: ${JSON.stringify(afterKeep.sales)}`);
  }
  if (String(afterKeep.sales || "").includes(FUND)) {
    wrong.push(`the kept folio's own sale is still in the preview: ${afterKeep.sales}`);
  }
  if ((afterKeep.saleEvents || []).includes(FUND)) {
    wrong.push("the kept folio's own sale is in the planned events");
  }
  if (afterKeep.primary !== "Record 1 sale") {
    wrong.push(`after Keep primary: ${JSON.stringify(afterKeep.primary)}`);
  }
  return wrong;
}

function verifyKeptWrite(state) {
  const wrong = [];
  const after = state.after || {};
  if (after.entries !== 0) wrong.push(`the file is still in the inbox: ${after.entries}`);
  if (!after.demat) wrong.push("the demat is missing");
  else {
    const live = after.demat.filter((row) => !row.disposed && Number(row.quantity) > 0);
    const sold = after.demat.filter((row) => !!row.disposed);
    const equityLive = live.find((row) => row.isin === EQUITY);
    if (!equityLive || Number(equityLive.quantity) !== 8) {
      wrong.push(`the demat equity row is ${JSON.stringify(equityLive)}`);
    }
    if (sold.length !== 1 || sold[0].isin !== EQUITY
      || Number(sold[0].disposedQuantity) !== 2) {
      wrong.push(`the demat disposal is ${JSON.stringify(sold)}`);
    }
    if (after.demat.some((row) => row.isin === FUND)) {
      wrong.push("the kept folio's fund row was written to the demat");
    }
  }
  if (!after.manual) wrong.push("the manual account is missing");
  else {
    if (after.manual.meta.current_value_paise !== MANUAL_PAISE) {
      wrong.push(`the manual total changed: ${JSON.stringify(after.manual.meta)}`);
    }
    if (after.manual.rows !== 0) wrong.push(`the manual account gained rows: ${after.manual.rows}`);
  }
  for (const want of ["1 sale or transfer recorded as sold", "…8993 was kept",
    "none of its rows were imported"]) {
    if (!String(after.status || "").includes(want)) {
      wrong.push(`the receipt is missing ${JSON.stringify(want)}: ${JSON.stringify(after.status)}`);
    }
  }
  if (/none of its movements were recorded/.test(after.status || "")) {
    wrong.push(`the receipt says the demat sale was not recorded: ${after.status}`);
  }
  if (/into 2 accounts/.test(after.status || "")) {
    wrong.push(`the receipt counts an account that received no row: ${after.status}`);
  }
  return wrong;
}

function verifyZeroCard(state) {
  const wrong = [];
  if (!state.before.ready) wrong.push("the zero-unit card is not Ready");
  if (state.before.primary !== "Import 3 holdings") {
    wrong.push(`the zero-unit card says ${JSON.stringify(state.before.primary)}`);
  }
  const dematLine = (state.before.accountLines || []).find((line) => /…5678/.test(line));
  if (!dematLine || !/2 holdings/.test(dematLine)) {
    wrong.push(`the demat line is ${JSON.stringify(dematLine)}`);
  }
  const folioLine = (state.before.accountLines || []).find((line) => /mutual fund · folio/.test(line));
  if (!folioLine || !/1 holding/.test(folioLine)) {
    wrong.push(`the folio line is ${JSON.stringify(folioLine)}`);
  }
  return wrong;
}

function verifyZeroWrite(state) {
  const wrong = [];
  const after = state.after || {};
  if (after.entries !== 0) wrong.push(`the file is still in the inbox: ${after.entries}`);
  if (after.accounts !== 2) wrong.push(`accounts: ${after.accounts}`);
  const demat = (after.holdings || []).find((account) => account.account === DEMAT);
  const folio = (after.holdings || []).find((account) => /mutual fund/i.test(account.subtype));
  if (!demat) wrong.push("the demat account was not created");
  else {
    const isins = demat.rows.map((row) => row.isin).sort();
    if (JSON.stringify(isins) !== JSON.stringify([EQUITY, FUND_ZERO].sort())) {
      wrong.push(`the demat rows are ${JSON.stringify(demat.rows)}`);
    }
  }
  if (!folio) wrong.push("the folio account was not created");
  else if (folio.rows.length !== 1 || folio.rows[0].isin !== FUND) {
    wrong.push(`the folio rows are ${JSON.stringify(folio.rows)}`);
  }
  if (!/3 holdings imported/.test(after.status || "")) {
    wrong.push(`the receipt does not count what it wrote: ${JSON.stringify(after.status)}`);
  }
  const wrote = (after.holdings || []).reduce((total, account) => total + account.rows.length, 0);
  if (wrote !== 3) wrong.push(`the store holds ${wrote} rows, the receipt says 3`);
  return wrong;
}

function verifyZeroOnlyCard(state) {
  const wrong = [];
  if (!state.before.ready) wrong.push("the zero-unit-only card is not Ready");
  if (state.before.primary !== "Import 1 holding") {
    wrong.push(`the zero-unit-only card says ${JSON.stringify(state.before.primary)}`);
  }
  const demat = (state.before.accountLines || []).find((line) => /…5678/.test(line));
  if (!demat || !/New demat account/.test(demat) || !/1 holding/.test(demat)) {
    wrong.push(`the zero-unit-only demat line is ${JSON.stringify(demat)}`);
  }
  return wrong;
}

function verifyZeroOnlyWrite(state) {
  const wrong = [];
  const after = state.after || {};
  if (after.entries !== 0) wrong.push(`the file is still in the inbox: ${after.entries}`);
  if (after.accounts !== 1) wrong.push(`accounts: ${after.accounts}`);
  const demat = (after.holdings || []).find((account) => account.account === DEMAT);
  if (!demat) wrong.push("the demat account was not created");
  else {
    if (demat.rows.length !== 1 || demat.rows[0].isin !== FUND_ZERO
      || Number(demat.rows[0].quantity) !== 0) {
      wrong.push(`the demat rows are ${JSON.stringify(demat.rows)}`);
    }
  }
  if (!/1 holding imported/.test(after.status || "")) {
    wrong.push(`the receipt does not count the row: ${JSON.stringify(after.status)}`);
  }
  return wrong;
}

function verifyBoundaryCard(state) {
  const wrong = [];
  if (!state.before.ready) wrong.push("the boundary card is not Ready");
  if (state.before.primary !== "Import 1 holding") {
    wrong.push(`the boundary card says ${JSON.stringify(state.before.primary)}`);
  }
  const lines = state.before.accountLines || [];
  if (lines.some((line) => /Update Test Mutual Fund|Update .*mutual fund/i.test(line))) {
    wrong.push(`the fund account is the demat target: ${JSON.stringify(lines)}`);
  }
  if (!lines.some((line) => /…5678/.test(line) && /New demat account/.test(line))) {
    wrong.push(`the boundary card has no new demat line: ${JSON.stringify(lines)}`);
  }
  return wrong;
}

function verifyBoundaryWrite(state) {
  const wrong = [];
  const after = state.after || {};
  if (after.entries !== 0) wrong.push(`the file is still in the inbox: ${after.entries}`);
  if (after.accounts !== 2) wrong.push(`accounts: ${after.accounts}`);
  const manual = (after.holdings || []).find((account) => account.id === "axis-value");
  if (!manual) wrong.push("the fund account is missing");
  else {
    for (const key of ["identity_source", "identity_as_of", "broker_only", "depository", "dp"]) {
      if (Object.prototype.hasOwnProperty.call(manual.meta || {}, key)) {
        wrong.push(`the fund account inherited ${key}: ${JSON.stringify(manual.meta)}`);
      }
    }
    if (manual.meta.current_value_paise !== MANUAL_PAISE) {
      wrong.push(`the fund total changed: ${JSON.stringify(manual.meta)}`);
    }
    if (manual.rows.length !== 1 || manual.rows[0].isin !== FUND_ZERO
      || Number(manual.rows[0].quantity) !== 5) {
      wrong.push(`the fund rows changed: ${JSON.stringify(manual.rows)}`);
    }
  }
  const demat = (after.holdings || []).find((account) => account.account === DEMAT);
  if (!demat) wrong.push("the new demat account is missing");
  else if (demat.rows.length !== 1 || demat.rows[0].isin !== FUND_ZERO
    || Number(demat.rows[0].quantity) !== 0) {
    wrong.push(`the demat rows are ${JSON.stringify(demat.rows)}`);
  }
  return wrong;
}

function verifyUnhomedAfterKeep(state) {
  const wrong = [];
  const afterKeep = state.afterKeep || {};
  if (!afterKeep.ready) wrong.push("the card is not Ready after Keep");
  if (afterKeep.primary !== "Finish without importing") {
    wrong.push(`after Keep primary: ${JSON.stringify(afterKeep.primary)}`);
  }
  if (String(afterKeep.sales || "").includes(REDEEMED)) {
    wrong.push(`the unhomed sale is promised: ${afterKeep.sales}`);
  }
  return wrong;
}

function verifyUnhomedWrite(state) {
  const wrong = [];
  const after = state.after || {};
  if (after.entries !== 1) wrong.push(`the file left the inbox: ${after.entries}`);
  if (!/No account on file can take this statement/.test(after.status || "")) {
    wrong.push(`the refusal is missing: ${JSON.stringify(after.status)}`);
  }
  const manual = after.manual || {};
  if (manual.meta?.current_value_paise !== MANUAL_PAISE) {
    wrong.push(`the manual total changed: ${JSON.stringify(manual.meta)}`);
  }
  if (manual.rows !== 0) wrong.push(`the manual account gained rows: ${manual.rows}`);
  const demat = after.demat || [];
  if (demat.some((row) => row.isin === REDEEMED || row.disposed)) {
    wrong.push(`a refused movement was written: ${JSON.stringify(demat)}`);
  }
  if (demat.some((row) => row.isin === EQUITY && Number(row.quantity) !== 10)) {
    wrong.push(`the demat equity row changed: ${JSON.stringify(demat)}`);
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-folio-kept: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-folio-kept: --out-dir needs a value");
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
  throw new Error("render-import-folio-kept: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-folio-kept-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const script = join(dir, "page-kept.js");
      writeFileSync(script, pageScript({ mode: "kept" }));
      const out = join(args.outDir, `import-folio-kept-${shot.width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2400,
        width: shot.width, height: shot.height, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = verifyKeptCard(state);
      if (wrong.length) {
        throw new Error("render-import-folio-kept: the kept card is not the card that "
          + "was asked for.\n  " + wrong.join("\n  ")
          + "\n  full state: " + JSON.stringify(state));
      }
      console.log(out);
    }
  }
  const keptScript = join(dir, "page-kept-write.js");
  writeFileSync(keptScript, pageScript({ mode: "kept", write: true }));
  const keptOut = join(args.outDir, "import-folio-kept-written-390-light.png");
  const kept = await capture({
    page, out: keptOut, script: keptScript, wait: 2400,
    width: 390, height: 1800, theme: "light",
  });
  const keptState = JSON.parse(kept.value);
  const keptWrong = verifyKeptCard(keptState)
    .concat(verifyKeptAfter(keptState), verifyKeptWrite(keptState));
  if (keptWrong.length) {
    throw new Error("render-import-folio-kept: the kept card did not write the demat "
      + "movement.\n  " + keptWrong.join("\n  ")
      + "\n  full state: " + JSON.stringify(keptState));
  }
  console.log(keptOut);

  for (const shot of SHOTS) {
    const theme = shot.width === 390 ? "light" : "dark";
    const script = join(dir, "page-zero.js");
    writeFileSync(script, pageScript({ mode: "zero", write: shot.width === 390 }));
    const out = join(args.outDir, `import-folio-zero-${shot.width}-${theme}.png`);
    const result = await capture({
      page, out, script, wait: 2400,
      width: shot.width, height: shot.height, theme,
    });
    const state = JSON.parse(result.value);
    const wrong = verifyZeroCard(state)
      .concat(shot.width === 390 ? verifyZeroWrite(state) : []);
    if (wrong.length) {
      throw new Error("render-import-folio-kept: the zero-unit card is not the card that "
        + "was asked for.\n  " + wrong.join("\n  ")
        + "\n  full state: " + JSON.stringify(state));
    }
    console.log(out);
  }

  // A zero-unit-only statement: no demat on file, no equity row to create it.
  for (const shot of SHOTS) {
    const theme = shot.width === 390 ? "light" : "dark";
    const write = shot.width === 390;
    const script = join(dir, "page-zero-only.js");
    writeFileSync(script, pageScript({ mode: "zeroonly", write }));
    const out = join(args.outDir, `import-folio-zero-only-${shot.width}-${theme}.png`);
    const result = await capture({
      page, out, script, wait: 2400,
      width: shot.width, height: shot.height, theme,
    });
    const state = JSON.parse(result.value);
    const wrong = verifyZeroOnlyCard(state)
      .concat(write ? verifyZeroOnlyWrite(state) : []);
    if (wrong.length) {
      throw new Error("render-import-folio-kept: the zero-unit-only statement did not "
        + "create its demat.\n  " + wrong.join("\n  ")
        + "\n  full state: " + JSON.stringify(state));
    }
    console.log(out);
  }

  // A fund account holding the same ISIN is not the demat's home.
  for (const shot of SHOTS) {
    const theme = shot.width === 390 ? "light" : "dark";
    const write = shot.width === 390;
    const script = join(dir, "page-boundary.js");
    writeFileSync(script, pageScript({ mode: "boundary", write }));
    const out = join(args.outDir, `import-folio-boundary-${shot.width}-${theme}.png`);
    const result = await capture({
      page, out, script, wait: 2400,
      width: shot.width, height: shot.height, theme,
    });
    const state = JSON.parse(result.value);
    const wrong = verifyBoundaryCard(state)
      .concat(write ? verifyBoundaryWrite(state) : []);
    if (wrong.length) {
      throw new Error("render-import-folio-kept: the demat/fund boundary is not kept.\n  "
        + wrong.join("\n  ") + "\n  full state: " + JSON.stringify(state));
    }
    console.log(out);
  }

  // A kept folio plus a fully redeemed fund movement no target can record.
  const unhomedScript = join(dir, "page-unhomed.js");
  writeFileSync(unhomedScript, pageScript({ mode: "unhomed", write: true }));
  const unhomedOut = join(args.outDir, "import-folio-unhomed-390-light.png");
  const unhomed = await capture({
    page, out: unhomedOut, script: unhomedScript, wait: 2400,
    width: 390, height: 1800, theme: "light",
  });
  const unhomedState = JSON.parse(unhomed.value);
  const unhomedWrong = verifyUnhomedAfterKeep(unhomedState)
    .concat(verifyUnhomedWrite(unhomedState));
  if (unhomedWrong.length) {
    throw new Error("render-import-folio-kept: the kept folio finished over an unhomed "
      + "movement.\n  " + unhomedWrong.join("\n  ")
      + "\n  full state: " + JSON.stringify(unhomedState));
  }
  console.log(unhomedOut);

  console.log("import folio kept: a kept folio keeps only its own rows and movements out, "
    + "the demat's sale is previewed and recorded, and the file leaves the inbox; a "
    + "zero-unit folio row stays with its demat, and the receipt counts the three rows "
    + "the store holds; a zero-unit-only statement creates its demat and stores the row; "
    + "a fund account is never the demat target; a kept folio never finishes over a "
    + "movement no target can record · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
