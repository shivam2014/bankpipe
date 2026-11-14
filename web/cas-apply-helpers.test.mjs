import test from "node:test";
import assert from "node:assert/strict";
import { casFolioHoldings, casImportUnits, casMovementAccountBos, casPreviewAccounts,
  casWritableHoldings } from "./cas-apply.js";

// Regression guards for helpers added after dca90b3. They cannot run on that
// commit because the helpers did not exist there. The planner behavior that the
// old inline code got wrong is covered by cas-apply.test.mjs and
// cas-events.test.mjs.
const ISIN_A = "INE000000031";
const ISIN_B = "INE000000032";

test("a movement BO absent from the holdings route still maps to its demat", () => {
  const accounts = [
    { id: "demat-a", category: "demat", number: "1200000000000001" },
    { id: "demat-b", category: "demat", number: "1200000000000002" },
    { id: "cost-a", category: "bonds", number: "1200000000000002" },
  ];
  const routeAccounts = [{ boId: "1200000000000001", assetId: "demat-a" }];
  const movements = [{ account: "1200000000000002" }];
  const map = casMovementAccountBos({ accounts, routeAccounts, movements });
  assert.deepEqual(map.get("demat-a"), ["1200000000000001"]);
  assert.deepEqual(map.get("demat-b"), ["1200000000000002"]);
  assert.equal(map.has("cost-a"), false);
});

test("a movement-only demat appears in the preview with empty holdings", () => {
  const accounts = [
    { id: "demat-a", category: "demat", number: "1200000000000001" },
    { id: "demat-b", category: "demat", number: "1200000000000002" },
  ];
  const preview = casPreviewAccounts({
    accounts,
    routeAccounts: [{ boId: "1200000000000001", assetId: "demat-a", dpName: "A" }],
    movements: [{ account: "1200000000000002" }],
  });
  assert.deepEqual(preview.map((account) => account.boId),
    ["1200000000000001", "1200000000000002"]);
  assert.equal(preview[1].assetId, "demat-b");
  assert.equal(preview[1].synthetic, true);
});

test("the writable holding count drops a closed row and keeps a matured one", () => {
  const holdings = [
    { isin: ISIN_A, quantity: 10, valuePaise: 100000, kind: "bond",
      maturity: "2030-01-01" },
    { isin: ISIN_B, quantity: 0, valuePaise: 0, kind: "equity" },
    { isin: "INE000000033", quantity: 0, valuePaise: 0, kind: "bond",
      label: "9% TEST 01 Jan 2020", maturity: "2020-01-01" },
    { isin: "INE000000034", quantity: 0, valuePaise: 0, kind: "bond",
      label: "9% TEST 01 Jan 2030", maturity: "2030-01-01" },
  ];
  assert.equal(casWritableHoldings(holdings, "2026-11-14").length, 2);
});

test("the inbox picks a movement-only demat so its sale is written", () => {
  const accounts = [
    { id: "demat-a", category: "demat", number: "1200000000000001" },
    { id: "demat-b", category: "demat", number: "1200000000000002" },
  ];
  const units = casImportUnits({
    accounts,
    routeAccounts: [{ boId: "1200000000000001", assetId: "demat-a" }],
    groups: [],
    movements: [{ account: "1200000000000002" }],
  });
  assert.deepEqual([...units],
    ["bo:1200000000000001", "bo:1200000000000002"]);
});

test("a zero-unit fund is not shown as a folio unit", () => {
  const holdings = [
    { kind: "mf", folio: "123", amc: "TEST", quantity: 0, valuePaise: 5000 },
    { kind: "mf", folio: "124", amc: "TEST", quantity: 10, valuePaise: 5000 },
    { kind: "bond", quantity: 1 },
  ];
  assert.deepEqual(casFolioHoldings(holdings).map((holding) => holding.folio), ["124"]);
});
