#!/usr/bin/env node
// The rebuilt Import screen in its six required states, at 390 and 1280, light
// and dark. Every name, ISIN, number and amount here is invented.
//
//   node scripts/render-import-queue.mjs [--out-dir build/renders]
//
// The page's own reader and planner build each state through the public inbox
// state. The script fails when a row is missing, a pill says the wrong thing,
// the bar counts a file that cannot run, a control is under 44px, or the page
// scrolls sideways.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";
import { PDF_PASSWORD_WRONG } from "../web/import-password.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-import-queue.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const AS_OF = "2026-11-12";
const BO = "1200000012348054";
const CLIENT_ID = "AB1234567";
const UNMATCHED_ID = "ZZ9999999";
const isin = (n) => `INE${String(n).padStart(9, "0")}`;

const rows = Array.from({ length: 17 }, (_, at) => ({
  isin: isin(600 + at), label: `TEST EQUITY ${at + 1}`, category: "equity",
  quantity: 10 + at, valuePaise: 100000 * (at + 1), costPaise: null,
  purchaseDate: "", sourceRow: at,
}));

// The owner's file: 28 holdings under a short alphanumeric client id. The id
// is printed whole, never cut to "…T500", because the missing characters are
// what tell this account apart from another.
const rows28 = Array.from({ length: 28 }, (_, at) => ({
  ...rows[at % rows.length], isin: isin(1200 + at),
  label: `TEST EQUITY ${at + 1}`, quantity: 5 + at,
  valuePaise: 100000 * (at + 1), sourceRow: at,
}));

const account = {
  id: "demat-zerodha", label: "Demat · Zerodha · …8054", bank: "Zerodha",
  category: "demat", subtype: "equity", type: "equity", number: BO,
  holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "Zerodha Broking Ltd",
    client_id: CLIENT_ID, holdings_source: "cas", holdings_as_of: "2026-09-30" }),
  rows: [],
};

// A second demat the person may want instead of the automatic match. With
// `overlap`, it already holds ten of the broker file's seventeen ISINs, so the
// consequence after re-pointing is seven new and ten updated.
const hdfcAccount = ({ overlap = true } = {}) => ({
  id: "demat-hdfc", label: "Demat · HDFC · …1111", bank: "HDFC Bank",
  category: "demat", subtype: "equity", type: "equity",
  number: "9999000011111111", holder: "TEST HOLDER",
  meta: JSON.stringify({ depository: "CDSL", dp: "HDFC Bank Ltd",
    holdings_source: "zerodha", holdings_as_of: "2026-09-30",
    identity_source: "zerodha" }),
  rows: overlap ? rows.slice(0, 10).map((row) => ({
    security_id: row.isin, label: row.label, category: "equity",
    quantity: 1, cost_paise: null, value_paise: null, purchase_date: "",
    as_of: "2026-09-30", value_source: "zerodha", source: "zerodha",
  })) : [],
});

// A bond portfolio is an import account but not a depository. A demat snapshot
// cannot land there, so it must never appear in a broker file's change menu.
const bondAccount = {
  id: "bonds-portfolio", label: "Bonds · portfolio 1", bank: "",
  category: "bonds", subtype: "bond", type: "bond", number: "",
  holder: "TEST HOLDER", meta: JSON.stringify({}), rows: [],
};

// The same demat already holds every row the file names, with the same
// quantities and values, so re-pointing to it leaves nothing to import. Its
// label sorts after the Zerodha account, so the automatic match stays there;
// choosing this one is a real re-point.
const fullHdfcAccount = () => ({
  ...hdfcAccount({ overlap: true }),
  label: "Zzz HDFC · …1111",
  meta: JSON.stringify({ depository: "CDSL", dp: "HDFC Bank Ltd",
    holdings_source: "zerodha", holdings_as_of: AS_OF, identity_source: "zerodha",
    client_id: CLIENT_ID }),
  rows: rows.map((row) => ({
    security_id: row.isin, label: row.label, category: "equity",
    quantity: row.quantity, cost_paise: null, value_paise: row.valuePaise,
    purchase_date: "", as_of: AS_OF, value_source: "zerodha", source: "zerodha",
  })),
});

// The automatic match holds the same ISINs with stale quantities, so it has
// work; the Zzz account matches every row exactly and has none.
const staleZerodhaAccount = () => ({
  ...account,
  meta: JSON.stringify({ depository: "CDSL", dp: "Zerodha Broking Ltd",
    client_id: CLIENT_ID, holdings_source: "zerodha", identity_source: "zerodha",
    holdings_as_of: "2026-09-30" }),
  rows: rows.map((row) => ({
    security_id: row.isin, label: row.label, category: "equity",
    quantity: 1, cost_paise: null, value_paise: 1, purchase_date: "",
    as_of: "2026-09-30", value_source: "zerodha", source: "zerodha",
  })),
});

const holding = (over = {}) => ({
  isin: isin(600), label: "TEST EQUITY 1", kind: "equity", quantity: 10,
  valuePaise: 100000, costPaise: null, purchaseDate: "",
  couponPct: null, frequency: "", maturity: "", faceValuePaise: null,
  account: BO, folio: "", amc: "", amcFull: "", ...over,
});

const brokerEntry = (accountKey = CLIENT_ID, entryRows = rows) => ({
  id: `inbox-render-${accountKey}`,
  name: `holdings-${accountKey || "unknown"}.xlsx`, size: 2048, status: "ready",
  kind: "zerodha-holdings", broker: "zerodha", asOf: AS_OF,
  accountKey, accountKind: accountKey ? "client" : "", rows: entryRows,
  firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [], error: "", file: null,
});

