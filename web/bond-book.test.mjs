import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as book from "./bond-book.js";
import {
  BOND_SECTIONS, bondFacts, bondRowView, bondCardHtml, bondBookSummary,
  moneyText, bondDateLabel,
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

const LIVE_KEYS = [
  "total-if-held", "principal-returned", "principal-left", "next-interest",
  "gain-if-sold", "interest-progress",
  "market-value", "per-unit", "current-yield", "current-rating",
  "invested", "units", "purchase-date", "face-at-issue", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];

const MATURED_KEYS = [
  "value-in-net-worth", "principal-returned", "principal-left",
  "invested", "units", "purchase-date", "face-value", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];

const sorted = (values) => [...values].sort();

// Every opening tag, so a fact's section is read from the DOM the renderer
// emitted rather than from a second hand-written list.
function tags(html) {
  return [...html.matchAll(/<[^>]*>/g)].map((match) => match[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : "";
}

function factKeys(html) {
  return tags(html).map((tag) => attr(tag, "data-fact")).filter(Boolean);
}

function sectionBlocks(html) {
  const starts = [...html.matchAll(/<div class="bond-section" data-section="([^"]+)">/g)]
    .map((match) => ({ section: match[1], at: match.index }));
  return starts.map((start, index) => ({
    section: start.section,
    html: html.slice(start.at, index + 1 < starts.length ? starts[index + 1].at : html.length),
  }));
}

function sectionTitles(html) {
  return [...html.matchAll(/<h3 class="bond-section-title">([^<]+)<\/h3>/g)]
    .map((match) => match[1]);
}

function sectionOf(html, section) {
  const block = sectionBlocks(html).find((item) => item.section === section);
  assert.ok(block, `the card has a ${section} section`);
  return block.html;
}

function actionLabels(html) {
  return [...html.matchAll(/<[^>]*data-bond-action="[^"]*"[^>]*>([\s\S]*?)<\/(?:button|a)>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, "").trim())
    .filter(Boolean);
}

test("bondFacts is one ordered list with unique keys and one anchor", () => {
  const facts = bondFacts(bondRowView(row), { assetId: "acct-1" });
  const keys = facts.map((fact) => fact.key);
  assert.equal(new Set(keys).size, keys.length, "a key appears once");
  assert.deepEqual(keys, LIVE_KEYS);
  assert.equal(facts.filter((fact) => fact.kind === "anchor").length, 1,
    "exactly one anchor");
  assert.equal(facts[0].kind, "anchor", "the anchor leads");
  assert.equal(facts[0].key, "total-if-held");
  assert.ok(facts.some((fact) => fact.kind === "progress"), "the progress ranks inline");
  assert.ok(facts.some((fact) => fact.kind === "sources"), "the sources are the foot");
});

test("the fact list follows Returns, Market value, Purchase", () => {
  const facts = bondFacts(bondRowView(row), { assetId: "acct-1" });
  assert.deepEqual([...new Set(facts.map((fact) => fact.section))], BOND_SECTIONS);
  assert.deepEqual(BOND_SECTIONS, ["Returns", "Market value", "Purchase"]);
  const returns = facts.filter((fact) => fact.section === "Returns").map((fact) => fact.key);
  assert.deepEqual(returns, ["total-if-held", "principal-returned", "principal-left",
    "next-interest", "gain-if-sold", "interest-progress"]);
});

test("the live card renders every fact key exactly once, in its own section", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.deepEqual(factKeys(card), LIVE_KEYS);
  assert.equal(new Set(factKeys(card)).size, factKeys(card).length,
    "no fact renders twice");

  const declared = bondFacts(bondRowView(row), { assetId: "acct-1" })
    .map((fact) => `${fact.section}:${fact.key}`);
  const rendered = sectionBlocks(card).flatMap((block) => [...block.html
    .matchAll(/data-fact="([^"]+)"/g)].map((match) => `${block.section}:${match[1]}`));
  assert.deepEqual(rendered, declared, "each fact sits in its declared section");

  assert.deepEqual(sectionTitles(card), BOND_SECTIONS);
});

test("the pull request keeps production's Purchase, Market and Returns facts inline", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  for (const key of ["principal-returned", "principal-left", "gain-if-sold",
    "current-rating", "per-unit", "frequency", "purchase-yield",
    "purchase-rating", "face-at-issue"]) {
    assert.equal(factKeys(card).filter((seen) => seen === key).length, 1,
      `${key} survives inline`);
  }
  assert.match(sectionOf(card, "Returns"),
    /data-fact="principal-returned"[^>]*><span class="k">Principal returned<\/span><span class="v ">₹ 80,000\.00/);
  assert.match(sectionOf(card, "Returns"),
    /data-fact="principal-left"[^>]*><span class="k">Principal left<\/span><span class="v ">₹ 7,20,000\.00/);
});

test("Total if held leads Returns as the one 24px figure, not a tinted block", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  const facts = bondFacts(bondRowView(row), { assetId: "acct-1" });
  assert.equal(facts[0].key, "total-if-held");
  assert.equal(facts[0].section, "Returns");
  assert.match(card, /<div class="bond-fact bond-fact-anchor" data-fact="total-if-held" data-section="Returns">/);
  assert.match(card, /<span class="k">Total if held<\/span><span class="v ">₹ [\d,]+\.\d{2}/);
  assert.match(card, /<span class="sub pos">\+₹ [\d,]+\.\d{2} gain<\/span>/);
  assert.doesNotMatch(card, /class="bond-anchor"/);
  assert.doesNotMatch(card, /<div class="bond-anchor"/);
});

test("the interest progress is the one tinted block and sits in Returns", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.equal((card.match(/class="bond-progress"/g) || []).length, 1);
  assert.match(sectionOf(card, "Returns"),
    /class="bond-progress" data-fact="interest-progress" data-section="Returns"/);
  assert.doesNotMatch(sectionOf(card, "Market value"), /bond-progress/);
  assert.doesNotMatch(card, /bond-progress-empty/);
});

test("the card has no disclosure and no ledger remnant", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.doesNotMatch(card, /<details/);
  assert.doesNotMatch(card, /<summary/);
  assert.doesNotMatch(card, /bond-breakdown/);
  assert.doesNotMatch(card, /class="bl-/);
});

test("the card names all four actions and no glyph-only edit", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1");
  assert.deepEqual(sorted(actionLabels(card)), ["Edit", "Refresh", "Remove", "SMEST ↗"]);
  assert.doesNotMatch(card, /✎/, "no icon-only action survives");
});

