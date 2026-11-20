import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assetAtCost } from "./assets.js";
import { bondAnalytics, bondInputsMissing, splitMatured } from "./bonds.js";
import { summarizeHoldings } from "./holdings.js";
import { bondBookSummary, bondCardHtml, bondCoverageText, bondDateLabel,
  bondGapBannerHtml, bondRatingOf, bondRowView, bondSortValue, moneyText }
  from "./bond-book.js";
import { bondGapBanner, bondImportOf, importAccountGaps } from "./import-flow.js";
import { escapeHtml as esc, jsArg } from "./escape.js";

// The page's own holdings card, run with the module imports it calls. The
// fixture is synthetic: one lot has a BSE price and one carries only its cost.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const from = html.indexOf("function holdingsCard(");
const to = html.indexOf("// A demat account's holdings arrive", from);
assert.ok(from >= 0 && to > from, "holdingsCard is in index.html");

const holdingsCard = new Function(
  "window", "splitMatured", "summarizeHoldings", "bondAnalytics", "assetAtCost",
  "bondInputsMissing", "bondRatingOf", "importAccountGaps", "dateLabel",
  "bondGapBanner", "bondRowView", "bondSortValue", "bondCoverageText",
  "bondBookSummary", "bondImportOf", "currency", "bondCardHtml",
  "bondGapBannerHtml", "money", "esc", "jsArg", "bondFetchPanelBody",
  `${html.slice(from, to)}
   return holdingsCard;`,
)({ bpBondSortState: null, bpGapAccountRows: [], bpBondFetchStatus: null },
  splitMatured, summarizeHoldings, bondAnalytics, assetAtCost,
  bondInputsMissing, bondRatingOf, importAccountGaps, bondDateLabel,
  bondGapBanner, bondRowView, bondSortValue, bondCoverageText,
  bondBookSummary, bondImportOf, () => "₹", bondCardHtml,
  bondGapBannerHtml, moneyText, esc, jsArg, () => "");

const base = {
  category: "bond", quantity: 800, face_paise: 100000,
  purchase_date: "2024-11-05", frequency: "Half-yearly",
  rating: "AA", rating_at_purchase: "AA", yield_bps: 740, source: "report",
};

const priced = {
  ...base, id: "lot-priced", label: "7.40% TEST BOND 3 10 Feb 2030",
  issuer: "TEST BOND 3", security_id: "INE000000123",
  cost_paise: 80000000, value_paise: 81440000, value_source: "BSE",
  as_of: "2026-10-31", interest_date: "2027-02-10", maturity: "2030-02-10",
};

const costOnly = {
  ...base, id: "lot-cost", label: "7.40% TEST BOND 4 10 Feb 2031",
  issuer: "TEST BOND 4", security_id: "INE000000124",
  cost_paise: 80000000, value_paise: null, value_source: "",
  interest_date: "2027-02-10", maturity: "2031-02-10",
};

const mixedAccount = {
  id: "demat-mixed", label: "Demat", category: "demat", subtype: "equity",
  number: "IN99990001344321", holdings_count: 2,
  holdings_live_cost: 160000000, holdings_live_value: 81440000,
  holdings_valued_count: 1, holdings_value: 81440000, holdings_cost: 160000000,
};

const cardNamed = (rendered, name) => {
  const card = rendered.split('<div class="bond-card"').slice(1)
    .find((part) => part.includes(`<div class="bond-name">${name}</div>`));
  assert.ok(card, `${name} has a card`);
  return card;
};

test("a cost-only lot beside a priced lot is shown held at cost", () => {
  assert.equal(assetAtCost(mixedAccount), false,
    "the account has one priced row, so the account measure is not at cost");

  const rendered = holdingsCard([priced, costOnly], "demat-mixed", mixedAccount);

  const atCostCard = cardNamed(rendered, "7.40% TEST BOND 4 10 Feb 2031");
  const atCostValue = atCostCard.slice(atCostCard.indexOf('data-fact="market-value"'));
  assert.match(atCostValue, /<span class="k">Value now<\/span>/);
  assert.ok(atCostValue.includes(`<span class="v ">${moneyText(80000000)}`),
    "the card shows the cost as its value");
  assert.ok(atCostValue.includes("held at cost"),
    "the cost is named as the cost");
  assert.doesNotMatch(atCostValue, /cost from the report/,
    "a bare noun is not a source");
  assert.match(atCostValue, /Enter market value/);
  assert.doesNotMatch(atCostValue, /not recorded/);

  const pricedCard = cardNamed(rendered, "7.40% TEST BOND 3 10 Feb 2030");
  const pricedValue = pricedCard.slice(pricedCard.indexOf('data-fact="market-value"'));
  assert.match(pricedValue, /<span class="k">Market value<\/span>/);
  assert.ok(pricedValue.includes(`<span class="v ">${moneyText(81440000)}`),
    "the priced lot keeps its market value");
  assert.match(pricedValue, /from BSE/);
  assert.doesNotMatch(pricedValue, /held at cost/,
    "the priced card is unchanged by its cost-only neighbour");
});
