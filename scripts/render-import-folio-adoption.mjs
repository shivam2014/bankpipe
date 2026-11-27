#!/usr/bin/env node
// The import card when a value-only mutual fund account already carries the
// statement's folio. A CDSL row prints `90000001234/0`; the stored manual
// account prints `90000001234` with a current value and no units. The card must
// say the folio is already on that account, offer Adopt or Keep the manual
// total, and never call it a new account. Adopt writes one position under the
// same id and removes the manual total; the printed `/0` stays in storage.
//
// Every name, ISIN and number here is invented. The page's own inbox resolver
// and renderer produce the card; the write check presses its buttons and reads
// the store back.
//
//   node scripts/render-import-folio-adoption.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-folio-adoption.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-09-30";
const DEMAT = "1200000012345678";
const BASE = "90000001234";
const PRINTED = "90000001234/0";
const ISIN = "INF000000901";
const MANUAL_PAISE = 31000000;
const STATEMENT_PAISE = 32453600;
const COST_PAISE = 24000000;

const fund = {
  isin: ISIN, label: "TEST FUND GROWTH PLAN", kind: "mf",
  quantity: 100, valuePaise: STATEMENT_PAISE, costPaise: COST_PAISE,
  folio: PRINTED, amc: "TESTMUTUAL", amcFull: "Test Mutual Fund",
};

