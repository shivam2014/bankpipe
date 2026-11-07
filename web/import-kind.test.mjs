import test from "node:test";
import assert from "node:assert/strict";
import { guessKind, IMPORT_KINDS, IMPORT_KIND_LABEL } from "./import-kind.js";

test("the CDSL transaction export is a CAS even without the word", () => {
  assert.equal(guessKind("SEP2026_AA06635090_TXN_unlocked.pdf"), "cas");
  assert.equal(guessKind("CDSL_CAS_2026.pdf"), "cas");
  assert.equal(guessKind("NSDLe-CAS_116750635_SEP_2026.pdf"), "cas");
});

test("a broker export is recognised by its own words", () => {
  assert.equal(guessKind("holdings-report-2026-10-26.csv"), "broker");
  assert.equal(guessKind("portfolio-cashflow-future.csv"), "broker");
  assert.equal(guessKind("contract-note.pdf"), "broker");
});

test("a bank statement is the fallback for a plain statement", () => {
  assert.equal(guessKind("pnb-statement-oct.csv"), "bank");
  assert.equal(guessKind("HDFC_stmt.xlsx"), "bank");
  assert.equal(guessKind("download.pdf"), "bank");
});

test("an unknown name falls back to broker, never to CAS", () => {
  assert.equal(guessKind(""), "broker");
  assert.equal(guessKind("export.csv"), "broker");
});

test("every kind has a label a person can read", () => {
  for (const kind of IMPORT_KINDS) {
    assert.ok(IMPORT_KIND_LABEL[kind], `${kind} has no label`);
    assert.ok(IMPORT_KIND_LABEL[kind].length > 3);
  }
});
