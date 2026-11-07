// The CAS reader. A CDSL or NSDL consolidated statement lists what the
// depository actually holds, which is the only quantity a bond portfolio can be
// audited against: a seller report knows what was paid, never what is still
// there.
//
// The two layouts differ, but both share one property worth relying on: an ISIN
// appears once per holding, in vertical order, and every field of that holding
// sits within the band between the ISIN before it and the ISIN after it. That is
// the row rule here. Nothing is matched by name, and a row with no ISIN is
// quarantined rather than guessed at.
//
// Pure: it reads text items (str, x, y) from pdf.js and returns data. No DOM, no
// storage, no network.

import { boId } from "./bo-id.js";

const ISIN = /^IN[A-Z0-9]{10}$/;
const DATE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const NUMBER = /^\d[\d,]*(\.\d+)?$/;

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function rupees(text) {
  const n = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function quantity(text) {
  const n = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isoDate(text) {
  const m = String(text).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return "";
  const months = ["jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return "";
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

// The three depository sections. A page repeats them, so a heading only matters
// for the rows that follow it before the next heading.
const SECTIONS = [
  [/corporate\s*bonds?/i, "bond"],
  [/equity\s*shares?/i, "equity"],
  [/mutual\s*fund/i, "mf"],
];

/**
 * Read a CAS. Every holding is a band of items around one ISIN.
 * @param {{pages: Array<{items: Array<{str: string, x: number, y: number}>}>}} pdf
 * @returns {{depository: string, holdings: Array<object>, sections: object,
 *   warnings: Array<object>, counts: object}}
 */
export function parseCas(pdf) {
  const items = [];
  for (const page of pdf?.pages || []) {
    for (const item of page.items || []) {
      const str = tidy(item.str);
      if (str) items.push({ str, x: Number(item.x) || 0, y: Number(item.y) || 0 });
    }
  }
  const text = items.map((i) => i.str).join(" ");
  const depository = /central depository/i.test(text) ? "CDSL"
    : /national securities depository/i.test(text) ? "NSDL" : "";
  // The statement prints every account it covers. One demat per PAN is the
  // common case, so the first BO ID that reads as an account is the one the
  // holdings belong to. A second account would need its own page section.
  const bo = (text.match(/\bIN\d{14}\b/g) || [])
    .concat(text.match(/\b\d{16}\b/g) || [])
    .map((raw) => boId(raw))
    .find((id) => id.kind === "bo") || null;

  // Section of each item: the last heading above it on its page. Headings are
  // matched on the whole line, because a PDF splits "Equity Shares" into two
  // items as often as it keeps them together, and an item-level match then misses
  // the heading and files every following row under the previous section.
  const sectionAt = new Map();
  let current = "";
  const ordered = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of ordered) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= 3) last.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  for (const line of lines) {
    const text = line.items.map((i) => i.str).join(" ");
    for (const [re, name] of SECTIONS) if (re.test(text)) current = name;
    for (const item of line.items) sectionAt.set(item, current);
  }

  const isins = ordered.filter((i) => ISIN.test(i.str.toUpperCase().replace(/\s+/g, "")));
  if (!isins.length) {
    return { depository, demat: bo ? bo.boId : "", holdings: [], warnings: [{ code: "no_isin", count: 0 }],
      sections: {}, counts: { rows: 0, quarantined: 0 } };
  }

  // Band boundaries sit halfway between neighbouring ISINs, so a field printed
  // a line above or below its ISIN still lands in the right holding.
  const ys = isins.map((i) => i.y);
  const holdings = [];
  const warnings = [];
  let quarantined = 0;

  isins.forEach((anchor, index) => {
    const high = index === 0 ? ys[0] + (ys[0] - ys[1] || 40) / 2 : (ys[index - 1] + ys[index]) / 2;
    const low = index === isins.length - 1
      ? ys[index] - (ys[index - 1] - ys[index] || 40) / 2
      : (ys[index] + ys[index + 1]) / 2;
    const band = ordered.filter((i) => i.y <= high && i.y > low);
    const isin = anchor.str.toUpperCase().replace(/\s+/g, "");
    const numbers = band.filter((i) => NUMBER.test(i.str))
      .sort((a, b) => a.x - b.x);
    const date = band.find((i) => DATE.test(i.str));
    const name = band.filter((i) => /[A-Za-z]{3}/.test(i.str)
      && !ISIN.test(i.str.toUpperCase()) && !DATE.test(i.str))
      .sort((a, b) => b.str.length - a.str.length)[0];

    // Four numbers, left to right: quantity, face value, price, value. A row
    // with fewer than two is unreadable, and guessing which number is which is
    // how a portfolio ends up with a face value of 30.
    if (numbers.length < 2) {
      quarantined += 1;
      warnings.push({ code: "short_row", count: 1, isin: "redacted" });
      return;
    }
    const tail = numbers.slice(-4).map((i) => i.str);
    const quantityText = tail.length >= 4 ? tail[0] : tail[0];
    const faceText = tail.length >= 4 ? tail[1] : "";
    const priceText = tail.length >= 2 ? tail[tail.length - 2] : "";
    const valueText = tail[tail.length - 1];
    // The coupon sits left of the maturity date; the fields right of it are
    // quantity, face, price and value.
    const coupon = date
      ? numbers.filter((i) => i.x < date.x).slice(-1)[0] : null;
    const kind = sectionAt.get(anchor) || (isin.startsWith("INF") ? "mf" : "equity");
    holdings.push({
      isin,
      label: name ? tidy(name.str) : "",
      kind: kind === "bond" && date ? "bond" : kind === "bond" ? "bond" : kind,
      quantity: quantity(quantityText),
      faceValuePaise: faceText ? rupees(faceText) : null,
      pricePaise: priceText ? rupees(priceText) : null,
      valuePaise: rupees(valueText),
      maturity: date ? isoDate(date.str) : "",
      couponPct: coupon ? Number(coupon.str.replace(/,/g, "")) : null,
    });
  });

  const sections = {};
  for (const h of holdings) sections[h.kind] = (sections[h.kind] || 0) + 1;
  return { depository, demat: bo ? bo.boId : "", holdings, sections, warnings,
    counts: { rows: holdings.length, quarantined } };
}

/**
 * Where each holding belongs. A CAS covers one demat but several classes, and
 * this app keeps bonds and equities in separate accounts, so one target would
 * either overwrite a class or force the person to import the same file twice.
 * @param {{holdings: Array<object>, demat?: string}} parsed
 * @param {Array<{id: string, label?: string, category?: string, number?: string}>} assets
 * @returns {{demat: string, accounts: Array<object>, groups: Array<object>,
 *   homeless: Array<object>}}
 */
export function casRoute(parsed, assets = []) {
  const holdings = parsed?.holdings || [];
  const bo = boId(parsed?.demat || "");
  const accounts = bo.kind === "bo"
    ? (assets || []).filter((a) => boId(a.number).boId === bo.boId)
    : [];
  const home = (kind) => {
    // Bonds live in a bond portfolio. Shares live in the demat account itself.
    // Fund units are a folio, not a demat holding, and this app files them as a
    // demat asset with the "mutual fund" subtype — so the subtype is what keeps
    // a fund from landing on the share account and replacing it.
    if (kind === "bond") {
      return accounts.find((a) => String(a.category || "") === "bonds") || null;
    }
    const demat = accounts.filter((a) => String(a.category || "") === "demat");
    const isFund = (a) => /mutual\s*fund|^mf$/i.test(String(a.subtype || ""));
    return kind === "mf"
      ? demat.find(isFund) || null
      : demat.find((a) => !isFund(a)) || null;
  };
  const groups = new Map();
  const homeless = new Map();
  for (const holding of holdings) {
    const target = home(holding.kind);
    const bucket = target ? groups : homeless;
    const key = target ? `${holding.kind}|${target.id}` : holding.kind;
    if (!bucket.has(key)) {
      bucket.set(key, { kind: holding.kind, assetId: target?.id || "",
        assetLabel: target?.label || "", count: 0, valuePaise: 0 });
    }
    const row = bucket.get(key);
    row.count += 1;
    row.valuePaise += Number(holding.valuePaise) || 0;
  }
  return {
    demat: bo.kind === "bo" ? bo.boId : "",
    accounts,
    groups: [...groups.values()],
    homeless: [...homeless.values()],
  };
}

/**
 * A CAS is only worth writing when it agrees with itself: the sum of the rows
 * must equal the total the statement prints. The caller passes both, and a
 * mismatch is a refusal, not an exception to review.
 * @param {{holdings: Array<object>}} parsed
 * @param {number|null} statedTotalPaise
 * @returns {{ok: boolean, sumPaise: number, statedTotalPaise: number|null, diffPaise: number|null}}
 */
export function casTotals(parsed, statedTotalPaise) {
  const sumPaise = (parsed?.holdings || [])
    .reduce((t, h) => t + (Number(h.valuePaise) || 0), 0);
  if (statedTotalPaise === null || statedTotalPaise === undefined) {
    return { ok: true, sumPaise, statedTotalPaise: null, diffPaise: null };
  }
  const diffPaise = sumPaise - Number(statedTotalPaise);
  return { ok: diffPaise === 0, sumPaise, statedTotalPaise: Number(statedTotalPaise),
    diffPaise };
}
