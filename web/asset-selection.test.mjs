import test from "node:test";
import assert from "node:assert/strict";

import { selectedAssets, selectionSummary, bulkDeleteBarText,
  bulkDeleteConfirmText, bulkDeleteFacts, bulkDeleteAssets } from "./asset-selection.js";

const bank = {
  id: "bank-1", label: "Test savings", category: "bank", subtype: "savings",
  facts: 3, balance: 5000000, value_paise: 100,
};
const gold = {
  id: "gold-1", label: "Test gold", category: "gold", subtype: "physical",
  value_paise: 2500000,
};
const noValue = { id: "other-1", label: "Test other", category: "other" };
const costRecord = {
  id: "cost-1", label: "Test cost record", category: "bonds", subtype: "bond",
  meta: JSON.stringify({ cost_only: "1", linked_label: "Demat · Test · …0001" }),
};
const meta = (value) => JSON.stringify(value);

function fakeStore(accounts, { holdings = {}, totals = {}, failOn = "" } = {}) {
  const calls = { snapshots: [], deletes: [] };
  return {
    calls,
    listAccounts: async () => accounts,
    listHoldings: async (id) => holdings[id] || [],
    accountDetail: async (id) => ({ totals: { n: totals[id] || 0 } }),
    snapshotDb: async (label) => {
      calls.snapshots.push(label);
      return { key: "snap-1", label };
    },
    deleteAccount: async (id) => {
      calls.deletes.push(id);
      if (id === failOn) throw new Error("disk full");
    },
  };
}

// --- what is ticked ---------------------------------------------------------

test("the summary counts only ticked assets and sums their own values", () => {
  const assets = [bank, gold, noValue];
  const summary = selectionSummary(assets, new Set(["bank-1", "gold-1"]));
  assert.equal(summary.count, 2);
  assert.equal(summary.valued, 2);
  assert.equal(summary.noValue, 0);
  assert.equal(summary.valuePaise, 5000000 + 2500000);
  assert.deepEqual(summary.ids, ["bank-1", "gold-1"]);
});

test("an unticked asset is not in the count or the total", () => {
  const summary = selectionSummary([bank, gold], new Set(["gold-1"]));
  assert.equal(summary.count, 1);
  assert.equal(summary.valuePaise, 2500000);
});

test("an asset with no value is counted but adds nothing", () => {
  const summary = selectionSummary([bank, noValue], new Set(["bank-1", "other-1"]));
  assert.equal(summary.count, 2);
  assert.equal(summary.valued, 1);
  assert.equal(summary.noValue, 1);
  assert.equal(summary.valuePaise, 5000000);
});

test("a stale id is ignored, and one account ticked twice counts once", () => {
  assert.equal(selectionSummary([bank], new Set(["gone"])).count, 0);
  const twice = selectedAssets([bank, { ...bank }], ["bank-1"]);
  assert.equal(twice.length, 1);
  assert.equal(selectionSummary([bank, { ...bank }],
    new Set(["bank-1"])).count, 1);
});

test("a cost record is never ticked, counted or deleted", async () => {
  assert.deepEqual(selectedAssets([bank, costRecord], ["cost-1"]), []);
  const summary = selectionSummary([bank, costRecord],
    new Set(["bank-1", "cost-1"]));
  assert.deepEqual(summary.ids, ["bank-1"]);
  assert.equal(summary.count, 1);
  assert.equal(summary.valuePaise, 5000000);

  const facts = await bulkDeleteFacts(fakeStore([bank, costRecord]), ["cost-1"]);
  assert.deepEqual(facts.accounts, []);
  assert.equal(facts.holdings, 0);

  const store = fakeStore([bank, costRecord]);
  const result = await bulkDeleteAssets({ store, ids: ["cost-1"] });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(store.calls.snapshots, []);
  assert.deepEqual(store.calls.deletes, []);
});

test("a demat split across class rows is still one asset at its full value", () => {
  const demat = { id: "demat-1", label: "Demat", category: "demat",
    subtype: "equity", holdings_count: 2, holdings_cost: 100000,
    holdings_value: 100000, class_bond_value: 60000, class_mf_value: 40000 };
  const summary = selectionSummary([demat], new Set(["demat-1"]));
  assert.equal(summary.count, 1);
  assert.equal(summary.valuePaise, 100000);
});

test("the bar text carries the ticked count and the summed value", () => {
  const format = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;
  assert.equal(bulkDeleteBarText(2, 7500000, format), "Delete 2 · ₹75,000");
  assert.equal(bulkDeleteBarText(0, 0, format), "Delete");
});

// --- what the confirm says --------------------------------------------------

test("the confirm names assets, holdings, transactions and linked FDs", () => {
  const text = bulkDeleteConfirmText({ count: 3, holdings: 12, transactions: 240,
    linkedFds: 2 });
  assert.match(text, /^Delete 3 assets and their 12 holdings and 240 imported transactions\?/);
  assert.match(text, /2 linked fixed deposits will stay and become unlinked\./);
  assert.match(text, /snapshot of the database is taken first/);
  assert.match(text, /restored from Settings/);
});

