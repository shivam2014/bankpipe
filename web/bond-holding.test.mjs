import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bondHoldingPatch, bondKeptLine, bondLabelText } from "./bond-holding.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from > -1, `missing ${start}`);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return html.slice(from, to);
};

const fields = {
  label: "10.50% TEST 31 DEC 2030",
  isin: "ine000000001",
  issuer: "Test Issuer",
  redemptions: "2027-06-30,2027-12-31",
  units: 10, cost: 1000000, face: 100000,
  value: 1020000, asOf: "2026-11-01", purchaseDate: "2024-01-01",
  rating: "AA", frequency: "Quarterly", payout: 25000,
  interestDate: "2026-12-31",
};

test("the form patch writes only the columns the form has a control for", () => {
  const patch = bondHoldingPatch(fields);
  assert.deepEqual(Object.keys(patch).sort(), [
    "as_of", "cost_paise", "face_paise", "frequency", "interest_date", "issuer",
    "label", "payout_paise", "purchase_date", "quantity", "rating",
    "redemption_dates", "security_id", "value_paise", "value_source",
  ]);
  for (const kept of ["returned_paise", "returned_at", "returned_record_date",
    "returned_source", "principal_dates", "future_principal_paise",
    "future_interest_paise", "yield_bps", "category", "rating_at_purchase"]) {
    assert.equal(kept in patch, false, `${kept} is not the form's to write`);
  }
  assert.equal(patch.security_id, "INE000000001");
  assert.equal(patch.value_source, "Manual");
});

test("a blank face is left to the store instead of overwriting it", () => {
  const patch = bondHoldingPatch({ ...fields, face: null });
  assert.equal("face_paise" in patch, false);
  const added = bondHoldingPatch({ ...fields, face: undefined });
  assert.equal("face_paise" in added, false, "a new lot simply has no face yet");
});

test("clearing a money or date control is written, not skipped", () => {
  const patch = bondHoldingPatch({ ...fields, value: null, payout: null,
    interestDate: "", asOf: "" });
  assert.equal(patch.value_paise, null);
  assert.equal(patch.value_source, "");
  assert.equal(patch.payout_paise, null);
  assert.equal(patch.interest_date, "");
  assert.equal(patch.as_of, "");
});

test("an untouched market value keeps its stored source and date", () => {
  const patch = bondHoldingPatch({ ...fields, valueTouched: false });
  for (const key of ["value_paise", "value_source", "as_of"]) {
    assert.equal(key in patch, false, `${key} is not written back`);
  }
  assert.equal(patch.label, fields.label, "the rest of the form still saves");
});

test("the kept line names the principal returned and the schedule", () => {
  const both = bondKeptLine({
    returned_paise: 4000000, returned_at: "2026-04-10", returned_source: "bank",
    future_principal_paise: 6000000,
    principal_dates: "2027-12-31,2027-06-30",
  });
  assert.equal(both, "Kept as saved: principal returned ₹ 40,000.00 on 10 Apr 2026 "
    + "from the bank; principal still to come ₹ 60,000.00 in 2 payments, "
    + "30 Jun 2027 and 31 Dec 2027.");
  assert.equal(bondKeptLine({ returned_paise: 4000000, returned_at: "2026-04-10",
    returned_source: "smest" }),
  "Kept as saved: principal returned ₹ 40,000.00 on 10 Apr 2026 from SMEST.");
  assert.equal(bondKeptLine({ principal_dates: "2027-06-30" }),
    "Kept as saved: principal still to come in one payment, 30 Jun 2027.");
  assert.equal(bondKeptLine({ future_principal_paise: 6000000 }),
    "Kept as saved: principal still to come ₹ 60,000.00.");
  assert.equal(bondKeptLine({ returned_paise: 0 }), "",
    "a plain bond says nothing extra");
  assert.equal(bondKeptLine(null), "");
});

test("the edit form saves through the shared patch and shows the kept line", () => {
  const save = between("window.bpBondHoldingSave", "window.bpBondHoldingDelete");
  assert.match(save, /\.\.\.bondHoldingPatch\(/);
  assert.match(save, /valueTouched/);
  assert.doesNotMatch(save, /returned_paise|principal_dates|future_|yield_bps/);
  const form = between("function renderBondHoldingForm()", "window.bpBondLabelPreview");
  assert.match(form, /bondKeptLine\(h, currency\(\)\)/);
  assert.match(form, /id="bh-kept"/);
  assert.match(form, /id="bh-value"[\s\S]{0,120}data-prior=/);
  assert.match(form, /id="bh-value-date"[\s\S]{0,120}data-prior=/);
  assert.doesNotMatch(form, /id="bh-returned"/, "returned principal has no input");
});

test("a term the form writes carries its source; an untouched guess is not promoted", () => {
  const untouched = bondHoldingPatch(fields);
  assert.equal("coupon_pct" in untouched, false);
  assert.equal("maturity" in untouched, false);
  assert.equal("coupon_source" in untouched, false);

  const typed = bondHoldingPatch({ ...fields, coupon: 9.5,
    couponSource: "Manual", couponAsOf: "2026-11-16",
    maturity: "2030-12-31", maturitySource: "Manual", maturityAsOf: "2026-11-16",
    faceSource: "Manual", faceAsOf: "2026-11-16" });
  assert.equal(typed.coupon_pct, 9.5);
  assert.equal(typed.coupon_source, "Manual");
  assert.equal(typed.coupon_as_of, "2026-11-16");
  assert.equal(typed.maturity, "2030-12-31");
  assert.equal(typed.maturity_source, "Manual");
  assert.equal(typed.maturity_as_of, "2026-11-16");
  assert.equal(typed.face_source, "Manual");
  assert.equal(typed.face_as_of, "2026-11-16");
});

test("the saved name still reads as rate, name, maturity", () => {
  assert.equal(bondLabelText("Test 31", 10.5, "2030-12-31"),
    "10.5% Test 31 31 DEC 2030");
});
