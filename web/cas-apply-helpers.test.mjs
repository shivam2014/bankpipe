import test from "node:test";
import assert from "node:assert/strict";
import { casCostedImportHoldings, casDematRows, casFolioHoldings,
  casGroupByAsset, casImportHoldings, casImportUnits, casMovementAccountBos,
  casPreviewAccounts, casWritableHoldings } from "./cas-apply.js";

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
    groups: [{ kind: "mf", folio: true, amc: "Test AMC", folioNo: "F1",
      assetId: "mf-test" }],
    movements: [{ account: "1200000000000002" }],
  });
  assert.deepEqual([...units],
    ["bo:1200000000000001", "mf:test amc:f1", "bo:1200000000000002"]);
});

test("the card unit and the writer group agree on a zero-unit fund", () => {
  const zero = { kind: "mf", folio: "aaa", amc: "Test AMC", quantity: 0,
    valuePaise: 5000, isin: "INF000000001" };
  const positive = { kind: "mf", folio: "bbb", amc: "Test AMC", quantity: 10,
    valuePaise: 15000, isin: "INF999900287" };
  const groups = [{ kind: "mf", folio: true, amc: "Test AMC", folioNo: "bbb",
    assetId: "mf-test", boId: "" }];
  const importDay = "2026-11-14";
  const card = casFolioHoldings(casWritableHoldings([zero, positive], importDay));
  const writer = casGroupByAsset({ holdings: [zero, positive], groups, importDay });
  assert.deepEqual(card.map((holding) => holding.isin), ["INF999900287"]);
  assert.deepEqual(writer.get("mf-test").map((holding) => holding.isin),
    ["INF999900287"]);
  const cardValue = card.reduce((sum, holding) => sum + holding.valuePaise, 0);
  const writerValue = writer.get("mf-test")
    .reduce((sum, holding) => sum + holding.valuePaise, 0);
  assert.equal(cardValue, 15000);
  assert.equal(writerValue, cardValue);
});

test("a zero-unit fund is not shown as a folio unit", () => {
  const holdings = [
    { kind: "mf", folio: "123", amc: "TEST", quantity: 0, valuePaise: 5000 },
    { kind: "mf", folio: "124", amc: "TEST", quantity: 10, valuePaise: 5000 },
    { kind: "bond", quantity: 1 },
  ];
  assert.deepEqual(casFolioHoldings(holdings).map((holding) => holding.folio), ["124"]);
});

test("a zero-unit folio row the route left in the demat is written there", () => {
  const zero = { kind: "mf", folio: "aaa", amc: "Test AMC", quantity: 0,
    valuePaise: 5000, isin: "INF000000001", account: "BO1" };
  const nullUnit = { ...zero, isin: "INF000000003", quantity: null, valuePaise: 0 };
  const positive = { kind: "mf", folio: "bbb", amc: "Test AMC", quantity: 10,
    valuePaise: 15000, isin: "INF999900287", account: "BO1" };
  const importDay = "2026-11-14";
  const dematGroup = { kind: "mf", folio: false, boId: "BO1", amc: "",
    assetId: "demat-a" };
  const folioGroup = { kind: "mf", folio: true, amc: "Test AMC", folioNo: "bbb",
    assetId: "mf-test", boId: "" };
  // Group order is whatever casRoute inserted first. The split must not depend
  // on it: the zero rows go to the demat, the positive row to the folio.
  for (const groups of [[dematGroup, folioGroup], [folioGroup, dematGroup]]) {
    const writer = casGroupByAsset({ holdings: [zero, nullUnit, positive],
      groups, importDay });
    assert.deepEqual(writer.get("demat-a").map((holding) => holding.isin),
      ["INF000000001", "INF000000003"]);
    assert.deepEqual(writer.get("mf-test").map((holding) => holding.isin),
      ["INF999900287"]);
    const card = casDematRows(casWritableHoldings([zero, nullUnit, positive],
      importDay), "BO1");
    const cardValue = card.reduce((sum, holding) => sum + holding.valuePaise, 0)
      + casFolioHoldings(casWritableHoldings([zero, nullUnit, positive], importDay))
        .reduce((sum, holding) => sum + holding.valuePaise, 0);
    const writerValue = [...writer.values()].flat()
      .reduce((sum, holding) => sum + holding.valuePaise, 0);
    assert.equal(cardValue, 20000);
    assert.equal(writerValue, cardValue);
  }

  // A positive folio row with no folio group must not fall into the demat.
  // The card shows it as a new folio unit, so unticking that unit must stop
  // the write instead of silently writing it to the demat.
  assert.equal(casGroupByAsset({ holdings: [positive], groups: [dematGroup],
    importDay }).has("demat-a"), false);

  // With no demat group offered, a zero row never falls into the folio account.
  assert.equal(casGroupByAsset({ holdings: [zero], groups: [folioGroup], importDay })
    .has("mf-test"), false);
});