// A one-account CAS. The holdings table is what the planner reads; no movement
// rows, so this statement groups with the broker file that lands on the same
// account.
const CAS_HOLDINGS = rows.slice(0, 12).map((row, at) => holding({
  isin: row.isin, label: row.label, quantity: row.quantity,
  valuePaise: row.valuePaise, account: BO,
}));
const casEntry = () => {
  const parsed = {
    depository: "CDSL", demat: BO, asOf: "2026-10-31",
    accounts: [{ boId: BO, dpName: "Zerodha Broking Ltd", holdings: CAS_HOLDINGS }],
    holdings: CAS_HOLDINGS, transactions: [],
    counts: { rows: CAS_HOLDINGS.length, quarantined: 0 },
    printedTotalPaise: CAS_HOLDINGS.reduce((total, row) => total + row.valuePaise, 0),
  };
  return {
    id: "inbox-render-cas", name: "cdsl-cas-oct-2026.pdf", size: 4096,
    status: "ready", kind: "cas", broker: "", asOf: parsed.asOf,
    accountKey: BO, accountKind: "bo",
    rows: CAS_HOLDINGS.map((row) => ({
      isin: row.isin, label: row.label, category: row.kind,
      quantity: row.quantity, valuePaise: row.valuePaise, costPaise: null,
      purchaseDate: "", couponPct: null, frequency: "", maturity: "",
      facePaise: null, account: row.account, folio: "", amc: "", amcFull: "",
      sourceRow: 0,
    })),
    firstBuyByIsin: {}, termsByIsin: [], termsByLabel: [], error: "", parsed,
    casAccounts: parsed.accounts.map((item) => ({
      boId: item.boId, dpName: item.dpName,
      rows: item.holdings.map((row) => ({
        isin: row.isin, label: row.label, category: row.kind,
        quantity: row.quantity, valuePaise: row.valuePaise, costPaise: null,
        purchaseDate: "", couponPct: null, frequency: "", maturity: "",
        facePaise: null, account: row.account, folio: "", amc: "", amcFull: "",
        sourceRow: 0,
      })),
    })),
    file: null,
  };
};

// The row geometry the owner reads: one line for the account name, a 44px
// Change flush with the status pill, every bubble the same height, and no
// empty band before the bar. The checks run on every shot, open or closed.
function importLayoutWrong(state) {
  const wrong = [];
  for (const item of state.accountLines || []) {
    const line = Number.parseFloat(item.lineHeight) || 19;
    // The evidence is its own line by design. The name above it must stay one
    // ellipsized line; measuring the wrapper would count the evidence too.
    const nameHeight = item.nameH || item.h;
    if (nameHeight > line * 1.3 + 0.5) {
      wrong.push(`the account name wraps to ${nameHeight}px at ${state.width}`);
    }
    if (item.whiteSpace !== "nowrap" || item.textOverflow !== "ellipsis") {
      wrong.push(`the account line is not a single ellipsized line at ${state.width}`);
    }
  }
  (state.changeRects || []).forEach((item, index) => {
    if (item.h < 44) wrong.push(`Change is ${item.h}px high at ${state.width}`);
    const pill = (state.pillRights || [])[index];
    if (pill != null && Math.abs(item.right - pill) > 1) {
      wrong.push(`Change right ${item.right} is not flush with the pill ${pill} `
        + `at ${state.width}`);
    }
  });
  if (state.removeBottom != null && state.barTop != null) {
    const gap = state.barTop - state.removeBottom;
    if (gap < 0 || gap > 13) {
      wrong.push(`the gap after Remove is ${gap}px at ${state.width}`);
    }
  }
  const heights = (state.bubbleMetrics || []).map((item) => item.h);
  if (heights.length && Math.max(...heights) - Math.min(...heights) > 1) {
    wrong.push(`bubble heights differ at ${state.width}: ${JSON.stringify(heights)}`);
  }
  if (state.width <= 640) {
    const labels = (state.bubbleMetrics || []).map((item) => item.labelH);
    if (labels.length && Math.max(...labels) - Math.min(...labels) > 1) {
      wrong.push(`bubble labels differ at ${state.width}: ${JSON.stringify(labels)}`);
    }
  }
  const menu = state.menuRows || [];
  if (menu.length) {
    const rows = menu.map((item) => item.h);
    if (Math.min(...rows) < 44) {
      wrong.push(`an option row is under 44px at ${state.width}: ${JSON.stringify(rows)}`);
    }
    if (Math.max(...rows) - Math.min(...rows) > 1) {
      wrong.push(`option rows differ at ${state.width}: ${JSON.stringify(rows)}`);
    }
    const lefts = menu.map((item) => item.hitsLeft).filter((item) => item != null);
    if (lefts.length === menu.length
      && Math.max(...lefts) - Math.min(...lefts) > 1) {
      wrong.push(`the evidence column is ragged at ${state.width}: ${JSON.stringify(lefts)}`);
    }
    const selected = menu.filter((item) => item.selected);
    if (selected.length !== 1) {
      wrong.push(`selected options: ${selected.length} at ${state.width}`);
    } else {
      if (selected[0].check !== "✓") {
        wrong.push(`the selected row has no check at ${state.width}`);
      }
      if (selected[0].badge !== "Current") {
        wrong.push(`the selected badge is ${selected[0].badge} at ${state.width}`);
      }
    }
  }
  if (state.menuLastBottom != null && state.barTop != null) {
    const gap = state.barTop - state.menuLastBottom;
    if (gap < 0 || gap > 13) {
      wrong.push(`the gap after the menu is ${gap}px at ${state.width}`);
    }
  }
  return wrong;
}

