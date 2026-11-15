#!/usr/bin/env node
// The gated movement card, rendered from the repo. Seeds the sample portfolio
// with the synthetic pair in web/fixtures/import/pdf, drops it through the
// page's own inbox, and fails unless the statement card is gated on the broker
// that funds its disposal.
//
//   node scripts/render-gate-fixture.mjs [--out-dir build/renders]
//
// Writes four screenshots: 390 and 1280, light and dark. Synthetic data only.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-gate-fixture.mjs [--out-dir build/renders]

  --out-dir  where the four PNGs go, default build/renders
`;

// Runs inside the page, after the sample portfolio has booted. It seeds one live
// bond with no cost, drops the CAS that sells it and the broker report that
// funds it, then reports the card's state so the runner can refuse a silent
// regression.
const PAGE_SCRIPT = `(async () => {
  go("import");
  await new Promise((done) => setTimeout(done, 1500));
  const store = await import("./db.js");
  const account = (await store.listAccounts()).find((row) => row.category === "demat");
  if (!account) throw new Error("the sample portfolio has no demat account");
  let meta = {};
  try { meta = JSON.parse(account.meta || "{}"); } catch { meta = {}; }
  await store.updateAccount(account.id, {
    number: "IN99990001344321",
    meta: JSON.stringify({ ...meta, ucid: "TEST0001", identity_source: "cas",
      identity_as_of: "2026-09-30", holdings_source: "cas", holdings_as_of: "2026-09-30" }),
  });
  const current = await store.listHoldings(account.id);
  await store.replaceHoldings(account.id, [...current, {
    security_id: "INE000000002", label: "SOLD BOND 31 DEC 2028", category: "bond",
    quantity: 10, cost_paise: null, value_paise: 100000, as_of: "2026-09-30",
    value_source: "CAS", source: "report",
  }], "2026-09-30");
  const file = async (name) => {
    const bytes = new Uint8Array(await (await fetch("fixtures/import/pdf/" + name))
      .arrayBuffer());
    return new File([bytes], name, { type: "application/pdf" });
  };
  await window.bpImportInboxAdd([await file("cas-sold.pdf"), await file("motilal-sold.pdf")]);
  await new Promise((done) => setTimeout(done, 600));
  const state = window.bpImportInbox;
  const plans = state.plans || [];
  const cas = plans.find((plan) => plan.head.family === "cas");
  const broker = plans.find((plan) => plan.head.family !== "cas");
  const cardFor = (title) => [...document.querySelectorAll(".import-bundle")]
    .find((card) => card.querySelector(".import-title")?.textContent.trim() === title);
  const casCard = cardFor("CDSL CAS");
  const brokerCard = cardFor("Motilal Oswal holdings report");
  const importAll = [...document.querySelectorAll(".import-batch-actions .btn")]
    .find((button) => /Import all/.test(button.textContent));
  const host = document.getElementById("import-inbox-host");
  if (host) {
    host.scrollIntoView({ block: "start" });
    window.scrollBy(0, -70);
  }
  return JSON.stringify({
    gate: cas?.gate?.label || "",
    statementReady: !!cas?.ready,
    pill: casCard?.querySelector(".import-pill")?.textContent.trim() || "",
    primaryLabel: casCard?.querySelector(".btn.primary")?.textContent.trim() || "",
    primaryDisabled: !!casCard?.querySelector(".btn.primary")?.disabled,
    gateButton: [...(casCard?.querySelectorAll(".btn") || [])]
      .map((button) => button.textContent.trim()).find((text) => /^Go to the /.test(text)) || "",
    brokerReady: !!broker?.ready,
    brokerPill: brokerCard?.querySelector(".import-pill")?.textContent.trim() || "",
    brokerPrimaryLabel: brokerCard?.querySelector(".btn.primary")?.textContent.trim() || "",
    brokerPrimaryDisabled: !!brokerCard?.querySelector(".btn.primary")?.disabled,
    importAllPresent: !!importAll,
  });
})()`;

const CHECKS = {
  gate: "Motilal",
  statementReady: false,
  pill: "Import the Motilal report first",
  primaryLabel: "Import 1 holding",
  primaryDisabled: true,
  gateButton: "Go to the Motilal report",
  brokerReady: true,
  brokerPill: "Ready",
  brokerPrimaryLabel: "Import 1 holding",
  brokerPrimaryDisabled: false,
  importAllPresent: false,
};

const SHOTS = [
  { width: 390, height: 2800, theme: "dark" },
  { width: 390, height: 2800, theme: "light" },
  { width: 1280, height: 1900, theme: "dark" },
  { width: 1280, height: 1900, theme: "light" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-gate-fixture: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-gate-fixture: --out-dir needs a value");
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
  throw new Error("render-gate-fixture: web/server.mjs did not answer.");
}

function verify(state) {
  const wrong = Object.entries(CHECKS)
    .filter(([key, want]) => state[key] !== want)
    .map(([key, want]) => `${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(state[key])}`);
  if (wrong.length) {
    throw new Error("render-gate-fixture: the gate is not the card that was asked for.\n  "
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

const dir = mkdtempSync(join(tmpdir(), "bankpipe-gate-"));
const pageScript = join(dir, "page.js");
writeFileSync(pageScript, PAGE_SCRIPT);
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const out = join(args.outDir, `gate-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script: pageScript, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    verify(JSON.parse(result.value));
    console.log(out);
  }
  console.log("gate: Import the Motilal report first · primary disabled · broker Ready · "
    + "Import all hidden");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
