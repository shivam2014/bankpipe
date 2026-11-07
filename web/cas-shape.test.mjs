import test from "node:test";
import assert from "node:assert/strict";
import { casShape, casShapeText } from "./cas-shape.js";

const pdf = {
  pages: [
    { items: [
      { str: "INE585B01010", x: 3, y: 617 },
      { str: "5.00", x: 328, y: 613 },
      { str: "5", x: 408, y: 613 },
      { str: "11,672.00", x: 561, y: 613 },
      { str: "MARUTI SUZUKI INDIA LTD", x: 83, y: 613 },
      { str: "2.00", x: 328, y: 590 },
      { str: "9", x: 408, y: 590 },
      { str: "2,939.40", x: 561, y: 590 },
      { str: "1.00", x: 328, y: 567 },
      { str: "34", x: 408, y: 567 },
      { str: "959.40", x: 561, y: 567 },
    ] },
  ],
};

const parsed = {
  depository: "", demat: "",
  counts: { rows: 1, quarantined: 2 },
  holdings: [{ isin: "INE585B01010", kind: "equity", valuePaise: 5836000,
    maturity: "" }],
};

test("the shape reports where numbers sit, not what they are", () => {
  const shape = casShape(pdf, parsed);
  assert.equal(shape.pages, 1);
  assert.equal(shape.numericItems, 9);
  assert.ok(shape.columns.length >= 2);
  const text = casShapeText(shape);
  assert.equal(text.includes("11,672"), false);
  assert.equal(text.includes("MARUTI"), false);
  assert.equal(text.includes("INE585B01010"), false);
  assert.match(text, /columns {10}\d+x\d+/);
});

test("the shape says which fields were missing", () => {
  const shape = casShape(pdf, parsed);
  assert.equal(shape.withValue, 1);
  assert.equal(shape.withIsin, 1);
  assert.equal(shape.maturityParsed, 0);
  assert.equal(shape.dematFound, false);
  assert.equal(shape.quarantined, 2);
});

test("an empty document is described, not thrown", () => {
  const shape = casShape({ pages: [] }, { holdings: [], counts: {} });
  assert.equal(shape.rowsRead, 0);
  assert.deepEqual(shape.columns, []);
  assert.match(casShapeText(shape), /pages {12}0/);
});
