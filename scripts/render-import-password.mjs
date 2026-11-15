#!/usr/bin/env node
// The inbox entry after a wrong PDF password: "Try the password again" as the
// primary action, Remove as a secondary button beside it, and no attempt limit.
//
// Drops web/fixtures/import/pdf/locked-synthetic.pdf through the page's own
// inbox, types a wrong password four times through the real gate, and fails
// unless the fifth attempt is still offered. A second pass unlocks once to prove
// the same entry is re-read instead of duplicated.
//
//   node scripts/render-import-password.mjs [--out-dir build/renders]
//
// Writes four screenshots: 390 and 1280, light and dark. Synthetic data only.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { PDF_PASSWORD_WRONG } from "../web/import-password.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-password.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const WRONG = "not-the-password";
const RIGHT = "Synthetic1";
const PAGE_LINE = PDF_PASSWORD_WRONG;

const HELPERS = `
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const waitFor = async (read, label) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const value = read();
      if (value) return value;
      await sleep(50);
    }
    throw new Error("timed out waiting for " + label);
  };
  const gate = () => document.getElementById("import-inbox-pw");
  const gateGo = () => document.getElementById("import-inbox-pw-go");
  const retryButton = () => [...document.querySelectorAll("#import-inbox-host .btn")]
    .find((button) => button.textContent.trim() === "Try the password again");
  const entryCard = () => [...document.querySelectorAll("#import-inbox-host .import-wrong")]
    .find((card) => card.querySelector("b")?.textContent.includes("locked-synthetic.pdf"));
  const entryOf = () => (window.bpImportInbox.entries || [])
    .find((item) => item.name === "locked-synthetic.pdf");
  const dropLocked = async () => {
    const bytes = new Uint8Array(await (await fetch(
      "fixtures/import/pdf/locked-synthetic.pdf")).arrayBuffer());
    window.bpImportInboxAdd([
      new File([bytes], "locked-synthetic.pdf", { type: "application/pdf" }),
    ]).catch(() => {});
    await waitFor(gate, "the first password prompt");
  };
  const guess = async (password) => {
    gate().value = password;
    gateGo().click();
    await sleep(250);
  };
  // One wrong guess, through the gate if it is open or through the entry's own
  // retry action if the reader has handed control back.
  const wrongAttempt = async (attempt) => {
    if (!gate()) {
      const retry = await waitFor(retryButton, "the retry action before attempt " + attempt);
      retry.click();
      await waitFor(gate, "the password prompt before attempt " + attempt);
    }
    await guess(${JSON.stringify(WRONG)});
    const open = Boolean(gate());
    const retry = Boolean(retryButton());
    if (!open && !retry) {
      throw new Error("no way to try again after wrong attempt " + attempt);
    }
    const nextHeading = open
      ? (document.querySelector("#import-inbox-gate .import-password b")
        ?.textContent.trim() || "")
      : "";
    return { open, retry, nextHeading };
  };
`;

function pageScript(body) {
  return `(async () => {
  ${HELPERS}
  go("import");
  await sleep(800);
  await waitFor(() => document.getElementById("import-inbox-files"), "the inbox");
  ${body}
})()`;
}

