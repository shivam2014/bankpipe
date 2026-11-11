// Market data for the hosted app.
//
// The browser cannot read either source directly: BSE wants a Referer it will
// not let a page set, and SMEST is cross-origin with the data inside the page.
// The desktop build answers from its local Node server (web/server.mjs); this
// module gives the Pages worker the same two routes, same-origin with the app.
//
//   GET /__market/bond?isin=INE...   terms from SMEST + a BSE quote
//   GET /__market/debt?isins=a,b&days=10   last traded prices only
//
// Caches live in the isolate. They are a courtesy, not a promise: a cold worker
// simply reads the exchange again.

import { parseSmest } from "./bond-source.js";

const BSE_DEBT = "https://www.bseindia.com/download/BhavCopy/Debt/DEBTBHAVCOPY";
const SMEST = "https://smest.in/bond-details/x/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126 Safari/537.36";
const BOND_TTL = 12 * 60 * 60 * 1000;
const ISIN = /^IN[A-Z0-9]{10}$/;

const priceCache = new Map(); // isin -> { ltp, yield, face, date }
const dayCache = new Map();   // iso -> Promise<number>
const bondCache = new Map();  // isin -> { at, details }

export function resetMarketCache() {
  priceCache.clear();
  dayCache.clear();
  bondCache.clear();
}

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// --- BSE debt bhavcopy ------------------------------------------------------

function entries(buf) {
  // Local file headers only: the bhavcopy zip is written in one pass, with no
  // data descriptors, so the sizes are always in the header.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let i = 0;
  while (i + 30 <= buf.byteLength && view.getUint32(i, true) === 0x04034b50) {
    const method = view.getUint16(i + 8, true);
    const size = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const start = i + 30 + nameLen + extraLen;
    const end = start + size;
    if (!size || end > buf.byteLength) break;
    const name = new TextDecoder().decode(buf.slice(i + 30, i + 30 + nameLen));
    out.push({ name, method, body: buf.slice(start, end) });
    i = end;
  }
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function csvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export function bseDates(days, now = new Date()) {
  const out = [];
  for (let i = 0; out.length < days && i < days * 3 + 10; i++) {
    const day = new Date(now.getTime() - i * 86400000);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

async function readDay(iso, fetchImpl) {
  const [y, m, d] = iso.split("-");
  const res = await fetchImpl(`${BSE_DEBT}${d}${m}${y}.zip`, {
    headers: { "User-Agent": UA, Referer: "https://www.bseindia.com/markets/MarketInfo/BhavCopy" },
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return 0;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 100 || new DataView(buf.buffer).getUint32(0, true) !== 0x04034b50) return 0;
  let found = 0;
  for (const entry of entries(buf)) {
    if (!/icdm/i.test(entry.name)) continue;
    const body = entry.method === 0 ? entry.body : await inflateRaw(entry.body);
    const lines = new TextDecoder().decode(body).split(/\r?\n/);
    const head = csvLine(lines[0] || "").map((h) => h.toLowerCase());
    const at = (name) => head.findIndex((h) => h.includes(name));
    const iIsin = at("isin"), iLtp = at("ltp"), iYield = at("yield"),
      iFace = at("face value");
    if (iIsin < 0 || iLtp < 0) continue;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const row = csvLine(line);
      const isin = (row[iIsin] || "").toUpperCase();
      if (!ISIN.test(isin) || priceCache.has(isin)) continue;
      const ltp = Number(row[iLtp]);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      priceCache.set(isin, { ltp, date: iso,
        yield: iYield >= 0 ? Number(row[iYield]) || null : null,
        face: iFace >= 0 ? Number(row[iFace]) || null : null });
      found++;
    }
  }
  return found;
}

// One download per trading day, however many ISINs ask for it.
function dayOnce(iso, fetchImpl) {
  if (!dayCache.has(iso)) dayCache.set(iso, readDay(iso, fetchImpl).catch(() => 0));
  return dayCache.get(iso);
}

export async function debtPrices(isins, days = 10, fetchImpl = fetch) {
  const want = isins.filter((x) => !priceCache.has(x));
  for (const iso of bseDates(days)) {
    if (want.every((x) => priceCache.has(x))) break;
    await dayOnce(iso, fetchImpl);
  }
  const out = {};
  for (const isin of isins) if (priceCache.has(isin)) out[isin] = priceCache.get(isin);
  return out;
}

// --- SMEST terms ------------------------------------------------------------

async function smestBond(isin, fetchImpl) {
  try {
    const res = await fetchImpl(SMEST + encodeURIComponent(isin), {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 200) return { details: null, answered: res.status === 404 };
    return { details: parseSmest(await res.text()), answered: true };
  } catch (e) {
    return { details: null, answered: false };
  }
}

export async function bondDetails(isin, fetchImpl = fetch) {
  const hit = bondCache.get(isin);
  if (hit && Date.now() - hit.at < BOND_TTL) {
    return { details: { ...hit.details }, cached: true, answered: true };
  }
  const got = await smestBond(isin, fetchImpl);
  if (!got.details) return { details: null, cached: false, answered: got.answered };
  bondCache.set(isin, { at: Date.now(), details: got.details });
  if (bondCache.size > 500) bondCache.delete(bondCache.keys().next().value);
  return { details: { ...got.details }, cached: false, answered: true };
}

// --- routes -----------------------------------------------------------------

export async function handleMarket(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/__market/debt") {
    const isins = String(url.searchParams.get("isins") || "").toUpperCase()
      .split(",").map((x) => x.trim()).filter((x) => ISIN.test(x)).slice(0, 60);
    if (!isins.length) return json({ error: "no isins" }, 400);
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 10));
    const prices = await debtPrices(isins, days, fetchImpl);
    const dates = Object.values(prices).map((p) => p.date).sort();
    return json({ asOf: dates.length ? dates[dates.length - 1] : null,
      found: Object.keys(prices).length, asked: isins.length, prices });
  }

  if (url.pathname === "/__market/bond") {
    const isin = String(url.searchParams.get("isin") || "").trim().toUpperCase();
    if (!ISIN.test(isin)) return json({ error: "bad isin" }, 400);
    // Terms and price are independent; either alone still helps. The price is
    // given 7s and then left running, so pressing again is quick once cached.
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({}), 7000);
      if (timer.unref) timer.unref();
    });
    const [bond, quote] = await Promise.allSettled([
      bondDetails(isin, fetchImpl),
      Promise.race([debtPrices([isin], 12, fetchImpl).catch(() => ({})), timeout]),
    ]);
    if (timer) clearTimeout(timer);
    const found = bond.status === "fulfilled" ? bond.value.details : null;
    const answered = bond.status === "fulfilled" ? bond.value.answered : false;
    const market = quote.status === "fulfilled" ? quote.value[isin] || null : null;
    if (!found && !market) {
      return json({ isin, error: answered ? "not listed" : "unreachable" },
        answered ? 404 : 502);
    }
    const details = found ? { ...found } : null;
    if (details && market) { details.ltp = market.ltp; details.ltpDate = market.date; }
    return json({ isin, details,
      detailsError: details ? null : "SMEST does not list this ISIN",
      market, cached: bond.status === "fulfilled" ? bond.value.cached : false });
  }

  return json({ error: "not found" }, 404);
}
