import test from "node:test";
import assert from "node:assert/strict";
import { createBondSyncDialog } from "./bond-sync-dialog.js";

function makeElement(id = "") {
  const listeners = new Map();
  return {
    id,
    open: false,
    focused: false,
    textContent: "",
    style: {},
    children: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    emit(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() {
      this.open = false;
      this.emit("close");
    },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

function makeDoc() {
  const ids = {};
  for (const id of ["bond-sync-dialog", "bond-sync-title", "bond-sync-dangers",
    "bond-sync-summary", "bond-sync-cancel", "bond-sync-accept"]) {
    ids[id] = makeElement(id);
  }
  return {
    ids,
    getElementById: (id) => ids[id] || null,
    createElement: () => makeElement(),
  };
}

const ask = (controller, extra = {}) => controller.ask({
  heading: "Apply bond sync?",
  dangerLines: [],
  body: "Replace the holdings on this portfolio with 9 current lots?",
  acceptLabel: "Replace holdings",
  ...extra,
});

test("the dialog opens with Cancel focused", () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  ask(controller);
  assert.equal(doc.ids["bond-sync-cancel"].focused, true);
  assert.equal(doc.ids["bond-sync-accept"].focused, false);
  assert.equal(doc.ids["bond-sync-dialog"].open, true);
});

test("danger lines keep their order and the accept label is the consequence", () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  ask(controller, {
    dangerLines: ["This Demat is mapped to Bonds · portfolio 1.",
      "Applying here removes 17 existing lots from this portfolio."],
    acceptLabel: "Move mapping and remove 17 lots",
  });
  assert.deepEqual(doc.ids["bond-sync-dangers"].children.map((el) => el.textContent),
    ["This Demat is mapped to Bonds · portfolio 1.",
      "Applying here removes 17 existing lots from this portfolio."]);
  assert.equal(doc.ids["bond-sync-dangers"].style.display, "grid");
  assert.equal(doc.ids["bond-sync-accept"].textContent,
    "Move mapping and remove 17 lots");
});

test("Cancel resolves false and closes without consent", async () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  const pending = ask(controller);
  doc.ids["bond-sync-cancel"].emit("click");
  assert.equal(await pending, false);
  assert.equal(doc.ids["bond-sync-dialog"].open, false);
});

test("Escape resolves false and is kept from the native close", async () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  const pending = ask(controller);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  doc.ids["bond-sync-dialog"].emit("cancel", event);
  assert.equal(event.prevented, true);
  assert.equal(await pending, false);
  assert.equal(doc.ids["bond-sync-dialog"].open, false);
});

test("only the accept button resolves true", async () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  const pending = ask(controller, { acceptLabel: "Move mapping" });
  doc.ids["bond-sync-accept"].emit("click");
  assert.equal(await pending, true);
  assert.equal(doc.ids["bond-sync-dialog"].open, false);
});

test("closing the dialog by another path is not consent", async () => {
  const doc = makeDoc();
  const controller = createBondSyncDialog(doc);
  const pending = ask(controller);
  doc.ids["bond-sync-dialog"].close();
  assert.equal(await pending, false);
});

test("a missing dialog refuses instead of falling through to a write", async () => {
  const doc = makeDoc();
  delete doc.ids["bond-sync-dialog"];
  assert.equal(createBondSyncDialog(doc), null);
});
