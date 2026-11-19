#!/usr/bin/env node
// The locked PDF row after a wrong password: the field stays in the row, the
// retry is the primary action, Remove is the secondary, and the page line never
// repeats the sentence. Four wrong attempts still leave the fifth open.
//
// Drops web/fixtures/import/pdf/locked-synthetic.pdf through the page's own
// inbox, so the real reader and the real row are what is checked. Every name
// here is synthetic.
//
//   node scripts/render-import-password.mjs [--out-dir build/renders]

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

const HELPERS = `
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const waitFor = async (read, label) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const value = read();
      if (value) return value;
      await sleep(50);
    }
    throw new Error("timed out waiting for " + label);
  };
  const entryOf = () => (window.bpImportInbox.entries || [])
    .find((item) => item.name === "cdsl-cas-locked-synthetic.pdf");
  const row = () => [...document.querySelectorAll("#import-inbox-host .import-row")]
    .find((item) => text(item.querySelector(".import-row-name"))
      .includes("cdsl-cas-locked-synthetic.pdf"));
  const field = () => row()?.querySelector(".import-row-pw input[type=password]");
  const primary = () => [...(row()?.querySelectorAll(".btn") || [])]
    .find((button) => /^(Unlock|Try the password again)$/.test(text(button)));
  const pill = () => text(row()?.querySelector(".import-row-pill"));
  const dropLocked = async () => {
    const bytes = new Uint8Array(await (await fetch(
      "fixtures/import/pdf/locked-synthetic.pdf")).arrayBuffer());
    window.bpImportInbox.entries.length = 0;
    window.bpImportInboxAdd([
      new File([bytes], "cdsl-cas-locked-synthetic.pdf", { type: "application/pdf" }),
    ]).catch(() => {});
    await waitFor(field, "the inline password field");
  };
  const guess = async (password) => {
    const input = await waitFor(field, "the password field");
    input.value = password;
    primary().click();
    await sleep(350);
    await waitFor(() => {
      const entry = entryOf();
      return entry && entry.status === "locked" && field();
    }, "the row to keep its field after a wrong password");
    return {
      field: !!field(),
      pill: pill(),
      primary: text(primary()),
      message: row()?.querySelector(".import-row-note.error")?.textContent?.trim() || "",
    };
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
    attempts.push(await guess(${JSON.stringify(WRONG)}));
  }
  const entry = entryOf();
  const input = field();
  document.querySelector(".import-queue-card")?.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify({
    attempts: attempts.length,
    everyAttemptHadAField: attempts.every((item) => item.field),
    everyAttemptSaidRetry: attempts.every((item) => item.primary === "Try the password again"),
    entries: (window.bpImportInbox.entries || [])
      .filter((item) => item.name === "cdsl-cas-locked-synthetic.pdf").length,
    status: entry.status,
    message: entry.error,
    pill: pill(),
    input: !!input,
    hint: text(row()?.querySelector(".import-row-pw .import-row-note")).split(" · ")[0],
    pageLine: document.getElementById("import-inbox-status").textContent.trim(),
    actions: [...row().querySelectorAll(".import-row-pw .btn")].map(text).join(" | "),
  });
`;

const UNLOCK_BODY = `
  await dropLocked();
  await guess(${JSON.stringify(WRONG)});
  await waitFor(() => entryOf().status === "locked" && field(), "the locked row");
  const input = field();
  input.value = ${JSON.stringify(RIGHT)};
  primary().click();
  await waitFor(() => {
    const entry = entryOf();
    return entry && entry.status !== "locked" && entry.status !== "reading"
      && entry.status !== "queued";
  }, "the re-read of the unlocked file");
  document.querySelector(".import-queue-card")?.scrollIntoView({ block: "start" });
  window.scrollBy(0, -70);
  return JSON.stringify({
    entries: (window.bpImportInbox.entries || [])
      .filter((item) => item.name === "cdsl-cas-locked-synthetic.pdf").length,
    status: entryOf().status,
    locked: entryOf().status === "locked",
    fieldGone: !field(),
  });
`;

const CHECKS = {
  attempts: 4,
  everyAttemptHadAField: true,
  everyAttemptSaidRetry: true,
  entries: 1,
  status: "locked",
  message: PDF_PASSWORD_WRONG,
  pill: "Needs password",
  input: true,
  hint: "Usually your PAN in capitals",
  pageLine: "",
  actions: "Try the password again | Remove",
};

const UNLOCK_CHECKS = {
  entries: 1,
  status: "error",
  locked: false,
  fieldGone: true,
};

const SHOTS = [
  { width: 390, height: 1200, theme: "dark" },
  { width: 390, height: 1200, theme: "light" },
  { width: 1280, height: 1000, theme: "dark" },
  { width: 1280, height: 1000, theme: "light" },
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
    width: 390, height: 1200, theme: "light",
  });
  verify(JSON.parse(unlocked.value), UNLOCK_CHECKS, "the unlocked retry");
  console.log(unlockedOut);
  console.log("password: 4 wrong guesses, the field stays · retry primary · Remove secondary");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
