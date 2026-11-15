import test from "node:test";
import assert from "node:assert/strict";
import {
  BOND_CARD_FACTS, BOND_MATURED_FACTS, BOND_BAND_SECTIONS,
  bondFacts, bondRowView, bondCardHtml, bondLedgerHtml, moneyText,
} from "./bond-book.js";

// A fully specified live lot: coupon, maturity, a BSE mark, a part repayment
// and a cashflow schedule. The same row is matured by moving its date into the
// past, so the two states cannot drift apart in the fixture either.
const row = {
  id: "lot-1", category: "bond", label: "7.40% TEST BOND 3 10 Feb 2030",
  issuer: "TEST BOND 3", security_id: "INE000000123",
  quantity: 800, cost_paise: 80000000, value_paise: 81440000,
  value_source: "BSE", as_of: "2026-10-31", face_paise: 100000,
  purchase_date: "2024-11-05", maturity: "2030-02-10",
  interest_date: "2027-02-10", frequency: "Half-yearly",
  rating: "AA", rating_at_purchase: "AA", yield_bps: 740,
  returned_paise: 8000000, returned_at: "2026-04-10",
  returned_source: "bank", redemption_dates: "2026-04-10",
  future_principal_paise: 72000000, future_interest_paise: 18648000,
  source: "report",
};

const maturedRow = {
  ...row, id: "lot-2", label: "7.40% TEST BOND 3 10 Feb 2020",
  maturity: "2020-02-10", interest_date: "2020-02-10",
  value_paise: 50000000, future_principal_paise: null,
  future_interest_paise: null, as_of: "2020-02-10",
};

const sorted = (values) => [...values].sort();

// Every opening tag, so the surface split is read from the DOM the renderer
// actually emitted rather than from a second hand-written list.
function tags(html) {
  return [...html.matchAll(/<[^>]*>/g)].map((match) => match[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : "";
}

function keysOn(html, surface, keyAttr) {
  return tags(html)
    .filter((tag) => attr(tag, "data-surface") === surface)
    .map((tag) => attr(tag, keyAttr))
    .filter(Boolean);
}

function actionLabels(html) {
  return [...html.matchAll(/<[^>]*data-bond-action="[^"]*"[^>]*>([\s\S]*?)<\/(?:button|a)>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, "").trim())
    .filter(Boolean);
}

// The visible grid is the six-fact budget. The progress block sits after it in
// the card body, so the grid stops at the progress or the disclosure.
function visibleFacts(html) {
  const at = html.indexOf('<div class="bond-grid bond-facts">');
  assert.ok(at > -1, "the card has a visible facts grid");
  const stops = ['<div class="bond-progress', '<details class="bond-breakdown"']
    .map((marker) => html.indexOf(marker, at)).filter((index) => index > -1);
  assert.ok(stops.length, "the visible facts grid closes");
  const end = Math.min(...stops);
  assert.ok(end > at, "the visible facts grid closes after it opens");
  return html.slice(at, end);
}

function visibleKeys(html) {
  return [...visibleFacts(html).matchAll(/data-fact="([^"]+)"/g)].map((m) => m[1]);
}

function openBands(ledger) {
  return [...ledger.matchAll(/<div class="bl-band"[^>]*>/g)]
    .map((match) => match[0]).filter((tag) => !tag.includes("hidden"));
}

test("the live card shows exactly six facts, all in the declared order", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.deepEqual(visibleKeys(card), BOND_CARD_FACTS.map((fact) => fact.key));
  assert.equal(visibleKeys(card).length, 6, "a seventh visible fact breaks the budget");
  for (const fact of BOND_CARD_FACTS) {
    assert.match(visibleFacts(card), new RegExp(
      `data-fact="${fact.key}"[\\s\\S]*?<span class="k">${fact.label}</span>`),
    `${fact.label} is visible on the card`);
  }
});

test("the live card carries each fact's number, not a bare label", () => {
  const grid = visibleFacts(bondCardHtml(bondRowView(row), "acct-1"));
  assert.match(grid, /<span class="k">Interest rate<\/span><span class="v ">7\.4%<\/span>/);
  assert.match(grid, /<span class="k">Maturity date<\/span><span class="v ">10 Feb 2030<\/span>/);
  assert.match(grid, /<span class="k">Next interest<\/span><span class="v ">₹ 26,640\.00/);
  assert.match(grid, /<span class="k">Invested<\/span><span class="v ">₹ 8,00,000\.00<\/span>/);
  assert.match(grid, /<span class="k">Market value<\/span><span class="v ">₹ 8,14,400\.00/);
  assert.match(grid, /<span class="k">Current yield<\/span><span class="v ">6\.54%<\/span>/);
});

test("the card anchors on total if held, with the gain beneath it", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.match(card, /<div class="bond-anchor"[^>]*>[\s\S]*?<span class="k">Total if held<\/span>/);
  assert.match(card, /<span class="k">Total if held<\/span>\s*<span class="v">₹ [\d,]+\.\d{2}<\/span>/);
  assert.match(card, /<span class="sub pos">\+₹ [\d,]+\.\d{2} gain<\/span>/);
});

test("the interest progress is in the card body, above the disclosure", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  const detailsAt = card.indexOf('<details class="bond-breakdown"');
  assert.ok(detailsAt > -1, "the card has one Full breakdown");
  const body = card.slice(0, detailsAt);
  const disclosure = card.slice(detailsAt);
  assert.match(body, /class="bond-progress"[^>]*data-fact="interest-progress"/);
  assert.match(body, /data-fact="interest-progress"[^>]*data-surface="row"/);
  assert.doesNotMatch(disclosure, /data-fact="interest-progress"/,
    "the progress is not a disclosure fact");
});

