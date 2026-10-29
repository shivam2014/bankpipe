import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHoldings, groupHoldings, validateHolding, holdingKey } from "./holdings.js";

const rows = [
  { security_id: "A", label: "Alpha", category: "AA", quantity: 10, cost_paise: 100000, value_paise: 125000 },
  { security_id: "B", label: "Beta", category: "AA", quantity: 5, cost_paise: 50000, value_paise: 45000 },
  { security_id: "C", label: "Gamma", category: "", quantity: 2, cost_paise: 20000, value_paise: null },
];

test("summaries add only the values that exist", () => {
  const s = summarizeHoldings(rows);
  assert.equal(s.count, 3);
  assert.equal(s.cost, 170000);
  assert.equal(s.value, 170000);
  assert.equal(s.gain, 0);
  assert.equal(s.gainPct, 0);
});

test("a missing current value does not become zero", () => {
  const s = summarizeHoldings([{ cost_paise: 100, value_paise: null }]);
  assert.equal(s.value, null);
  assert.equal(s.gain, null);
  assert.equal(s.gainPct, null);
});

test("groups are sorted by value, then category", () => {
  const g = groupHoldings(rows);
  assert.equal(g.length, 2);
  assert.equal(g[0].category, "AA");
  assert.equal(g[0].count, 2);
  assert.equal(g[0].value, 170000);
  assert.equal(g[1].category, "Unrated");
});

test("validation names the missing or invalid field", () => {
  assert.deepEqual(validateHolding({ security_id: "A", label: "Alpha", quantity: 1,
    cost_paise: 100, value_paise: 120 }), []);
  const errs = validateHolding({ security_id: "", label: "", quantity: 0,
    cost_paise: 1.5, value_paise: -1 });
  assert.ok(errs.includes("missing security_id"));
  assert.ok(errs.includes("missing label"));
  assert.ok(errs.includes("quantity <= 0"));
  assert.ok(errs.includes("cost_paise not a non-negative integer"));
  assert.ok(errs.includes("value_paise not a non-negative integer"));
});

test("the key is stable and distinguishes lots", () => {
  const a = holdingKey({ asset_id: "z", security_id: "A", label: "Alpha",
    category: "AA", quantity: 1, cost_paise: 100, value_paise: 120 });
  const b = holdingKey({ asset_id: "z", security_id: "A", label: "Alpha",
    category: "AA", quantity: 2, cost_paise: 100, value_paise: 120 });
  assert.notEqual(a, b);
  assert.match(a, /^z\|A\|Alpha\|AA\|1\|100\|120$/);
});
