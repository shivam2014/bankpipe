// Money maths for income-producing and priced assets. Everything is integer
// paise and ISO dates; nothing here reads the database or the DOM.
//
// The rules are deliberately conservative:
//   - FD: quarterly compounding, the Indian bank norm, capped at maturity.
//   - Bond: simple coupon interest over the term; "received so far" is what the
//     user recorded, never an estimate.
//   - Gold: value = grams x price per gram. PnL needs both buy and current price.
//   - Equity: value and cost come from the last holdings import, or manual.
//   - Insurance: premiums paid are the investment. The cover/maturity value is
//     reported separately and is not added to net worth.

const DAY = 86_400_000;

export function parseDay(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function yearsBetween(from, to) {
  const a = parseDay(from), b = parseDay(to);
  if (a === null || b === null) return null;
  return (b - a) / (365.25 * DAY);
}

// Calendar months, not day fractions: an FD from 1 Jan to 1 Jan is exactly one
// year even when the span contains a leap day.
export function monthsBetween(from, to) {
  const a = parseDay(from), b = parseDay(to);
  if (a === null || b === null) return null;
  const da = new Date(a), db = new Date(b);
  const months = (db.getUTCFullYear() - da.getUTCFullYear()) * 12
    + (db.getUTCMonth() - da.getUTCMonth());
  return months + (db.getUTCDate() - da.getUTCDate()) / 30.44;
}

export function addMonths(iso, months) {
  const t = parseDay(iso);
  if (t === null) return null;
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const pct = (gain, invested) =>
  invested ? Math.round((gain * 10000) / invested) / 100 : null;

export function fdMaturityValue(principal, rateBps, start, maturity) {
  if (!principal || !rateBps || !start || !maturity) return null;
  const months = monthsBetween(start, maturity);
  if (months === null || months <= 0) return null;
  const r = rateBps / 10000;
  return Math.round(principal * Math.pow(1 + r / 4, months / 3));
}

export function fdAccruedInterest(principal, rateBps, start, asOf, maturity) {
  if (!principal || !rateBps || !start || !asOf) return null;
  const end = maturity && parseDay(asOf) > parseDay(maturity) ? maturity : asOf;
  const months = monthsBetween(start, end);
  if (months === null || months <= 0) return 0;
  const r = rateBps / 10000;
  return Math.round(principal * (Math.pow(1 + r / 4, months / 3) - 1));
}

export function bondTotalInterest(principal, rateBps, start, maturity) {
  if (!principal || !rateBps || !start || !maturity) return null;
  const months = monthsBetween(start, maturity);
  if (months === null || months <= 0) return null;
  return Math.round(principal * (rateBps / 10000) * (months / 12));
}

const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function metaOf(asset) {
  const raw = asset?.meta;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// One shape for every asset row, so the page and the dashboard cannot disagree.
export function assetMetrics(asset, category, today = new Date()) {
  const asOf = today.toISOString().slice(0, 10);
  const meta = metaOf(asset);
  const manual = n(asset?.value_paise);
  const facts = Number(asset?.facts || 0);
  const balance = n(asset?.balance);
  const principal = n(asset?.principal_paise);
  const rate = n(asset?.rate_bps);
  const start = asset?.start_date || "";
  const maturity = asset?.maturity_date || "";
  const received = n(asset?.interest_paid_paise);

  const base = {
    value: null, invested: null, gain: null, gainPct: null,
    expectedAtMaturity: null, interestSoFar: null, expectedInterest: null,
    cover: null, premium: null, note: "", excluded: false,
  };

  if (category === "insurance") {
    // The family treats what has actually been paid as the investment. The
    // cover (the expected return at maturity) is shown, but not added to net
    // worth, because it has not been received yet.
    const premium = n(meta.premium_paise) ?? manual;
    const cover = n(meta.sum_assured_paise);
    return {
      ...base,
      value: premium,
      invested: premium,
      cover,
      premium,
      expectedAtMaturity: cover,
      note: [premium !== null ? "premiums paid" : "no premiums recorded",
        maturity ? `matures ${maturity}` : ""].filter(Boolean).join(" · "),
      excluded: false,
    };
  }

  if (category === "fd") {
    const maturityValue = fdMaturityValue(principal, rate, start, maturity);
    const accrued = fdAccruedInterest(principal, rate, start, asOf, maturity);
    // The principal is real money even when the sheet does not give a rate or
    // start date. Show it, and say why no interest is added, instead of
    // pretending the FD has no value.
    const value = principal !== null ? principal + (accrued || 0) : manual;
    const missing = [
      rate === null ? "rate" : "",
      !start ? "start date" : "",
    ].filter(Boolean);
    return {
      ...base,
      value,
      invested: principal,
      gain: accrued,
      gainPct: accrued !== null ? pct(accrued, principal) : null,
      expectedAtMaturity: maturityValue,
      note: [
        rate ? `${rate / 100}%` : "",
        maturity ? `matures ${maturity}` : "",
        principal !== null && missing.length ? `principal only · ${missing.join(" and ")} missing` : "",
      ].filter(Boolean).join(" · ") || "fixed deposit",
    };
  }

  if (category === "bonds") {
    // A bond portfolio imported as holdings is valued from its lots, not from
    // a single principal/rate pair. A manually added bond still uses the
    // coupon calculation below.
    const lots = n(asset?.holdings_count);
    if (lots !== null && lots > 0) {
      const cost = n(asset?.holdings_cost);
      const pricedValue = n(asset?.holdings_priced_value);
      const pricedCost = n(asset?.holdings_priced_cost);
      const pricedCount = n(asset?.holdings_priced_count);
      const held = n(asset?.holdings_value);
      // Older callers may not supply the priced aggregates yet.
      const hasPricedFields = asset?.holdings_priced_value !== undefined
        || asset?.holdings_priced_cost !== undefined;
      const hasPrice = pricedValue !== null && pricedCost !== null;
      // Unpriced lots stay at cost. Comparing one priced lot with the cost of
      // every lot produced a huge fake loss on a partially priced portfolio.
      const value = hasPricedFields
        ? (cost === null ? manual : (hasPrice ? cost + (pricedValue - pricedCost) : cost))
        : (held !== null ? held : (cost !== null ? cost : manual));
      const gain = hasPricedFields
        ? (hasPrice ? pricedValue - pricedCost : null)
        : (cost !== null && held !== null ? held - cost : null);
      const gainPct = gain !== null
        ? pct(gain, hasPricedFields ? (pricedCost ?? cost) : cost) : null;
      return {
        ...base,
        value,
        invested: cost,
        gain,
        gainPct,
        pricedCount: hasPricedFields ? pricedCount : (held !== null ? lots : null),
        pricedCost: hasPricedFields ? pricedCost : null,
        lots,
        note: `${lots} holdings${hasPricedFields
          ? (pricedCount ? ` · ${pricedCount} priced` : " · at cost")
          : (held === null ? " · at cost" : "")}`,
      };
    }
    const totalInterest = bondTotalInterest(principal, rate, start, maturity);
    const expected = principal !== null && totalInterest !== null
      ? principal + totalInterest : null;
    const value = principal !== null ? principal + (received || 0) : manual;
    return {
      ...base,
      value,
      invested: principal,
      gain: received,
      gainPct: received !== null ? pct(received, principal) : null,
      expectedAtMaturity: expected,
      interestSoFar: received,
      expectedInterest: totalInterest,
      note: [
        rate ? `coupon ${rate / 100}%` : "",
        maturity ? `matures ${maturity}` : "",
      ].filter(Boolean).join(" · ") || "bond",
    };
  }

  if (category === "gold") {
    const givenGrams = n(meta.grams);
    const buy = n(meta.buy_per_gram_paise);
    const current = n(meta.current_per_gram_paise);
    const cost = manual;
    // If the weight is not written down, the buy value and the price per gram
    // are enough to estimate it. Keep the estimate labelled, never silent.
    let grams = givenGrams;
    let gramsDerived = false;
    if (grams === null && buy !== null && buy > 0 && cost !== null) {
      grams = Math.round((cost / buy) * 1000) / 1000;
      gramsDerived = true;
    }
    const invested = givenGrams !== null && buy !== null ? Math.round(givenGrams * buy)
      : cost;
    const marketValue = grams !== null && current !== null
      ? Math.round(grams * current) : null;
    // Net worth carries the cost of the gold, not its market value. An
    // unrealised gain is information, not money already earned.
    const value = invested !== null ? invested : manual;
    const unrealisedGain = marketValue !== null && invested !== null
      ? marketValue - invested : null;
    const realisedGain = n(meta.realised_gain_paise);
    const buyDate = meta.buy_date || start;
    const sinceYear = buyDate ? Number(String(buyDate).slice(0, 4)) : null;
    return {
      ...base,
      value,
      invested,
      marketValue,
      unrealisedGain,
      realisedGain,
      gain: realisedGain,
      gainPct: realisedGain !== null && invested !== null ? pct(realisedGain, invested) : null,
      grams,
      gramsDerived,
      buyDate,
      sinceYear,
      note: [
        grams !== null ? `${grams} g${gramsDerived ? " estimated" : ""}` : "",
        value === invested && invested !== null ? "at cost" : "",
        sinceYear ? `since ${sinceYear}` : "",
      ].filter(Boolean).join(" · ") || "gold",
    };
  }

  if (category === "demat") {
    const lots = n(asset?.holdings_count);
    const buy = lots !== null && lots > 0
      ? n(asset?.holdings_cost) : n(meta.buy_value_paise);
    const heldValue = lots !== null && lots > 0 ? n(asset?.holdings_value) : null;
    const manualCurrent = n(meta.current_value_paise);
    let value = heldValue !== null ? heldValue
      : (manualCurrent !== null ? manualCurrent : manual);
    let note = lots ? `${lots} holdings`
      : (meta.source === "import"
        ? `last import${meta.as_of ? " " + meta.as_of : ""}`
        : (meta.as_of ? `manual ${meta.as_of}` : "manual"));
    if (lots && heldValue === null && manualCurrent === null && buy !== null) {
      value = buy;
      note = `${lots} holdings · at cost`;
    }
    const gain = buy !== null && value !== null ? value - buy : null;
    return {
      ...base,
      value,
      invested: buy,
      gain,
      gainPct: gain !== null ? pct(gain, buy) : null,
      note,
    };
  }

  // Bank and cash: a statement balance wins over a manual value.
  if ((category === "bank" || category === "cash") && facts > 0 && balance !== null
      && (!asset?.currency || asset.currency === "INR")) {
    return { ...base, value: balance, note: "latest statement" };
  }
  return {
    ...base,
    value: manual,
    note: manual === null ? "no value yet"
      : (asset?.value_date ? `manual · ${asset.value_date}` : "manual"),
  };
}
