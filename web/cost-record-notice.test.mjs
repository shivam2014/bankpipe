import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The orphan cost record is a task on its own bond portfolio page, not on the
// Assets list. These checks read the one renderer in index.html and pin the
// split, so the task cannot drift back onto the Assets hero.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not read ${start} … ${end}`);
  return html.slice(from, to);
};

test("the Assets page renders no cost task", () => {
  const assets = between("async function renderRealAssets", "function metaOf");
  assert.equal(/cost-task/.test(assets), false, "Assets still builds the cost task");
  assert.equal(/costTaskFor/.test(assets), false,
    "Assets still reads holdings for a task");
  assert.equal(/costRecordsHtml/.test(assets), false,
    "Assets still interpolates the task block");
});

test("only the record's own bond portfolio asks for its task", () => {
  const task = between("async function costTaskFor", "function costTaskNoticeHtml");
  assert.match(task, /categoryOf\(record\) !== "bonds"/);
  assert.match(task, /!isCostRecord\(record\)/);
  assert.match(task, /unattachedCostRecords\(assets\)/);
  assert.match(task, /store\.listHoldings\(id\)/);
  assert.match(task, /positions: new Map\(dematRows\)/);
});

test("the portfolio page passes the task into the form", () => {
  const page = between("function renderAsset()", "async function fetchIfscDetails");
  assert.match(page, /const costTask = await costTaskFor\(store, accounts, id\)/);
  assert.match(page, /undefined, holdings, costTask\)/);
  const form = between("function assetForm", "function bondLabelParts");
  assert.match(form, /a, factCount, defaultCat, holdings, costTask/);
});

test("the notice keeps the sentence and the Import a CAS action above the cards", () => {
  const notice = between("function costTaskNoticeHtml", "async function renderRealAssets");
  assert.match(notice, /costRecordSentence\(1\)/);
  assert.match(notice, /NO_DEMAT_SENTENCE/);
  assert.match(notice, /go\('import'\)">Import a CAS</);
  assert.match(notice, /bpAttachCostRecord/);
  assert.match(notice, /attachActionLabel\(task\.target\)/);
  const form = between("function assetForm", "function bondLabelParts");
  const taskAt = form.indexOf("costTaskNoticeHtml(costTask)");
  const cardsAt = form.indexOf("holdingsBlock(holdings, id)");
  assert.ok(taskAt >= 0, "the form renders the task");
  assert.ok(cardsAt > taskAt, "the task sits above the holdings and bond cards");
  assert.match(form, /cat === "bonds" && costTask/);
});
