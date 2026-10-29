// Reading a bond's terms from SMEST (smest.in), a free page per ISIN.
//
// The page is a Next.js app that ships its data as one JSON blob in
// `<script id="__NEXT_DATA__">`. Parsing that is far steadier than scraping the
// rendered HTML, which changes with every restyle. Everything here is pure: the
// server does the fetching, the browser does the formatting, and the tests run
// against a saved blob.

const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

// Rupee amounts arrive as "100000 RUPEES" or "1,000 RUPEES".
function firstAmount(text) {
  const m = String(text ?? "").match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// SMEST mixes ISO ("2024-01-12") and Indian ("24/12/2024") dates.
export function isoDate(text) {
  const s = String(text ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// The app's payment-frequency options are these five; SMEST is free text.
export function smestFrequency(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t) return "";
  if (t.includes("month")) return "Monthly";
  if (t.includes("quarter")) return "Quarterly";
  if (t.includes("half") || t.includes("semi")) return "Half-yearly";
  if (t.includes("annual") || t.includes("year")) return "Annual";
  if (t.includes("matur") || t.includes("cumulative") || t.includes("bullet")) return "Cumulative";
  return "";
}

function ratingsOf(b) {
  return (b.ratingOrganizationMasters || []).map((r) => {
    const inner = r?.rating;
    const value = String(typeof inner === "string" ? inner : inner?.rating || "").trim();
    const agency = String(r?.organization?.name || "").trim();
    return {
      agency, value,
      date: isoDate(r?.ratingDate) || String(inner?.insertedAt || "").slice(0, 10),
      text: [agency, value].filter(Boolean).join(" "),
    };
  }).filter((r) => r.value);
}

export function parseSmest(html) {
  const m = String(html || "").match(NEXT_DATA);
  if (!m) return null;
  let data = null;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }
  const b = data?.props?.pageProps?.bondDetails;
  if (!b || !b.isin) return null;

  // Older bonds redeem in parts; the last date is the real maturity.
  const redemptionDates = (b.maturities || []).map((x) => isoDate(x?.date)).filter(Boolean).sort();
  const ratingList = ratingsOf(b);
  // Ratings are issuer-level: several agencies may cover the same paper. The
  // newest one is the one a buyer checks first.
  const rating = [...ratingList].sort((a, z) => String(z.date).localeCompare(String(a.date)))[0] || null;
  const couponRate = Number((b.coupons || [])[0]?.rate);

  return {
    isin: String(b.isin).toUpperCase(),
    name: String(b.securityName || "").trim(),
    issuer: String(b.issuerOfSecurity?.issuerName || "").trim(),
    coupon: Number.isFinite(couponRate) && couponRate > 0
      ? Math.round(couponRate * 100) / 100 : firstAmount(b.securityName),
    face: firstAmount(b.faceValue),
    maturity: isoDate(b.maturityDate)
      || (redemptionDates.length ? redemptionDates[redemptionDates.length - 1] : ""),
    allotment: isoDate(b.issueDate),
    frequency: smestFrequency(b.frequencyOfInterest),
    nextInterest: isoDate(b.nextIPDate),
    lastInterest: isoDate(b.lastIPDate),
    rating: rating ? { ...rating, others: ratingList.filter((r) => r !== rating) } : null,
    secured: String(b.securedOrUnsecured || "").trim(),
    guarantee: String(b.guaranteeType || "").trim(),
    taxStatus: String(b.taxCategory || "").trim(),
    sector: String(b.sector || "").trim(),
    mode: String(b.modeOfIssue || "").trim(),
    redemptions: redemptionDates,
    marketPrice: firstAmount(b.currentMarketPrice),
  };
}

// "10.85% Satin Creditcare Network Limited 10 Jul 2026" -> "Satin Creditcare…"
export function bondNameOnly(label) {
  return String(label || "")
    .replace(/^\s*\d+(?:\.\d+)?\s*%\s*/, "")
    .replace(/\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s*$/, "")
    .trim();
}

// What the holding form would become. The value needs units (from the row or
// the form) and the BSE price per ₹100 face; without either it stays null and
// the user keeps whatever they typed.
export function bondPrefill(details, row = {}) {
  if (!details) return null;
  const units = Number(row.quantity) || 0;
  const face = Number(details.face) > 0 ? Number(details.face) : null;
  const ltp = Number(details.ltp) > 0 ? Number(details.ltp) : null;
  return {
    name: bondNameOnly(details.name),
    coupon: details.coupon ?? null,
    maturity: details.maturity || "",
    frequency: details.frequency || "",
    rating: details.rating?.text || "",
    interest_date: details.nextInterest || "",
    value_paise: face && units && ltp ? Math.round(face * units * ltp) : null,
    face, ltp, units,
  };
}