test("a missing market value keeps Enter it inline", () => {
  const view = { ...bondRowView({ ...row, value_paise: null, as_of: null }),
    matured: false };
  const card = bondCardHtml(view, "acct-1");
  assert.equal(actionLabels(card).filter((label) => label === "Enter it").length, 1);
  assert.match(sectionOf(card, "Market value"), /data-fact="market-value"/);
  assert.match(sectionOf(card, "Market value"), /not recorded · <button class="vupdate"/);
  assert.match(sectionOf(card, "Market value"),
    /data-fact="per-unit"[^>]*>[\s\S]*?needs a market value/);
  assert.match(sectionOf(card, "Returns"),
    /data-fact="gain-if-sold"[^>]*>[\s\S]*?needs a market value/);
});

test("a missing figure says why instead of a bare dash", () => {
  const view = { ...bondRowView({ ...row, returned_paise: 0, returned_at: "",
    redemption_dates: "" }), matured: false };
  const card = bondCardHtml(view, "acct-1");
  assert.match(sectionOf(card, "Returns"),
    /<span class="k">Principal returned<\/span><span class="v ">—<span class="sub ">none yet<\/span>/);
  const noDate = { ...bondRowView({ ...row, purchase_date: "" }), matured: false };
  assert.match(sectionOf(bondCardHtml(noDate, "acct-1"), "Purchase"),
    /<span class="k">Purchase date<\/span><span class="v ">—<span class="sub ">not in the statement<\/span>/);
});

