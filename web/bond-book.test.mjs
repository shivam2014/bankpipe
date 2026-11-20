import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as book from "./bond-book.js";
import { splitMatured } from "./bonds.js";
import {
  BOND_SECTIONS, BOND_GAP_COPY, bondFacts, bondRowView, bondCardHtml,
  bondBookSummary, bondCardGap, bondCoverageText, bondGapBannerHtml, moneyText,
  bondDateLabel,
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

// Terms live only in the dashed name: no couponPct and no maturity field.
const dashedRow = {
  id: "lot-dashed", category: "bond", label: "TESTD-11.90%-3-12-26-PVT",
  issuer: "TEST DASHED ISSUER", security_id: "INE000000124",
  quantity: 2, cost_paise: 20000000, value_paise: 21000000,
  value_source: "CAS", as_of: "2026-10-31", purchase_date: "2024-06-06",
  frequency: "Monthly", rating: "ICRA BBB / Stable",
  rating_at_purchase: "ICRA BBB / Stable", source: "report",
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

function footOf(html) {
  return html.match(/data-fact="sources"[^>]*>([^<]*)</)?.[1] || "";
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

test("a coupon and maturity read from the name are both marked guesses", () => {
  const view = bondRowView(dashedRow);
  assert.equal(view.coupon, 11.9);
  assert.equal(view.couponSource, "label");
  assert.equal(view.couponGuessed, true);
  assert.equal(view.maturity, "2026-12-03");
  assert.equal(view.maturityGuessed, true);
  const facts = bondFacts(view);
  const coupon = facts.find((fact) => fact.key === "coupon");
  const maturity = facts.find((fact) => fact.key === "maturity");
  assert.equal(coupon.value, "11.9%");
  assert.equal(coupon.sub, "read from the bond name");
  assert.equal(coupon.subTone, "amber");
  assert.equal(maturity.value, "03 Dec 2026");
  assert.equal(maturity.sub, "read from the bond name");
  assert.equal(maturity.subTone, "amber");
  assert.match(sectionOf(bondCardHtml(view, "acct-1"), "Purchase"),
    /data-fact="coupon"[\s\S]*?read from the bond name/);
});

test("a stated coupon keeps its value and loses the guess note", () => {
  const view = bondRowView({ ...dashedRow, couponPct: 9.5 });
  assert.equal(view.coupon, 9.5);
  assert.equal(view.couponSource, "stored");
  assert.equal(view.couponGuessed, false);
  const coupon = bondFacts(view).find((fact) => fact.key === "coupon");
  assert.equal(coupon.value, "9.5%");
  assert.equal(coupon.sub, "");
  assert.equal(coupon.subTone, "");
});

test("a stated maturity loses the guess note", () => {
  const view = bondRowView({ ...dashedRow, maturity: "2031-01-01" });
  assert.equal(view.maturity, "2031-01-01");
  assert.equal(view.maturityGuessed, false);
  const maturity = bondFacts(view).find((fact) => fact.key === "maturity");
  assert.equal(maturity.value, "01 Jan 2031");
  assert.equal(maturity.sub, "");
  assert.equal(maturity.subTone, "");
});

test("terms stored from a lookup render plain with their source and date", () => {
  const view = bondRowView({ ...dashedRow, coupon_pct: 9.5,
    coupon_source: "SMEST", coupon_as_of: "2026-11-16",
    maturity: "2029-10-07", maturity_source: "SMEST",
    maturity_as_of: "2026-11-16" });
  assert.equal(view.coupon, 9.5);
  assert.equal(view.couponGuessed, false);
  assert.equal(view.maturity, "2029-10-07");
  assert.equal(view.maturityGuessed, false);
  const facts = bondFacts(view);
  const coupon = facts.find((fact) => fact.key === "coupon");
  const maturity = facts.find((fact) => fact.key === "maturity");
  assert.equal(coupon.sub, "from SMEST · 16 Nov 2026");
  assert.equal(coupon.subTone, "");
  assert.equal(maturity.sub, "from SMEST · 16 Nov 2026");
  assert.equal(maturity.subTone, "");
  assert.doesNotMatch(sectionOf(bondCardHtml(view, "acct-1"), "Purchase"),
    /read from the bond name/);
});

test("a hand-entered term says so and a report keeps its name", () => {
  const manual = bondFacts(bondRowView({ ...dashedRow, coupon_pct: 9.5,
    coupon_source: "Manual", coupon_as_of: "2026-11-16" }))
    .find((fact) => fact.key === "coupon");
  assert.equal(manual.sub, "entered by hand · 16 Nov 2026");
  assert.equal(manual.subTone, "");

  const report = bondFacts(bondRowView({ ...dashedRow,
    maturity: "2029-10-07", maturity_source: "DigiFInn investment report",
    maturity_as_of: "2026-10-31" })).find((fact) => fact.key === "maturity");
  assert.equal(report.sub, "from DigiFInn investment report · 31 Oct 2026");
  assert.equal(report.subTone, "");
});

test("a stored value with no provenance stays plain rather than invented", () => {
  const coupon = bondFacts(bondRowView({ ...dashedRow, couponPct: 9.5 }))
    .find((fact) => fact.key === "coupon");
  assert.equal(coupon.sub, "");
  assert.equal(coupon.subTone, "");
});

test("the name's terms make Total if held and Next interest compute", () => {
  const view = bondRowView(dashedRow);
  const facts = bondFacts(view);
  const total = facts.find((fact) => fact.key === "total-if-held");
  const next = facts.find((fact) => fact.key === "next-interest");
  // The CAS value is a statement figure now, so a gain needs a market source.
  const gain = bondFacts(bondRowView({ ...dashedRow, value_source: "BSE" }))
    .find((fact) => fact.key === "gain-if-sold");
  assert.notEqual(total.value, "—");
  assert.match(total.sub, /gain/);
  assert.notEqual(next.value, "—");
  assert.match(next.sub, /estimated/);
  assert.notEqual(gain.value, "—");
});

test("a rounding gap in the coupon estimate is not called a repayment", () => {
  const view = bondRowView(dashedRow);
  assert.equal(view.returned, 0);
  const progress = bondFacts(view).find((fact) => fact.key === "interest-progress");
  assert.equal(progress.progress.note, "original schedule · estimated");
});

test("a real repayment still carries the early-repayment note", () => {
  const view = bondRowView(row);
  assert.ok(view.returned > 0);
  const progress = bondFacts(view).find((fact) => fact.key === "interest-progress");
  assert.match(progress.progress.note, /less after the early repayment/);
});

test("a returned amount with no date is not called an early repayment", () => {
  // A face below the cost-implied one is money already back, but nothing says
  // when. The estimate is not reduced by a date, so the gap is rounding.
  const view = bondRowView({ ...dashedRow, face_paise: 8000, returned_paise: 4000000 });
  assert.ok(view.returned > 0);
  assert.equal(view.returnedAt, "");
  const progress = bondFacts(view).find((fact) => fact.key === "interest-progress");
  assert.equal(progress.progress.note, "original schedule · estimated");
});

test("a redemption date with nothing returned is not an early repayment", () => {
  const view = bondRowView({ ...dashedRow, redemption_dates: "2025-01-15" });
  assert.equal(view.returned, 0);
  assert.ok(view.ba.firstPast);
  assert.ok(view.couponLost > 0, "the rounding gap is what the old gate fired on");
  const progress = bondFacts(view).find((fact) => fact.key === "interest-progress");
  assert.equal(progress.progress.note, "original schedule · estimated");
});

test("principal dates alone are not called an early repayment", () => {
  // The estimate only shrinks on a past redemption date. A principal schedule
  // that is now in the past does not shrink it, so the gap stays rounding.
  const view = bondRowView({
    ...dashedRow, face_paise: 1000000, returned_paise: 2000000,
    future_principal_paise: 8000000, interest_date: "2026-12-01",
    principal_dates: "2026-01-15,2027-01-15,2028-01-15",
  });
  assert.ok(view.returned > 0);
  assert.equal(view.ba.firstPast, "");
  const progress = bondFacts(view).find((fact) => fact.key === "interest-progress");
  assert.equal(progress.progress.note, "original schedule · estimated");
});

test("a cumulative bond is not told its frequency is missing", () => {
  const view = bondRowView({ ...dashedRow, frequency: "Cumulative" });
  assert.equal(bondFacts(view).find((fact) => fact.key === "frequency").value,
    "Cumulative");
  const next = bondFacts(view).find((fact) => fact.key === "next-interest");
  assert.equal(next.value, "—");
  assert.equal(next.sub, "no periodic payment");
});

test("without a frequency Next interest names the missing input", () => {
  const view = bondRowView({ ...dashedRow, frequency: "" });
  const facts = bondFacts(view);
  const next = facts.find((fact) => fact.key === "next-interest");
  const total = facts.find((fact) => fact.key === "total-if-held");
  assert.equal(next.value, "—");
  assert.equal(next.sub, "needs the payment frequency");
  assert.notEqual(total.value, "—", "the lifetime total does not need a frequency");
  assert.match(total.sub, /gain/);
});

test("an unreadable date in the name stays a dash and says so", () => {
  const view = bondRowView({ ...dashedRow, label: "TESTD-11.90%-31-02-27-PVT" });
  assert.equal(view.coupon, 11.9);
  assert.equal(view.maturity, "");
  assert.equal(view.maturityUnread, true);
  const maturity = bondFacts(view).find((fact) => fact.key === "maturity");
  assert.equal(maturity.value, "—");
  assert.equal(maturity.sub, "the date in the name could not be read");
  assert.equal(maturity.subTone, "amber");
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
  assert.match(card,
    /<span class="sub ">stays in net worth until a bank credit is matched · from BSE<\/span>/);
  assert.doesNotMatch(card, /Total if held/);
  assert.doesNotMatch(card, /data-fact="interest-progress"/);
  assert.doesNotMatch(card, /class="bond-progress"/);
  assert.doesNotMatch(card, /data-fact="next-interest"/);
  assert.doesNotMatch(card, /data-fact="market-value"/);
  assert.match(sectionOf(card, "Purchase"), /data-fact="face-value"[^>]*><span class="k">Face value<\/span>/);
});

// A row with no schedule: the foot is the only provenance on the card, so the
// four states below test the words rather than the estimate beside them.
const provenanceRow = {
  id: "prov-1", category: "bond", label: "TEST PROVENANCE 10 Feb 2030",
  security_id: "INE000000130", quantity: 10, cost_paise: null,
  purchase_date: "2026-01-05", value_paise: 1010000,
  value_source: "ICICI Direct holdings", as_of: "2026-11-20", source: "report",
};
const quiet = { returned_paise: 0, returned_at: "", redemption_dates: "",
  returned_source: "" };

test("a demat statement names itself and its date in the foot", () => {
  const view = bondRowView({ ...provenanceRow, ...quiet });
  const foot = footOf(bondCardHtml(view, "acct-1"));
  assert.equal(foot, "from ICICI Direct holdings · 20 Nov 2026");
  assert.doesNotMatch(foot, /\breport\b/);
});

test("a SMEST enrichment names both sources, value first", () => {
  const view = bondRowView({ ...provenanceRow, ...quiet,
    coupon_pct: 7.4, coupon_source: "SMEST", coupon_as_of: "2026-11-20",
    maturity: "2030-02-10", maturity_source: "SMEST",
    maturity_as_of: "2026-11-20" });
  const foot = footOf(bondCardHtml(view, "acct-1"));
  assert.equal(foot,
    "value from ICICI Direct holdings · 20 Nov 2026 · terms from SMEST · 20 Nov 2026");
  assert.doesNotMatch(foot, /\breport\b/);
});

test("a hand-entered lot says so and names no file", () => {
  const view = bondRowView({ ...provenanceRow, ...quiet,
    source: "manual", value_source: "Manual" });
  assert.equal(footOf(bondCardHtml(view, "acct-1")), "entered by hand");
});

test("a foot with no nameable source renders nothing", () => {
  const view = bondRowView({ ...provenanceRow, ...quiet,
    source: "report", value_source: "" });
  const card = bondCardHtml(view, "acct-1");
  assert.equal(footOf(card), "");
  assert.doesNotMatch(footOf(card), /source not recorded/);
  assert.doesNotMatch(card, /data-fact="sources"[^>]*>\s*report/);
});

test("a repayment names its source and an unknown one stays silent", () => {
  const bank = bondRowView({ ...provenanceRow, returned_paise: 500000,
    returned_at: "2026-04-10", returned_source: "bank" });
  assert.match(footOf(bondCardHtml(bank, "acct-1")),
    /repayment from the bank/);
  const smest = bondRowView({ ...provenanceRow, returned_paise: 500000,
    returned_at: "2026-04-10", returned_source: "smest" });
  assert.match(footOf(bondCardHtml(smest, "acct-1")),
    /repayment from SMEST/);
  const unknown = bondRowView({ ...provenanceRow, returned_paise: 500000,
    returned_at: "2026-04-10", returned_source: "" });
  assert.doesNotMatch(footOf(bondCardHtml(unknown, "acct-1")),
    /source not recorded/);
});

test("a matured foot names the terms file and invents no rating source", () => {
  const card = bondCardHtml({ ...bondRowView({ ...maturedRow, source: "report",
    coupon_source: "SMEST", coupon_as_of: "2026-11-16",
    maturity_source: "SMEST", maturity_as_of: "2026-11-16" }),
  matured: true }, "acct-1", { matured: true });
  assert.equal(footOf(card), "from SMEST · 16 Nov 2026");
  assert.doesNotMatch(card, /rating from SMEST/);
  const unnamed = bondCardHtml({ ...bondRowView({ ...maturedRow, source: "report" }),
    matured: true }, "acct-1", { matured: true });
  assert.equal(footOf(unnamed), "");
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
    costed: 0, priced: 0,
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
  assert.equal(summary.costed, 1);
  assert.equal(summary.priced, 1);
});

test("coverage text appears only when the book is partly covered", () => {
  assert.equal(bondCoverageText(1, 17, "costed"), "1 of 17 costed");
  assert.equal(bondCoverageText(0, 16, "priced"), "0 of 16 priced");
  assert.equal(bondCoverageText(17, 17, "costed"), "");
  assert.equal(bondCoverageText(3, 3, "priced"), "");
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

// --- a card whose facts are missing -----------------------------------------
// A demat that imported only a CAS has names, ISINs, units and statement
// values, no cost and no terms. The card names the report that fills it
// instead of printing one dash per field.

const bare = {
  id: "bare-1", category: "bond", label: "TEST BARE BOND",
  security_id: "INE000000124", quantity: 100, face_paise: 100000,
  value_paise: 2500000, value_source: "CAS", as_of: "2026-10-31",
};
const noStatement = { ...bare, id: "bare-2", value_paise: null, face_paise: null };
const costLine = {
  id: "cost-line-1", category: "bond", label: "7.15% TEST TERMS 15 May 2030",
  security_id: "INE000000125", quantity: 50, face_paise: null, cost_paise: null,
};
const termsOnly = {
  id: "terms-line-1", category: "bond", label: "TEST TERMS MISSING",
  security_id: "INE000000126", quantity: 50, face_paise: 100000,
  cost_paise: 5000000, value_paise: 5100000, value_source: "BSE",
  as_of: "2026-10-31", rating: "AA",
};

test("a bare card names the dealer report and keeps only its present facts", () => {
  const view = bondRowView(bare);
  const card = bondCardHtml(view, "acct-1");
  assert.match(card,
    /No cost or terms yet\. Your dealer's report has both\. <button type="button" class="bond-gap-link"/);
  assert.match(card, /onclick="bpBondDealerImport\(&quot;acct-1&quot;\)">Import<\/button>/);
  assert.deepEqual(factKeys(card), ["statement-value", "market-value", "units",
    "face-at-issue", "sources"]);
  for (const key of ["total-if-held", "invested", "coupon", "maturity", "per-unit",
    "current-yield", "gain-if-sold", "interest-progress"]) {
    assert.equal(factKeys(card).includes(key), false, `${key} is not a bare-card fact`);
  }
  assert.equal((card.match(/—/g) || []).length, 1,
    "only the one empty Market value remains");
});

test("the bare card keeps the statement's figure in its own name", () => {
  const card = bondCardHtml(bondRowView(bare), "acct-1");
  assert.match(card,
    /data-fact="statement-value"[^>]*><span class="k">Statement value<\/span><span class="v ">₹ 25,000\.00<span class="sub ">as on 31 Oct 2026, from the CAS<\/span>/);
  assert.match(card,
    /data-fact="face-at-issue"[^>]*><span class="k">Face value<\/span><span class="v ">₹ 1,00,000\.00<\/span>/);
  assert.doesNotMatch(card,
    /data-fact="face-at-issue"[\s\S]*?face-at-issue[\s\S]*?as on 31 Oct 2026/,
    "the face does not borrow the value's date or source");
  assert.match(card,
    /data-fact="market-value"[\s\S]*?<span class="v ">—<span class="sub ">not recorded · <button class="vupdate"/);
  assert.equal((card.match(/Enter it/g) || []).length, 1);
});

test("an explicit repayment survives a card with no analytics", () => {
  const view = bondRowView({ ...bare, returned_paise: 500000,
    returned_at: "2026-04-10", returned_source: "bank" });
  const card = bondCardHtml(view, "acct-1");
  assert.match(card,
    /data-fact="principal-returned"[^>]*><span class="k">Principal returned<\/span><span class="v ">₹ 5,000\.00<span class="sub ">on 10 Apr 2026<\/span>/);
});

test("a BSE figure is a market value, never a statement", () => {
  const card = bondCardHtml(bondRowView({ ...bare, value_source: "BSE" }), "acct-1");
  assert.match(card, /data-fact="market-value"[\s\S]*?from BSE/);
  assert.equal(factKeys(card).includes("statement-value"), false);
});

test("a bare card with no statement value invents no figure", () => {
  const card = bondCardHtml(bondRowView(noStatement), "");
  assert.doesNotMatch(card, /₹/);
  assert.doesNotMatch(card, /—/);
  assert.deepEqual(factKeys(card), ["units", "sources"]);
  assert.match(card, /No cost, terms or value yet\./);
});

test("an empty statement value is not a zero", () => {
  for (const value of ["", 0]) {
    const card = bondCardHtml(bondRowView({ ...noStatement, value_paise: value }), "");
    assert.equal(factKeys(card).includes("statement-value"), false,
      `value ${JSON.stringify(value)} is not a statement figure`);
    assert.doesNotMatch(card, /₹/);
  }
});

test("a BSE value without cost keeps the market facts and the second sentence", () => {
  const view = bondRowView({ ...bare, id: "bse-bare-1", value_source: "BSE" });
  assert.equal(view.value, 2500000);
  assert.equal(view.statementValue, null);
  const card = bondCardHtml(view, "acct-1");
  assert.match(card,
    /No cost or terms yet\. Your dealer's report has both\./);
  assert.deepEqual(factKeys(card),
    ["market-value", "per-unit", "units", "face-at-issue", "sources"]);
  assert.equal(factKeys(card).includes("statement-value"), false);
  assert.match(card, /data-fact="market-value"[\s\S]*?from BSE/);
});

test("a named statement source keeps its name", () => {
  const card = bondCardHtml(bondRowView({ ...bare, value_source: "Motilal" }),
    "acct-1");
  assert.match(card, /data-fact="statement-value"[\s\S]*?from Motilal/);
  assert.doesNotMatch(card, /data-fact="statement-value"[\s\S]*?from the CAS/);
});

test("a manual value says entered by hand", () => {
  const card = bondCardHtml(bondRowView({ ...bare, value_source: "Manual" }), "");
  assert.match(card, /data-fact="market-value"[\s\S]*?entered by hand/);
  assert.doesNotMatch(card, /data-fact="market-value"[\s\S]*?from the CAS/);
});

test("an empty source says source not recorded, never CAS", () => {
  const view = bondRowView({ ...bare, value_source: "" });
  assert.equal(view.value, 2500000, "the legacy empty source stays a market value");
  assert.equal(view.statementValue, null);
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /data-fact="market-value"[\s\S]*?source not recorded/);
  assert.doesNotMatch(card, /data-fact="market-value"[\s\S]*?from the CAS/);
  assert.equal(factKeys(card).includes("statement-value"), false);
});

test("the gap sentences are one frozen object", () => {
  assert.equal(Object.isFrozen(BOND_GAP_COPY), true);
  assert.deepEqual(BOND_GAP_COPY, {
    costTermsMarket: "No cost, terms or value yet. Your dealer's report has the cost and terms.",
    costTerms: "No cost or terms yet. Your dealer's report has both.",
    cost: "Cost not known yet",
    terms: "Coupon or maturity not known yet",
  });
});

test("a cost record gets no dead instruction", () => {
  const card = bondCardHtml(bondRowView(bare), "bonds-1", { importTarget: "" });
  assert.match(card, /No cost or terms yet\.<\/div>/);
  assert.doesNotMatch(card, /Your dealer's report/);
  assert.doesNotMatch(card, /bond-gap-link/);
  assert.match(card, /data-bond-action="enter-value"/,
    "the card can still take a value of its own");
  const market = bondCardHtml(bondRowView({ ...bare, value_source: "BSE" }),
    "bonds-1", { importTarget: "" });
  assert.match(market, /No cost or terms yet\.<\/div>/);
  assert.doesNotMatch(market, /Your dealer's report/);
});

test("a bonds portfolio imports through the generic page", () => {
  const card = bondCardHtml(bondRowView(bare), "bonds-1", { importVia: "page" });
  assert.match(card, /onclick="go\('import'\)">Import<\/button>/);
  assert.doesNotMatch(card, /bpBondDealerImport/);
  const banner = bondGapBannerHtml({ text: "1 bond needs cost and terms" },
    "bonds-1", "page");
  assert.match(banner, /onclick="go\('import'\)"/);
  assert.doesNotMatch(banner, /bpBondDealerImport/);
});

test("a demat opens the dealer report import", () => {
  const card = bondCardHtml(bondRowView(bare), "demat-1");
  assert.match(card, /onclick="bpBondDealerImport\(&quot;demat-1&quot;\)"/);
});

test("a blank cost is absent, not zero", () => {
  const view = bondRowView({ ...row, cost_paise: "", value_paise: 2500000,
    value_source: "BSE" });
  assert.equal(view.cost, null);
  assert.equal(view.gain, null);
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /Cost not known yet/);
  assert.doesNotMatch(card, /₹ 0\.00/);
  assert.doesNotMatch(card, /data-fact="gain-if-sold"/);
  assert.match(sectionOf(card, "Market value"), /data-fact="market-value"/);
});

test("a cost-only lot in an at-cost account shows the cost, not a gap", () => {
  const view = bondRowView({ ...row, id: "at-cost-1", value_paise: null,
    value_source: "", as_of: "" });
  const card = bondCardHtml(view, "acct-1", { atCost: true });
  assert.match(sectionOf(card, "Market value"),
    /data-fact="market-value"[^>]*><span class="k">Value now<\/span><span class="v ">₹ 8,00,000\.00<span class="sub ">held at cost · <button class="vupdate" data-bond-action="enter-value"[^>]*>Enter market value<\/button>/);
  assert.match(sectionOf(card, "Returns"),
    /data-fact="gain-if-sold"[^>]*><span class="k">Gain if sold now<\/span><span class="v ">—<span class="sub ">no market value yet<\/span>/);
  assert.equal((card.match(/data-bond-action="enter-value"/g) || []).length, 1,
    "the card can still take a market value");
  assert.doesNotMatch(card, /not recorded/);
  assert.doesNotMatch(card, /needs a market value/);
  assert.deepEqual(sectionTitles(card), ["Returns", "Purchase"],
    "a MARKET VALUE heading would name the cost a market value");
  assert.deepEqual(factKeys(card), LIVE_KEYS);
});

test("the at-cost value names the source that supplied the cost", () => {
  const manualRow = { ...row, id: "at-cost-manual", value_paise: null,
    value_source: "", as_of: "", source: "manual" };
  assert.match(bondCardHtml(bondRowView(manualRow), "acct-1", { atCost: true }),
    /held at cost · cost entered by hand/);
  assert.match(bondCardHtml(bondRowView({ ...manualRow, source: "cas" }), "acct-1",
    { atCost: true }), /held at cost · cost from the CAS/);
});

test("an at-cost flag does not change a lot that has a market value", () => {
  const card = bondCardHtml(bondRowView(row), "acct-1", { atCost: true });
  assert.match(sectionOf(card, "Market value"),
    /<span class="k">Market value<\/span><span class="v ">₹ 8,14,400\.00/);
  assert.deepEqual(sectionTitles(card), BOND_SECTIONS);
});

test("a cost-only lot outside an at-cost account keeps the old wording", () => {
  const view = bondRowView({ ...row, id: "at-cost-2", value_paise: null,
    value_source: "", as_of: "" });
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /Market value<\/span><span class="v ">—<span class="sub ">not recorded · <button/);
  assert.match(card, /Enter it/);
  assert.match(card, /needs a market value/);
});

test("an at-cost figure survives a terms gap with no value entry", () => {
  const view = bondRowView({ ...row, id: "at-cost-terms", label: "TEST BOND NO TERMS",
    value_paise: null, value_source: "", as_of: "", coupon_pct: null,
    maturity: null, coupon_source: "" });
  const card = bondCardHtml(view, "", { atCost: true });
  assert.match(card, /Coupon or maturity not known yet/);
  assert.match(sectionOf(card, "Market value"),
    /data-fact="market-value"[^>]*><span class="k">Value now<\/span>/);
});

test("the card treatment follows the missing inputs, matured wins", () => {
  assert.deepEqual(bondCardGap(bondRowView(bare)),
    { noCost: true, noTerms: true, noMarket: true, treatment: "one-line" });
  assert.deepEqual(bondCardGap(bondRowView(costLine)),
    { noCost: true, noTerms: false, noMarket: true, treatment: "cost-line" });
  assert.deepEqual(bondCardGap(bondRowView(termsOnly)),
    { noCost: false, noTerms: true, noMarket: false, treatment: "terms-line" });
  const priced = bondRowView({ ...row, value_paise: null, as_of: null });
  assert.deepEqual(bondCardGap(priced),
    { noCost: false, noTerms: false, noMarket: true, treatment: "full" });
  const maturedBare = { ...bondRowView(bare), matured: true };
  assert.equal(bondCardGap(maturedBare).treatment, "full",
    "a matured lot is awaiting payment, not work");
});

test("a cost line keeps the terms and asks only for the cost", () => {
  const view = bondRowView(costLine);
  const card = bondCardHtml(view, "");
  assert.match(card, /Cost not known yet/);
  assert.doesNotMatch(card, /No cost, terms or market value yet/);
  assert.doesNotMatch(card, /class="bond-gap-link"/, "no account, no link");
  assert.deepEqual(factKeys(card), ["units", "coupon", "maturity", "sources"]);
  for (const key of ["total-if-held", "invested", "market-value", "gain-if-sold",
    "principal-returned", "interest-progress"]) {
    assert.equal(factKeys(card).includes(key), false, `${key} is not a cost-line fact`);
  }
});

test("a terms line keeps the cost and market facts and names the gap", () => {
  const view = bondRowView(termsOnly);
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /Coupon or maturity not known yet/);
  assert.match(card, /Coupon or maturity not known yet[\s\S]*?class="bond-gap-link"/);
  assert.deepEqual(factKeys(card), ["gain-if-sold", "market-value", "per-unit",
    "current-rating", "invested", "units", "face-at-issue", "sources"]);
  for (const key of ["total-if-held", "principal-left", "next-interest",
    "interest-progress", "coupon", "maturity", "purchase-yield"]) {
    assert.equal(factKeys(card).includes(key), false, `${key} is not a terms-line fact`);
  }
  assert.equal((card.match(/bond-gap-line/g) || []).length, 1,
    "one gap line, not two");
});

test("a terms line with no market value keeps Enter it", () => {
  const view = bondRowView({ ...termsOnly, value_paise: null });
  const card = bondCardHtml(view, "acct-1");
  assert.equal(factKeys(card).filter((key) => key === "market-value").length, 1);
  assert.equal((card.match(/Enter it/g) || []).length, 1);
});

test("a coupon-only bond gets the terms line and keeps its coupon", () => {
  const view = bondRowView({ ...termsOnly, id: "coupon-only",
    label: "TEST COUPON ONLY", couponPct: 8 });
  assert.equal(bondCardGap(view).treatment, "terms-line");
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /Coupon or maturity not known yet/);
  assert.equal(factKeys(card).includes("coupon"), true);
  assert.equal(factKeys(card).includes("maturity"), false);
  assert.equal(factKeys(card).includes("total-if-held"), false,
    "no anchor from a half-term bond");
});

test("a maturity-only bond gets the terms line and keeps its maturity", () => {
  const view = bondRowView({ ...termsOnly, id: "maturity-only",
    label: "TEST MATURITY ONLY 15 May 2031", couponPct: null });
  assert.equal(bondCardGap(view).treatment, "terms-line");
  const card = bondCardHtml(view, "acct-1");
  assert.match(card, /Coupon or maturity not known yet/);
  assert.equal(factKeys(card).includes("maturity"), true);
  assert.equal(factKeys(card).includes("coupon"), false);
  assert.equal(factKeys(card).includes("total-if-held"), false,
    "no anchor from a half-term bond");
});

test("the banner is one clickable sentence with a trailing arrow", () => {
  const text = "16 bonds need cost and terms — import a dealer report";
  const button = bondGapBannerHtml({ text }, "acct-1");
  assert.match(button,
    /^<button type="button" class="bond-gap-banner" data-bond-gap-banner onclick="bpBondDealerImport\(&quot;acct-1&quot;\)">/);
  assert.match(button,
    /<span>16 bonds need cost and terms — import a dealer report<\/span><span aria-hidden="true">→<\/span><\/button>$/);
  assert.doesNotMatch(button, /class="btn/);
  assert.doesNotMatch(button, /Import broker report/);
  const plain = bondGapBannerHtml({ text }, "");
  assert.match(plain, /^<div class="bond-gap-banner" data-bond-gap-banner>/);
  assert.doesNotMatch(plain, /onclick|bpBondDealerImport/);
  assert.match(plain, /→<\/span><\/div>$/);
});

test("a stored coupon survives a name that only carries the date", () => {
  const view = bondRowView({ ...costLine, label: "TEST TERMS 15 May 2030",
    couponPct: 8 });
  assert.equal(view.coupon, 8);
  assert.equal(bondCardGap(view).treatment, "cost-line");
  assert.match(bondCardHtml(view, ""), /data-fact="coupon"[\s\S]*?8%/);
});

test("a cost line with an account keeps the Enter it action", () => {
  const card = bondCardHtml(bondRowView(costLine), "acct-1");
  assert.equal(factKeys(card).filter((key) => key === "market-value").length, 1);
  assert.equal((card.match(/Enter it/g) || []).length, 1);
});

test("a market-only card keeps every fact, one Enter it and no gap line", () => {
  const view = { ...bondRowView({ ...row, value_paise: null, as_of: null }),
    matured: false };
  const card = bondCardHtml(view, "acct-1");
  assert.deepEqual(factKeys(card), LIVE_KEYS);
  assert.doesNotMatch(card, /bond-gap-line/);
  assert.equal((card.match(/Enter it/g) || []).length, 1);
});

test("a CAS value with a broker cost stays a statement figure", () => {
  const view = { ...bondRowView({ ...row, value_source: "CAS",
    value_paise: 2500000, cost_paise: 2000000, as_of: "2026-10-31" }),
  matured: false };
  assert.equal(view.value, null, "the CAS figure is not a market value");
  assert.equal(view.statementValue, 2500000);
  assert.equal(view.gain, null, "no gain from a statement figure");
  assert.equal(view.marketPerUnit, null);
  assert.equal(view.currentYield, null);
  const card = bondCardHtml(view, "acct-1");
  const keys = factKeys(card);
  assert.equal(keys.includes("statement-value"), true);
  assert.equal(keys.indexOf("statement-value") + 1, keys.indexOf("market-value"),
    "the statement figure sits before the empty market value");
  assert.doesNotMatch(sectionTitles(card).join("|"), /Market value/,
    "a statement figure gets no MARKET VALUE heading");
  assert.match(sectionOf(card, "Market value"),
    /data-fact="statement-value"[\s\S]*?from the CAS/);
  assert.match(card, /data-fact="market-value"[\s\S]*?not recorded/);
  for (const key of ["gain-if-sold", "current-yield", "per-unit"]) {
    assert.match(sectionOf(card, "Market value") + sectionOf(card, "Returns"),
      new RegExp(`data-fact="${key}"[^>]*>[\\s\\S]*?<span class="v ">—<span class="sub ">needs a market value`),
      `${key} is empty, not derived from the statement figure`);
  }
});

test("a matured CAS anchor is the book's value, not the cost", () => {
  for (const cost of [2000000, null]) {
    const split = splitMatured([{ ...maturedRow, value_source: "CAS",
      value_paise: 2500000, cost_paise: cost }], "2026-11-16");
    assert.equal(split.maturedValue, 2500000,
      "the book counts the statement value");
    const view = { ...bondRowView(split.matured[0]), matured: true };
    assert.equal(view.value, null);
    assert.equal(view.statementValue, 2500000);
    const card = bondCardHtml(view, "acct-1", { matured: true });
    assert.match(sectionOf(card, "Returns"),
      /<span class="k">Value in net worth<\/span><span class="v ">₹ 25,000\.00<span class="sub ">stays in net worth until a bank credit is matched · from the CAS<\/span>/);
    assert.equal(factKeys(card).includes("statement-value"), false);
    assert.deepEqual(factKeys(card), MATURED_KEYS);
  }
});

test("a matured lot with no value names cost in the anchor", () => {
  const split = splitMatured([{ ...maturedRow, value_paise: null,
    value_source: "", cost_paise: 2500000 }], "2026-11-16");
  assert.equal(split.maturedValue, 2500000);
  const view = { ...bondRowView(split.matured[0]), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  assert.match(sectionOf(card, "Returns"),
    /<span class="k">Value in net worth<\/span><span class="v ">₹ 25,000\.00<span class="sub ">stays in net worth until a bank credit is matched · at cost<\/span>/);
});

test("a matured lot states a missing cost quietly", () => {
  const card = bondCardHtml({ ...bondRowView({ ...maturedRow, cost_paise: null }),
    matured: true }, "acct-1", { matured: true });
  assert.match(card, /<div class="bond-matured-gap">Cost not known<\/div>/);
  assert.equal((card.match(/data-bond-action="import-broker"/g) || []).length, 0);
  assert.equal((card.match(/bond-gap-link/g) || []).length, 0);
});

test("a matured lot states missing terms quietly", () => {
  const card = bondCardHtml({ ...bondRowView({ ...maturedRow, couponPct: null,
    label: "TEST MATURED 15 May 2020" }), matured: true }, "acct-1", { matured: true });
  assert.match(card,
    /<div class="bond-matured-gap">Coupon not known<\/div>/);
  assert.equal((card.match(/data-bond-action="import-broker"/g) || []).length, 0);
});

test("a matured lot states cost and terms quietly together", () => {
  const card = bondCardHtml({ ...bondRowView({ ...maturedRow, cost_paise: null,
    couponPct: null, label: "TEST MATURED 15 May 2020" }), matured: true },
  "acct-1", { matured: true });
  assert.match(card,
    /<div class="bond-matured-gap">Cost or coupon not known<\/div>/);
  assert.equal((card.match(/data-bond-action="import-broker"/g) || []).length, 0);
});

test("a complete matured lot has no quiet line", () => {
  const card = bondCardHtml({ ...bondRowView(maturedRow), matured: true },
    "acct-1", { matured: true });
  assert.doesNotMatch(card, /bond-matured-gap/);
});

test("only a market value gives the edit screen a market price", () => {
  const cas = bondRowView({ ...row, value_source: "CAS", value_paise: 2500000,
    cost_paise: 2000000 });
  assert.equal(cas.marketPrice, null);
  const bse = bondRowView({ ...row, value_source: "BSE", value_paise: 2500000,
    cost_paise: 2000000 });
  assert.ok(bse.marketPrice > 0);
});

test("a matured blank cost is a dash, not zero", () => {
  const view = { ...bondRowView({ ...maturedRow, value_paise: null,
    value_source: "", cost_paise: "" }), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  assert.match(sectionOf(card, "Returns"),
    /data-fact="value-in-net-worth"[^>]*><span class="k">Value in net worth<\/span><span class="v ">—/);
  assert.doesNotMatch(card, /₹ 0\.00/);
});

test("current yield needs a market value, not a purchase yield", () => {
  const view = { ...bondRowView({ ...row, value_source: "CAS",
    value_paise: 2500000, cost_paise: 2000000 }), matured: false };
  const card = bondCardHtml(view, "acct-1");
  assert.match(sectionOf(card, "Market value"),
    /data-fact="current-yield"[^>]*><span class="k">Current yield<\/span><span class="v ">—<span class="sub ">needs a market value<\/span>/);
  assert.match(sectionOf(card, "Purchase"),
    /data-fact="purchase-yield"[\s\S]*?\d+\.\d+%/);
});

test("a book of bare lots has no summary figure to print", () => {
  const summary = bondBookSummary([bondRowView(bare)]);
  assert.equal(summary.count, 1);
  assert.equal(summary.totalIfHeld, null);
  assert.equal(summary.principalLeft, null);
  assert.equal(summary.interestPct, null);
});

test("a matured lot never gets a gap line", () => {
  const view = { ...bondRowView(bare), matured: true };
  const card = bondCardHtml(view, "acct-1", { matured: true });
  assert.doesNotMatch(card, /bond-gap-line/);
  assert.match(card, /data-fact="value-in-net-worth"/);
});
