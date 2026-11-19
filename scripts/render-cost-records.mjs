#!/usr/bin/env node
// Renders the Assets page with cost records in three states: every record
// attached (no block), one orphan with a named account, and one orphan whose
// bonds no demat holds. It also renders two orphans for the plural sentence.
// Synthetic rows only, under the reserved 9999 namespace.
//
//   node scripts/render-cost-records.mjs [--out-dir <dir>]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-cost-records.mjs [--out-dir <dir>]

  --out-dir  where the PNGs go, default a fresh OS temp directory
`;

const DEMAT_ID = "cost-demat";
const DEMAT_LABEL = "Demat · TEST COST HOLDER · …3456";
const ISIN = "INE999900121";
const MISSING = "INE999900999";
const COST = 12345678;
const SPLIT_DEMAT_ID = "split-two";
const SPLIT_DEMAT_LABEL = "Demat · TEST SPLIT TWO · …4321";
const SPLIT_ISIN = "INE999900122";
const SPLIT_COST = 23456789;
const NAMED_DEMAT_ID = "only-one";
const NAMED_DEMAT_LABEL = "Demat · TEST ONLY ONE · …7777";
const NAMED_ISIN = "INE999900123";

function pageScript({ scene }) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  for (let i = 0; i < 100 && !window.bp.demo; i += 1) await sleep(100);
  if (!window.bp.demo) throw new Error("the sample portfolio did not open");
  const store = await import("./db.js");

  await store.createAccount({
    id: ${JSON.stringify(DEMAT_ID)},
    label: ${JSON.stringify(DEMAT_LABEL)},
    bank: "Test Securities",
    number: "IN99990000123456",
    holder: "TEST COST HOLDER",
    type: "equity",
    category: "demat",
    subtype: "equity",
    meta: JSON.stringify({ holdings_as_of: "2026-10-31" }),
  });
  await store.replaceHoldings(${JSON.stringify(DEMAT_ID)}, [{
    security_id: ${JSON.stringify(ISIN)},
    label: "9.10% TEST COST BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: null,
    value_paise: 1000000,
    purchase_date: "2025-05-15",
    as_of: "2026-10-31",
  }], "2026-10-31");

  // This one is already attached and must stay silent in every scene.
  await store.createAccount({
    id: "cost-attached",
    label: "TEST ATTACHED COST PORTFOLIO",
    category: "bonds",
    subtype: "bond",
    meta: JSON.stringify({ cost_only: "1", linked_asset: ${JSON.stringify(DEMAT_ID)},
      linked_label: ${JSON.stringify(DEMAT_LABEL)} }),
  });
  await store.replaceHoldings("cost-attached", [{
    security_id: ${JSON.stringify(ISIN)},
    label: "9.10% TEST COST BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: ${COST},
    purchase_date: "2025-05-15",
  }], "2026-10-31");

  await store.createAccount({
    id: "cost-orphan",
    label: "TEST ORPHAN COST PORTFOLIO",
    category: "bonds",
    subtype: "bond",
    meta: JSON.stringify({ cost_only: "1" }),
  });
  await store.replaceHoldings("cost-orphan", [{
    security_id: ${JSON.stringify(scene === "nohome" ? MISSING : ISIN)},
    label: "9.10% TEST COST BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: ${COST},
    purchase_date: "2025-05-15",
  }], "2026-10-31");

  if (${JSON.stringify(scene)} === "split") {
    await store.createAccount({
      id: ${JSON.stringify(SPLIT_DEMAT_ID)},
      label: ${JSON.stringify(SPLIT_DEMAT_LABEL)},
      bank: "Test Securities",
      number: "IN99990000654321",
      holder: "TEST SPLIT TWO",
      type: "equity",
      category: "demat",
      subtype: "equity",
      meta: JSON.stringify({ holdings_as_of: "2026-10-31" }),
    });
    await store.replaceHoldings(${JSON.stringify(SPLIT_DEMAT_ID)}, [{
      security_id: ${JSON.stringify(SPLIT_ISIN)},
      label: "9.20% TEST SPLIT BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: null,
      value_paise: 2000000,
      purchase_date: "2025-05-15",
      as_of: "2026-10-31",
    }], "2026-10-31");
    await store.createAccount({
      id: "cost-split",
      label: "TEST SPLIT COST PORTFOLIO",
      category: "bonds",
      subtype: "bond",
      meta: JSON.stringify({ cost_only: "1" }),
    });
    await store.replaceHoldings("cost-split", [{
      security_id: ${JSON.stringify(ISIN)},
      label: "9.10% TEST COST BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: ${COST},
      purchase_date: "2025-05-15",
    }, {
      security_id: ${JSON.stringify(SPLIT_ISIN)},
      label: "9.20% TEST SPLIT BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: ${SPLIT_COST},
      purchase_date: "2025-05-15",
    }], "2026-10-31");
  }
  if (${JSON.stringify(scene)} === "named-empty") {
    await store.createAccount({
      id: ${JSON.stringify(NAMED_DEMAT_ID)},
      label: ${JSON.stringify(NAMED_DEMAT_LABEL)},
      bank: "Test Securities",
      number: "IN99990000777777",
      holder: "TEST ONLY ONE",
      type: "equity",
      category: "demat",
      subtype: "equity",
      meta: JSON.stringify({ holdings_as_of: "2026-10-31" }),
    });
    await store.replaceHoldings(${JSON.stringify(NAMED_DEMAT_ID)}, [{
      security_id: ${JSON.stringify(NAMED_ISIN)},
      label: "9.30% TEST ONLY BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: null,
      value_paise: 3000000,
      purchase_date: "2025-05-15",
      as_of: "2026-10-31",
    }], "2026-10-31");
    await store.createAccount({
      id: "cost-named-empty",
      label: "TEST NAMED EMPTY COST PORTFOLIO",
      number: "IN99990000777777",
      category: "bonds",
      subtype: "bond",
      meta: JSON.stringify({ cost_only: "1" }),
    });
    await store.replaceHoldings("cost-named-empty", [{
      security_id: "INE999900124",
      label: "9.40% TEST NAMED EMPTY BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: ${COST},
      purchase_date: "2025-05-15",
    }], "2026-10-31");
  }
  if (${JSON.stringify(scene)} === "attached") {
    await store.updateAccount("cost-orphan", { meta: JSON.stringify({ cost_only: "1",
      linked_asset: ${JSON.stringify(DEMAT_ID)},
      linked_label: ${JSON.stringify(DEMAT_LABEL)} }) });
  }
  if (${JSON.stringify(scene)} === "plural") {
    await store.createAccount({
      id: "cost-nohome",
      label: "TEST NO-HOME COST PORTFOLIO",
      category: "bonds",
      subtype: "bond",
      meta: JSON.stringify({ cost_only: "1" }),
    });
    await store.replaceHoldings("cost-nohome", [{
      security_id: ${JSON.stringify(MISSING)},
      label: "9.10% TEST MISSING BOND 15 May 2031",
      category: "bond",
      quantity: 10,
      cost_paise: ${COST},
      purchase_date: "2025-05-15",
    }], "2026-10-31");
  }

  go("assets");
  await sleep(1000);

  const body = document.body.textContent;
  if (body.includes("Merge into the demat")) {
    throw new Error("the old Merge into the demat copy is still on the page");
  }
  if (body.includes("Cost records (")) {
    throw new Error("the old Cost records disclosure is still on the page");
  }

  const section = document.querySelector(".cost-task");
  const allAccounts = await store.listAccounts();
  const costCount = allAccounts.filter((account) => {
    try { return !!JSON.parse(account.meta || "{}").cost_only; } catch (e) { return false; }
  }).length;
  const listed = allAccounts.length - costCount;
  const heroWant = "Across " + listed + " asset" + (listed === 1 ? "" : "s");
  const heroLabel = document.querySelector(".hero .lbl")?.textContent.trim() || "";
  if (heroLabel !== heroWant) {
    throw new Error("the hero says " + heroLabel + ", want " + heroWant);
  }
  const state = {
    scene: ${JSON.stringify(scene)},
    width: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    oldMerge: body.includes("Merge into the demat"),
    oldDisclosure: body.includes("Cost records ("),
    section: !!section,
    line: "", items: 0, buttons: [], insideCard: false, insideRow: false,
    hasAmount: false, hasCheckbox: false,
    buttonRight: 0,
  };
  if (section) {
    state.line = section.querySelector(".cost-task-line")?.textContent
      .replace(/\\s+/g, " ").trim() || "";
    state.items = section.querySelectorAll(".cost-task-item").length;
    state.buttons = [...section.querySelectorAll("button")]
      .map((button) => button.textContent.replace(/\\s+/g, " ").trim());
    state.insideCard = !!section.closest(".card");
    state.insideRow = !!section.closest(".srow");
    state.hasAmount = !!section.querySelector(".amt, .vl");
    state.hasCheckbox = !!section.querySelector('input[type="checkbox"]');
    const first = section.querySelector("button");
    state.buttonRight = first
      ? Math.round(first.getBoundingClientRect().right) : 0;
  }

  const itemFor = (name) => [...document.querySelectorAll(".cost-task-item")]
    .find((item) => item.textContent.includes(name));

  if (${JSON.stringify(scene)} === "attached") {
    if (section) throw new Error("an all-attached page still shows a cost task");
    go("home");
    await sleep(900);
    const chips = document.querySelector(".hero .chips")?.textContent || "";
    if (!chips.includes(" of " + listed + " assets valued")) {
      throw new Error("Home still counts a cost record: " + chips);
    }
    go("assets");
    await sleep(900);
  } else if (${JSON.stringify(scene)} === "orphan") {
    if (!section) throw new Error("the orphan has no cost task");
    if (state.line !== "A cost record has no account. It holds what you paid, so the gain can be shown.") {
      throw new Error("the singular line says " + state.line);
    }
    if (state.items !== 1) throw new Error(state.items + " cost task items, want 1");
    if (state.buttons.length !== 1) {
      throw new Error(state.buttons.length + " cost task buttons, want 1");
    }
    if (state.buttons[0] !== "Attach to " + ${JSON.stringify(DEMAT_LABEL)}) {
      throw new Error("the action says " + state.buttons[0]);
    }
    if (state.insideCard || state.insideRow || state.hasAmount || state.hasCheckbox) {
      throw new Error("the cost task reads as an asset card or row");
    }

    window.bpAssetSelectToggle();
    await sleep(900);
    if (document.querySelector('.selrow input[data-asset-id="cost-orphan"]')) {
      throw new Error("selection mode drew a tick for the cost record");
    }
    window.bpAssetSel = new Set(["cost-orphan"]);
    go("assets", { keepScroll: true });
    await sleep(900);
    const del = document.getElementById("asset-bulk-delete");
    if (!del) throw new Error("the selection bar is missing");
    if (!del.disabled) throw new Error("a forged cost-record id enabled Delete");
    if (del.textContent.replace(/\\s+/g, " ").trim() !== "Delete") {
      throw new Error("the selection bar says " + del.textContent);
    }
    window.bpAssetSelectOff();
    await sleep(900);
  } else if (${JSON.stringify(scene)} === "attach") {
    if (!section) throw new Error("the attach state lost its cost task");
    const button = section.querySelector(".btn");
    if (!button) throw new Error("the attach action is missing");
    button.click();
    await sleep(1500);
    const after = await store.listAccounts();
    const orphan = after.find((account) => account.id === "cost-orphan");
    if (!orphan) throw new Error("the attach deleted the cost record");
    const meta = JSON.parse(orphan.meta || "{}");
    if (meta.linked_asset !== ${JSON.stringify(DEMAT_ID)}) {
      throw new Error("the record links to " + String(meta.linked_asset));
    }
    if (meta.linked_label !== ${JSON.stringify(DEMAT_LABEL)}) {
      throw new Error("the record says " + String(meta.linked_label));
    }
    if (!after.some((account) => account.id === "cost-attached")) {
      throw new Error("the attach removed an unrelated cost record");
    }
    const positions = await store.listHoldings(${JSON.stringify(DEMAT_ID)});
    const row = positions.find((holding) => holding.security_id === ${JSON.stringify(ISIN)});
    if (!row || Number(row.cost_paise) !== ${COST}) {
      throw new Error("the demat did not take the cost: " + JSON.stringify(row?.cost_paise));
    }
    if (document.querySelector(".cost-task")) {
      throw new Error("the cost task survived the attach");
    }
    await window.bpAttachCostRecord("cost-orphan", ${JSON.stringify(DEMAT_ID)});
    await sleep(600);
    const again = (await store.listHoldings(${JSON.stringify(DEMAT_ID)}))
      .find((holding) => holding.security_id === ${JSON.stringify(ISIN)});
    if (!again || Number(again.cost_paise) !== ${COST}) {
      throw new Error("the second attach changed the cost: "
        + JSON.stringify(again && again.cost_paise));
    }
    state.afterAttach = true;
  } else if (${JSON.stringify(scene)} === "split") {
    const item = itemFor("TEST SPLIT COST PORTFOLIO");
    if (!item) throw new Error("the split record has no cost task");
    const button = item.querySelector(".btn");
    if (!button || !button.textContent.startsWith("Attach to ")) {
      throw new Error("the split record has no named attach");
    }
    button.click();
    await sleep(1800);
    const after = await store.listAccounts();
    const record = after.find((account) => account.id === "cost-split");
    if (!record) throw new Error("the split attach deleted the cost record");
    const meta = JSON.parse(record.meta || "{}");
    if (meta.linked_asset !== ${JSON.stringify(DEMAT_ID)}) {
      throw new Error("the split record links to " + String(meta.linked_asset));
    }
    if (!String(meta.linked_label).includes("SPLIT TWO")) {
      throw new Error("the split record says " + String(meta.linked_label));
    }
    const one = (await store.listHoldings(${JSON.stringify(DEMAT_ID)}))
      .find((holding) => holding.security_id === ${JSON.stringify(ISIN)});
    const two = (await store.listHoldings(${JSON.stringify(SPLIT_DEMAT_ID)}))
      .find((holding) => holding.security_id === ${JSON.stringify(SPLIT_ISIN)});
    if (Number(one?.cost_paise) !== ${COST}) {
      throw new Error("the first demat did not take the cost: "
        + JSON.stringify(one?.cost_paise));
    }
    if (Number(two?.cost_paise) !== ${SPLIT_COST}) {
      throw new Error("the second demat did not take the cost: "
        + JSON.stringify(two?.cost_paise));
    }
    if (itemFor("TEST SPLIT COST PORTFOLIO")) {
      throw new Error("the split task survived the attach");
    }
    state.splitAfter = true;
  } else if (${JSON.stringify(scene)} === "named-empty") {
    const item = itemFor("TEST NAMED EMPTY COST PORTFOLIO");
    if (!item) throw new Error("the named-empty record has no cost task");
    if (!item.textContent.includes("No demat account holds its bonds.")) {
      throw new Error("the named-empty record claimed a demat home");
    }
    const buttons = [...item.querySelectorAll(".btn")]
      .map((button) => button.textContent.replace(/\\s+/g, " ").trim());
    if (buttons.length !== 1 || buttons[0] !== "Import a CAS") {
      throw new Error("the named-empty action is " + buttons.join(" | "));
    }
    if (buttons.some((text) => text.startsWith("Attach to "))) {
      throw new Error("a named-empty record still offers an attach");
    }
    state.namedEmpty = true;
  } else if (${JSON.stringify(scene)} === "nohome") {
    if (!section) throw new Error("the no-home record has no cost task");
    if (!section.textContent.includes("No demat account holds its bonds.")) {
      throw new Error("the no-home line is missing");
    }
    if (state.buttons.length !== 1 || state.buttons[0] !== "Import a CAS") {
      throw new Error("the no-home action is " + state.buttons.join(" | "));
    }
    if (state.buttons.some((text) => text.startsWith("Attach to "))) {
      throw new Error("a no-home record still offers an attach");
    }
  } else if (${JSON.stringify(scene)} === "plural") {
    if (!section) throw new Error("the plural state has no cost task");
    if (state.line !== "2 cost records have no account. They hold what you paid, so the gain can be shown.") {
      throw new Error("the plural line says " + state.line);
    }
    if (state.items !== 2) throw new Error(state.items + " cost task items, want 2");
    if (state.buttons.length !== 2) {
      throw new Error(state.buttons.length + " cost task buttons, want 2");
    }
    if (!state.buttons.some((text) => text === "Attach to " + ${JSON.stringify(DEMAT_LABEL)})) {
      throw new Error("the plural state lost the named account");
    }
    if (!state.buttons.includes("Import a CAS")) {
      throw new Error("the plural state lost the Import a CAS step");
    }
  }

  const live = document.querySelector(".cost-task");
  state.sectionAfter = !!live;
  if (live) {
    live.scrollIntoView({ block: "center" });
    await sleep(250);
  } else {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(250);
  }
  return JSON.stringify(state);
})();`;
}