const SCENARIOS = [
  {
    name: "empty",
    seed: null,
    entries: [],
    wide: true,
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 0) wrong.push(`rows: ${state.rows}`);
      if (state.cardShown) wrong.push("the empty queue card is on screen");
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (an inert bar is not drawn)`);
      }
      if (state.emptyText !== "") {
        wrong.push(`empty copy: ${JSON.stringify(state.emptyText)}`);
      }
      return wrong;
    },
  },
  {
    name: "one-file",
    seed: account,
    entries: [brokerEntry()],
    wide: true,
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (!state.cardShown) wrong.push("the first file did not bring the queue card back");
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/17 holdings/.test(state.facts[0] || "")) {
        wrong.push(`consequence: ${JSON.stringify(state.facts)}`);
      }
      if (!/Matches Demat · Zerodha · …8054/.test(state.accounts[0] || "")) {
        wrong.push(`account: ${JSON.stringify(state.accounts)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.barDisabled) wrong.push("the ready bar is disabled");
      return wrong;
    },
  },
  {
    name: "cas-one-file",
    seed: account,
    entries: [casEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/NSDL\/CDSL \(CAS\)/.test(state.facts[0] || "")) {
        wrong.push(`the row type is not NSDL/CDSL (CAS): ${JSON.stringify(state.facts)}`);
      }
      if (!/12 holdings/.test(state.facts[0] || "")) {
        wrong.push(`consequence: ${JSON.stringify(state.facts)}`);
      }
      if (!/Matches Demat · Zerodha · …8054/.test(state.accounts[0] || "")) {
        wrong.push(`account: ${JSON.stringify(state.accounts)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "matched-change-open",
    seed: [account, hdfcAccount(), bondAccount],
    entries: [brokerEntry()],
    menu: true,
    wide: true,
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!state.menuItems.some((line) => /Demat · Zerodha · …8054/.test(line)
        && /client ID match/.test(line))) {
        wrong.push(`current account choice: ${JSON.stringify(state.menuItems)}`);
      }
      if (!state.menuItems.some((line) => /Demat · HDFC · …1111/.test(line)
        && /10 of 17 ISINs match/.test(line))) {
        wrong.push(`replacement account choice: ${JSON.stringify(state.menuItems)}`);
      }
      if (state.menuItems.some((line) => /Bonds · portfolio/.test(line))) {
        wrong.push(`a bond portfolio was offered: ${JSON.stringify(state.menuItems)}`);
      }
      if (!state.menuItems.some((line) => /^Create a new account/.test(line))) {
        wrong.push(`create choice: ${JSON.stringify(state.menuItems)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "locked",
    seed: null,
    entries: [{
      id: "inbox-render-locked", name: "cdsl-cas-oct-2026.pdf", size: 4096,
      status: "locked", kind: "cas", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [], error: PDF_PASSWORD_WRONG, file: null,
    }],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Needs password") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!state.passwordInput) wrong.push("the password field is not in the row");
      if (!/Usually your PAN in capitals · used once, not stored/.test(state.passwordHint || "")) {
        wrong.push(`hint: ${JSON.stringify(state.passwordHint)}`);
      }
      if (state.accounts.length) wrong.push("a locked file named an account before it opened");
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (an inert bar is not drawn)`);
      }
      return wrong;
    },
  },
  {
    name: "no-account",
    seed: null,
    entries: [brokerEntry(UNMATCHED_ID)],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Needs an account") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/Create Zerodha demat …9999 and import/.test(state.proposals.join(" "))) {
        wrong.push(`proposal: ${JSON.stringify(state.proposals)}`);
      }
      if (state.accounts.length) wrong.push("an unresolved file named a target account");
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (an inert bar is not drawn)`);
      }
      return wrong;
    },
  },
  {
    name: "create-target",
    seed: null,
    entries: [brokerEntry("SYN500", rows28)],
    choices: { "zerodha:SYN500": "__create__" },
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Ready") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (state.accounts[0] !== "Create Zerodha demat SYN500 New account") {
        wrong.push(`account line: ${JSON.stringify(state.accounts)}`);
      }
      if (state.accounts.some((line) => /^·| · /.test(line))) {
        wrong.push(`the evidence starts with a separator: ${JSON.stringify(state.accounts)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "two-files",
    seed: account,
    entries: [casEntry(), brokerEntry()],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 2) wrong.push(`rows: ${state.rows}`);
      if (state.plans !== 1) wrong.push(`plans: ${state.plans}`);
      if (state.pills.some((pill) => pill !== "Ready")) {
        wrong.push(`pills: ${JSON.stringify(state.pills)}`);
      }
      if (state.groups[0] !== "Goes with the NSDL/CDSL (CAS) above") {
        wrong.push(`group: ${JSON.stringify(state.groups)}`);
      }
      if (state.bar !== "Import 2 ready files") wrong.push(`bar: ${state.bar}`);
      if (state.barDisabled) wrong.push("the two-file bar is disabled");
      return wrong;
    },
  },
  {
    name: "failure",
    seed: null,
    entries: [{
      id: "inbox-render-failure", name: "notes.txt", size: 128,
      status: "error", kind: "", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [],
      error: "This file is not a CAS, broker holdings report or bank statement. Nothing was read.",
      file: null,
    }],
    checks: (state) => {
      const wrong = [];
      if (state.rows !== 1) wrong.push(`rows: ${state.rows}`);
      if (state.pills[0] !== "Couldn't read") wrong.push(`pill: ${JSON.stringify(state.pills)}`);
      if (!/not a CAS, broker holdings report or bank statement/.test(state.notes[0] || "")) {
        wrong.push(`note: ${JSON.stringify(state.notes)}`);
      }
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (an inert bar is not drawn)`);
      }
      return wrong;
    },
  },
];

