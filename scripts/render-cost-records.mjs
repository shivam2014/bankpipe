#!/usr/bin/env node
// The orphan cost record is a task on the bond portfolio it names, not on the
// Assets list. This renders the Assets page without the task, the portfolio
// page with it, the no-demat state that keeps Import a CAS, and the attached
// state that renders nothing. Synthetic rows only, under 9999.
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
const ORPHAN_ID = "cost-orphan";
const ORPHAN_LABEL = "Bonds · portfolio 2";
const NOHOME_ID = "cost-nohome";
const NOHOME_LABEL = "Bonds · portfolio 3";
const ATTACHED_ID = "cost-attached";
const ATTACHED_LABEL = "Bonds · portfolio 1";

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

  await store.createAccount({
    id: ${JSON.stringify(ATTACHED_ID)},
    label: ${JSON.stringify(ATTACHED_LABEL)},
    category: "bonds",
    subtype: "bond",
    meta: JSON.stringify({ cost_only: "1", linked_asset: ${JSON.stringify(DEMAT_ID)},
      linked_label: ${JSON.stringify(DEMAT_LABEL)} }),
  });
  await store.replaceHoldings(${JSON.stringify(ATTACHED_ID)}, [{
    security_id: ${JSON.stringify(ISIN)},
    label: "9.10% TEST COST BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: ${COST},
    purchase_date: "2025-05-15",
  }], "2026-10-31");

  await store.createAccount({
    id: ${JSON.stringify(ORPHAN_ID)},
    label: ${JSON.stringify(ORPHAN_LABEL)},
    category: "bonds",
    subtype: "bond",
    meta: JSON.stringify({ cost_only: "1" }),
  });
  await store.replaceHoldings(${JSON.stringify(ORPHAN_ID)}, [{
    security_id: ${JSON.stringify(ISIN)},
    label: "9.10% TEST COST BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: ${COST},
    purchase_date: "2025-05-15",
  }], "2026-10-31");

  await store.createAccount({
    id: ${JSON.stringify(NOHOME_ID)},
    label: ${JSON.stringify(NOHOME_LABEL)},
    category: "bonds",
    subtype: "bond",
    meta: JSON.stringify({ cost_only: "1" }),
  });
  await store.replaceHoldings(${JSON.stringify(NOHOME_ID)}, [{
    security_id: ${JSON.stringify(MISSING)},
    label: "9.20% TEST MISSING BOND 15 May 2031",
    category: "bond",
    quantity: 10,
    cost_paise: ${COST},
    purchase_date: "2025-05-15",
  }], "2026-10-31");

  const labels = {
    orphan: ${JSON.stringify(ORPHAN_LABEL)},
    nohome: ${JSON.stringify(NOHOME_LABEL)},
    attached: ${JSON.stringify(ATTACHED_LABEL)},
  };
  const state = {
    scene: ${JSON.stringify(scene)},
    width: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    notice: false, line: "", buttons: [], links: 0, aboveCards: false,
    insideCard: false, insideRow: false, tasks: 0,
  };
  const checkNoTask = (where) => {
    if (document.querySelector(".cost-task")) {
      throw new Error("the cost task still renders on " + where);
    }
  };
  const readNotice = () => {
    const section = document.querySelector(".cost-task");
    if (!section) return null;
    const cards = document.querySelector(".bond-cards");
    return {
      section,
      line: section.querySelector(".cost-task-line")?.textContent
        .replace(/\\s+/g, " ").trim() || "",
      buttons: [...section.querySelectorAll("button")]
        .map((button) => button.textContent.replace(/\\s+/g, " ").trim()),
      links: section.querySelectorAll("a").length,
      aboveCards: !!(cards && (section.compareDocumentPosition(cards)
        & Node.DOCUMENT_POSITION_FOLLOWING)),
      insideCard: !!section.closest(".card"),
      insideRow: !!section.closest(".srow"),
      tasks: document.querySelectorAll(".cost-task").length,
    };
  };
  const take = (seen) => {
    if (!seen) return;
    state.notice = true;
    state.line = seen.line;
    state.buttons = seen.buttons;
    state.links = seen.links;
    state.aboveCards = seen.aboveCards;
    state.insideCard = seen.insideCard;
    state.insideRow = seen.insideRow;
    state.tasks = seen.tasks;
    seen.section.scrollIntoView({ block: "center" });
  };
  const open = async (id) => {
    window.bpAsset(id);
    await sleep(1400);
  };

  if (${JSON.stringify(scene)} === "assets" || ${JSON.stringify(scene)} === "plural") {
    go("assets");
    await sleep(1100);
    checkNoTask("Assets");
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
    state.hero = heroLabel;
  }
  if (${JSON.stringify(scene)} === "orphan") {
    await open(${JSON.stringify(ORPHAN_ID)});
    take(readNotice());
    if (!state.notice) throw new Error("the orphan's portfolio page has no notice");
    if (state.line !== "A cost record has no account. It holds what you paid, so the gain can be shown.") {
      throw new Error("the notice says " + state.line);
    }
    if (state.tasks !== 1) throw new Error(state.tasks + " notices, want 1");
    if (state.buttons.length !== 1) {
      throw new Error(state.buttons.length + " notice buttons, want 1");
    }
    if (state.buttons[0] !== "Attach to " + ${JSON.stringify(DEMAT_LABEL)}) {
      throw new Error("the action says " + state.buttons[0]);
    }
    if (state.links) throw new Error("the notice still links to the record it is on");
    if (!state.aboveCards) throw new Error("the notice is not above the bond cards");
    if (state.insideCard || state.insideRow) {
      throw new Error("the notice reads as an asset card or row");
    }
  }
  if (${JSON.stringify(scene)} === "nohome") {
    await open(${JSON.stringify(NOHOME_ID)});
    take(readNotice());
    if (!state.notice) throw new Error("the no-home portfolio has no notice");
    if (!state.line.startsWith("A cost record has no account.")) {
      throw new Error("the notice says " + state.line);
    }
    if (!document.querySelector(".cost-task")?.textContent
      .includes("No demat account holds its bonds.")) {
      throw new Error("the no-home sentence is missing");
    }
    if (state.buttons.length !== 1 || state.buttons[0] !== "Import a CAS") {
      throw new Error("the no-home action is " + state.buttons.join(" | "));
    }
    if (!state.aboveCards) throw new Error("the notice is not above the bond cards");
  }
  if (${JSON.stringify(scene)} === "attached") {
    await open(${JSON.stringify(ATTACHED_ID)});
    checkNoTask("an attached cost record");
    window.scrollTo(0, 0);
  }
  if (${JSON.stringify(scene)} === "plural") {
    await open(${JSON.stringify(ORPHAN_ID)});
    const first = readNotice();
    if (!first || first.buttons[0] !== "Attach to " + ${JSON.stringify(DEMAT_LABEL)}) {
      throw new Error("the first record lost its own attach");
    }
    await open(${JSON.stringify(NOHOME_ID)});
    const second = readNotice();
    if (!second || second.buttons[0] !== "Import a CAS") {
      throw new Error("the second record lost its own Import a CAS");
    }
    if (document.querySelectorAll(".cost-task").length !== 1) {
      throw new Error("a portfolio page shows more than its own notice");
    }
    state.notice = true;
    state.line = "each orphan page shows only its own task";
    state.buttons = [first.buttons[0], second.buttons[0]];
    state.tasks = 1;
    state.plural = true;
  }
  if (${JSON.stringify(scene)} === "attach") {
    await open(${JSON.stringify(ORPHAN_ID)});
    const button = document.querySelector(".cost-task button");
    if (!button) throw new Error("the attach action is missing");
    button.click();
    await sleep(2200);
    const after = await store.listAccounts();
    const orphan = after.find((account) => account.id === ${JSON.stringify(ORPHAN_ID)});
    if (!orphan) throw new Error("the attach deleted the cost record");
    const meta = JSON.parse(orphan.meta || "{}");
    if (meta.linked_asset !== ${JSON.stringify(DEMAT_ID)}) {
      throw new Error("the record links to " + String(meta.linked_asset));
    }
    const positions = await store.listHoldings(${JSON.stringify(DEMAT_ID)});
    const row = positions.find((holding) => holding.security_id === ${JSON.stringify(ISIN)});
    if (!row || Number(row.cost_paise) !== ${COST}) {
      throw new Error("the demat did not take the cost: " + JSON.stringify(row?.cost_paise));
    }
    checkNoTask("the portfolio page after attaching");
    state.afterAttach = true;
  }
  if (${JSON.stringify(scene)} === "import") {
    await open(${JSON.stringify(NOHOME_ID)});
    const button = document.querySelector(".cost-task button");
    if (!button || button.textContent.trim() !== "Import a CAS") {
      throw new Error("the Import a CAS action is missing");
    }
    button.click();
    await sleep(1200);
    const title = document.querySelector("h1")?.textContent.trim() || "";
    if (title !== "Import") throw new Error("the action opened " + title);
    state.imported = true;
  }

  if (!state.notice && ${JSON.stringify(scene)} !== "attach"
    && ${JSON.stringify(scene)} !== "import") {
    window.scrollTo(0, 0);
  }
  return JSON.stringify(state);
})()`;
}

const SHOTS = [
  { scene: "assets", width: 390, height: 844, theme: "light" },
  { scene: "assets", width: 390, height: 844, theme: "dark" },
  { scene: "assets", width: 1280, height: 900, theme: "light" },
  { scene: "assets", width: 1280, height: 900, theme: "dark" },
  { scene: "orphan", width: 390, height: 844, theme: "light" },
  { scene: "orphan", width: 390, height: 844, theme: "dark" },
  { scene: "orphan", width: 1280, height: 900, theme: "light" },
  { scene: "orphan", width: 1280, height: 900, theme: "dark" },
  { scene: "nohome", width: 390, height: 844, theme: "light" },
  { scene: "nohome", width: 390, height: 844, theme: "dark" },
  { scene: "nohome", width: 1280, height: 900, theme: "light" },
  { scene: "attached", width: 390, height: 844, theme: "light" },
  { scene: "plural", width: 390, height: 844, theme: "light" },
  { scene: "attach", width: 390, height: 844, theme: "light" },
  { scene: "import", width: 390, height: 844, theme: "light" },
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
  if (state.notice) {
    console.log(`${where}: "${state.line}" · ${state.buttons.join(" | ")}`);
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
    const script = join(dir, `${shot.scene}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript(shot));
    const out = join(outDir,
      `cost-record-${shot.scene}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 1600,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    report(state, shot);
  }
  console.log("cost records: Assets has no task; a bond portfolio shows only its own "
    + "notice above its bond cards · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
