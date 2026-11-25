import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Settings is one renderer in index.html. These checks pin the behavior the
// maintenance-card move must hold: backup and restore stays first, the
// maintenance capabilities keep their handlers, and the three report/legacy
// tools sit under one closed Advanced disclosure at the bottom.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

const settings = () => between("function renderSettings", "function flowMonthLabel");

const at = (text, label) => {
  const index = text.indexOf(label);
  assert.ok(index >= 0, `${label} is in Settings`);
  return index;
};

test("Settings keeps Backup and restore first and the rest of its cards in order", () => {
  const page = settings();
  const order = [
    "Backup and restore",
    "Light or dark",
    "This device",
    "Erase this browser's data",
    "Bank logins",
    "What is local and what is not",
    "About",
  ];
  const positions = order.map((label) => at(page, label));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions,
    `Settings card order changed: ${order.join(" → ")}`);
});

test("the three maintenance tools sit under one closed Advanced disclosure at the bottom", () => {
  const page = settings();
  const start = page.indexOf('<details class="adv settings-advanced">');
  assert.ok(start > at(page, "About"), "Advanced comes after About");
  const end = page.indexOf("</details>", start);
  assert.ok(end > start, "the Advanced disclosure closes");
  const advanced = page.slice(start, end);

  assert.match(advanced, /<summary>Advanced<\/summary>/);
  assert.equal(/\bopen\b/.test(advanced.split(">")[0]), false,
    "Advanced is closed by default");
  assert.match(advanced, /Maintenance tools for whoever keeps BankPipe/);

  const order = ["Audit data", "Diagnostics", "Workbook metadata"];
  const positions = order.map((label) => at(advanced, label));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions,
    `Advanced contents changed: ${order.join(" → ")}`);
  assert.equal((advanced.match(/id="legacy-meta"/g) || []).length, 1,
    "workbook metadata has one file input");
});

test("Verify an import is gone with its page, route and handlers", () => {
  assert.equal(html.includes("Verify an import"), false);
  assert.equal(html.includes("Verify import"), false);
  assert.equal(html.includes("renderVerify"), false);
  assert.equal(html.includes("bpVerify"), false);
  assert.equal(html.includes("verifyWorkbook"), false);
  assert.equal(html.includes("wireVerify"), false);
  assert.equal(html.includes("go('verify')"), false);
});

test("the maintenance capabilities keep a handler", () => {
  assert.match(html, /window\.bpDownloadAppAudit = async/);
  assert.match(html, /window\.bpDownloadDiagnostics = \(\)/);
  assert.match(html, /window\.bpStoreLegacyMeta = async/);
});