test("casGroupByAsset honours the picked folio key", () => {
  const positive = { kind: "mf", folio: "bbb", amc: "Test AMC", quantity: 10,
    valuePaise: 15000, isin: "INF999900287", account: "BO1" };
  const groups = [{ kind: "mf", folio: true, amc: "Test AMC", folioNo: "bbb",
    assetId: "mf-test", boId: "" }];
  assert.equal(casGroupByAsset({ holdings: [positive], groups,
    picked: new Set(["mf:test amc:bbb"]) }).get("mf-test").length, 1);
  assert.equal(casGroupByAsset({ holdings: [positive], groups,
    picked: new Set() }).has("mf-test"), false);
});

test("two folios of one AMC are two units, not one", () => {
  const groups = [
    { kind: "mf", folio: true, amc: "Test AMC", folioNo: "F1", assetId: "mf-f1" },
    { kind: "mf", folio: true, amc: "Test AMC", folioNo: "F2", assetId: "mf-f2" },
  ];
  assert.deepEqual([...casImportUnits({ groups })],
    ["mf:test amc:f1", "mf:test amc:f2"]);
});

test("two positive holdings of one AMC with different folios are two positions", () => {
  const first = { kind: "mf", folio: "F1", amc: "Test AMC", quantity: 1,
    valuePaise: 100, isin: "INF000000001" };
  const second = { kind: "mf", folio: "F2", amc: "Test AMC", quantity: 2,
    valuePaise: 200, isin: "INF999900287" };
  const groups = [
    { kind: "mf", folio: true, amc: "Test AMC", folioNo: "F1", assetId: "mf-f1" },
    { kind: "mf", folio: true, amc: "Test AMC", folioNo: "F2", assetId: "mf-f2" },
  ];
  const writer = casGroupByAsset({ holdings: [first, second], groups,
    importDay: "2026-11-14" });
  assert.deepEqual(writer.get("mf-f1").map((holding) => holding.isin),
    ["INF000000001"]);
  assert.deepEqual(writer.get("mf-f2").map((holding) => holding.isin),
    ["INF999900287"]);
});

test("the inbox scoping keeps a positive folio row for its own account", () => {
  const demat = "IN99990001344321";
  const bond = { isin: "INE000000001", kind: "bond", quantity: 1, valuePaise: 100,
    account: demat };
  const fund = { isin: "INF000000001", kind: "mf", folio: "F1", amc: "Test AMC",
    quantity: 10, valuePaise: 1000, account: demat };
  const parsed = {
    holdings: [bond, fund],
    accounts: [{ boId: demat, holdings: [bond, fund] }],
  };
  const targets = [
    { boId: demat, rows: [bond], plan: { identityOnly: false,
      decisions: [{ isin: bond.isin, action: "create" }] } },
    { boId: "mf:f1", rows: [fund], plan: { identityOnly: false,
      decisions: [{ isin: fund.isin, action: "create" }] } },
  ];
  const out = casImportHoldings({ parsed, targets });
  assert.deepEqual(out.accounts[0].holdings.map((holding) => holding.isin).sort(),
    ["INE000000001", "INF000000001"]);
  assert.deepEqual(out.holdings.map((holding) => holding.isin).sort(),
    ["INE000000001", "INF000000001"]);
});

