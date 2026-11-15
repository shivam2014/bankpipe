import test from "node:test";
import assert from "node:assert/strict";
import {
  BOND_CARD_FACTS, BOND_MATURED_FACTS, BOND_INDEX_FACTS,
  bondRowView, bondCardHtml, bondBookHtml, moneyText,
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

// The visible grid is the six-fact budget. The breakdown below it carries the
// record facts and must never inflate this number.
function visibleFacts(html) {
  const at = html.indexOf('<div class="bond-grid bond-facts">');
  assert.ok(at > -1, "the card has a visible facts grid");
  const end = html.indexOf('<details class="bond-breakdown">', at);
  assert.ok(end > at, "the visible facts grid closes before the breakdown");
  return html.slice(at, end);
}

function dossierOf(book) {
  const at = book.indexOf('id="bond-dossier"');
  assert.ok(at > -1, "the book has a dossier");
  return book.slice(at);
}

test("the live card shows exactly six facts, all in the declared order", () => {
  const view = bondRowView(row);
  const card = bondCardHtml(view, "acct-1");
  const grid = visibleFacts(card);
  const keys = [...grid.matchAll(/data-fact="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, BOND_CARD_FACTS.map((f) => f.key));
  assert.equal(keys.length, 6, "a seventh visible fact breaks the budget");
  for (const fact of BOND_CARD_FACTS) {
    assert.match(grid, new RegExp(`data-fact="${fact.key}"[\\s\\S]*?<span class="k">${fact.label}</span>`),
      `${fact.label} is visible on the card`);
  }
});

test("the live card carries each fact's number, not a bare label", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  const grid = visibleFacts(card);
  assert.match(grid, /<span class="k">Interest rate<\/span><span class="v ">7\.4%<\/span>/);
  assert.match(grid, /<span class="k">Maturity date<\/span><span class="v ">10 Feb 2030<\/span>/);
  assert.match(grid, /<span class="k">Next interest<\/span><span class="v ">₹ 26,640\.00/);
  assert.match(grid, /<span class="k">Invested<\/span><span class="v ">₹ 8,00,000\.00<\/span>/);
  assert.match(grid, /<span class="k">Market value<\/span><span class="v ">₹ 8,14,400\.00/);
  assert.match(grid, /<span class="k">Current yield<\/span><span class="v ">6\.54%<\/span>/);
});

test("the card anchors on total if held, with the gain beneath it", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.match(card, /<div class="bond-anchor">[\s\S]*?<span class="k">Total if held<\/span>/);
  assert.match(card, /<span class="k">Total if held<\/span>\s*<span class="v">₹ [\d,]+\.\d{2}<\/span>/);
  assert.match(card, /<span class="sub pos">\+₹ [\d,]+\.\d{2} gain<\/span>/);
});

test("record facts stay on the card behind one Full breakdown", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.match(card, /<details class="bond-breakdown"><summary>Full breakdown<\/summary>/);
  const breakdown = card.slice(card.indexOf('<details class="bond-breakdown">'));
  for (const label of ["Purchase date", "Units", "Face at issue", "Payment frequency",
    "Purchase yield", "Purchase rating", "Per unit", "Current rating",
    "Principal returned", "Principal left", "Gain if sold now", "Maturity value",
    "Interest received"]) {
    assert.match(breakdown, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${label} is still on the card`);
  }
  assert.match(breakdown, /Principal returned<\/span><span class="v ">₹ 80,000\.00/);
  assert.match(breakdown, /Principal left<\/span><span class="v ">₹ 7,20,000\.00/);
});

test("the card names all four actions and no glyph-only edit", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  const actions = card.slice(card.indexOf('<div class="bond-card-actions">'),
    card.indexOf("</div>", card.indexOf('<div class="bond-card-actions">')));
  for (const label of ["SMEST ↗", "Refresh", "Edit", "Remove"]) {
    assert.match(actions, new RegExp(`>${label}<`), `${label} is a labelled button`);
  }
  assert.doesNotMatch(card, /✎/, "no icon-only action survives");
});

test("the desktop dossier is the phone card verbatim, fact for fact", () => {
  const view = { ...bondRowView(row), matured: false };
  const card = bondCardHtml(view, "acct-1");
  const book = bondBookHtml([view], "acct-1");
  assert.ok(book.includes(card), "the dossier embeds the card exactly");
  const dossier = dossierOf(book);
  assert.match(dossier, /<div class="bond-card" data-bond-card="lot-1"/);
  const grid = visibleFacts(dossier);
  for (const fact of BOND_CARD_FACTS) {
    assert.match(grid, new RegExp(`data-fact="${fact.key}"[\\s\\S]*?<span class="k">${fact.label}</span>`),
      `${fact.label} is in the desktop dossier`);
  }
  assert.equal([...grid.matchAll(/data-fact="/g)].length, 6);
});

test("the index carries comparison only, in five labelled columns", () => {
  const view = { ...bondRowView(row), matured: false };
  const book = bondBookHtml([view], "acct-1");
  const index = book.slice(book.indexOf('<div class="bond-index">'), book.indexOf('id="bond-dossier"'));
  for (const fact of BOND_INDEX_FACTS) {
    assert.match(index, new RegExp(`>${fact.label}<`), `${fact.label} is an index column`);
  }
  assert.match(index, /7\.40% TEST BOND 3 10 Feb 2030/);
  assert.match(index, /₹ 8,14,400\.00/);
  assert.match(index, /6\.54%/);
  assert.match(index, /₹ 26,640\.00/);
  assert.match(index, /10 Feb 2030/);
  assert.doesNotMatch(book, /<table/, "the table is gone");
});

test("selecting a different row changes the dossier, not the index", () => {
  const first = { ...bondRowView(row), matured: false };
  const second = { ...bondRowView({ ...row, id: "lot-2",
    label: "8.10% TEST BOND 2 20 Nov 2028", couponPct: 8.1,
    maturity: "2028-11-20" }), matured: false };
  const book = bondBookHtml([first, second], "acct-1", { selectedId: "lot-2" });
  const dossier = dossierOf(book);
  assert.match(dossier, /data-bond-card="lot-2"/);
  assert.doesNotMatch(dossier, /data-bond-card="lot-1"/);
  assert.match(book, /data-bond-id="lot-1"/);
  assert.match(book, /data-bond-id="lot-2"/);
  assert.match(book, /data-bond-id="lot-2"\s+aria-pressed="true"/);
});

test("a matured lot carries the badge, six matured facts and no live anchor", () => {
  const view = { ...bondRowView(maturedRow), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  assert.match(card, /<span class="bond-matured-badge">Matured · awaiting payment<\/span>/);
  assert.match(card, /<span class="k">Value in net worth<\/span>/);
  assert.doesNotMatch(card, /<span class="k">Total if held<\/span>/);
  assert.doesNotMatch(card, /<span class="k">Next interest<\/span>/);
  const grid = visibleFacts(card);
  const keys = [...grid.matchAll(/data-fact="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, BOND_MATURED_FACTS.map((f) => f.key));
  assert.doesNotMatch(grid, /Value in net worth/,
    "the carrying value is the anchor, not a seventh fact");
  for (const fact of BOND_MATURED_FACTS) {
    assert.match(grid, new RegExp(`data-fact="${fact.key}"[\\s\\S]*?<span class="k">${fact.label}</span>`),
      `${fact.label} is visible on a matured card`);
  }
  const book = bondBookHtml([view], "acct-1", { maturedValue: 50000000 });
  assert.match(dossierOf(book), /Matured · awaiting payment/);
});

test("a matured index row offers no live yield or next interest", () => {
  const view = { ...bondRowView(maturedRow), matured: true };
  const book = bondBookHtml([view], "acct-1", { maturedValue: 50000000 });
  const index = book.slice(book.indexOf('<div class="bond-index">'), book.indexOf('id="bond-dossier"'));
  assert.match(index, /data-bond-id="lot-2"[\s\S]*?<span class="bi-num">₹ 5,00,000\.00<\/span>/);
  assert.match(index, /data-bond-id="lot-2"[\s\S]*?<span class="bi-num">—<\/span>\s*<span class="bi-num">—<\/span>/);
  assert.match(index, /Matured · awaiting payment/);
});

test("money keeps Indian grouping and two paise digits", () => {
  assert.equal(moneyText(81440000), "₹ 8,14,400.00");
  assert.equal(moneyText(100000000), "₹ 10,00,000.00");
  assert.equal(moneyText(0), "₹ 0.00");
  assert.equal(moneyText(null), "—");
});