test("a matured lot leads with Value in net worth and carries no future facts", () => {
  const view = { ...bondRowView(maturedRow), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  assert.deepEqual(factKeys(card), MATURED_KEYS);
  assert.deepEqual(sectionTitles(card), ["Returns", "Purchase"],
    "a matured lot has no market section");
  assert.match(card, /<span class="bond-matured-badge">Matured · awaiting payment<\/span>/);
  assert.match(card, /<div class="bond-fact bond-fact-anchor" data-fact="value-in-net-worth" data-section="Returns">/);
  assert.match(card, /<span class="k">Value in net worth<\/span>/);
  assert.match(card, /<span class="sub ">stays in net worth until a bank credit is matched<\/span>/);
  assert.doesNotMatch(card, /Total if held/);
  assert.doesNotMatch(card, /data-fact="interest-progress"/);
  assert.doesNotMatch(card, /class="bond-progress"/);
  assert.doesNotMatch(card, /data-fact="next-interest"/);
  assert.doesNotMatch(card, /data-fact="market-value"/);
  assert.match(sectionOf(card, "Purchase"), /data-fact="face-value"[^>]*><span class="k">Face value<\/span>/);
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

test("bondBookSummary adds the live book and weights interest by coupon", () => {
  const summary = bondBookSummary([
    { matured: false, ba: { lifetimeTotal: 100000 }, principalLeft: 40000,
      pastCoupon: 2500, originalCoupon: 10000 },
    { matured: false, ba: { lifetimeTotal: 50000 }, principalLeft: 10000,
      pastCoupon: 500, originalCoupon: 5000 },
    { matured: true, ba: { lifetimeTotal: 999999 }, principalLeft: 999,
      pastCoupon: 9, originalCoupon: 10 },
  ]);
  assert.deepEqual(summary, {
    count: 2, totalIfHeld: 150000, principalLeft: 50000, interestPct: 20,
  });
  assert.equal(bondBookSummary([]), null);
  assert.equal(bondBookSummary([{ matured: true, ba: { lifetimeTotal: 1 } }]), null);
});

test("bondBookSummary reads the same total the card anchor shows", () => {
  const view = { ...bondRowView(row), matured: false };
  const anchor = bondFacts(view, { assetId: "acct-1" })
    .find((fact) => fact.key === "total-if-held");
  const summary = bondBookSummary([view]);
  assert.equal(summary.count, 1);
  assert.equal(moneyText(summary.totalIfHeld), anchor.value);
  assert.equal(summary.principalLeft, 72000000);
  assert.ok(summary.interestPct > 0 && summary.interestPct <= 100);
});

test("the module no longer exports the ledger", () => {
  assert.equal(book.bondLedgerHtml, undefined);
  for (const name of ["ledgerRow", "ledgerBand", "bandKv", "rowProgress",
    "bandIdOf", "maturedNote"]) {
    assert.equal(book[name], undefined, `${name} is gone`);
  }
});

test("index.html and the card module carry no ledger or disclosure remnant", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("./bond-book.js", import.meta.url), "utf8");
  for (const marker of [".bond-ledger", ".bl-", ".bond-anchor", ".bond-breakdown",
    "bpBondSelected", "bpBondSelect", "bpBondCardToggle", "matured-bonds"]) {
    assert.equal(html.includes(marker), false, `${marker} is gone from index.html`);
  }
  for (const marker of ["bondLedgerHtml", "ledgerRow", "ledgerBand", "bandKv",
    "rowProgress", "bandIdOf", "maturedNote"]) {
    assert.equal(source.includes(marker), false, `${marker} is gone from bond-book.js`);
  }
  assert.doesNotMatch(html, /\.bond-fact-anchor\{[^}]*background/,
    "the anchor carries no tint");
});

test("the card grid is two equal columns at desktop and one below", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html,
    /\.bond-cards\{display:grid;grid-template-columns:minmax\(0,1fr\);gap:16px;margin-top:10px;max-width:720px\}/);
  assert.match(html,
    /@media \(min-width:1000px\)\{\s*\.bond-cards\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);max-width:none\}/);
  assert.match(html,
    /\.bond-card \.bond-grid-purchase\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(html, /\.mini-btn:focus-visible,\.vupdate:focus-visible,\.sortbtn:focus-visible\{\s*outline:2px solid var\(--green\);outline-offset:2px\}/,
    "bond actions and sort controls show a focus ring");
});

test("money keeps Indian grouping and two paise digits", () => {
  assert.equal(moneyText(81440000), "₹ 8,14,400.00");
  assert.equal(moneyText(100000000), "₹ 10,00,000.00");
  assert.equal(moneyText(0), "₹ 0.00");
  assert.equal(moneyText(null), "—");
});

test("dates keep the day, short month and year", () => {
  assert.equal(bondDateLabel("2030-02-10"), "10 Feb 2030");
  assert.equal(bondDateLabel(""), "");
});
