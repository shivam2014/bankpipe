import test from "node:test";
import assert from "node:assert/strict";

import { sheetAccountLabel } from "./receipt-label.js";

test("a known account adds its label and last four", () => {
  assert.equal(sheetAccountLabel(5, ["ICICI demat account …4051"]),
    "Sheet 5 · ICICI demat account …4051");
});

test("a multi-account sheet shows the first and counts the rest", () => {
  assert.equal(sheetAccountLabel(5, ["ICICI demat account …4051",
    "SCB savings …1842", "HDFC savings …8821"]),
    "Sheet 5 · ICICI demat account …4051 +2 more");
});

test("an unmapped sheet says no account", () => {
  assert.equal(sheetAccountLabel(6, []), "Sheet 6 · no account");
});

test("a receipt without the account field keeps the bare index", () => {
  assert.equal(sheetAccountLabel(6, undefined), "Sheet 6");
});