test("the confirm says one asset, one holding, one transaction, one deposit", () => {
  const text = bulkDeleteConfirmText({ count: 1, holdings: 1, transactions: 1,
    linkedFds: 1 });
  assert.match(text, /^Delete 1 asset and its 1 holding and 1 imported transaction\?/);
  assert.match(text, /1 linked fixed deposit will stay and become unlinked\./);
});

test("the confirm names a few linked FDs, and stops naming at four", () => {
  const one = bulkDeleteConfirmText({ count: 1, linkedFds: 1,
    linkedFdNames: ["FD stays"] });
  assert.match(one, /1 linked fixed deposit \(FD stays\) will stay/);
  const many = bulkDeleteConfirmText({ count: 1, linkedFds: 4,
    linkedFdNames: ["A", "B", "C", "D"] });
  assert.match(many, /4 linked fixed deposits will stay/);
  assert.equal(many.includes("A, B"), false);
});

test("the confirm leaves out zero counts and says nothing about FDs when none stay", () => {
  const text = bulkDeleteConfirmText({ count: 2, holdings: 0, transactions: 0 });
  assert.match(text, /^Delete 2 assets\?/);
  assert.equal(/0 holdings|0 imported|fixed deposit/.test(text), false);
  assert.match(text, /snapshot of the database is taken first/);
});

// --- what the pre-delete read counts ---------------------------------------

test("a linked FD that is itself ticked does not count as staying behind", async () => {
  const accounts = [
    bank,
    { id: "fd-stays", label: "FD stays", category: "fd",
      meta: meta({ linked_account_id: "bank-1" }) },
    { id: "fd-goes", label: "FD goes", category: "fd",
      meta: meta({ linked_account_id: "bank-1" }) },
    { id: "fd-elsewhere", label: "FD elsewhere", category: "fd",
      meta: meta({ linked_account_id: "bank-2" }) },
  ];
  const store = fakeStore(accounts, {
    holdings: { "bank-1": [{ id: 1 }, { id: 2 }] },
    totals: { "bank-1": 40, "fd-goes": 2 },
  });
  const facts = await bulkDeleteFacts(store, ["bank-1", "fd-goes"]);
  assert.deepEqual(facts.accounts.map((asset) => asset.id), ["bank-1", "fd-goes"]);
  assert.equal(facts.holdings, 2);
  assert.equal(facts.transactions, 42);
  assert.equal(facts.linkedFds, 1);
  assert.deepEqual(facts.linkedFdNames, ["FD stays"]);
});

test("a selected id that no longer exists is not counted in the confirm", async () => {
  const store = fakeStore([bank, gold]);
  const facts = await bulkDeleteFacts(store, ["bank-1", "gone"]);
  assert.deepEqual(facts.accounts.map((asset) => asset.id), ["bank-1"]);
  assert.equal(facts.linkedFds, 0);
});

// --- one snapshot, then one delete per ticked id ---------------------------

test("a bulk delete takes one snapshot and deletes only the ticked assets", async () => {
  const accounts = [bank, gold, noValue];
  const store = fakeStore(accounts);
  const result = await bulkDeleteAssets({ store, ids: ["other-1", "bank-1", "gone"] });
  assert.deepEqual(store.calls.snapshots, ["Before deleting 2 assets"]);
  assert.deepEqual(store.calls.deletes, ["bank-1", "other-1"]);
  assert.deepEqual(result.deleted, ["bank-1", "other-1"]);
  assert.deepEqual(result.missing, ["gone"]);
  assert.equal(result.failed, null);
});

test("the page's label is the snapshot label", async () => {
  const store = fakeStore([bank]);
  await bulkDeleteAssets({ store, ids: ["bank-1"], label: "Before deleting 1 asset" });
  assert.deepEqual(store.calls.snapshots, ["Before deleting 1 asset"]);
});

test("a failure stops the loop, names the asset and leaves the rest untouched", async () => {
  const accounts = [bank, gold, noValue];
  const store = fakeStore(accounts, { failOn: "gold-1" });
  const result = await bulkDeleteAssets({ store, ids: ["bank-1", "gold-1", "other-1"] });
  assert.deepEqual(store.calls.snapshots, ["Before deleting 3 assets"]);
  assert.deepEqual(store.calls.deletes, ["bank-1", "gold-1"]);
  assert.deepEqual(result.deleted, ["bank-1"]);
  assert.equal(result.failed, "gold-1");
  assert.deepEqual(result.remaining, ["other-1"]);
});

test("a snapshot failure still deletes, and the error is reported", async () => {
  const store = fakeStore([bank]);
  store.snapshotDb = async () => { throw new Error("locked"); };
  const result = await bulkDeleteAssets({ store, ids: ["bank-1"] });
  assert.deepEqual(store.calls.deletes, ["bank-1"]);
  assert.equal(result.snapshotError, "locked");
});

test("nothing ticked means no snapshot and no delete", async () => {
  const store = fakeStore([bank]);
  const result = await bulkDeleteAssets({ store, ids: [] });
  assert.deepEqual(store.calls.snapshots, []);
  assert.deepEqual(store.calls.deletes, []);
  assert.deepEqual(result.deleted, []);
});
