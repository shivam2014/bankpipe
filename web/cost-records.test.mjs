import test from "node:test";
import assert from "node:assert/strict";

import { isCostRecord, liveDemats, unattachedCostRecords, costRecordTasks,
  costRecordSentence, attachActionLabel, NO_DEMAT_SENTENCE } from "./cost-records.js";

const meta = (value) => JSON.stringify(value);

const demat = (id, number, holder = "TEST HOLDER") => ({
  id,
  label: `Demat · ${holder} · …${String(number).slice(-4)}`,
  category: "demat",
  subtype: "equity",
  number,
});

const dematOne = demat("demat-one", "IN99990000123456", "TEST HOLDER ONE");
const dematTwo = demat("demat-two", "IN99990000987654", "TEST HOLDER TWO");

// A fund folio is demat-shaped but holds units, not bonds.
const folio = {
  id: "folio-one", label: "Folio …1234", category: "demat",
  subtype: "mutual fund", number: "TESTFOLIO",
};

const record = (id, extra = {}) => ({
  id,
  label: `TEST COST ${id}`,
  category: "bonds",
  subtype: "bond",
  ...extra,
  meta: meta({ cost_only: "1", ...(extra.meta || {}) }),
});

const lot = (isin, extra = {}) => ({
  security_id: isin, category: "bond", quantity: 10,
  purchase_date: "2025-05-15", ...extra,
});

const positions = (pairs) => new Map(pairs);

// --- what counts as a cost record ------------------------------------------

test("a cost record is read from string or object meta, and nothing else", () => {
  assert.equal(isCostRecord({ meta: meta({ cost_only: "1" }) }), true);
  assert.equal(isCostRecord({ meta: { cost_only: true } }), true);
  assert.equal(isCostRecord({ meta: meta({ cost_only: "" }) }), false);
  assert.equal(isCostRecord({ meta: "{not json" }), false);
  assert.equal(isCostRecord({ label: "no meta" }), false);
});

test("a fund folio is not a demat a cost record can join", () => {
  assert.deepEqual(liveDemats([dematOne, folio, dematTwo]).map((a) => a.id),
    ["demat-one", "demat-two"]);
});

// --- which records still need a task ---------------------------------------

test("a link that resolves to a live demat means there is no task", () => {
  const attached = record("cost-attached",
    { meta: { linked_asset: "demat-one", linked_label: dematOne.label } });
  assert.deepEqual(unattachedCostRecords([dematOne, attached]), []);
  assert.deepEqual(costRecordTasks({ assets: [dematOne, attached], lots: new Map(),
    positions: positions([["demat-one", []]]) }), []);
});

test("a linked_label alone is not an attachment", () => {
  const prose = record("cost-prose", { meta: { linked_label: dematOne.label } });
  assert.deepEqual(unattachedCostRecords([dematOne, prose]), [prose]);
});

test("a link to a deleted demat is unattached, and the lots name the live one", () => {
  const orphan = record("cost-orphan", { meta: { linked_asset: "demat-gone" } });
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, orphan],
    lots: new Map([["cost-orphan", [lot("INE999900001")]]]),
    positions: positions([["demat-one", [lot("INE999900001")]],
      ["demat-two", [lot("INE999900002")]]]),
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].record.id, "cost-orphan");
  assert.equal(tasks[0].target.id, "demat-one");
});

test("a link to a fund folio is unattached", () => {
  const orphan = record("cost-folio", { meta: { linked_asset: "folio-one" } });
  const tasks = costRecordTasks({
    assets: [folio, dematOne, orphan],
    lots: new Map([["cost-folio", [lot("INE999900001")]]]),
    positions: positions([["demat-one", [lot("INE999900001")]],
      ["folio-one", [lot("INE999900001")]]]),
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].target.id, "demat-one");
});

// --- naming the target the way the rest of the app does --------------------

test("a printed demat number does not fall back to another account on one bond", () => {
  // The record names demat two, which holds none of its bonds. Demat one holds
  // the only bond, but one shared ISIN is not enough to make it the home. It is
  // offered as a choice instead of being chosen.
  const named = record("cost-named", { number: dematTwo.number });
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, named],
    lots: new Map([["cost-named", [lot("INE999900001")]]]),
    positions: positions([["demat-one", [lot("INE999900001")]],
      ["demat-two", [lot("INE999900002")]]]),
  });
  assert.equal(tasks[0].target, null);
  assert.deepEqual(tasks[0].targets.map((demat) => demat.id), ["demat-one"]);
});