test("record facts stay on the card behind one Full breakdown", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.match(card, /<details class="bond-breakdown"[^>]*><summary>Full breakdown<\/summary>/);
  const breakdown = card.slice(card.indexOf('<details class="bond-breakdown"'));
  for (const label of ["Purchase date", "Units", "Face at issue", "Payment frequency",
    "Purchase yield", "Purchase rating", "Per unit", "Current rating",
    "Principal returned", "Principal left", "Gain if sold now"]) {
    assert.match(breakdown, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${label} is still on the card`);
  }
  assert.match(breakdown, /Principal returned<\/span><span class="v ">₹ 80,000\.00/);
  assert.match(breakdown, /Principal left<\/span><span class="v ">₹ 7,20,000\.00/);
  assert.doesNotMatch(breakdown, /Maturity value/,
    "the anchor already carries the maturity total");
});

test("the card names all four actions and no glyph-only edit", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.deepEqual(sorted(actionLabels(card)), ["Edit", "Refresh", "Remove", "SMEST ↗"]);
  assert.doesNotMatch(card, /✎/, "no icon-only action survives");
});

test("bondFacts is one ordered list with unique keys and one anchor", () => {
  const facts = bondFacts(bondRowView(row), { assetId: "acct-1" });
  const keys = facts.map((fact) => fact.key);
  assert.equal(new Set(keys).size, keys.length, "a key appears once");
  assert.equal(facts[0].kind, "anchor", "the anchor leads");
  assert.ok(facts.some((fact) => fact.kind === "progress"), "the progress ranks with the row");
  assert.ok(facts.some((fact) => fact.kind === "sources"), "the sources are a band fact");
});

test("the ledger row and band partition the card's own fact keys", () => {
  const view = { ...bondRowView(row), matured: false };
  const card = bondCardHtml(view, "acct-1");
  const ledger = bondLedgerHtml([view], "acct-1", { selectedId: "lot-1" });
  const cardRow = keysOn(card, "row", "data-fact");
  const cardBand = keysOn(card, "band", "data-fact");
  const rowKeys = keysOn(ledger, "row", "data-row-fact");
  const bandKeys = keysOn(ledger, "band", "data-fact");
  assert.deepEqual(sorted(rowKeys), sorted(cardRow), "the row is the card's row-ranked set");
  assert.deepEqual(sorted(bandKeys), sorted(cardBand), "the band is the card's band-ranked set");
  assert.deepEqual(rowKeys.filter((key) => bandKeys.includes(key)), [], "no fact is in both");
  assert.deepEqual(sorted([...rowKeys, ...bandKeys]), sorted([...cardRow, ...cardBand]),
    "the union is every card fact");
  assert.equal(rowKeys.filter((key) => key === "interest-progress").length, 1,
    "the interest progress ranks with the row");
  assert.equal(bandKeys.filter((key) => key === "sources").length, 1,
    "the sources rank with the band");
});

test("the band follows the card's sections in the card's order", () => {
  const view = { ...bondRowView(row), matured: false };
  const card = bondCardHtml(view, "acct-1");
  const ledger = bondLedgerHtml([view], "acct-1", { selectedId: "lot-1" });
  const cardSections = [...card.matchAll(/<h3 class="bond-section-title">([^<]+)<\/h3>/g)]
    .map((match) => match[1]);
  const bandSections = [...ledger.matchAll(/<div class="bl-col" data-section="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(cardSections, BOND_BAND_SECTIONS);
  assert.deepEqual(bandSections, BOND_BAND_SECTIONS);
});

test("the first row opens on load and selecting another moves the band", () => {
  const first = { ...bondRowView(row), matured: false };
  const second = { ...bondRowView({ ...row, id: "lot-2",
    label: "8.10% TEST BOND 2 20 Nov 2028", couponPct: 8.1,
    maturity: "2028-11-20" }), matured: false };
  const initial = bondLedgerHtml([first, second], "acct-1");
  assert.match(initial, /data-bond-id="lot-1"[^>]*aria-expanded="true"/);
  assert.equal(openBands(initial).length, 1);
  assert.match(openBands(initial)[0], /data-band-id="lot-1"/);

  const switched = bondLedgerHtml([first, second], "acct-1", { selectedId: "lot-2" });
  assert.match(switched, /data-bond-id="lot-2"[^>]*aria-expanded="true"/);
  assert.match(switched, /data-bond-id="lot-1"[^>]*aria-expanded="false"/);
  assert.equal(openBands(switched).length, 1, "one band is open, never two");
  assert.match(openBands(switched)[0], /data-band-id="lot-2"/);
});

test("the coupon stays in the row identifier, added only when the name lacks it", () => {
  const named = { ...bondRowView(row), matured: false };
  const namedLedger = bondLedgerHtml([named], "acct-1", { selectedId: "lot-1" });
  assert.doesNotMatch(namedLedger.slice(namedLedger.indexOf('class="bl-id"')),
    /class="bl-coupon"/, "the name already carries 7.40%");

  const unnamed = { ...bondRowView({ ...row, label: "TEST BOND WITHOUT A RATE",
    couponPct: 7.4 }), matured: false };
  const unnamedLedger = bondLedgerHtml([unnamed], "acct-1", { selectedId: "lot-1" });
  assert.match(unnamedLedger, /class="bl-coupon">7\.4%<\/span>/);
  assert.match(unnamedLedger, /data-row-fact="coupon"/);
});

test("every card action exists in the band and the band invents none", () => {
  const view = { ...bondRowView(row), matured: false };
  const card = bondCardHtml(view, "acct-1");
  const ledger = bondLedgerHtml([view], "acct-1", { selectedId: "lot-1" });
  assert.deepEqual(sorted(actionLabels(card)), sorted(actionLabels(ledger)));
});

test("a missing market value keeps the Enter it action on both surfaces", () => {
  const view = { ...bondRowView({ ...row, value_paise: null, as_of: null }),
    matured: false };
  const card = bondCardHtml(view, "acct-1");
  const ledger = bondLedgerHtml([view], "acct-1", { selectedId: "lot-1" });
  assert.ok(actionLabels(card).includes("Enter it"));
  assert.ok(actionLabels(ledger).includes("Enter it"));
  assert.deepEqual(sorted(actionLabels(card)), sorted(actionLabels(ledger)));
});

test("a matured lot keeps its own anchor, table and carried note", () => {
  const view = { ...bondRowView(maturedRow), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  const ledger = bondLedgerHtml([view], "acct-1", { maturedValue: 50000000 });
  const cardRow = keysOn(card, "row", "data-fact");
  const cardBand = keysOn(card, "band", "data-fact");
  assert.deepEqual(sorted(keysOn(ledger, "row", "data-row-fact")), sorted(cardRow));
  assert.deepEqual(sorted(keysOn(ledger, "band", "data-fact")), sorted(cardBand));
  assert.deepEqual(keysOn(ledger, "row", "data-row-fact")
    .filter((key) => keysOn(ledger, "band", "data-fact").includes(key)), []);
  assert.match(ledger, /Value in net worth/);
  assert.match(ledger, /carried until matched/);
  assert.match(ledger, /Matured · awaiting payment/);
  assert.doesNotMatch(ledger, /Total if held/,
    "the matured table does not borrow the live anchor");
  assert.doesNotMatch(ledger, /data-fact="next-interest"/);
  assert.doesNotMatch(ledger, /data-fact="market-value"/);
  assert.match(card, /<span class="bond-matured-badge">Matured · awaiting payment<\/span>/);
  assert.match(card, /<span class="k">Value in net worth<\/span>/);
  assert.doesNotMatch(card, /data-fact="interest-progress"/,
    "a matured lot has no future interest progress");
  assert.deepEqual(visibleKeys(card), BOND_MATURED_FACTS.map((fact) => fact.key));
  assert.deepEqual(sorted(actionLabels(card)), sorted(actionLabels(ledger)));
});

test("selecting a matured row opens the matured band, not the live one", () => {
  const live = { ...bondRowView(row), matured: false };
  const matured = { ...bondRowView(maturedRow), matured: true };
  const ledger = bondLedgerHtml([live, matured], "acct-1", { selectedId: "lot-2" });
  assert.match(ledger, /data-bond-id="lot-1"[^>]*aria-expanded="false"/);
  assert.match(ledger, /data-bond-id="lot-2"[^>]*aria-expanded="true"/);
  assert.equal(openBands(ledger).length, 1);
  assert.match(openBands(ledger)[0], /data-band-id="lot-2"/);
});

test("a manual lot names manual as its source", () => {
  const live = { ...bondRowView({ ...row, source: "manual", value_source: "Manual" }),
    matured: false };
  const liveCard = bondCardHtml(live, "acct-1");
  assert.match(liveCard, /data-fact="sources"[^>]*>manual/);
  assert.doesNotMatch(liveCard, /data-fact="sources"[^>]*>CAS/);
  const matured = { ...bondRowView({ ...maturedRow, source: "manual" }), matured: true };
  assert.match(bondCardHtml(matured, "acct-1", { matured: true }),
    /data-fact="sources"[^>]*>Terms entered by hand/);
});

test("money keeps Indian grouping and two paise digits", () => {
  assert.equal(moneyText(81440000), "₹ 8,14,400.00");
  assert.equal(moneyText(100000000), "₹ 10,00,000.00");
  assert.equal(moneyText(0), "₹ 0.00");
  assert.equal(moneyText(null), "—");
});
