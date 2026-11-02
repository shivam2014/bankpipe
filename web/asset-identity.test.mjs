import test from "node:test";
import assert from "node:assert/strict";

import { assetIdentity } from "./asset-identity.js";

const bond = {
  id: "bonds-1",
  label: "Bonds · portfolio 1",
  bank: "DigiFInn",
  number: "IN99990009183122",
  holder: "TEST HOLDER",
};

test("a bond identity carries broker, Demat and holder", () => {
  const id = assetIdentity(bond, { numberLabel: "Demat" });
  assert.equal(id.row, "DigiFInn · IN99990009183122 · TEST HOLDER");
  assert.equal(id.name, "Bonds · portfolio 1 (TEST HOLDER)");
  assert.equal(id.full, "Bonds · portfolio 1 · IN99990009183122 (TEST HOLDER)");
  assert.equal(id.numberLine, "Demat IN99990009183122 (TEST HOLDER)");
});

test("a missing holder drops the parentheses", () => {
  const id = assetIdentity({ ...bond, holder: "" }, { numberLabel: "Demat" });
  assert.equal(id.name, "Bonds · portfolio 1");
  assert.equal(id.full, "Bonds · portfolio 1 · IN99990009183122");
  assert.equal(id.numberLine, "Demat IN99990009183122");
});

test("a missing number drops the middle clause", () => {
  const id = assetIdentity({ ...bond, number: "" });
  assert.equal(id.row, "DigiFInn · TEST HOLDER");
  assert.equal(id.name, "Bonds · portfolio 1 (TEST HOLDER)");
  assert.equal(id.full, "Bonds · portfolio 1 (TEST HOLDER)");
  assert.equal(id.numberLine, "TEST HOLDER");
  assert.equal(/·\s*·/.test(id.row), false);
});

test("a missing label falls back to the broker without an empty separator", () => {
  const id = assetIdentity({ ...bond, label: "" });
  assert.equal(id.label, "DigiFInn");
  assert.equal(id.name, "DigiFInn (TEST HOLDER)");
  assert.equal(id.row, "DigiFInn · IN99990009183122 · TEST HOLDER");
});

test("an empty or quote-only identity becomes empty, not quotes", () => {
  assert.deepEqual(assetIdentity({}),
    { rawLabel: "", broker: "", label: "", number: "", holder: "",
      name: "", numberLine: "", full: "", row: "" });
  const quoted = assetIdentity({ ...bond, number: '""', holder: '""' });
  assert.equal(quoted.number, "");
  assert.equal(quoted.holder, "");
  assert.equal(quoted.full, "Bonds · portfolio 1");
  assert.equal(quoted.full.includes('""'), false);
  assert.equal(quoted.row.includes('""'), false);
});

test("a bank asset reads the same way as the Assets row", () => {
  const id = assetIdentity({ label: "SCB savings", bank: "SCB", number: "99990071842",
    holder: "TEST HOLDER" });
  assert.equal(id.row, "SCB · 99990071842 · TEST HOLDER");
  assert.equal(id.name, "SCB savings (TEST HOLDER)");
});
