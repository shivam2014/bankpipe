#!/usr/bin/env node
// Renders the bond book when a CAS left the cards without cost or terms. The
// "gap" scene seeds sixteen bare CAS-shaped lots and one complete lot, so the
// banner has the observed sentence. The "edge" scene seeds one cost-line lot
// (terms known, cost missing), one terms-line lot (cost known, terms missing)
// and the same complete lot. The "terms" scene shows that line alone. The "cas"
// scene puts a CAS statement value beside a broker cost and a BSE price; the
// "oneTerm" scene has a coupon-only and a maturity-only lot. Synthetic rows only.
//
//   node scripts/render-bond-gap.mjs [--out-dir build/renders]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, freePort } from "./render-shot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `usage: node scripts/render-bond-gap.mjs [--out-dir build/renders]

  --out-dir  where the PNGs go, default build/renders
`;

const SECTIONS = ["Returns", "Market value", "Purchase"];
const LIVE_KEYS = [
  "total-if-held", "principal-returned", "principal-left", "next-interest",
  "gain-if-sold", "interest-progress",
  "market-value", "per-unit", "current-yield", "current-rating",
  "invested", "units", "purchase-date", "face-at-issue", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];
const BARE_KEYS = ["statement-value", "market-value", "units", "face-at-issue",
  "sources"];
const MATURED_KEYS = [
  "value-in-net-worth", "principal-returned", "principal-left",
  "invested", "units", "purchase-date", "face-value", "coupon",
  "maturity", "frequency", "purchase-yield", "purchase-rating",
  "sources",
];

const COMPLETE = {
  security_id: "INE000000901", label: "9.25% TEST COMPLETE 15 May 2031",
  issuer: "TEST COMPLETE", category: "bond", quantity: 100,
  cost_paise: 10000000, value_paise: 10400000, value_source: "BSE",
  as_of: "2026-10-31", face_paise: 100000, purchase_date: "2025-05-15",
  coupon_pct: 9.25, coupon_source: "report", coupon_as_of: "2026-10-31",
  maturity: "2031-05-15", maturity_source: "report", maturity_as_of: "2026-10-31",
  interest_date: "2027-05-15", frequency: "Half-yearly", rating: "AAA",
  rating_at_purchase: "AA+", yield_bps: 925,
  future_principal_paise: 10000000, future_interest_paise: 4625000,
};

const BARE = Array.from({ length: 16 }, (_, index) => ({
  security_id: `INE0000001${String(index + 20).padStart(2, "0")}`,
  label: `TEST CAS BOND ${String(index + 1).padStart(2, "0")}`,
  category: "bond", quantity: 10 + index, face_paise: 100000,
  value_paise: 2500000 + index * 1000, value_source: "CAS",
  as_of: "2026-10-31",
}));

// Terms known, cost missing: the cost-line card.
const COST_LINE = {
  security_id: "INE000000801", label: "7.15% TEST TERMS 15 May 2031",
  issuer: "TEST TERMS", category: "bond", quantity: 50, face_paise: 100000,
  value_paise: 1250000, value_source: "CAS", as_of: "2026-10-31",
  coupon_pct: 7.15, coupon_source: "CAS", coupon_as_of: "2026-10-31",
  maturity: "2031-05-15", maturity_source: "CAS", maturity_as_of: "2026-10-31",
};

// Cost known, terms missing: the full card the sketch leaves alone.
const TERMS_MISSING = {
  security_id: "INE000000802", label: "TEST COST ONLY BOND",
  issuer: "TEST COST ONLY", category: "bond", quantity: 50, face_paise: 100000,
  cost_paise: 5000000, value_paise: 5100000, value_source: "BSE",
  as_of: "2026-10-31",
};

// A real CAS name can be long. This scene measures what the sentence, actions
// and five present facts cost when the title takes two lines.
const LONG_BARE = {
  security_id: "INE000000803",
  label: "NATIONAL TEST HIGHWAYS AUTHORITY TAX-FREE BOND SERIES II",
  category: "bond", quantity: 10, face_paise: 100000, value_paise: 2500000,
  value_source: "CAS", as_of: "2026-10-31",
};

// A CAS statement figure with a broker cost and both terms. It is a full card,
// but its only value is a statement figure, so it gets no MARKET VALUE heading.
const CAS_WITH_COST = {
  security_id: "INE000000804", label: "8.00% TEST CAS VALUE 15 May 2031",
  issuer: "TEST CAS VALUE", category: "bond", quantity: 50, face_paise: 100000,
  cost_paise: 2000000, value_paise: 2500000, value_source: "CAS",
  as_of: "2026-10-31", rating: "AA", purchase_date: "2025-05-15",
  coupon_pct: 8, coupon_source: "CAS", coupon_as_of: "2026-10-31",
  maturity: "2031-05-15", maturity_source: "CAS", maturity_as_of: "2026-10-31",
  interest_date: "2027-05-15", frequency: "Half-yearly",
};

// A matured CAS lot: the book counts its stored value, so the net-worth
// anchor must count the same ₹25,000, not the ₹20,000 cost.
const MATURED_CAS = {
  security_id: "INE999900249", label: "8.25% TEST MATURED CAS 15 May 2020",
  issuer: "TEST MATURED CAS", category: "bond", quantity: 50, face_paise: 100000,
  cost_paise: 2000000, value_paise: 2500000, value_source: "CAS",
  as_of: "2020-05-15", rating: "AA", rating_at_purchase: "AA",
};

// A matured lot missing both cost and coupon. It is owed money, not a task:
// the card says so quietly and never gets a banner or an Import.
const MATURED_BARE = {
  security_id: "INE000000808", label: "TEST MATURED BARE 15 May 2020",
  issuer: "TEST MATURED BARE", category: "bond", quantity: 10, face_paise: 100000,
  as_of: "2020-05-15",
};

const COUPON_ONLY = {
  security_id: "INE000000805", label: "8.10% TEST COUPON ONLY",
  issuer: "TEST COUPON ONLY", category: "bond", quantity: 50, face_paise: 100000,
  cost_paise: 5000000, value_paise: 5100000, value_source: "BSE",
  as_of: "2026-10-31",
};

const MATURITY_ONLY = {
  security_id: "INE000000806", label: "TEST MATURITY ONLY 15 May 2031",
  issuer: "TEST MATURITY ONLY", category: "bond", quantity: 50, face_paise: 100000,
  cost_paise: 5000000, value_paise: 5100000, value_source: "BSE",
  as_of: "2026-10-31",
};

// A CAS stores the maturity and face but not the coupon. Six lots have no
// cost; two of those carry a rating. Two more carry a cost and no rating. The
// header counts the coupon alone, and the two cards ask for their own gap.
const CAS_COUPON_BARE = Array.from({ length: 6 }, (_, index) => ({
  security_id: `INE00000013${index}`, label: `TEST CAS COUPON ${index + 1} 31 Dec 2026`,
  category: "bond", quantity: 1, face_paise: 10000000,
  face_source: "CAS", face_as_of: "2026-10-31",
  value_paise: 9950000, value_source: "CAS", as_of: "2026-10-31",
  maturity: "2026-12-31", maturity_source: "CAS", maturity_as_of: "2026-10-31",
  ...(index < 2 ? { rating: "AA", rating_at_purchase: "AA" } : {}),
  source: "report",
}));
const CAS_COUPON_COSTED = Array.from({ length: 2 }, (_, index) => ({
  security_id: `INE00000014${index}`, label: `TEST COSTED COUPON ${index + 1} 30 Nov 2026`,
  category: "bond", quantity: 1, face_paise: 10000000,
  cost_paise: 9859863, value_paise: 5000000, value_source: "BSE",
  as_of: "2026-10-31", maturity: "2026-11-30", maturity_source: "CAS",
  maturity_as_of: "2026-10-31", source: "report",
}));

// A bare lot whose name, face and rating are present, so the CAS scene's hold
// bar can show the priced market figure instead of the fetch line.
const BARE_QUIET = {
  ...BARE[0], issuer: "TEST CAS QUIET", rating: "AA", rating_at_purchase: "AA",
  coupon_pct: 9, coupon_source: "CAS", coupon_as_of: "2026-10-31",
  maturity: "2031-05-15", maturity_source: "CAS", maturity_as_of: "2026-10-31",
};

const SCENES = {
  gap: { rows: [...BARE, COMPLETE],
    banner: "16 bonds need cost and terms — import a dealer report",
    bare: 16, bondRows: 16 },
  edge: { rows: [COMPLETE, COST_LINE, TERMS_MISSING],
    banner: "2 bonds need cost or terms — import a dealer report",
    bare: 0, bondRows: 2 },
  bar: { rows: BARE,
    banner: "16 bonds need cost and terms — import a dealer report",
    bare: 16, bondRows: 16 },
  long: { rows: [LONG_BARE],
    banner: "1 bond needs cost and terms — import a dealer report",
    bare: 1, bondRows: 1 },
  terms: { rows: [TERMS_MISSING],
    banner: "1 bond needs terms — import a dealer report",
    bare: 0, bondRows: 1 },
  cas: { rows: [COMPLETE, CAS_WITH_COST, BARE_QUIET],
    banner: "1 bond needs cost — import a dealer report",
    bare: 0, bondRows: 0 },
  oneTerm: { rows: [COUPON_ONLY, MATURITY_ONLY],
    banner: "2 bonds need terms — import a dealer report",
    bare: 0, bondRows: 2 },
  header: { rows: [CAS_COUPON_BARE[0], CAS_COUPON_COSTED[0]].concat(
    CAS_COUPON_BARE.slice(1), CAS_COUPON_COSTED.slice(1)),
    banner: "8 bonds need cost or terms — import a dealer report",
    bare: 6, bondRows: 8 },
  matured: { rows: [MATURED_CAS, MATURED_BARE, BARE_QUIET],
    banner: "1 bond needs cost — import a dealer report",
    bare: 0, bondRows: 0 },
};

function pageScript({ scene }) {
  const config = SCENES[scene];
  return `(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = await import("./db.js");
  const flow = await import("./import-flow.js");
  const accounts = await store.listAccounts();
  const demat = accounts.find((account) => account.category === "demat");
  if (!demat) throw new Error("the sample portfolio has no demat account");
  for (const row of await store.listHoldings(demat.id)) await store.deleteHolding(row.id);
  const rows = ${JSON.stringify(config.rows)};
  // replaceHoldings writes a report row with its own source, so the demo does
  // not label every CAS lot "added by hand" the way a manual upsert would.
  await store.replaceHoldings(demat.id, rows, "2026-10-31");
  const storedRows = await store.listHoldings(demat.id);
  window.bpState = { asset: demat.id, assetClass: "bond" };
  go("asset");
  await sleep(900);

  const banner = document.querySelector(".bond-gap-banner");
  if (!banner) throw new Error("the gap banner is missing");
  if (banner.tagName !== "BUTTON") throw new Error(\`the banner is a \${banner.tagName}\`);
  if (!banner.getAttribute("onclick")?.includes("bpBondDealerImport")) {
    throw new Error("the banner has no dealer report handler");
  }
  const bannerText = banner.textContent.replace(/\\s+/g, " ").trim()
    .replace(/\\s*→\\s*$/, "");
  if (bannerText !== ${JSON.stringify(config.banner)}) {
    throw new Error(\`the banner says \${bannerText}\`);
  }
  if (banner.querySelectorAll(".btn").length) {
    throw new Error("the banner still wraps a .btn");
  }
  const holdingsPrimaries = document.querySelectorAll("#bond-holdings .btn.primary").length;
  if (holdingsPrimaries !== 0) {
    throw new Error(\`\${holdingsPrimaries} filled buttons in the holdings card\`);
  }
  const fetchButton = document.getElementById("bond-fetch-btn");
  if (fetchButton && fetchButton.classList.contains("primary")) {
    throw new Error("Fetch online kept its fill while the banner exists");
  }

  const cardsEl = document.querySelector(".bond-cards");
  if (!cardsEl) throw new Error("the bond card grid is missing");
  const cards = [...cardsEl.querySelectorAll(".bond-card")];
  const detail = document.querySelector(".needs-details");
  if (!detail) throw new Error("the disclosure is missing");
  if (detail.open) throw new Error("the disclosure is open");
  const detailHeight = Math.round(detail.getBoundingClientRect().height);
  if (detailHeight > 40) {
    throw new Error(\`the closed disclosure still occupies \${detailHeight}px\`);
  }
  const bondRows = detail.querySelectorAll(
    ".needs-list > div:not(.import-account-gap)").length;
  if (bondRows !== ${config.bondRows}) {
    throw new Error(\`the disclosure holds \${bondRows} bond rows, want ${config.bondRows}\`);
  }
  const gapLines = [...detail.querySelectorAll(".needs-list .import-account-gap")]
    .map((el) => el.textContent.trim());
  const expectedGaps = flow.importAccountGaps(demat, storedRows, (value) => value,
    "2026-11-16").gaps.map((gap) => gap.text);
  if (gapLines.length !== expectedGaps.length
    || gapLines.some((line, index) => line !== expectedGaps[index])) {
    throw new Error(\`the disclosure says \${gapLines.join(" | ")}, \`
      + \`the account says \${expectedGaps.join(" | ")}\`);
  }

  // The import gate is the same isImportAccount the import page uses, not the
  // category. Exercise it in the page context as well as in the unit tests.
  const bondsAccount = { id: "bonds-probe", category: "bonds", subtype: "bond" };
  const costAccount = { id: "cost-probe", category: "bonds", subtype: "bond",
    meta: '{"cost_only":true}' };
  if (!flow.bondGapBanner(bondsAccount, storedRows)) {
    throw new Error("a bonds portfolio lost its banner");
  }
  if (flow.bondGapBanner(costAccount, storedRows)) {
    throw new Error("a cost-only record got a banner");
  }
  const dematImport = flow.bondImportOf(demat, demat.id);
  if (dematImport.importVia !== "broker" || !dematImport.importTarget) {
    throw new Error("a demat lost its broker import");
  }
  const bondsImport = flow.bondImportOf(bondsAccount, "bonds-probe");
  if (bondsImport.importVia !== "page" || !bondsImport.importTarget) {
    throw new Error("a bonds portfolio lost the generic import");
  }
  if (flow.bondImportOf(costAccount, "cost-probe").importTarget !== "") {
    throw new Error("a cost-only record got an import target");
  }
  const holdBar = document.querySelector(".hold-bar")?.textContent
    .replace(/\\s+/g, " ").trim() || "";
  const state = {
    scene: ${JSON.stringify(scene)},
    holdBar,
    width: document.documentElement.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    banner: bannerText,
    bannerTop: Math.round(banner.getBoundingClientRect().top),
    disclosureTop: Math.round(detail.getBoundingClientRect().top),
    cardsTop: Math.round(cardsEl.getBoundingClientRect().top),
    gapLines,
    bondRows,
    cards: cards.map((card) => ({
      name: card.querySelector(".bond-name")?.textContent.trim() || "",
      matured: card.dataset.matured === "true",
      treatment: card.dataset.gapTreatment || "full",
      facts: [...card.querySelectorAll("[data-fact]")].map((el) => el.dataset.fact),
      sections: [...card.querySelectorAll(".bond-section-title")]
        .map((el) => el.textContent.trim()),
      gapLines: card.querySelectorAll(".bond-gap-line").length,
      enterIt: card.querySelectorAll('[data-bond-action="enter-value"]').length,
      height: Math.round(card.getBoundingClientRect().height * 10) / 10,
      text: card.querySelector(".bond-gap-line")?.textContent.trim() || "",
      statement: card.querySelector('[data-fact="statement-value"] .v')
        ?.textContent.trim() || "",
      market: card.querySelector('[data-fact="market-value"] .v')
        ?.textContent.trim() || "",
      gain: card.querySelector('[data-fact="gain-if-sold"] .v')
        ?.textContent.trim() || "",
      currentYield: card.querySelector('[data-fact="current-yield"] .v')
        ?.textContent.trim() || "",
      perUnit: card.querySelector('[data-fact="per-unit"] .v')
        ?.textContent.trim() || "",
      anchorValue: card.querySelector('[data-fact="value-in-net-worth"] .v')
        ?.firstChild?.textContent.trim() || "",
      anchorSub: card.querySelector('[data-fact="value-in-net-worth"] .sub')
        ?.textContent.trim() || "",
      quietLine: card.querySelector(".bond-matured-gap")?.textContent.trim() || "",
      importActions: card.querySelectorAll('[data-bond-action="import-broker"]').length,
      importLinks: card.querySelectorAll(".bond-gap-link").length,
    })),
    summaryFigures: document.querySelectorAll(".bond-summary .bs-fig").length,
    summarySorts: document.querySelectorAll(".bond-summary .sortbtn").length,
    summaryScope: document.querySelector(".bond-summary .bs-scope")
      ?.textContent.trim() || "",
    summary: (() => {
      const bar = document.querySelector(".bond-summary");
      if (!bar) return null;
      const firstCard = document.querySelector(".bond-cards .bond-card");
      const sorts = [...bar.querySelectorAll(".sortbtn")];
      return {
        borderTopWidth: getComputedStyle(bar).borderTopWidth,
        background: getComputedStyle(bar).backgroundColor,
        position: getComputedStyle(bar).position,
        sortCount: sorts.length,
        sortTops: sorts.map((el) => Math.round(el.getBoundingClientRect().top)),
        bottom: Math.round(bar.getBoundingClientRect().bottom),
        firstCardTop: firstCard ? Math.round(firstCard.getBoundingClientRect().top) : null,
      };
    })(),
  };
  if (${JSON.stringify(scene)} === "bar") {
    if (state.holdBar.includes("—")) {
      throw new Error(\`the hold bar prints a dash: \${state.holdBar}\`);
    }
    if (state.holdBar.includes("₹")) {
      throw new Error(\`the hold bar prints a currency figure: \${state.holdBar}\`);
    }
    if (!state.holdBar.includes("16 holdings")) {
      throw new Error(\`the hold bar lost its count: \${state.holdBar}\`);
    }
  }
  if (${JSON.stringify(scene)} === "cas") {
    const cas = state.cards.find((card) => card.name.includes("TEST CAS VALUE"));
    if (!cas) throw new Error("the CAS value card is missing");
    if (cas.treatment !== "full") throw new Error(\`the CAS card is \${cas.treatment}\`);
    if (cas.sections.includes("Market value")) {
      throw new Error("a statement figure still has a MARKET VALUE heading");
    }
    if (!cas.facts.includes("statement-value")) {
      throw new Error("the CAS statement figure is missing");
    }
    if (!cas.statement.includes("₹ 25,000.00") || !cas.statement.includes("from the CAS")) {
      throw new Error(\`the statement fact says \${cas.statement}\`);
    }
    if (!cas.market.startsWith("—") && !cas.market.includes("held at cost")) {
      throw new Error(\`the market slot says \${cas.market}\`);
    }
    for (const [name, text] of [["gain", cas.gain], ["current yield", cas.currentYield],
      ["per unit", cas.perUnit]]) {
      if (!text.startsWith("—")) {
        throw new Error(\`\${name} came from the statement figure: \${text}\`);
      }
    }
    if (state.holdBar.includes("25,000")) {
      throw new Error(\`the statement value reached the hold bar: \${state.holdBar}\`);
    }
    if (!state.holdBar.includes("1,04,000")) {
      throw new Error(\`the hold bar lost the real market value: \${state.holdBar}\`);
    }
    if (!state.holdBar.includes("2 of 3 costed")
      || !state.holdBar.includes("1 of 3 priced")) {
      throw new Error(\`the hold bar lost its scope: \${state.holdBar}\`);
    }
  }
  if (${JSON.stringify(scene)} === "oneTerm") {
    const coupon = state.cards.find((card) => card.name.includes("TEST COUPON ONLY"));
    const maturity = state.cards.find((card) => card.name.includes("TEST MATURITY ONLY"));
    if (coupon?.treatment !== "terms-line" || maturity?.treatment !== "terms-line") {
      throw new Error(\`one-term treatments: \${coupon?.treatment} \${maturity?.treatment}\`);
    }
    for (const [card, want] of [[coupon, "Maturity date not known yet"],
      [maturity, "Coupon not known yet"]]) {
      if (!card.text.includes(want)) {
        throw new Error(\`the one-term sentence is \${card.text}, want \${want}\`);
      }
      if (card.text.includes("Coupon or maturity")) {
        throw new Error(\`the one-term sentence still merges both: \${card.text}\`);
      }
      if (card.facts.includes("total-if-held")) {
        throw new Error("a one-term card still has an anchor");
      }
    }
    if (!coupon.facts.includes("coupon") || coupon.facts.includes("maturity")) {
      throw new Error(\`the coupon-only facts: \${coupon.facts.join("|")}\`);
    }
    if (!maturity.facts.includes("maturity") || maturity.facts.includes("coupon")) {
      throw new Error(\`the maturity-only facts: \${maturity.facts.join("|")}\`);
    }
  }
  if (${JSON.stringify(scene)} === "header") {
    const want = "8 holdings · 6 ratings missing · 8 coupons not stored";
    if (!state.holdBar.includes(want)) {
      throw new Error(\`the hold bar says \${state.holdBar}, want \${want}\`);
    }
    if (/coupons? or maturit/i.test(state.holdBar)) {
      throw new Error(\`the hold bar still merges the terms: \${state.holdBar}\`);
    }
    const bare = state.cards.find((card) => card.name.includes("TEST CAS COUPON 1 31 Dec"));
    const costed = state.cards.find((card) => card.name.includes("TEST COSTED COUPON 1"));
    if (bare?.treatment !== "one-line") {
      throw new Error(\`the bare coupon card is \${bare?.treatment}\`);
    }
    if (costed?.treatment !== "terms-line") {
      throw new Error(\`the costed coupon card is \${costed?.treatment}\`);
    }
    if (!bare.text.includes("No cost or coupon yet. Your dealer's report has both.")) {
      throw new Error(\`the bare coupon card says \${bare.text}\`);
    }
    if (!costed.text.includes("Coupon not known yet") || costed.text.includes("maturity")) {
      throw new Error(\`the costed coupon card says \${costed.text}\`);
    }
    for (const card of [bare, costed]) {
      if (!card.facts.includes("maturity")) {
        throw new Error(\`\${card.name} lost its stored maturity\`);
      }
    }
  }
  if (${JSON.stringify(scene)} === "matured") {
    const cas = state.cards.find((card) => card.name.includes("TEST MATURED CAS"));
    const bare = state.cards.find((card) => card.name.includes("TEST MATURED BARE"));
    if (!cas || !bare) throw new Error("a matured card is missing");
    for (const card of [cas, bare]) {
      if (card.treatment !== "full") throw new Error("a matured card has a treatment");
      if (!same(card.facts, ${JSON.stringify(MATURED_KEYS)})) {
        throw new Error(\`the matured facts are \${card.facts.join("|")}\`);
      }
      if (card.facts.includes("statement-value")) {
        throw new Error("a matured statement figure is duplicated");
      }
    }
    if (cas.quietLine !== "") throw new Error(\`the complete matured card says \${cas.quietLine}\`);
    if (bare.quietLine !== "Cost or coupon not known") {
      throw new Error(\`the quiet line says \${bare.quietLine}\`);
    }
    if (bare.importActions !== 0 || bare.importLinks !== 0) {
      throw new Error("a matured card carries an Import action");
    }
    if (bare.anchorValue !== "—") {
      throw new Error(\`the bare matured anchor is \${bare.anchorValue}\`);
    }
    const divider = document.querySelector(".bond-matured-divider span:last-child")
      ?.textContent.replace(/\\s+/g, " ").trim() || "";
    if (!divider.includes(cas.anchorValue) || !divider.includes("2 lots")) {
      throw new Error(\`the divider says \${divider}, the anchor \${cas.anchorValue}\`);
    }
    if (!cas.anchorSub.includes("from the CAS")) {
      throw new Error(\`the anchor sub says \${cas.anchorSub}\`);
    }
  }
  if (state.width >= 1000) {
    if (!state.summary) throw new Error("the summary bar is missing");
    const emptySummary = ["bar", "oneTerm", "matured", "terms"].includes(${JSON.stringify(scene)});
    const want = emptySummary ? 0 : 3;
    if (state.summaryFigures !== want) {
      throw new Error(\`the summary bar has \${state.summaryFigures} figures, want \${want}\`);
    }
    if (state.summarySorts !== 4 || state.summary.sortCount !== 4) {
      throw new Error(\`the summary bar has \${state.summarySorts} sort controls\`);
    }
    const scopeWant = {
      gap: "1 of 17 costed", edge: "2 of 3 costed", bar: "0 of 16 costed",
      cas: "2 of 3 costed", oneTerm: "", terms: "", matured: "0 of 1 costed",
    }[${JSON.stringify(scene)}] ?? "";
    if (state.summaryScope !== scopeWant) {
      throw new Error(\`the scope says "\${state.summaryScope}", want "\${scopeWant}"\`);
    }
    if (emptySummary) {
      if (state.summary.borderTopWidth !== "0px") {
        throw new Error(\`the empty bar has a \${state.summary.borderTopWidth} top border\`);
      }
      if (state.summary.background !== "rgba(0, 0, 0, 0)") {
        throw new Error(\`the empty bar has a \${state.summary.background} background\`);
      }
      if (state.summary.position !== "static") {
        throw new Error(\`the empty bar is \${state.summary.position}\`);
      }
      if (new Set(state.summary.sortTops).size !== 1) {
        throw new Error(\`the empty bar's sort controls are on \${new Set(state.summary.sortTops).size} rows\`);
      }
      if (!(state.summary.bottom <= state.summary.firstCardTop + 1)) {
        throw new Error(\`the empty bar bottom \${state.summary.bottom} is below the card
          \${state.summary.firstCardTop}\`);
      }
    } else {
      if (state.summary.borderTopWidth === "0px") {
        throw new Error("the figured bar lost its border");
      }
      if (state.summary.background === "rgba(0, 0, 0, 0)") {
        throw new Error("the figured bar lost its background");
      }
      if (state.summary.position !== "sticky") {
        throw new Error(\`the figured bar is \${state.summary.position}\`);
      }
    }
  }

  const bare = state.cards.filter((card) => card.treatment === "one-line");
  if (bare.length !== ${config.bare}) {
    throw new Error(\`\${bare.length} one-line cards, want ${config.bare}\`);
  }
  for (const card of state.cards) {
    if (card.gapLines > 1) throw new Error(\`\${card.name} has \${card.gapLines} gap lines\`);
  }
  const gapCards = state.cards.filter((card) => card.treatment !== "full");
  if (state.width === 390) {
    for (const card of gapCards) {
      if (card.height >= 440) {
        throw new Error(\`\${card.name} is \${card.height}px tall, limit 440\`);
      }
    }
  }
  if (${JSON.stringify(scene)} === "edge") {
    const costLine = state.cards.find((card) => card.name.includes("TEST TERMS"));
    if (costLine?.treatment !== "cost-line") {
      throw new Error(\`the cost line is \${costLine?.treatment || "missing"}\`);
    }
    const termsLine = state.cards.find((card) => card.name.includes("TEST COST ONLY"));
    if (termsLine?.treatment !== "terms-line") {
      throw new Error(\`the terms line is \${termsLine?.treatment || "missing"}\`);
    }
  }
  if (!["bar", "long", "terms", "oneTerm", "matured", "header"]
    .includes(${JSON.stringify(scene)})) {
    const complete = state.cards.find((card) => card.name.includes("TEST COMPLETE"));
    if (!complete) throw new Error("the complete card is missing");
    if (complete.treatment !== "full") throw new Error("the complete card has a treatment");
    if (!same(complete.facts, ${JSON.stringify(LIVE_KEYS)})) {
      throw new Error(\`the complete card facts are \${complete.facts.join("|")}\`);
    }
    if (!same(complete.sections, ${JSON.stringify(SECTIONS)})) {
      throw new Error(\`the complete card sections are \${complete.sections.join("|")}\`);
    }
    if (complete.gapLines !== 0) throw new Error("the complete card has a gap line");
  }
  if (state.bannerTop >= state.cardsTop) throw new Error("the banner is below the cards");
  if (state.bannerTop <= state.disclosureTop) {
    throw new Error("the banner is above the disclosure");
  }

  const scrollTarget = ["bar", "header"].includes(${JSON.stringify(scene)})
    ? document.querySelector(".hold-bar") : detail;
  window.scrollTo(0, scrollTarget.getBoundingClientRect().top + window.scrollY - 72);
  await sleep(100);
  return JSON.stringify(state);
})();

function same(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}`;
}

const SHOTS = [
  { scene: "gap", width: 390, height: 1800, theme: "light" },
  { scene: "gap", width: 390, height: 1800, theme: "dark" },
  { scene: "gap", width: 1280, height: 1400, theme: "light" },
  { scene: "gap", width: 1280, height: 1400, theme: "dark" },
  { scene: "edge", width: 390, height: 3200, theme: "light" },
  { scene: "edge", width: 390, height: 3200, theme: "dark" },
  { scene: "edge", width: 1280, height: 2000, theme: "light" },
  { scene: "edge", width: 1280, height: 2000, theme: "dark" },
  { scene: "bar", width: 1280, height: 1200, theme: "light" },
  { scene: "bar", width: 1280, height: 1200, theme: "dark" },
  { scene: "long", width: 390, height: 1000, theme: "light" },
  { scene: "long", width: 390, height: 1000, theme: "dark" },
  { scene: "terms", width: 390, height: 1200, theme: "light" },
  { scene: "terms", width: 390, height: 1200, theme: "dark" },
  { scene: "terms", width: 1280, height: 1000, theme: "light" },
  { scene: "terms", width: 1280, height: 1000, theme: "dark" },
  { scene: "cas", width: 390, height: 1600, theme: "light" },
  { scene: "cas", width: 390, height: 1600, theme: "dark" },
  { scene: "cas", width: 1280, height: 1400, theme: "light" },
  { scene: "cas", width: 1280, height: 1400, theme: "dark" },
  { scene: "oneTerm", width: 390, height: 1600, theme: "light" },
  { scene: "oneTerm", width: 390, height: 1600, theme: "dark" },
  { scene: "oneTerm", width: 1280, height: 1400, theme: "light" },
  { scene: "oneTerm", width: 1280, height: 1400, theme: "dark" },
  { scene: "header", width: 390, height: 1500, theme: "light" },
  { scene: "header", width: 390, height: 1500, theme: "dark" },
  { scene: "matured", width: 390, height: 2200, theme: "light" },
  { scene: "matured", width: 390, height: 2200, theme: "dark" },
  { scene: "matured", width: 1280, height: 1200, theme: "light" },
  { scene: "matured", width: 1280, height: 1200, theme: "dark" },
];

function parseArgs(argv) {
  const args = { outDir: join(ROOT, "build/renders") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--out-dir") throw new Error(`render-bond-gap: unknown flag ${flag}`);
    const value = argv[index + 1];
    if (!value) throw new Error("render-bond-gap: --out-dir needs a value");
    args.outDir = value;
    index += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "web/server.mjs")], {
    env: { ...process.env, PORT: String(port) }, stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return { port, child };
    } catch { /* still starting */ }
  }
  child.kill();
  throw new Error("render-bond-gap: web/server.mjs did not answer.");
}

