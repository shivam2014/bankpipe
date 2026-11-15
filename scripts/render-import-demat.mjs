#!/usr/bin/env node
// The import card for a statement that lists a demat and also moves it.
//
// Two synthetic statements, one difference: the "created" statement lists the
// twelve equities of the demat its movements name, so the import can create that
// account and write the disposals in one go. The "blocked" statement moves the
// same demat but lists no holding under it, so there is nothing to create the
// account from and the card must still refuse.
//
// Both cards are rendered from the page's own inbox resolver and renderer at 390
// and 1280, light and dark. Every name, ISIN and number here is invented.
//
//   node scripts/render-import-demat.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-demat.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-09-30";
const MOVED_BO = "IN99990001344321";
const HELD_BO = "1200000012345678";
const FOLIO = "91062983856";

const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const equity = (n) => ({
  isin: isin(300 + n), label: `TEST EQUITY ${n}`, kind: "equity",
  quantity: 10 + n, valuePaise: 100000 * (n + 1),
});
const bond = (n) => ({
  isin: isin(400 + n), label: `9.25% TEST BOND ${n} 31 Dec 2028`,
  kind: "bond", quantity: 10, valuePaise: 100000, couponPct: 9.25,
  maturity: "2028-12-31",
});
const fund = {
  isin: "INF000000901", label: "TEST FUND GROWTH PLAN", kind: "mf",
  quantity: 100, valuePaise: 500000, folio: FOLIO, amc: "TESTMUTUAL",
  amcFull: "Test Mutual Fund",
};

const equities = Array.from({ length: 12 }, (_, at) => equity(at + 1));
const bonds = Array.from({ length: 18 }, (_, at) => bond(at + 1));

// The statement is dated after its movements, so its holdings table already
// shows the post-sale units. These four rows sold two units each inside the
// period.
const SOLD_TWO = new Map([[equities[0].isin, 9], [equities[1].isin, 10],
  [bonds[2].isin, 8], [bonds[3].isin, 8]]);
const afterSales = (holding) => (SOLD_TWO.has(holding.isin)
  ? { ...holding, quantity: SOLD_TWO.get(holding.isin) } : holding);
const equityRows = equities.map(afterSales);
const bondRows = bonds.map(afterSales);

// Two matured bonds already on the account, absent from this statement. They are
// the rows the card moves to history, and the label carries the maturity because
// a stored row has no maturity column.
const maturedRows = [1, 2].map((n) => ({
  security_id: isin(500 + n), label: `8.10% TEST MATURED OLD ${n} 15 May 2020`,
  category: "bond", quantity: 10, cost_paise: null, value_paise: 100000, quantity_face: null,
  purchase_date: "2015-05-15", as_of: "2026-08-31", value_source: "CAS", source: "report",
}));

const SEED = [{
  id: "demat-hdfc", label: "Demat · HDFC · …5678", category: "demat",
  subtype: "equity", type: "equity", number: HELD_BO, holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "HDFC Bank Ltd",
    holdings_source: "cas", holdings_as_of: "2026-08-31" }),
  rows: maturedRows,
}];

// Four disposals, two per demat, all partial so the holding stays in the table.
// The closing balance is printed in paise the way the parser reads it, so a
// closing of eight units is 800.
const sale = (bo, holding, description) => ({
  isin: holding.isin, security: `TEST ${description}`, account: bo,
  date: "2026-09-14", type: "SALE", description, quantity: 2,
  creditPaise: 0, debitPaise: 20000, openingPaise: (holding.quantity + 2) * 100,
  closingPaise: holding.quantity * 100,
});
const sales = [
  sale(MOVED_BO, equityRows[0], "SALE - TEST EQUITY 1"),
  sale(MOVED_BO, equityRows[1], "SALE - TEST EQUITY 2"),
  sale(HELD_BO, bondRows[2], "SALE - TEST BOND 3"),
  sale(HELD_BO, bondRows[3], "SALE - TEST BOND 4"),
];
// Seventeen payout credits. Each prints a wording the writer cannot read as a
// purchase or a transfer in, so each is refused one by one. The units do not
// move, so the printed closing balance is the holding's own.
const credits = Array.from({ length: 17 }, (_, at) => ({
  isin: bonds[4 + (at % (bonds.length - 4))].isin,
  security: `TEST BOND ${5 + (at % (bonds.length - 4))}`,
  account: HELD_BO, date: "2026-09-18", type: "PAYOUT-CR",
  description: `PAYOUT-CR CM ${1000 + at}`, quantity: 5, creditPaise: 1234,
  debitPaise: 0, openingPaise: 1000, closingPaise: 1000,
}));