function pageScript(scenario) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(scenario.seed)};
  const seeds = Array.isArray(seed) ? seed : (seed ? [seed] : []);
  for (const item of seeds) {
    const { rows: seedRows, ...fields } = item;
    await store.createAccount(fields);
    if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-09-30");
  }
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = ${JSON.stringify(scenario.choices || {})};
  state.acceptAsk = {};
  state.receipts = [];
  state.accountRows = null;
  state.entries.push(...${JSON.stringify(scenario.entries)});
  // Re-entering the page runs the real planner over the staged entries. Nothing
  // here writes a plan by hand.
  go("import");
  await sleep(1400);
  if (${scenario.menu ? "true" : "false"}) {
    const control = document.querySelector(
      "#import-inbox-host .import-row details.import-row-account-control");
    control?.querySelector("summary")?.click();
    await sleep(250);
  }

  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const host = document.getElementById("import-inbox-host");
  const rows = [...host.querySelectorAll(".import-row")];
  const bar = host.querySelector(".import-batchbar .btn");
  const bubbles = [...document.querySelectorAll(".import-type")];
  const drop = document.getElementById("import-inbox-drop");
  const empty = host.querySelector(".import-empty");
  const controls = [...document.querySelectorAll(".import-type, .import-batchbar .btn, .import-row .btn, .import-row-pw input, .import-row-account-control summary, .import-row-account select, .import-row-account-menu select, .import-row-account-menu input, .import-drop")]
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden"
        && node.getClientRects().length > 0;
    })
    .map((node) => ({ tag: node.tagName, text: text(node).slice(0, 40),
      height: Math.round(node.getBoundingClientRect().height) }));
  const short = controls.filter((item) => item.height > 0 && item.height < 44);
  const accountLines = [...document.querySelectorAll(".import-row-account")]
    .map((node) => {
      const box = node.getBoundingClientRect();
      const name = node.querySelector("b");
      const style = getComputedStyle(node);
      return { h: Math.round(box.height),
        nameH: name ? Math.round(name.getBoundingClientRect().height) : 0,
        lineHeight: style.lineHeight,
        whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
        scrollW: node.scrollWidth, clientW: node.clientWidth };
    });
  const changeRects = [...document.querySelectorAll(".import-row-change")]
    .map((node) => {
      const box = node.getBoundingClientRect();
      return { h: Math.round(box.height), right: Math.round(box.right) };
    });
  const pillRights = [...document.querySelectorAll(".import-row-pill")]
    .map((node) => Math.round(node.getBoundingClientRect().right));
  const bubbleMetrics = bubbles.map((node) => {
    const label = node.querySelector(".import-type-name");
    return { h: Math.round(node.getBoundingClientRect().height),
      labelH: label ? Math.round(label.getBoundingClientRect().height) : 0 };
  });
  const menuRowNodes = [...host.querySelectorAll(
    ".import-row-account-control[open] .import-account-listbox .import-account-choice")];
  const menuRows = menuRowNodes.map((node) => {
    const box = node.getBoundingClientRect();
    const hits = node.querySelector(".import-choice-hits");
    const hitsBox = hits?.getBoundingClientRect();
    return { h: Math.round(box.height),
      hitsLeft: hitsBox ? Math.round(hitsBox.left) : null,
      selected: node.classList.contains("on"),
      check: text(node.querySelector(".import-choice-check")),
      badge: text(hits),
      name: text(node.querySelector(".import-choice-name")) };
  });
  const menuLastBottom = menuRowNodes.length
    ? Math.round(menuRowNodes[menuRowNodes.length - 1]
      .getBoundingClientRect().bottom) : null;
  const actionButtons = [...host.querySelectorAll(".import-row-actions .btn")];
  const barBox = host.querySelector(".import-batchbar");
  const removeBottom = actionButtons.length
    ? Math.round(actionButtons[actionButtons.length - 1].getBoundingClientRect().bottom)
    : null;
  const barTop = barBox ? Math.round(barBox.getBoundingClientRect().top) : null;
  // The bar sits at the bottom of the queue; bring the top of the queue into
  // view so one shot carries the drop zone, the bubbles and the first rows.
  // An open account menu is the thing to read, so that row leads instead.
  const focus = ${scenario.menu ? "true" : "false"}
    ? document.querySelector("#import-inbox-host .import-row")
    : document.querySelector(".import-shell");
  focus.scrollIntoView({ block: "start" });
  window.scrollBy(0, -80);

  return JSON.stringify({
    width: innerWidth,
    theme: document.documentElement.dataset.theme || "system",
    bubbles: bubbles.length,
    bubbleLabels: bubbles.map(text),
    drop: !!drop,
    cardShown: !!document.querySelector(".import-queue-card")?.getClientRects().length,
    rows: rows.length,
    plans: (state.plans || []).length,
    pills: rows.map((row) => text(row.querySelector(".import-row-pill"))),
    facts: rows.map((row) => text(row.querySelector(".import-row-facts"))),
    accounts: rows.map((row) => text(row.querySelector(".import-row-account")))
      .filter(Boolean),
    notes: rows.map((row) => text(row.querySelector(".import-row-note"))),
    groups: rows.map((row) => text(row.querySelector(".import-row-group"))).filter(Boolean),
    proposals: [...host.querySelectorAll(".import-row .btn.primary")].map(text),
    passwordInput: !!host.querySelector(".import-row-pw input[type=password]"),
    passwordHint: text(host.querySelector(".import-row-pw .import-row-note")),
    bar: text(bar),
    barDisabled: !!bar?.disabled,
    emptyText: text(empty),
    menuItems: [...document.querySelectorAll(
      ".import-row-account-control[open] .import-account-choice")].map(text),
    menuRows, menuLastBottom,
    controls: controls.length,
    shortControls: short,
    docWidth: document.documentElement.scrollWidth,
    accountLines, changeRects, pillRights, bubbleMetrics,
    removeBottom, barTop,
  });
})()`;
}

const FLOWS = [
  {
    name: "two-files-one-plan",
    seed: account,
    entries: [casEntry(), brokerEntry()],
    body: `
      const bar = () => document.querySelector(".import-batchbar .btn");
      const before = text(bar());
      if (before !== "Import 2 ready files") throw new Error("bar before: " + before);
      bar().click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 2,
        "two receipts");
      const receipts = [...document.querySelectorAll(".import-row-receipt")]
        .map((row) => ({ name: text(row.querySelector(".import-row-name")),
          text: text(row.querySelector(".import-row-note")),
          pill: text(row.querySelector(".import-row-pill")) }));
      const holdings = (await store.listHoldings("${account.id}")).length;
      return JSON.stringify({ before, after: text(bar()), receipts, holdings,
        plans: (window.bpImportInbox.plans || []).length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.after !== "") {
        wrong.push(`bar after: ${JSON.stringify(state.after)} (nothing was left to run)`);
      }
      if (state.receipts.length !== 2) wrong.push(`receipts: ${state.receipts.length}`);
      if (state.receipts.some((item) => item.pill !== "Imported")) {
        wrong.push(`receipt pills: ${JSON.stringify(state.receipts)}`);
      }
      if (state.holdings !== 17) wrong.push(`holdings: ${state.holdings}`);
      if (state.plans !== 0) wrong.push(`plans after: ${state.plans}`);
      return wrong;
    },
  },
  {
    name: "locked-does-not-block",
    seed: account,
    entries: [brokerEntry(), {
      id: "inbox-render-locked-flow", name: "cdsl-cas-oct-2026.pdf", size: 4096,
      status: "locked", kind: "cas", broker: "", asOf: "", accountKey: "",
      accountKind: "", rows: [], firstBuyByIsin: {}, termsByIsin: [],
      termsByLabel: [], error: PDF_PASSWORD_WRONG, file: null,
    }],
    body: `
      const bar = () => document.querySelector(".import-batchbar .btn");
      const before = text(bar());
      if (before !== "Import 1 ready file") throw new Error("bar before: " + before);
      bar().click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "one receipt");
      const rows = [...document.querySelectorAll("#import-inbox-host .import-row")]
        .map((row) => ({ name: text(row.querySelector(".import-row-name")),
          pill: text(row.querySelector(".import-row-pill")) }));
      const holdings = (await store.listHoldings("${account.id}")).length;
      return JSON.stringify({ before, after: text(bar()), rows, holdings });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.before !== "Import 1 ready file") wrong.push(`bar before: ${state.before}`);
      if (state.after !== "") {
        wrong.push(`bar after: ${JSON.stringify(state.after)} (nothing was left to run)`);
      }
      if (!state.rows.some((row) => row.pill === "Needs password")) {
        wrong.push(`the locked row left: ${JSON.stringify(state.rows)}`);
      }
      if (state.holdings !== 17) wrong.push(`holdings: ${state.holdings}`);
      return wrong;
    },
  },
  {
    name: "cas-create-one-press",
    seed: null,
    entries: [casEntry()],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const barBefore = document.querySelector("#import-inbox-host .import-batchbar");
      if (barBefore) throw new Error("an inert bar was drawn before Create");
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create Zerodha demat/.test(text(button)));
      if (!create) throw new Error("the CAS Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the CAS receipt");
      const accounts = await store.listAccounts();
      const holdings = accounts[0] ? (await store.listHoldings(accounts[0].id)).length : 0;
      return JSON.stringify({ label,
        bar: text(document.querySelector("#import-inbox-host .import-batchbar .btn")),
        accounts: accounts.map((item) => item.label),
        holdings, receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.label !== "Create Zerodha demat …8054 and import") {
        wrong.push(`proposal: ${state.label}`);
      }
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (one press leaves nothing to run)`);
      }
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (state.holdings !== 12) wrong.push(`holdings: ${state.holdings}`);
      return wrong;
    },
  },
  {
    name: "bank-one-file",
    seed: null,
    entries: [],
    body: `
      const csv = [
        "HDFC Bank Statement",
        "Date,Narration,Withdrawal,Deposit,Balance",
        "01-11-2026,Salary,0,1000,5000",
        "02-11-2026,Groceries,250,0,4750",
        "03-11-2026,Interest,0,50,4800",
      ].join("\\n");
      await window.bpImportInboxAdd([
        new File([csv], "statement.csv", { type: "text/csv" }),
      ]);
      await waitFor(() => document.querySelector(".import-row[data-bank]"),
        "the bank row");
      const row = () => document.querySelector(".import-row[data-bank]");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create /.test(text(button)));
      if (!create) throw new Error("the bank Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => pill() === "Ready", "the bank row to become ready");
      const bar = text(document.querySelector(".import-batchbar .btn"));
      document.querySelector(".import-batchbar .btn").click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the bank receipt");
      const entry = (window.bpBatch?.entries || [])[0] || {};
      const accounts = await store.listAccounts();
      return JSON.stringify({ label, bar, accounts: accounts.map((item) => item.label),
        inserted: entry.result?.inserted || 0,
        receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (!/^Create HDFC/.test(state.label)) wrong.push(`proposal: ${state.label}`);
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      if (state.inserted < 3) wrong.push(`inserted: ${state.inserted}`);
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (!state.accounts.some((label) => /HDFC/.test(label))) {
        wrong.push(`accounts: ${JSON.stringify(state.accounts)}`);
      }
      return wrong;
    },
  },
  {
    name: "change-target",
    seed: [account, hdfcAccount()],
    entries: [brokerEntry()],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const accountText = () => text(row()?.querySelector(".import-row-account"));
      const facts = () => text(row()?.querySelector(".import-row-facts"));
      const openMenu = async () => {
        const control = row().querySelector("details.import-row-account-control");
        control.querySelector("summary").click();
        await sleep(200);
        return control;
      };
      const before = facts();
      const menu = await openMenu();
      const names = [...menu.querySelectorAll(".import-account-choice")].map(text);
      const hdfc = [...menu.querySelectorAll(".import-account-choice")]
        .find((button) => /HDFC/.test(text(button)));
      if (!hdfc) throw new Error("the HDFC account is not offered: " + JSON.stringify(names));
      hdfc.click();
      await waitFor(() => /HDFC/.test(accountText()), "the HDFC target");
      const afterTarget = accountText();
      const afterFacts = facts();
      const barAfter = text(document.querySelector(".import-batchbar .btn"));
      const createMenu = await openMenu();
      const create = [...createMenu.querySelectorAll(".import-account-choice")]
        .find((button) => /^Create a new account/.test(text(button)));
      if (!create) throw new Error("Create a new account is not offered");
      create.click();
      await waitFor(() => /^Create Zerodha demat/.test(accountText()), "the create target");
      const createTarget = accountText();
      const createFacts = facts();
      const createBar = text(document.querySelector(".import-batchbar .btn"));
      document.querySelector(".import-batchbar .btn").click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the receipt");
      const accounts = await store.listAccounts();
      return JSON.stringify({ before, names, afterTarget, afterFacts, barAfter,
        createTarget, createFacts, createBar,
        accounts: accounts.map((item) => item.label),
        receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (!/17 holdings/.test(state.before)) wrong.push(`before: ${state.before}`);
      if (!state.names.some((line) => /HDFC/.test(line) && /10 of 17/.test(line))) {
        wrong.push(`HDFC choice: ${JSON.stringify(state.names)}`);
      }
      if (!state.names.some((line) => /Create a new account/.test(line))) {
        wrong.push(`create choice: ${JSON.stringify(state.names)}`);
      }
      if (!/HDFC/.test(state.afterTarget)) wrong.push(`target: ${state.afterTarget}`);
      if (!/7 new · 10 updated/.test(state.afterFacts)) {
        wrong.push(`consequence after: ${state.afterFacts}`);
      }
      if (state.barAfter !== "Import 1 ready file") wrong.push(`bar after: ${state.barAfter}`);
      if (!/^Create Zerodha demat/.test(state.createTarget)) {
        wrong.push(`create target: ${state.createTarget}`);
      }
      if (/· New account/.test(state.createTarget)) {
        wrong.push(`the evidence line starts with a separator: ${state.createTarget}`);
      }
      if (!/ New account$/.test(state.createTarget)) {
        wrong.push(`the new-account evidence left the line: ${state.createTarget}`);
      }
      if (!/17 holdings/.test(state.createFacts)) {
        wrong.push(`create consequence: ${state.createFacts}`);
      }
      if (state.createBar !== "Import 1 ready file") wrong.push(`create bar: ${state.createBar}`);
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      if (!state.accounts.some((label) => /…4567/.test(label))) {
        wrong.push(`new account: ${JSON.stringify(state.accounts)}`);
      }
      return wrong;
    },
  },
  {
    name: "change-target-cas",
    seed: [account],
    entries: [casEntry()],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const control = row().querySelector("details.import-row-account-control");
      control.querySelector("summary").click();
      await sleep(200);
      const names = [...control.querySelectorAll(".import-account-choice")].map(text);
      return JSON.stringify({ facts: text(row().querySelector(".import-row-facts")),
        names, bar: text(document.querySelector(".import-batchbar .btn")) });
    `,
    checks: (state) => {
      const wrong = [];
      if (!/12 holdings/.test(state.facts)) wrong.push(`facts: ${state.facts}`);
      if (!state.names.some((line) => /Demat · Zerodha · …8054/.test(line)
        && /BO ID match/.test(line))) {
        wrong.push(`current CAS account: ${JSON.stringify(state.names)}`);
      }
      if (state.names.some((line) => /^Create a new account/.test(line))) {
        wrong.push(`a second account under the same BO ID was offered: ${
          JSON.stringify(state.names)}`);
      }
      if (state.bar !== "Import 1 ready file") wrong.push(`bar: ${state.bar}`);
      return wrong;
    },
  },
  {
    name: "change-splits-group",
    seed: [account, hdfcAccount({ overlap: false })],
    entries: [casEntry(), brokerEntry()],
    body: `
      const rows = () => [...document.querySelectorAll("#import-inbox-host .import-row")];
      const brokerRow = () => rows().find((row) =>
        /holdings-AB1234567/.test(text(row.querySelector(".import-row-name"))));
      const beforePlans = (window.bpImportInbox.plans || []).length;
      const beforeTargets = rows().map((row) => text(row.querySelector(".import-row-account")));
      const control = brokerRow().querySelector("details.import-row-account-control");
      control.querySelector("summary").click();
      await sleep(200);
      const names = [...control.querySelectorAll(".import-account-choice")].map(text);
      const hdfc = [...control.querySelectorAll(".import-account-choice")]
        .find((button) => /HDFC/.test(text(button)));
      if (!hdfc) throw new Error("the empty HDFC demat is not offered: " + JSON.stringify(names));
      hdfc.click();
      await waitFor(() => (window.bpImportInbox.plans || []).length === 2, "two plans");
      const groups = [...document.querySelectorAll(".import-row-group")].map(text);
      const targets = rows().map((row) => text(row.querySelector(".import-row-account")));
      return JSON.stringify({ beforePlans, beforeTargets, names,
        afterPlans: (window.bpImportInbox.plans || []).length,
        groups, targets,
        bar: text(document.querySelector(".import-batchbar .btn")) });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.beforePlans !== 1) wrong.push(`before plans: ${state.beforePlans}`);
      if (state.beforeTargets.length !== 2
        || state.beforeTargets.some((line) => !/Zerodha/.test(line))) {
        wrong.push(`before targets: ${JSON.stringify(state.beforeTargets)}`);
      }
      if (!state.names.some((line) => /HDFC/.test(line) && /No ISINs match/.test(line))) {
        wrong.push(`empty HDFC choice: ${JSON.stringify(state.names)}`);
      }
      if (state.afterPlans !== 2) wrong.push(`after plans: ${state.afterPlans}`);
      if (state.groups.length) wrong.push(`group line survived: ${JSON.stringify(state.groups)}`);
      if (state.bar !== "Import 2 ready files") wrong.push(`bar: ${state.bar}`);
      if (state.targets.length !== 2
        || state.targets.filter((line) => /Zerodha/.test(line)).length !== 1
        || state.targets.filter((line) => /HDFC/.test(line)).length !== 1) {
        wrong.push(`the other row did not keep its target: ${JSON.stringify(state.targets)}`);
      }
      return wrong;
    },
  },
  {
    name: "change-to-nowork",
    seed: [staleZerodhaAccount(), fullHdfcAccount()],
    entries: [brokerEntry()],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      const facts = () => text(row()?.querySelector(".import-row-facts"));
      const before = { pill: pill(), bar: text(document.querySelector(".import-batchbar .btn")) };
      const control = row().querySelector("details.import-row-account-control");
      control.querySelector("summary").click();
      await sleep(200);
      const hdfc = [...control.querySelectorAll(".import-account-choice")]
        .find((button) => /HDFC/.test(text(button)));
      if (!hdfc) throw new Error("HDFC is not offered");
      hdfc.click();
      await waitFor(() => pill() === "Nothing new", "the no-work row");
      return JSON.stringify({ before, pill: pill(), facts: facts(),
        bar: text(document.querySelector(".import-batchbar .btn")) });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.before.pill !== "Ready" || state.before.bar !== "Import 1 ready file") {
        wrong.push(`before: ${JSON.stringify(state.before)}`);
      }
      if (state.pill !== "Nothing new") wrong.push(`pill after: ${state.pill}`);
      if (/Nothing new/.test(state.facts)) {
        wrong.push(`the no-work row repeated the pill in its facts: ${state.facts}`);
      }
      if (!/Zerodha holdings/.test(state.facts)) {
        wrong.push(`the type left the row: ${state.facts}`);
      }
      if (state.bar !== "") {
        wrong.push(`bar after: ${JSON.stringify(state.bar)} (an inert bar is not drawn)`);
      }
      return wrong;
    },
  },
  {
    name: "create-one-press",
    seed: null,
    entries: [brokerEntry("SYN500", rows28)],
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      const pill = () => text(row()?.querySelector(".import-row-pill"));
      if (pill() !== "Needs an account") throw new Error("pill before: " + pill());
      const barBefore = document.querySelector("#import-inbox-host .import-batchbar");
      if (barBefore) throw new Error("an inert bar was drawn before Create");
      const create = [...row().querySelectorAll(".btn.primary")]
        .find((button) => /^Create Zerodha demat/.test(text(button)));
      if (!create) throw new Error("the Create proposal is missing");
      const label = text(create);
      create.click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "one receipt");
      const receipt = document.querySelector(".import-row-receipt");
      const accounts = await store.listAccounts();
      const holdings = accounts[0] ? (await store.listHoldings(accounts[0].id)).length : 0;
      return JSON.stringify({ label,
        bar: text(document.querySelector("#import-inbox-host .import-batchbar .btn")),
        pill: text(receipt?.querySelector(".import-row-pill")),
        receipt: text(receipt?.querySelector(".import-row-note")),
        accounts: accounts.map((item) => item.label),
        holdings, receipts: document.querySelectorAll(".import-row-receipt").length });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.label !== "Create Zerodha demat SYN500 and import") {
        wrong.push(`proposal: ${state.label}`);
      }
      if (state.bar !== "") {
        wrong.push(`bar: ${JSON.stringify(state.bar)} (one press leaves nothing to run)`);
      }
      if (state.pill !== "Imported") wrong.push(`receipt pill: ${state.pill}`);
      if (!/28 holdings imported/.test(state.receipt || "")) {
        wrong.push(`receipt: ${JSON.stringify(state.receipt)}`);
      }
      if (state.holdings !== 28) wrong.push(`holdings: ${state.holdings}`);
      if (!state.accounts.some((label) => /SYN500/.test(label))) {
        wrong.push(`new account: ${JSON.stringify(state.accounts)}`);
      }
      if (state.receipts !== 1) wrong.push(`receipts: ${state.receipts}`);
      return wrong;
    },
  },
  {
    name: "create-target-bar",
    seed: null,
    entries: [brokerEntry("SYN500", rows28)],
    choices: { "zerodha:SYN500": "__create__" },
    body: `
      const row = () => document.querySelector("#import-inbox-host .import-row");
      if (!/^Create Zerodha demat SYN500/.test(text(row()?.querySelector(".import-row-account")))) {
        throw new Error("the create target is not on the row");
      }
      const bar = document.querySelector("#import-inbox-host .import-batchbar .btn");
      const before = text(bar);
      if (before !== "Import 1 ready file") throw new Error("bar before: " + before);
      bar.click();
      await waitFor(() => document.querySelectorAll(".import-row-receipt").length === 1,
        "the receipt");
      const accounts = await store.listAccounts();
      const holdings = accounts[0] ? (await store.listHoldings(accounts[0].id)).length : 0;
      return JSON.stringify({ before,
        bar: text(document.querySelector("#import-inbox-host .import-batchbar .btn")),
        receipt: text(document.querySelector(".import-row-receipt .import-row-note")),
        holdings });
    `,
    checks: (state) => {
      const wrong = [];
      if (state.before !== "Import 1 ready file") wrong.push(`bar before: ${state.before}`);
      if (state.bar !== "") {
        wrong.push(`bar after: ${JSON.stringify(state.bar)} (nothing was left to run)`);
      }
      if (!/28 holdings imported/.test(state.receipt || "")) {
        wrong.push(`receipt: ${JSON.stringify(state.receipt)}`);
      }
      if (state.holdings !== 28) wrong.push(`holdings: ${state.holdings}`);
      return wrong;
    },
  },
];

function flowScript(flow) {
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
  const waitFor = async (read, label) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (read()) return;
      await sleep(100);
    }
    throw new Error("timed out waiting for " + label);
  };
  const store = await import("./db.js");
  await store.clearAll();
  const seed = ${JSON.stringify(flow.seed)};
  const seeds = Array.isArray(seed) ? seed : (seed ? [seed] : []);
  for (const item of seeds) {
    const { rows: seedRows, ...fields } = item;
    await store.createAccount(fields);
    if (seedRows.length) await store.replaceHoldings(fields.id, seedRows, "2026-09-30");
  }
  go("import");
  await sleep(900);
  const state = window.bpImportInbox;
  state.entries.length = 0;
  state.bundles.length = 0;
  state.plans.length = 0;
  state.choices = ${JSON.stringify(flow.choices || {})};
  state.acceptAsk = {};
  state.receipts = [];
  state.accountRows = null;
  state.entries.push(...${JSON.stringify(flow.entries)});
  go("import");
  await sleep(1400);
  ${flow.body}
})()`;
}

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-import-queue: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-import-queue: --out-dir needs a value");
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
  throw new Error("render-import-queue: web/server.mjs did not answer.");
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
const dir = mkdtempSync(join(tmpdir(), "bankpipe-import-queue-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
const SHOTS = [
  { width: 390, height: 1600, theme: "dark" },
  { width: 390, height: 1600, theme: "light" },
  { width: 1280, height: 1200, theme: "dark" },
  { width: 1280, height: 1200, theme: "light" },
  // The smallest phone the app supports. The brief asks for 390 and 1280;
  // this is the no-clipping check the UI skill adds.
  { width: 320, height: 1600, theme: "light" },
  { width: 320, height: 1600, theme: "dark" },
];
// The row and the source tiles get a real desktop check on the states that
// carry them, not on every edge case.
const WIDE_SHOTS = [
  { width: 1440, height: 1200, theme: "light" },
  { width: 1440, height: 1200, theme: "dark" },
  { width: 1920, height: 1200, theme: "light" },
  { width: 1920, height: 1200, theme: "dark" },
];
try {
  // RENDER_ONLY=<scenario-or-flow> is for a quick targeted pass; the normal
  // run renders every state.
  const only = String(process.env.RENDER_ONLY || "");
  for (const scenario of SCENARIOS) {
    if (only && scenario.name !== only) continue;
    const pageFile = join(dir, `${scenario.name}.js`);
    writeFileSync(pageFile, pageScript(scenario));
    const shots = scenario.wide ? [...SHOTS, ...WIDE_SHOTS] : SHOTS;
    for (const shot of shots) {
      const out = join(args.outDir,
        `import-queue-${scenario.name}-${shot.width}-${shot.theme}.png`);
      const result = await capture({
        page, out, script: pageFile, wait: 1800,
        width: shot.width, height: shot.height, theme: shot.theme,
      });
      const state = JSON.parse(result.value);
      const wrong = scenario.checks(state);
      wrong.push(...importLayoutWrong(state));
      if (state.bubbles !== 5) wrong.push(`bubbles: ${state.bubbles}`);
      if (!state.bubbleLabels.some((label) =>
        label.startsWith("NSDL/CDSL (CAS)"))) {
        wrong.push(`depository bubble: ${JSON.stringify(state.bubbleLabels)}`);
      }
      if (!state.drop) wrong.push("the drop zone is missing");
      if (state.docWidth > state.width + 1) {
        wrong.push(`sideways scroll: ${state.docWidth} > ${state.width}`);
      }
      if (state.shortControls.length) {
        wrong.push(`controls under 44px: ${JSON.stringify(state.shortControls)}`);
      }
      if (wrong.length) {
        throw new Error(`render-import-queue: ${scenario.name} ${shot.width} `
          + `${shot.theme} is not the state that was asked for.\n  ${wrong.join("\n  ")}`
          + `\n  full state: ${JSON.stringify(state)}`);
      }
      console.log(`${out}  ${state.rows} row(s)  ${state.bar}  `
        + `${state.controls} controls`);
    }
  }
  // The press itself: one plan, one receipt per file; a locked file left alone;
  // and a proposed account that becomes ready in one press.
  for (const flow of FLOWS) {
    if (only && flow.name !== only) continue;
    const flowFile = join(dir, `flow-${flow.name}.js`);
    writeFileSync(flowFile, flowScript(flow));
    const out = join(args.outDir, `import-queue-flow-${flow.name}.png`);
    const result = await capture({
      page, out, script: flowFile, wait: 1500,
      width: 390, height: 1200, theme: "light",
    });
    const state = JSON.parse(result.value);
    const wrong = flow.checks(state);
    if (wrong.length) {
      throw new Error(`render-import-queue: the ${flow.name} flow is not the behaviour `
        + `that was asked for.\n  ${wrong.join("\n  ")}\n  full state: ${JSON.stringify(state)}`);
    }
    console.log(`${out}  ${flow.name}  ${JSON.stringify(state).slice(0, 160)}`);
  }
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