test("a printed number that holds none of the bonds is not a target", () => {
  const named = record("cost-empty", { number: dematTwo.number });
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, named],
    lots: new Map([["cost-empty", [lot("INE999900009")]]]),
    positions: positions([["demat-one", []],
      ["demat-two", [lot("INE999900002")]]]),
  });
  assert.equal(tasks[0].target, null);
});

test("a split record lists both demats as choices and picks neither", () => {
  const split = record("cost-split");
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, split],
    lots: new Map([["cost-split",
      [lot("INE999900001"), lot("INE999900002")]]]),
    positions: positions([["demat-one", [lot("INE999900001")]],
      ["demat-two", [lot("INE999900002")]]]),
  });
  assert.equal(tasks[0].target, null);
  assert.deepEqual(tasks[0].targets.map((demat) => demat.id),
    ["demat-one", "demat-two"]);
});

test("the demat holding most of the record's ISINs is the target", () => {
  const orphan = record("cost-many");
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, orphan],
    lots: new Map([["cost-many", [lot("INE999900001"), lot("INE999900002")]]]),
    positions: positions([
      ["demat-one", [lot("INE999900001")]],
      ["demat-two", [lot("INE999900001"), lot("INE999900002")]],
    ]),
  });
  assert.equal(tasks[0].target.id, "demat-two");
});

test("a zero-unit or disposed row does not make a demat a home", () => {
  const orphan = record("cost-closed");
  const tasks = costRecordTasks({
    assets: [dematOne, dematTwo, orphan],
    lots: new Map([["cost-closed", [lot("INE999900001")]]]),
    positions: positions([
      ["demat-one", [lot("INE999900001", { quantity: 0 })]],
      ["demat-two", [lot("INE999900001", { disposed_at: "2026-01-02" })]],
    ]),
  });
  assert.equal(tasks[0].target, null);
});

test("no live demat and no lots both leave the task without a target", () => {
  const orphan = record("cost-none");
  const noHome = costRecordTasks({
    assets: [dematOne, dematTwo, orphan],
    lots: new Map([["cost-none", [lot("INE999900009")]]]),
    positions: positions([["demat-one", [lot("INE999900001")]],
      ["demat-two", [lot("INE999900002")]]]),
  });
  assert.equal(noHome[0].target, null);
  const empty = costRecordTasks({
    assets: [dematOne, orphan],
    lots: new Map([["cost-none", []]]),
    positions: positions([["demat-one", [lot("INE999900001")]]]),
  });
  assert.equal(empty[0].target, null);
  const noDemat = costRecordTasks({ assets: [orphan], lots: new Map(),
    positions: new Map() });
  assert.equal(noDemat[0].target, null);
});

test("tasks keep the page's order and skip the attached records", () => {
  const first = record("cost-first");
  const attached = record("cost-attached", { meta: { linked_asset: "demat-one" } });
  const second = record("cost-second", { meta: { linked_asset: "demat-gone" } });
  const tasks = costRecordTasks({
    assets: [first, dematOne, attached, second],
    lots: new Map([["cost-first", []], ["cost-second", []]]),
    positions: positions([["demat-one", []]]),
  });
  assert.deepEqual(tasks.map((task) => task.record.id), ["cost-first", "cost-second"]);
});

// --- the words --------------------------------------------------------------

test("the task sentence is singular for one record and plural for more", () => {
  assert.equal(costRecordSentence(1),
    "A cost record has no account. It holds what you paid, so the gain can be shown.");
  assert.equal(costRecordSentence(2),
    "2 cost records have no account. They hold what you paid, so the gain can be shown.");
  assert.equal(costRecordSentence(3).startsWith("3 cost records have no account."), true);
});

test("the action names the account, and its tail appears once", () => {
  assert.equal(attachActionLabel(dematOne),
    "Attach to Demat · TEST HOLDER ONE · …3456");
  assert.equal(attachActionLabel({ label: "Demat · TEST HOLDER", number: dematOne.number }),
    "Attach to Demat · TEST HOLDER · …3456");
  assert.equal(attachActionLabel({ label: "Demat", number: "" }), "Attach to Demat");
  assert.equal(attachActionLabel(null), "Attach to Demat");
});

test("the no-target sentence says exactly what is missing", () => {
  assert.equal(NO_DEMAT_SENTENCE, "No demat account holds its bonds.");
});