const SHOTS = [
  { scene: "attached", width: 390, height: 844, theme: "light" },
  { scene: "attached", width: 390, height: 844, theme: "dark" },
  { scene: "attached", width: 1280, height: 900, theme: "light" },
  { scene: "attached", width: 1280, height: 900, theme: "dark" },
  { scene: "orphan", width: 390, height: 844, theme: "light" },
  { scene: "orphan", width: 390, height: 844, theme: "dark" },
  { scene: "orphan", width: 1280, height: 900, theme: "light" },
  { scene: "orphan", width: 1280, height: 900, theme: "dark" },
  { scene: "attach", width: 390, height: 844, theme: "light" },
  { scene: "attach", width: 1280, height: 900, theme: "light" },
  { scene: "nohome", width: 390, height: 844, theme: "light" },
  { scene: "nohome", width: 390, height: 844, theme: "dark" },
  { scene: "nohome", width: 1280, height: 900, theme: "light" },
  { scene: "nohome", width: 1280, height: 900, theme: "dark" },
  { scene: "plural", width: 390, height: 844, theme: "light" },
  { scene: "plural", width: 1280, height: 900, theme: "light" },
  { scene: "split", width: 390, height: 844, theme: "light" },
  { scene: "split", width: 1280, height: 900, theme: "light" },
  { scene: "named-empty", width: 390, height: 844, theme: "light" },
  { scene: "named-empty", width: 1280, height: 900, theme: "light" },
];