const WRONG_BODY = `
  await dropLocked();
  const attempts = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    attempts.push(await wrongAttempt(attempt));
  }
  await waitFor(() => {
    const entry = entryOf();
    return entry && entry.status === "locked"
      && !document.getElementById("import-inbox-status").textContent.trim();
  }, "the locked entry with a quiet page line");

  const card = entryCard();
  if (!card) throw new Error("the locked entry card is missing");
  const buttons = [...card.querySelectorAll(".import-actions .btn")];
  const primary = card.querySelector(".import-actions .btn.primary");
  const remove = buttons.find((button) => button.textContent.trim() === "Remove");
  if (window.innerWidth >= 720) {
    document.getElementById("import-inbox-host").scrollIntoView({ block: "start" });
    window.scrollBy(0, -70);
  } else {
    card.scrollIntoView({ block: "center" });
  }

  return JSON.stringify({
    attempts: attempts.length,
    everyAttemptHadAWay: attempts.every((item) => item.open || item.retry),
    repromptHeadings: attempts.filter((item) => item.open)
      .map((item) => item.nextHeading).join(" | "),
    entries: (window.bpImportInbox.entries || [])
      .filter((item) => item.name === "locked-synthetic.pdf").length,
    status: entryOf().status,
    message: card.querySelector(".muted")?.textContent.trim() || "",
    primary: primary?.textContent.trim() || "",
    primaryClass: primary?.className || "",
    removeClass: remove?.className || "",
    actions: buttons.map((button) => button.textContent.trim()).join(" | "),
    pageLine: document.getElementById("import-inbox-status").textContent.trim(),
    gateOpen: Boolean(gate()),
    retryOffered: Boolean(retryButton()),
  });
`;

const UNLOCK_BODY = `
  await dropLocked();
  await wrongAttempt(1);
  await wrongAttempt(2);
  await waitFor(() => !gate() && retryButton(), "the locked entry");
  retryButton().click();
  await waitFor(gate, "the retry prompt");
  await guess(${JSON.stringify(RIGHT)});
  await waitFor(() => {
    const entry = entryOf();
    return entry && entry.status !== "locked" && entry.status !== "reading"
      && entry.status !== "queued";
  }, "the re-read of the unlocked file");

  const entry = entryOf();
  entryCard()?.scrollIntoView({ block: "center" });
  return JSON.stringify({
    entries: (window.bpImportInbox.entries || [])
      .filter((item) => item.name === "locked-synthetic.pdf").length,
    status: entry.status,
    locked: entry.status === "locked",
    retryGone: !retryButton(),
    message: entry.error || "",
  });
`;

const CHECKS = {
  attempts: 4,
  everyAttemptHadAWay: true,
  repromptHeadings: "Try the password again | Try the password again",
  entries: 1,
  status: "locked",
  message: PAGE_LINE,
  primary: "Try the password again",
  primaryClass: "btn primary",
  removeClass: "btn",
  actions: "Try the password again | Remove",
  pageLine: "",
  gateOpen: false,
  retryOffered: true,
};

const UNLOCK_CHECKS = {
  entries: 1,
  status: "error",
  locked: false,
  retryGone: true,
};

const SHOTS = [
  { width: 390, height: 900, theme: "dark" },
  { width: 390, height: 900, theme: "light" },
  { width: 1280, height: 900, theme: "dark" },
  { width: 1280, height: 900, theme: "light" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-password: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-password: --out-dir needs a value");
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
  throw new Error("render-import-password: web/server.mjs did not answer.");
}

function verify(state, checks, label) {
  const wrong = Object.entries(checks)
    .filter(([key, want]) => state[key] !== want)
    .map(([key, want]) => `${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(state[key])}`);
  if (wrong.length) {
    throw new Error(`render-import-password: ${label} is not the state that was asked for.\n  `
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

const dir = mkdtempSync(join(tmpdir(), "bankpipe-password-"));
const wrongScript = join(dir, "wrong.js");
const unlockScript = join(dir, "unlock.js");
writeFileSync(wrongScript, pageScript(WRONG_BODY));
writeFileSync(unlockScript, pageScript(UNLOCK_BODY));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const out = join(args.outDir, `import-password-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script: wrongScript, wait: 2200,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    verify(JSON.parse(result.value), CHECKS, `${shot.width} ${shot.theme}`);
    console.log(out);
  }
  const unlockedOut = join(args.outDir, "import-password-unlocked-390-light.png");
  const unlocked = await capture({
    page, out: unlockedOut, script: unlockScript, wait: 2200,
    width: 390, height: 900, theme: "light",
  });
  verify(JSON.parse(unlocked.value), UNLOCK_CHECKS, "the unlocked retry");
  console.log(unlockedOut);
  console.log("password: 4 wrong guesses, retry still offered · "
    + "primary Try the password again · secondary Remove · page line quiet");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