function statement() {
  const holdings = [{ ...fund, account: DEMAT }];
  return {
    depository: "CDSL", demat: DEMAT, asOf: AS_OF,
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
    id: "inbox-render-folio-adoption", name: "cdsl-cas-synthetic.pdf", size: 2048,
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

function pageScript({ write = false, keep = false, manualPaise = MANUAL_PAISE } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  await store.createAccount({
    id: "demat-1", label: "Demat · Test DP · …5678", category: "demat",
    subtype: "equity", type: "equity", number: ${JSON.stringify(DEMAT)},
  });
  await store.createAccount({
    id: "axis-value", label: "Test Mutual Fund", bank: "Test Mutual Fund",
    category: "demat", subtype: "mutual fund", type: "mf",
    number: ${JSON.stringify(BASE)},
    meta: JSON.stringify({ amc: "testmutual", amc_full: "Test Mutual Fund",
      current_value_paise: ${manualPaise} }),
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
  await window.bpImportDropPlan("__render__");
  await sleep(1200);

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const rowOf = () => document.querySelector('.import-row[data-entry="inbox-render-folio-adoption"]')
    || [...document.querySelectorAll(".import-row")]
      .find((item) => item.querySelector(".import-row-name")?.textContent.trim()
        === "cdsl-cas-synthetic.pdf");
  const row = rowOf();
  if (!row) throw new Error("the CDSL row is missing: "
    + JSON.stringify([...document.querySelectorAll(".import-row-name")].map(text)));
  const planOf = () => (state.plans || [])[0] || {};
  const folioTargetOf = () => (planOf().head?.casTargets || []).find((target) => target.folio);
  const folio = folioTargetOf();
  // The same block sits in the row's account control (closed) and in the open
  // "Choose the account" details. Measure and read the visible one.
  const visible = () => rowOf()?.querySelector(
    "details.import-row-more.import-row-account[open]") || rowOf();
  const offerNode = () => visible()?.querySelector(".import-folio");
  const buttons = () => [...(offerNode()?.querySelectorAll("button") || [])].map(text);
  const barNode = () => document.querySelector(".import-batchbar .btn");
  const rect = offerNode()?.getBoundingClientRect();
  const summary = {
    ready: !!planOf().ready,
    pill: text(rowOf()?.querySelector(".import-row-pill")),
    statusLines: [...(visible()?.querySelectorAll(
      ".import-account-choice .import-choice-meta") || [])].map(text),
    offer: text(offerNode()),
    offerButtons: buttons(),
    offerHeight: rect ? Math.round(rect.height * 10) / 10 : 0,
    offerWidth: rect ? Math.round(rect.width * 10) / 10 : 0,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    accountChrome: [...(visible()?.querySelectorAll(".import-account-choice") || [])].map(text),
    folioAction: folio?.action || "",
    folioBasis: folio?.offer?.basis || "",
    folioTargetId: folio?.targetId || "",
    genericFolioButton: [...(rowOf()?.querySelectorAll("button") || [])]
      .some((button) => /Create a new mutual fund folio account/i.test(text(button))),
    bar: text(barNode()),
    barDisabled: !!barNode()?.disabled,
  };
  if (${write}) {
    const adopt = [...(offerNode()?.querySelectorAll("button") || [])]
      .find((button) => /^Adopt into /.test(text(button)));
    if (!adopt) throw new Error("the Adopt button is missing");
    adopt.click();
    await sleep(1200);
    if (!rowOf()) throw new Error("the CDSL row is missing after Adopt");
    const afterAdopt = {
      ready: !!planOf().ready,
      pill: text(rowOf().querySelector(".import-row-pill")),
      statusLines: [...(visible()?.querySelectorAll(
        ".import-account-choice .import-choice-meta") || [])].map(text),
      accountChrome: [...(visible()?.querySelectorAll(".import-account-choice") || [])].map(text),
      offer: text(offerNode()),
      offerButtons: buttons(),
      folioTargetId: (folioTargetOf() || {}).targetId || "",
      bar: text(barNode()),
      barDisabled: !!barNode()?.disabled,
      summary: planOf().summary || null,
      needsChoice: !!planOf().needsChoice,
    };
    const button = barNode();
    if (!button || button.disabled) {
      throw new Error("the Import button is not available: " + JSON.stringify(afterAdopt));
    }
    button.click();
    let stored = null;
    for (let attempt = 0; attempt < 48 && !stored; attempt += 1) {
      await sleep(250);
      const accounts = await store.listAccounts();
      const funds = accounts.filter((account) =>
        /mutual\\s*fund|^mf$/i.test(String(account.subtype || account.type || "")));
      const rows = funds.length === 1 ? await store.listHoldings(funds[0].id) : [];
      if (rows.length) stored = { accounts, funds, rows, holdings: rows, account: funds[0] };
    }
    if (!stored) throw new Error("the import did not write a fund holding");
    const meta = JSON.parse(stored.account.meta || "{}");
    summary.afterAdopt = afterAdopt;
    summary.status = document.getElementById("import-inbox-status")?.textContent?.trim() || "";
    summary.receipt = text(document.querySelector(".import-row-receipt")) || "";
    summary.funds = stored.funds.map((account) => ({
      id: account.id, number: account.number, label: account.label,
      subtype: account.subtype, meta,
    }));
    summary.holdings = stored.rows.map((holding) => ({
      security_id: holding.security_id, quantity: holding.quantity,
      value_paise: holding.value_paise, cost_paise: holding.cost_paise,
      folio: holding.folio || "", value_source: holding.value_source || "",
    }));
  }
  if (${keep}) {
    const keepButton = [...(offerNode()?.querySelectorAll("button") || [])]
      .find((button) => /^Keep the manual total/.test(text(button)));
    if (!keepButton) throw new Error("the Keep the manual total button is missing");
    keepButton.click();
    await sleep(1200);
    if (!rowOf()) throw new Error("the CDSL row is missing after Keep");
    const afterKeep = {
      ready: !!planOf().ready,
      pill: text(rowOf().querySelector(".import-row-pill")),
      statusLines: [...(visible()?.querySelectorAll(
        ".import-account-choice .import-choice-meta") || [])].map(text),
      offer: text(offerNode()),
      allButtons: [...(rowOf()?.querySelectorAll("button") || [])].map(text),
      folioTargetId: (folioTargetOf() || {}).targetId || "",
      bar: text(barNode()),
      barDisabled: !!barNode()?.disabled,
      summary: planOf().summary || null,
      needsChoice: !!planOf().needsChoice,
    };
    const finish = barNode();
    if (!finish || finish.disabled) {
      throw new Error("the finish button is not available: " + JSON.stringify(afterKeep));
    }
    finish.click();
    await sleep(1500);
    const accounts = await store.listAccounts();
    const funds = accounts.filter((account) =>
      /mutual\\s*fund|^mf$/i.test(String(account.subtype || account.type || "")));
    summary.afterKeep = afterKeep;
    summary.keepFunds = funds.map((account) => ({
      id: account.id, number: account.number, label: account.label,
      subtype: account.subtype, meta: JSON.parse(account.meta || "{}"),
    }));
    summary.keepHoldings = funds.length === 1
      ? (await store.listHoldings(funds[0].id)).length : -1;
    summary.keepAccounts = accounts.length;
    summary.keepStatus = document.getElementById("import-inbox-status")?.textContent?.trim() || "";
    summary.keepReceipt = text(document.querySelector(".import-row-receipt")) || "";
  }
  rowOf()?.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify(summary);
})()`;
}

const SHOTS = [
  { width: 320, height: 3000 },
  { width: 390, height: 3000 },
  { width: 1280, height: 2100 },
];

function verifyCard(state) {
  const wrong = [];
  if (state.pageOverflow) wrong.push("the page scrolls sideways");
  if (state.ready) wrong.push("the card is Ready before the adopt-or-keep choice");
  if (state.pill !== "Needs an account") {
    wrong.push(`pill: want "Needs an account", got ${JSON.stringify(state.pill)}`);
  }
  if (!state.statusLines.some((line) => line.includes("Existing folio · choose below"))) {
    wrong.push(`status lines: ${JSON.stringify(state.statusLines)}`);
  }
  if (state.accountChrome.some((line) => /New mutual fund folio account/.test(line))) {
    wrong.push(`the card still calls the folio a new account: ${JSON.stringify(state.accountChrome)}`);
  }
  for (const want of ["Same fund?", "TEST FUND GROWTH PLAN · folio …1234",
    "Existing Test Mutual Fund", "3,10,000.00", "This statement", "3,24,536.00",
    "Difference", "+₹ 14,536.00", "4.7%", "Adopt replaces the manual total.",
    "Keep the manual total. No rows are imported."]) {
    if (!state.offer.includes(want)) {
      wrong.push(`offer is missing ${JSON.stringify(want)}: ${JSON.stringify(state.offer)}`);
    }
  }
  for (const stale of ["current value with no units", "Guess", "looks like your existing"]) {
    if (state.offer.includes(stale)) {
      wrong.push(`the exact offer still carries ${JSON.stringify(stale)}: ${JSON.stringify(state.offer)}`);
    }
  }
  if (!state.offerButtons.includes("Adopt into Test Mutual Fund")) {
    wrong.push(`Adopt button: ${JSON.stringify(state.offerButtons)}`);
  }
  if (!state.offerButtons.includes("Keep the manual total")) {
    wrong.push(`Keep button: ${JSON.stringify(state.offerButtons)}`);
  }
  if (state.offerButtons.some((line) => /Keep both|Create/i.test(line))) {
    wrong.push(`the exact offer still carries a create answer: ${JSON.stringify(state.offerButtons)}`);
  }
  if (state.folioAction !== "decide") {
    wrong.push(`folio action: want "decide", got ${JSON.stringify(state.folioAction)}`);
  }
  if (state.folioBasis !== "folio") {
    wrong.push(`folio basis: want "folio", got ${JSON.stringify(state.folioBasis)}`);
  }
  if (state.folioTargetId) wrong.push(`a target exists without a choice: ${state.folioTargetId}`);
  if (state.genericFolioButton) wrong.push("the generic create-folio button is still shown");
  if (state.bar) {
    wrong.push(`an Import button is available before the choice: ${JSON.stringify(state.bar)}`);
  }
  return wrong;
}

function verifyKeep(state) {
  const wrong = [];
  const after = state.afterKeep || {};
  if (!after.ready) wrong.push("the card is not Ready after Keep");
  if (after.pill !== "Ready") wrong.push(`after Keep pill: ${JSON.stringify(after.pill)}`);
  if (!after.statusLines.some((line) => line.includes("Kept the manual total"))) {
    wrong.push(`after Keep status: ${JSON.stringify(after.statusLines)}`);
  }
  // The finish action moved from the card to the queue's batch bar; the row
  // still names the one press that closes the file.
  if (after.bar !== "Import 1 ready file" || after.barDisabled) {
    wrong.push(`after Keep finish action: ${JSON.stringify(after)}`);
  }
  if (after.folioTargetId) wrong.push(`Keep made a target: ${after.folioTargetId}`);
  if (after.needsChoice) wrong.push("Keep still asks for a choice");
  if ((state.keepFunds || []).length !== 1
    || state.keepFunds?.[0]?.id !== "axis-value") {
    wrong.push(`the value-only account changed or a duplicate was made: ${JSON.stringify(state.keepFunds)}`);
  }
  if (state.keepFunds?.[0]?.meta?.current_value_paise !== MANUAL_PAISE) {
    wrong.push(`the manual total changed: ${JSON.stringify(state.keepFunds?.[0]?.meta)}`);
  }
  if (state.keepFunds?.[0]?.number !== BASE) {
    wrong.push(`the printed number changed: ${JSON.stringify(state.keepFunds?.[0]?.number)}`);
  }
  if (state.keepHoldings !== 0) wrong.push(`rows were written: ${state.keepHoldings}`);
  if (!/Nothing added/.test(state.keepReceipt || "")
    || !/kept; the manual total stays/.test(state.keepReceipt || "")) {
    wrong.push(`Keep receipt: ${JSON.stringify(state.keepReceipt || state.keepStatus)}`);
  }
  if (!/1 file finished with nothing added\./.test(state.keepStatus || "")) {
    wrong.push(`Keep status: ${JSON.stringify(state.keepStatus)}`);
  }
  if (!/\bNo change\b/.test(state.keepReceipt || "")) {
    wrong.push(`the history row does not say No change: ${JSON.stringify(state.keepReceipt)}`);
  }
  if (/\bImported\b/.test(state.keepReceipt || "")) {
    wrong.push(`the history row calls a no-change finish Imported: ${
      JSON.stringify(state.keepReceipt)}`);
  }
  if (/\binto 2 accounts\b/.test(state.keepReceipt || "")) {
    wrong.push(`Keep receipt counts a kept folio as written: ${JSON.stringify(state.keepReceipt)}`);
  }
  return wrong;
}

function verifyWrite(state) {  const wrong = [];
  const after = state.afterAdopt || {};
  if (!after.ready) wrong.push("the card is not Ready after Adopt");
  if (after.pill !== "Ready") wrong.push(`after Adopt pill: ${JSON.stringify(after.pill)}`);
  if (after.folioTargetId !== "axis-value") {
    wrong.push(`after Adopt target: ${JSON.stringify(after.folioTargetId)}`);
  }
  if (after.bar !== "Import 1 ready file" || after.barDisabled) {
    wrong.push(`after Adopt import action: ${JSON.stringify(after)}`);
  }
  if (!(state.funds || []).some((account) => account.id === "axis-value")) {
    wrong.push(`the value-only id was not kept: ${JSON.stringify(state.funds)}`);
  }
  if ((state.funds || []).length !== 1) {
    wrong.push(`a second folio account was created: ${JSON.stringify(state.funds)}`);
  }
  const meta = state.funds?.[0]?.meta || {};
  if (meta.current_value_paise !== undefined) {
    wrong.push(`the manual total survived the adoption: ${JSON.stringify(meta)}`);
  }
  // A fund account has no DP. The synthetic card label must not become identity.
  if (meta.dp !== undefined) {
    wrong.push(`the adopted folio gained a synthetic DP: ${JSON.stringify(meta.dp)}`);
  }
  if (/\binto 2 accounts\b/.test(state.receipt || "")) {
    wrong.push(`the receipt counts a demat that received no row: ${JSON.stringify(state.receipt)}`);
  }
  if (!/1 holding into Test Mutual Fund/.test(state.receipt || "")) {
    wrong.push(`the receipt does not name the account it wrote: ${JSON.stringify(state.receipt)}`);
  }
  if (!(meta.folios || []).includes(PRINTED)) {
    wrong.push(`the printed folio is not stored: ${JSON.stringify(meta.folios)}`);
  }
  if (state.funds?.[0]?.number !== BASE) {
    wrong.push(`the printed account number changed: ${JSON.stringify(state.funds?.[0]?.number)}`);
  }
  const holding = (state.holdings || [])[0];
  if (!holding) wrong.push("no holding was written");
  else {
    if (holding.security_id !== ISIN) wrong.push(`holding isin: ${holding.security_id}`);
    if (Math.abs(Number(holding.quantity) - 100) > 1e-9) wrong.push(`units: ${holding.quantity}`);
    if (Number(holding.value_paise) !== STATEMENT_PAISE) wrong.push(`value: ${holding.value_paise}`);
    if (Number(holding.cost_paise) !== COST_PAISE) wrong.push(`cost: ${holding.cost_paise}`);
    if (holding.value_source !== "CAS") wrong.push(`value source: ${holding.value_source}`);
  }
  if (!/adopted into Test Mutual Fund/.test(state.receipt || "")) {
    wrong.push(`receipt: ${JSON.stringify(state.receipt || state.status)}`);
  }
  return wrong;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-folio-adoption: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-folio-adoption: --out-dir needs a value");
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
  throw new Error("render-import-folio-adoption: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-folio-adoption-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"]) {
      const script = join(dir, "page-card.js");
      writeFileSync(script, pageScript());
      const out = join(args.outDir,
        `import-folio-adoption-${shot.width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2600,
        width: shot.width, height: shot.height, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = verifyCard(state);
      if (wrong.length) {
        throw new Error("render-import-folio-adoption: the card is not the card that was "
          + "asked for.\n  " + wrong.join("\n  ")
          + "\n  full state: " + JSON.stringify(state));
      }
      console.log(`${out} · offer ${state.offerWidth}×${state.offerHeight}`);
    }
  }
  // Equal totals: the exact offer is still a question, but a ₹0 difference row
  // would be noise, so the comparison stops after the statement.
  const equalScript = join(dir, "page-equal.js");
  writeFileSync(equalScript, pageScript({ manualPaise: STATEMENT_PAISE }));
  const equalOut = join(args.outDir, "import-folio-adoption-equal-390-light.png");
  const equal = await capture({
    page, out: equalOut, script: equalScript, wait: 2600,
    width: 390, height: 1800, theme: "light",
  });
  const equalState = JSON.parse(equal.value);
  const equalWrong = [];
  for (const want of ["Same fund?", "Existing Test Mutual Fund", "This statement",
    "3,24,536.00", "Adopt replaces the manual total.",
    "Keep the manual total. No rows are imported."]) {
    if (!equalState.offer.includes(want)) {
      equalWrong.push(`equal-value offer is missing ${JSON.stringify(want)}: `
        + JSON.stringify(equalState.offer));
    }
  }
  if (equalState.offer.includes("Difference")) {
    equalWrong.push(`an equal-value offer still shows a difference: ${JSON.stringify(equalState.offer)}`);
  }
  if (equalWrong.length) {
    throw new Error("render-import-folio-adoption: the equal-value card is not the card that "
      + "was asked for.\n  " + equalWrong.join("\n  ")
      + "\n  full state: " + JSON.stringify(equalState));
  }
  console.log(`${equalOut} · offer ${equalState.offerWidth}×${equalState.offerHeight} · no difference row`);
  // The real proof: press Adopt, then Import, and read the store back.
  const writeScript = join(dir, "page-write.js");
  writeFileSync(writeScript, pageScript({ write: true }));
  const writeOut = join(args.outDir, "import-folio-adoption-written-390-light.png");
  const written = await capture({
    page, out: writeOut, script: writeScript, wait: 2600,
    width: 390, height: 1800, theme: "light",
  });
  const writeState = JSON.parse(written.value);
  const writeWrong = verifyWrite(writeState);
  if (writeWrong.length) {
    throw new Error("render-import-folio-adoption: the card did not write what it promised.\n  "
      + writeWrong.join("\n  ") + "\n  full state: " + JSON.stringify(writeState));
  }
  console.log(writeOut);
  const keepScript = join(dir, "page-keep.js");
  writeFileSync(keepScript, pageScript({ keep: true }));
  const keepOut = join(args.outDir, "import-folio-adoption-kept-390-light.png");
  const kept = await capture({
    page, out: keepOut, script: keepScript, wait: 2600,
    width: 390, height: 1800, theme: "light",
  });
  const keepState = JSON.parse(kept.value);
  const keepWrong = verifyKeep(keepState);
  if (keepWrong.length) {
    throw new Error("render-import-folio-adoption: Keep did not leave the manual total alone.\n  "
      + keepWrong.join("\n  ") + "\n  full state: " + JSON.stringify(keepState));
  }
  console.log(keepOut);
  console.log("import folio adoption: the card offers the exact account, Adopt keeps its id "
    + "and writes one 3,24,536 position, and the printed 90000001234/0 stays in storage; "
    + "Keep writes no rows and leaves 3,10,000 · 320/390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