function parseArgs(argv) {
  const args = { outDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-cost-records: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-cost-records: --out-dir needs a value");
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
  throw new Error("render-cost-records: web/server.mjs did not answer.");
}

function report(state, shot) {
  const where = `${shot.scene} ${shot.width} ${shot.theme}`;
  if (state.width !== shot.width) {
    throw new Error(`render-cost-records (${where}): asked for ${shot.width}px, `
      + `got ${state.width}px`);
  }
  if (state.overflow) {
    throw new Error(`render-cost-records (${where}): the page scrolls sideways`);
  }
  if (state.oldMerge || state.oldDisclosure) {
    throw new Error(`render-cost-records (${where}): old copy is still on the page`);
  }
  if (state.section) {
    console.log(`${where}: "${state.line}" · ${state.items} task(s) · `
      + `${state.buttons.join(" | ")}`);
    if (state.buttonRight > state.width) {
      throw new Error(`render-cost-records (${where}): the action reaches `
        + `${state.buttonRight}px past ${state.width}px`);
    }
  } else {
    console.log(`${where}: no cost task`);
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

const outDir = args.outDir || mkdtempSync(join(tmpdir(), "bankpipe-cost-records-"));
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-cost-records-script-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.scene}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript(shot));
    const out = join(outDir,
      `cost-records-${shot.scene}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 1200, scale: 1,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    report(JSON.parse(result.value), shot);
    console.log(out);
  }
  console.log("cost records: a task only while unattached · named attach · "
    + "no-home Import a CAS · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
