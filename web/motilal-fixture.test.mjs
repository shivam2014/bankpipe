// The fixture is a 12-page Motilal Portfolio Holding Summary rebuilt from its
// printed span geometry. Every byte is written by scripts/motilal-fixture.mjs
// from scripts/motilal-fixture-spans.json; no original PDF object, font or byte
// survives. The expectation beside it was written from the substitution map,
// not from this parser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractPdf } from "./pdf-statement.js";
import { parseMotilalPages } from "./motilal.js";
import { generate } from "../scripts/motilal-fixture.mjs";

const FIXTURE = new URL(
  "./fixtures/motilal/motilal-portfolio-holding-summary-synthetic.pdf", import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL(
  "./fixtures/motilal/motilal-portfolio-holding-summary-synthetic.json", import.meta.url), "utf8"));
const SPANS = JSON.parse(readFileSync(new URL(
  "../scripts/motilal-fixture-spans.json", import.meta.url), "utf8"));

test("the committed PDF is the generator's own output", () => {
  assert.deepEqual(generate(), readFileSync(FIXTURE));
});

test("the fixture carries no embedded font or image object", () => {
  const bytes = readFileSync(FIXTURE).toString("latin1");
  assert.doesNotMatch(bytes, /\/FontFile|\/Subtype\s*\/Image|\/XObject/);
});

test("the generated Motilal export reads every bond row", async () => {
  const { pages, numPages } = await extractPdf(readFileSync(FIXTURE));
  assert.equal(numPages, 12);
  const parsed = parseMotilalPages(pages, { file: FIXTURE.pathname });
  assert.equal(parsed.error, null);
  assert.equal(parsed.asOf, EXPECTED.asOf);
  assert.equal(parsed.clientUcid, EXPECTED.clientUcid);
  assert.deepEqual(parsed.sections, EXPECTED.sections);
  assert.deepEqual(parsed.rows, EXPECTED.rows);
});

test("the generated fixture totals are the sum of its rows", async () => {
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const toPaise = (money) => Math.round(Number(String(money).replace(/,/g, "")) * 100);
  assert.equal(EXPECTED.totals.rows, EXPECTED.rows.length);
  for (const [key, total] of [["cost_paise", "cost"],
    ["market_value_paise", "market_value"], ["face_paise", "face"]]) {
    assert.equal(toPaise(EXPECTED.totals[total]), sum(EXPECTED.rows, key), key);
  }
  const { pages } = await extractPdf(readFileSync(FIXTURE));
  const parsed = parseMotilalPages(pages, { file: FIXTURE.pathname });
  for (const [key, total] of [["cost_paise", "cost"],
    ["market_value_paise", "market_value"], ["face_paise", "face"]]) {
    assert.equal(sum(parsed.rows, key), toPaise(EXPECTED.totals[total]), key);
  }
});

test("the extracted text is exactly the substituted span table", async () => {
  const { pages } = await extractPdf(readFileSync(FIXTURE));
  const extracted = pages.flatMap((page) => page.items.map((item) => item.str));
  const spans = SPANS.flatMap((page) => page.items.map((item) => item[3]));
  assert.deepEqual(extracted, spans);
  assert.doesNotMatch(extracted.join("\n"), /@motilaloswal\.com/i);
});
