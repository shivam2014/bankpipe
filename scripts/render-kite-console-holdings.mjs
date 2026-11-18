#!/usr/bin/env node
// The import card for Kite Console's three-sheet holdings export.
//
// The workbook is built in the page from the synthetic fixture, then dropped
// through the real inbox: detection, XLSX reading, the parser and the plan card
// all run. Equity and Mutual Funds carry the rows; Combined repeats them with a
// shifted header and must not double the count.
//
// Every name, ISIN, quantity and amount here is invented.
//
//   node scripts/render-kite-console-holdings.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { KITE_CONSOLE_SHEETS } from "../web/fixtures/import/samples.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-kite-console-holdings.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const FILE_NAME = "holdings-XXX002.xlsx";
const AS_OF = "2026-11-12";
const CLIENT_ID = "TEST500";

const SEED = [{
  id: "demat-zerodha",
  label: "Demat · Zerodha",
  category: "demat",
  subtype: "equity",
  type: "equity",
  number: "",
  holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "Zerodha", client_id: CLIENT_ID,
    broker_only: "1" }),
  rows: [],
}];

function pageScript() {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  for (const account of ${JSON.stringify(SEED)}) {
    const { rows, ...fields } = account;
    await store.createAccount(fields);
    await store.replaceHoldings(fields.id, rows, ${JSON.stringify(AS_OF)});
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
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  for (const [name, matrix] of Object.entries(${JSON.stringify(KITE_CONSOLE_SHEETS)})) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), name);
  }
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const file = new File([bytes], ${JSON.stringify(FILE_NAME)}, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  await window.bpImportInboxAdd([file]);
  await sleep(600);
  const card = [...document.querySelectorAll(".import-bundle")]
    .find((item) => item.querySelector(".import-title")?.textContent.trim() === "Zerodha holdings");
  if (!card) throw new Error("the Zerodha holdings card is missing");
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const entry = state.entries[0] || {};
  const bundle = state.bundles[0] || {};
  const plan = state.plans[0] || {};
  card.scrollIntoView({ block: "start" });
  window.scrollBy(0, -80);
  return JSON.stringify({
    kind: entry.kind,
    asOf: entry.asOf,
    accountKey: entry.accountKey,
    file: card.querySelector(".import-file-name")?.textContent.trim() || "",
    sub: text(card.querySelector(".import-sub")),
    pill: text(card.querySelector(".import-pill")),
    primaryLabel: text(card.querySelector(".btn.primary")),
    primaryDisabled: !!card.querySelector(".btn.primary")?.disabled,
    ready: !!plan.ready,
    changes: [...card.querySelectorAll(".import-change ul li")].map(text),
    warnings: [...card.querySelectorAll(".import-note")].map(text),
    parsedRows: (entry.rows || []).length,
    categories: (entry.rows || []).reduce((out, row) => {
      out[row.category] = (out[row.category] || 0) + 1;
      return out;
    }, {}),
    isins: [...new Set((entry.rows || []).map((row) => row.isin))].sort(),
    pledged: (entry.rows || []).find((row) => row.label === "TESTPOWER")?.quantity ?? null,
    bundleRows: (bundle.rows || []).length,
  });
})()`;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-kite-console-holdings: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-kite-console-holdings: --out-dir needs a value");
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
  throw new Error("render-kite-console-holdings: web/server.mjs did not answer.");
}

function check(state) {
  const wrong = [];
  const want = {
    kind: "zerodha-holdings",
    asOf: AS_OF,
    accountKey: CLIENT_ID,
    file: FILE_NAME,
    pill: "Ready",
    primaryLabel: "Import 5 holdings",
    primaryDisabled: false,
    ready: true,
    parsedRows: 5,
    bundleRows: 5,
    pledged: 77,
  };
  for (const [key, value] of Object.entries(want)) {
    if (state[key] !== value) {
      wrong.push(`${key}: want ${JSON.stringify(value)}, got ${JSON.stringify(state[key])}`);
    }
  }
  if (!state.sub.startsWith("3 equities and 2 funds")) {
    wrong.push(`category line: ${JSON.stringify(state.sub)}`);
  }
  if (state.sub.indexOf("as on 12 Nov 2026") < 0) {
    wrong.push(`date line: ${JSON.stringify(state.sub)}`);
  }
  if (state.categories?.equity !== 3 || state.categories?.mf !== 2) {
    wrong.push(`categories: ${JSON.stringify(state.categories)}`);
  }
  if (state.isins?.length !== 5) {
    wrong.push(`ISINs are not one per security: ${JSON.stringify(state.isins)}`);
  }
  return wrong;
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-kite-console-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  const script = join(dir, "page.js");
  writeFileSync(script, pageScript());
  for (const shot of [{ width: 390, height: 1600 }, { width: 1280, height: 1100 }]) {
    for (const theme of ["light", "dark"]) {
      const out = join(args.outDir,
        `kite-console-holdings-${shot.width}-${theme}.png`);
      const result = await capture({
        page, out, script, wait: 2400,
        width: shot.width, height: shot.height, theme,
      });
      const state = JSON.parse(result.value);
      const wrong = check(state);
      if (wrong.length) {
        throw new Error("render-kite-console-holdings: the card is not the card that was "
          + `asked for.\n  ${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
      }
      console.log(out);
    }
  }
  console.log("Kite Console holdings: Equity and Mutual Funds read once each, Combined "
    + "ignored, pledged units kept in the holding quantity, 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
