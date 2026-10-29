import test from "node:test";
import assert from "node:assert/strict";
import { accountKey, manualSnapshot, manualFor, manualUpdates, SSOT_KEYS } from "./ssot.js";

test("account keys use the full cleaned number and category", () => {
  assert.equal(accountKey({ category: "bank", number: "999-9-007184-2" }),
    "bank:n:99990071842");
  assert.equal(accountKey({ category: "fd", number: ",9999005500876421" }),
    "fd:n:9999005500876421");
  assert.equal(accountKey({ category: "bonds", bank: "Bonds", label: "Portfolio 1" }),
    "bonds:l:bonds|portfolio 1");
});

test("a manual snapshot keeps only set fields and manual meta", () => {
  const snap = manualSnapshot([{
    category: "bank", number: "123456789", label: "BOB savings", holder: "Vij",
    ifsc: "BARB0VISDEL", branch: "", notes: "keep", meta: JSON.stringify({
      linked_account_id: "other", grams: 10, premium_paise: 5000,
    }),
  }]);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].fields.holder, "Vij");
  assert.equal(snap[0].fields.branch, undefined);
  assert.equal(snap[0].meta.grams, 10);
  assert.equal(snap[0].meta.linked_account_id, undefined);
});

test("manual values are found again after an import creates the same number", () => {
  const before = [{ category: "bank", number: "999900482193", holder: "Arjun",
    ifsc: "ICIC0000011", notes: "old note" }];
  const snap = manualSnapshot(before);
  const after = { category: "bank", number: "999900482193", holder: "imported" };
  const saved = manualFor(after, snap);
  assert.equal(saved.fields.holder, "Arjun");
  assert.equal(saved.fields.ifsc, "ICIC0000011");
  assert.equal(saved.fields.label, undefined);
});

test("manual updates restore fields and merge manual meta", () => {
  const snap = manualSnapshot([{ category: "gold", number: "G1", label: "Gold",
    holder: "Mani", meta: JSON.stringify({ grams: 10, linked_account_id: "x" }) }]);
  const updates = manualUpdates([{ id: "gold-1", category: "gold", number: "G1",
    holder: "imported", meta: JSON.stringify({ current_per_gram_paise: 700000 }) }], snap);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.holder, "Mani");
  assert.equal(JSON.parse(updates[0].update.meta).grams, 10);
  assert.equal(JSON.parse(updates[0].update.meta).current_per_gram_paise, 700000);
  assert.equal(JSON.parse(updates[0].update.meta).linked_account_id, undefined);
});

test("the SSOT keys are stable strings", () => {
  assert.equal(SSOT_KEYS.accountMeta, "import.accountMeta");
  assert.equal(SSOT_KEYS.workbookTotals, "workbook.totals");
});
