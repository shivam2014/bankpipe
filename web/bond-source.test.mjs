import test from "node:test";
import assert from "node:assert/strict";
import { parseSmest, smestFrequency, isoDate, bondNameOnly, bondPrefill } from "./bond-source.js";

// Shaped like the real blob, trimmed to the fields we read.
const blob = (bond) => `<html><body><script id="__NEXT_DATA__" type="application/json">${
  JSON.stringify({ page: "/bond-details/[securityName]/[isin]", props: { pageProps: { bondDetails: bond } } })
}</script></body></html>`;

const navi = {
  isin: "INE342T07429",
  securityName: "10.25% Navi Finserv Limited 31 Dec 2026",
  issuerOfSecurity: { issuerName: "Navi Finserv Limited" },
  faceValue: "100000 RUPEES",
  pricePerBond: "100000 RUPEES",
  issueDate: "2023-12-11",
  maturityDate: "2026-12-31",
  frequencyOfInterest: "Monthly",
  nextIPDate: "2026-11-30",
  lastIPDate: "2026-10-31",
  securedOrUnsecured: "Senior Secured",
  guaranteeType: "Non-Guaranteed",
  taxCategory: "Taxable",
  sector: "NBFC",
  modeOfIssue: "Private Placement",
  currentMarketPrice: null,
  coupons: [{ date: "31/12/2026", rate: "10.250000" }],
  maturities: [{ date: "31/12/2026", amount: "100.000000" }],
  ratingOrganizationMasters: [
    { organization: { name: "IND" }, rating: { rating: "A / Stable" }, ratingDate: "18/08/2023" },
    { organization: { name: "CRISIL" }, rating: { rating: "A / Stable" }, ratingDate: "15/01/2024" },
  ],
};

test("reads the terms of a bond from the page's JSON blob", () => {
  const d = parseSmest(blob(navi));
  assert.equal(d.isin, "INE342T07429");
  assert.equal(d.coupon, 10.25);
  assert.equal(d.face, 100000);
  assert.equal(d.maturity, "2026-12-31");
  assert.equal(d.allotment, "2023-12-11");
  assert.equal(d.frequency, "Monthly");
  assert.equal(d.nextInterest, "2026-11-30");
  assert.equal(d.issuer, "Navi Finserv Limited");
  assert.equal(d.secured, "Senior Secured");
  assert.equal(d.redemptions.length, 1);
});

test("the newest rating wins, and the others are kept", () => {
  const d = parseSmest(blob(navi));
  assert.equal(d.rating.agency, "CRISIL");
  assert.equal(d.rating.date, "2024-01-15");
  assert.equal(d.rating.text, "CRISIL A / Stable");
  assert.equal(d.rating.others.length, 1);
  assert.equal(d.rating.others[0].agency, "IND");
});

test("a bond that redeems in parts matures on the last date", () => {
  const d = parseSmest(blob({
    ...navi,
    isin: "INE00XL07015",
    securityName: "9.75% B N Agritech Limited 27 Nov 2028",
    maturityDate: "",
    maturities: [
      { date: "27/11/2028" }, { date: "27/08/2028" },
      { date: "27/05/2028" }, { date: "27/02/2028" },
    ],
  }));
  assert.equal(d.maturity, "2028-11-27");
  assert.equal(d.redemptions.length, 4);
  assert.equal(d.redemptions[0], "2028-02-27");
  assert.equal(d.redemptions[3], "2028-11-27");
});

test("a page without the blob, broken JSON or no bond reads as nothing", () => {
  assert.equal(parseSmest("<html>not found</html>"), null);
  assert.equal(parseSmest(
    '<script id="__NEXT_DATA__" type="application/json">{oops</script>'), null);
  assert.equal(parseSmest(blob(null)), null);
});

test("SMEST payment wording becomes one of the app's five options", () => {
  assert.equal(smestFrequency("Monthly"), "Monthly");
  assert.equal(smestFrequency("Quarterly"), "Quarterly");
  assert.equal(smestFrequency("Half Yearly"), "Half-yearly");
  assert.equal(smestFrequency("Semi Annual"), "Half-yearly");
  assert.equal(smestFrequency("Annually"), "Annual");
  assert.equal(smestFrequency("At Maturity"), "Cumulative");
  assert.equal(smestFrequency(""), "");
});

test("dates arrive in both the ISO and the Indian forms", () => {
  assert.equal(isoDate("2024-01-12"), "2024-01-12");
  assert.equal(isoDate("24/12/2024"), "2024-12-24");
  assert.equal(isoDate("4/12/2024"), "2024-12-04");
  assert.equal(isoDate(""), "");
  assert.equal(isoDate(null), "");
});

test("the coupon and the maturity are cut out of the name", () => {
  assert.equal(bondNameOnly("10.25% Navi Finserv Limited 31 Dec 2026"), "Navi Finserv Limited");
  assert.equal(bondNameOnly("Navi Finserv Limited"), "Navi Finserv Limited");
});

test("the fetched price values the lot when the units are known", () => {
  const details = { ...parseSmest(blob(navi)), ltp: 98.5 };
  const p = bondPrefill(details, { quantity: 2 });
  assert.equal(p.name, "Navi Finserv Limited");
  assert.equal(p.coupon, 10.25);
  assert.equal(p.rating, "CRISIL A / Stable");
  // ₹100,000 face × 2 units × ₹98.50 per ₹100 = ₹1,97,000.
  assert.equal(p.value_paise, 19700000);
  assert.equal(bondPrefill(details, {}).value_paise, null);
  assert.equal(bondPrefill({ ...details, ltp: null }, { quantity: 2 }).value_paise, null);
  assert.equal(bondPrefill(null, {}), null);
});
