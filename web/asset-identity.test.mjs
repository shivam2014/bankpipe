import test from "node:test";
import assert from "node:assert/strict";

import { assetIdentity, assetShortIdentity } from "./asset-identity.js";

const bond = {
  id: "bonds-1",
  label: "Bonds · portfolio 1",
  bank: "DigiFInn",
  number: "IN30302873183122",
  holder: "BABITA BHALLA",
};

test("a bond identity carries broker, Demat and holder", () => {
  const id = assetIdentity(bond, { numberLabel: "Demat" });
  assert.equal(id.row, "DigiFInn · IN30302873183122 · BABITA BHALLA");
  assert.equal(id.name, "Bonds · portfolio 1 (BABITA BHALLA)");
  assert.equal(id.full, "Bonds · portfolio 1 · IN30302873183122 (BABITA BHALLA)");
  assert.equal(id.numberLine, "Demat IN30302873183122 (BABITA BHALLA)");
});

test("a missing holder drops the parentheses", () => {
  const id = assetIdentity({ ...bond, holder: "" }, { numberLabel: "Demat" });
  assert.equal(id.name, "Bonds · portfolio 1");
  assert.equal(id.full, "Bonds · portfolio 1 · IN30302873183122");
  assert.equal(id.numberLine, "Demat IN30302873183122");
});

test("a missing number drops the middle clause", () => {
  const id = assetIdentity({ ...bond, number: "" });
  assert.equal(id.row, "DigiFInn · BABITA BHALLA");
  assert.equal(id.name, "Bonds · portfolio 1 (BABITA BHALLA)");
  assert.equal(id.full, "Bonds · portfolio 1 (BABITA BHALLA)");
  assert.equal(id.numberLine, "BABITA BHALLA");
  assert.equal(/·\s*·/.test(id.row), false);
});

test("a missing label falls back to the broker without an empty separator", () => {
  const id = assetIdentity({ ...bond, label: "" });
  assert.equal(id.label, "DigiFInn");
  assert.equal(id.name, "DigiFInn (BABITA BHALLA)");
  assert.equal(id.row, "DigiFInn · IN30302873183122 · BABITA BHALLA");
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

test("a short identity keeps the label and only the last four digits", () => {
  const id = assetShortIdentity({ label: "ICICI demat account",
    number: "1201090009140907" });
  assert.equal(id, "ICICI demat account …0907");
  assert.equal(id.includes("1201090009140907"), false);
  assert.equal(assetShortIdentity({ label: "ICICI demat account", number: "4051" }),
    "ICICI demat account …4051");
  assert.equal(assetShortIdentity({ label: "SCB savings", number: "" }), "SCB savings");
});

test("a bank asset reads the same way as the Assets row", () => {
  const id = assetIdentity({ label: "SCB savings", bank: "SCB", number: "99990071842",
    holder: "A Holder" });
  assert.equal(id.row, "SCB · 99990071842 · A Holder");
  assert.equal(id.name, "SCB savings (A Holder)");
});