test("two AMCs sharing a folio string are two units", () => {
  const groups = [
    { kind: "mf", folio: true, amc: "AMC One", folioNo: "123/4", assetId: "mf-1" },
    { kind: "mf", folio: true, amc: "AMC Two", folioNo: "123/4", assetId: "mf-2" },
  ];
  assert.deepEqual([...casImportUnits({ groups })],
    ["mf:amc one:123/4", "mf:amc two:123/4"]);
});

test("two AMCs sharing a folio write to their own groups", () => {
  const first = { kind: "mf", folio: "123/4", amc: "AMC One", quantity: 1,
    valuePaise: 100, isin: "INF000000001" };
  const second = { kind: "mf", folio: "123/4", amc: "AMC Two", quantity: 2,
    valuePaise: 200, isin: "INF999900287" };
  const groups = [
    { kind: "mf", folio: true, amc: "AMC One", folioNo: "123/4", assetId: "mf-1" },
    { kind: "mf", folio: true, amc: "AMC Two", folioNo: "123/4", assetId: "mf-2" },
  ];
  const writer = casGroupByAsset({ holdings: [first, second], groups,
    importDay: "2026-11-14" });
  assert.deepEqual(writer.get("mf-1").map((holding) => holding.isin),
    ["INF000000001"]);
  assert.deepEqual(writer.get("mf-2").map((holding) => holding.isin),
    ["INF999900287"]);
});

test("a new folio row keeps its cost through inbox scoping and planning", () => {
  const demat = "IN99990001344321";
  const bond = { isin: "INE000000001", kind: "bond", quantity: 1, valuePaise: 100,
    account: demat };
  const fund = { isin: "INF000000001", kind: "mf", folio: "F1", amc: "Test AMC",
    quantity: 10, valuePaise: 1000, costPaise: 24002176, account: demat };
  const parsed = {
    holdings: [bond, fund],
    accounts: [{ boId: demat, holdings: [bond, fund] }],
  };
  const targets = [
    { boId: demat, folio: false, rows: [bond], plan: { identityOnly: false,
      decisions: [{ isin: bond.isin, action: "create" }] } },
    { boId: "mf:test amc:f1", folio: true, folioNo: "F1", amc: "Test AMC",
      rows: [fund], plan: { identityOnly: false,
        decisions: [{ isin: fund.isin, action: "add", changes: [] }] } },
  ];
  const scoped = casImportHoldings({ parsed, targets });
  const holdings = casCostedImportHoldings({ holdings: scoped.holdings,
    targets });
  assert.equal(holdings.find((holding) => holding.isin === fund.isin).costPaise,
    24002176);
});

test("a kept or asked cost is not overwritten by the incoming row", () => {
  const holding = { isin: "INF999900287", kind: "mf", folio: "F2", amc: "Test AMC",
    costPaise: 5000, account: "IN99990001344321" };
  for (const action of ["keep", "ask"]) {
    const target = { boId: "mf:test amc:f2", folio: true, folioNo: "F2",
      amc: "Test AMC", plan: { identityOnly: false,
        decisions: [{ isin: holding.isin, action, changes: [] }] } };
    const out = casCostedImportHoldings({ holdings: [holding], targets: [target] });
    assert.equal(out[0].costPaise, null, action);
  }
  const update = { boId: "mf:test amc:f2", folio: true, folioNo: "F2",
    amc: "Test AMC", plan: { identityOnly: false,
      decisions: [{ isin: holding.isin, action: "update",
        changes: [{ group: "cost", field: "cost" }] }] } };
  assert.equal(casCostedImportHoldings({ holdings: [holding], targets: [update] })[0]
    .costPaise, 5000);
});