function statement({ includeMoved }) {
  const accounts = [];
  const owned = (bo, rows) => rows.map((row) => ({ ...row, account: bo }));
  if (includeMoved) {
    accounts.push({ boId: MOVED_BO, dpName: "Zerodha Broking Ltd",
      holdings: owned(MOVED_BO, equityRows) });
  }
  accounts.push({ boId: HELD_BO, dpName: "HDFC Bank Ltd",
    holdings: owned(HELD_BO, [...bondRows, fund]) });
  const holdings = accounts.flatMap((account) => account.holdings);
  return {
    depository: "CDSL", demat: MOVED_BO, asOf: AS_OF, accounts, holdings,
    transactions: [...sales, ...credits],
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

function entryFor(includeMoved) {
  const parsed = statement({ includeMoved });
  return {
    id: `inbox-render-${includeMoved ? "created" : "blocked"}`,
    name: "cdsl-cas-synthetic.pdf", size: 2048, status: "ready", kind: "cas",
    broker: "", asOf: AS_OF, accountKey: MOVED_BO, accountKind: "bo",
    rows: parsed.holdings.map(row), firstBuyByIsin: {}, termsByIsin: [],
    termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((account) => ({
      boId: account.boId, dpName: account.dpName, rows: account.holdings.map(row),
    })),
    file: null,
  };
}

function pageScript(includeMoved, { write = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  for (const account of ${JSON.stringify(SEED)}) {
    const { rows, ...fields } = account;
    await store.createAccount(fields);
    await store.replaceHoldings(fields.id, rows, "2026-08-31");
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
  state.entries.push(${JSON.stringify(entryFor(includeMoved))});
  // The page keeps its planner module-scoped; dropping a plan that does not
  // exist is the smallest public control that re-runs it, unchanged.
  window.bpImportDropPlan("__render__");
  await sleep(900);

  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "CDSL CAS");
  if (!card) throw new Error("the CDSL card is missing");
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const accountLines = [...card.querySelectorAll(".import-account-choice")]
    .map((item) => text(item));
  const pill = text(card.querySelector(".import-pill"));
  const primary = card.querySelector(".btn.primary");
  const salesBlock = card.querySelector(".cas-sales");
  const salesNotes = [...(salesBlock?.querySelectorAll(":scope > div.muted") || [])]
    .map((item) => text(item));
  // The summary sentence is the div's own first text node; the disclosure is a
  // sibling element, so its text is not part of the line a person reads first.
  const creditNote = [...(salesBlock?.querySelectorAll("div.muted") || [])]
    .find((item) => /credit(s)? (was|were) not added/.test(item.childNodes[0]?.textContent || ""));
  const creditLine = creditNote
    ? (creditNote.childNodes[0].textContent || "").replace(/\\s+/g, " ").trim() : "";
  const salesLists = [...(salesBlock?.querySelectorAll("ul") || [])];
  const disclosure = salesBlock?.querySelector("details");
  const changeLines = [...card.querySelectorAll(".import-change ul li")].map(text);
  const warnings = [...card.querySelectorAll(".import-note")].map(text);
  const plan = (state.plans || [])[0] || {};
  const clean = (value) => String(value || "").replace(/[^0-9a-z]/gi, "").toUpperCase();
  if (${write}) {
    // The real proof: press the button that the card now leaves enabled, and read
    // the store afterwards. Nothing else here is a mock.
    const button = card.querySelector(".btn.primary");
    if (!button || button.disabled) throw new Error("the import button is not available");
    button.click();
    let moved = null;
    for (let attempt = 0; attempt < 48 && !moved; attempt += 1) {
      await sleep(250);
      moved = (await store.listAccounts()).find((account) => clean(account.number) === "${MOVED_BO}");
    }
    const rowsOf = async (id) => (await store.listHoldings(id)).map((row) => ({
      isin: row.security_id, quantity: row.quantity, disposed: row.disposed_at || "",
      disposedQuantity: row.disposed_quantity ?? null,
    }));
    const accounts = await store.listAccounts();
    const hdfc = accounts.find((account) => clean(account.number) === "${HELD_BO}");
    const folio = accounts.find((account) => clean(account.number) === "${FOLIO}");
    return JSON.stringify({
      moved: moved ? { number: moved.number, holdings: await rowsOf(moved.id) } : null,
      hdfc: hdfc ? { number: hdfc.number, holdings: await rowsOf(hdfc.id) } : null,
      folio: folio ? { number: folio.number, subtype: folio.subtype,
        holdings: await rowsOf(folio.id) } : null,
      status: document.getElementById("import-inbox-status")?.textContent?.trim() || "",
      accounts: accounts.map((account) => ({ number: account.number,
        label: account.label, category: account.category, subtype: account.subtype })),
    });
  }
  // The blocked card's add-account control has to land on the form with the BO
  // the statement prints already typed in. Walking there is the only proof.
  let addFlow = null;
  const addButton = [...card.querySelectorAll(".btn")]
    .find((button) => /^Add the demat account$/.test(text(button)));
  if (addButton) {
    addButton.click();
    await sleep(800);
    addFlow = { onForm: !!document.getElementById("s-number"),
      number: document.getElementById("s-number")?.value || "" };
    go("import");
    await sleep(1000);
  }
  const shown = [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "CDSL CAS");
  shown?.scrollIntoView({ block: "start" });
  window.scrollBy(0, -80);
  return JSON.stringify({
    ready: !!plan.ready,
    pill,
    primaryLabel: text(primary),
    primaryDisabled: !!primary?.disabled,
    accountLines,
    salesNotes,
    creditLine,
    eventLines: salesLists.slice(0, 1).flatMap((list) =>
      [...list.querySelectorAll("li")].map(text)),
    disclosure: disclosure ? {
      open: disclosure.open,
      summary: text(disclosure.querySelector("summary")),
      detail: [...disclosure.querySelectorAll("li")].map(text),
      detailFont: getComputedStyle(disclosure.querySelector("li") || disclosure).fontSize,
      summaryFont: getComputedStyle(disclosure.querySelector("summary")).fontSize,
    } : null,
    changeLines,
    warnings,
    addFlow,
    planCount: (state.plans || []).length,
  });
})()`;
}

const SCENARIOS = [
  {
    name: "created",
    includeMoved: true,
    checks: (state) => {
      const wrong = [];
      const want = {
        ready: true,
        pill: "Ready",
        primaryLabel: "Import 33 holdings",
        primaryDisabled: false,
      };
      for (const [key, value] of Object.entries(want)) {
        if (state[key] !== value) wrong.push(`${key}: want ${JSON.stringify(value)}, got ${JSON.stringify(state[key])}`);
      }
      if (!state.accountLines.some((line) => /Zerodha · …4321 New demat account 12 holdings/.test(line))) {
        wrong.push(`the moved demat is not offered as a new account: ${JSON.stringify(state.accountLines)}`);
      }
      if (state.warnings.some((line) => /No demat on file/.test(line))) {
        wrong.push("the card still refuses to import until the account exists");
      }
      for (const line of ["Add 31 holdings", "Record 4 sales or transfers as sold",
        "Move 2 matured bonds to history"]) {
        if (!state.changeLines.includes(line)) {
          wrong.push(`summary line ${JSON.stringify(line)} missing from ${JSON.stringify(state.changeLines)}`);
        }
      }
      const credit = "17 credits were not added because they name no purchase or transfer-in.";
      if (state.creditLine !== credit) {
        wrong.push(`credit line: ${JSON.stringify(state.creditLine)}`);
      }
      if (!state.disclosure || state.disclosure.detail.length !== 17) {
        wrong.push("the credit detail is not behind one disclosure of 17 lines");
      }
      const sold = state.eventLines.filter((line) => /^Sold/.test(line));
      if (sold.length !== 4) {
        wrong.push(`sale lines: ${JSON.stringify(sold)}`);
      }
      return wrong;
    },
  },
  {
    name: "blocked",
    includeMoved: false,
    checks: (state) => {
      const wrong = [];
      if (state.ready) wrong.push("the card is ready without a holdings row for the movement account");
      if (state.pill !== "Add the account first") wrong.push(`pill: ${JSON.stringify(state.pill)}`);
      if (!state.primaryDisabled) wrong.push("the primary action is enabled");
      if (!state.warnings.some((line) => /No demat on file for the movement account …4321\. Add that account, then import again\./.test(line))) {
        wrong.push(`blocked footer: ${JSON.stringify(state.warnings)}`);
      }
      if (state.accountLines.some((line) => /…4321/.test(line))) {
        wrong.push(`the card offers to create the account it refuses to move: ${JSON.stringify(state.accountLines)}`);
      }
      if (!state.addFlow?.onForm || state.addFlow.number !== MOVED_BO) {
        wrong.push(`the add-account control does not open the form with the BO ID: ${JSON.stringify(state.addFlow)}`);
      }
      return wrong;
    },
  },
];

const SHOTS = [
  { width: 390, height: 3000 },
  { width: 1280, height: 2100 },
];

// What the store must hold after pressing Import on the created card: the demat
// the movements name exists, carries the statement's equities, and holds the two
// disposals the same statement recorded. The account that was already on file
// keeps its rows and takes its own disposals.
function verifyWrite(state) {
  const wrong = [];
  const live = (rows) => rows.filter((row) => !row.disposed && Number(row.quantity) > 0);
  const disposed = (rows) => rows.filter((row) => !!row.disposed);
  if (!state.moved) {
    wrong.push("the import did not create the demat its movements name");
  } else {
    if (state.moved.number !== MOVED_BO) {
      wrong.push(`created number: ${JSON.stringify(state.moved.number)}`);
    }
    const movedEquities = live(state.moved.holdings).filter((row) =>
      equityRows.some((equity) => equity.isin === row.isin));
    if (movedEquities.length !== 12) {
      wrong.push(`created account equities: ${movedEquities.length}`);
    }
    const sold = disposed(state.moved.holdings);
    const soldIsins = sold.map((row) => row.isin).sort();
    const want = [equityRows[0].isin, equityRows[1].isin].sort();
    if (sold.length !== 2 || soldIsins.join() !== want.join()
      || sold.some((row) => row.disposedQuantity !== 2)) {
      wrong.push(`created account disposals: ${JSON.stringify(sold)}`);
    }
  }
  const hdfcSold = state.hdfc ? disposed(state.hdfc.holdings) : [];
  if (hdfcSold.length !== 2) {
    wrong.push(`the account on file recorded ${hdfcSold.length} disposals, want 2`);
  }
  if (!state.folio || state.folio.holdings.length !== 1) {
    wrong.push(`the fund folio account: ${JSON.stringify(state.folio)}`);
  }
  return wrong;
}


function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-demat: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-demat: --out-dir needs a value");
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
  throw new Error("render-import-demat: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-demat-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const scenario of SCENARIOS) {
    for (const shot of SHOTS) {
      for (const theme of ["light", "dark"]) {
        const script = join(dir, `page-${scenario.name}.js`);
        writeFileSync(script, pageScript(scenario.includeMoved));
        const out = join(args.outDir,
          `import-demat-${scenario.name}-${shot.width}-${theme}.png`);
        const result = await capture({
          page, out, script, wait: 2400,
          width: shot.width, height: shot.height, theme,
        });
        const state = JSON.parse(result.value);
        const wrong = scenario.checks(state);
        if (wrong.length) {
          throw new Error(`render-import-demat: the ${scenario.name} card is not the card `
            + `that was asked for.\n  ${wrong.join("\n  ")}\n  full state: `
            + JSON.stringify(state));
        }
        console.log(out);
      }
    }
  }
  // One write pass: the created card is not only allowed, it lands.
  const writeScriptPath = join(dir, "page-write.js");
  writeFileSync(writeScriptPath, pageScript(true, { write: true }));
  const writeOut = join(args.outDir, "import-demat-written-390-light.png");
  const written = await capture({
    page, out: writeOut, script: writeScriptPath, wait: 2400,
    width: 390, height: 1600, theme: "light",
  });
  const writeState = JSON.parse(written.value);
  const writeWrong = verifyWrite(writeState);
  if (writeWrong.length) {
    throw new Error("render-import-demat: the created card did not write what it promised.\n  "
      + `${writeWrong.join("\n  ")}\n  full state: ${JSON.stringify(writeState)}`);
  }
  console.log(writeOut);
  console.log("import demat: created card offers the new demat, is ready and folds 17 credit "
    + "warnings into one line · blocked card still refuses, names the account and opens the "
    + "add-account form with its BO ID · write checked in the store · "
    + "390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