function report(state, shot) {
  const where = `${shot.scene} ${shot.width} ${shot.theme}`;
  if (state.width !== shot.width) {
    throw new Error(`render-bond-gap (${where}): asked for ${shot.width}px, got ${state.width}px`);
  }
  if (state.pageOverflow) throw new Error(`render-bond-gap (${where}): the page scrolls sideways`);
  for (const card of state.cards) {
    console.log(`${where}: ${card.name} — ${card.treatment}, ${card.height}px, `
      + `facts ${card.facts.join("|")}`);
  }
  console.log(`${where}: banner "${state.banner}"`);
  console.log(`${where}: hold bar "${state.holdBar}"`);
  console.log(`${where}: summary ${state.summaryFigures} figures · ${state.summarySorts} sorts`
    + (state.summary ? ` · border ${state.summary.borderTopWidth}`
      + ` · bg ${state.summary.background} · ${state.summary.position}` : ""));
  console.log(`${where}: disclosure ${state.gapLines.join(" | ")} · ${state.bondRows} bond rows`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

mkdirSync(args.outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "bankpipe-bond-gap-"));
const server = await startServer();
const page = `http://127.0.0.1:${server.port}/?demo=1`;
try {
  for (const shot of SHOTS) {
    const script = join(dir, `page-${shot.scene}-${shot.width}-${shot.theme}.js`);
    writeFileSync(script, pageScript(shot));
    const out = join(args.outDir,
      `bond-gap-${shot.scene}-${shot.width}-${shot.theme}.png`);
    const result = await capture({
      page, out, script, wait: 400, scale: 1,
      width: shot.width, height: shot.height, theme: shot.theme,
    });
    const state = JSON.parse(result.value);
    report(state, shot);
    console.log(out);
  }
  console.log("bond gap: one sentence for a bare CAS card · 16-lot banner · live and matured "
    + "cards unchanged · 390/1280 light and dark");
} finally {
  server.child.kill();
  rmSync(dir, { recursive: true, force: true });
}
