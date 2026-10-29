// Zero-dependency static server for local use. Production needs none of this:
// the app is plain files, so any static host serves it.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSmest } from "./bond-source.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8801);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
};
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function denied(path) {
  if (path === "/server.mjs" || path === "/private" || path.startsWith("/private/")) return true;
  return path.split("/").some((part) => part.startsWith("."));
}


// --- BSE debt bhavcopy ------------------------------------------------------
// A free daily file keyed by ISIN. The browser cannot fetch it: BSE answers a
// fetch without a Referer with an HTML page, and a page cannot set that header.
// This local server can, so the page asks it for prices instead.
const BSE_DEBT = "https://www.bseindia.com/download/BhavCopy/Debt/DEBTBHAVCOPY";
const marketCache = new Map(); // isin -> { ltp, yield, face, date }

function zipCsvEntries(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    if (!compSize) break;
    const end = start + compSize;
    if (end > buf.length) break;
    if (/\.csv$/i.test(name)) {
      const raw = buf.subarray(start, end);
      out.push({ name, body: method === 0 ? raw : inflateRawSync(raw) });
    }
    i = end;
  }
  return out;
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

function bseDates(days) {
  const out = [];
  const d = new Date();
  for (let i = 0; out.length < days && i < days * 3 + 10; i++) {
    const day = new Date(d.getTime() - i * 86400000);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

async function bseDay(iso) {
  const [y, m, d] = iso.split("-");
  const url = `${BSE_DEBT}${d}${m}${y}.zip`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Referer: "https://www.bseindia.com/markets/MarketInfo/BhavCopy",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return 0;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) return 0;
  let found = 0;
  for (const entry of zipCsvEntries(buf)) {
    if (!/icdm/i.test(entry.name)) continue;
    const lines = entry.body.toString("utf8").split(/\r?\n/);
    const head = csvLine(lines[0] || "").map((h) => h.toLowerCase());
    const at = (name) => head.findIndex((h) => h.includes(name));
    const iIsin = at("isin"), iLtp = at("ltp"), iYield = at("yield"),
      iFace = at("face value");
    if (iIsin < 0 || iLtp < 0) continue;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const row = csvLine(line);
      const isin = (row[iIsin] || "").toUpperCase();
      if (!/^IN[A-Z0-9]{10}$/.test(isin)) continue;
      const ltp = Number(row[iLtp]);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      if (marketCache.has(isin)) continue;
      marketCache.set(isin, { ltp, date: iso,
        yield: iYield >= 0 ? Number(row[iYield]) || null : null,
        face: iFace >= 0 ? Number(row[iFace]) || null : null });
      found++;
    }
  }
  return found;
}

async function debtPrices(isins, days = 10) {
  const want = isins.filter((x) => !marketCache.has(x));
  for (const iso of bseDates(days)) {
    if (want.every((x) => marketCache.has(x))) break;
    try { await bseDayOnce(iso); } catch (e) { /* holiday or blocked */ }
  }
  const prices = {};
  for (const isin of isins) if (marketCache.has(isin)) prices[isin] = marketCache.get(isin);
  return prices;
}

// One Bhavcopy file per date, however many ISINs ask for it: "Fetch details for
// all" used to re-download the same twelve zips once per bond. A day's file
// never changes, so the promise is kept for the life of the process.
const dayOnce = new Map(); // iso -> Promise<number>
function bseDayOnce(iso) {
  if (!dayOnce.has(iso)) dayOnce.set(iso, bseDay(iso).catch(() => 0));
  return dayOnce.get(iso);
}

// --- SMEST bond details -----------------------------------------------------
// smest.in publishes one page per ISIN with the terms a buyer checks before
// buying: rating and agency, coupon, face value, maturity, payment frequency and
// the next interest date. The browser cannot read it — cross-origin, and the
// data sits inside the HTML — so the page asks this server. A bond's terms move
// a few times a year, so half a day of cache is plenty.
const SMEST = "https://smest.in/bond-details/x/";
const BOND_TTL = 12 * 60 * 60 * 1000;
const bondCache = new Map(); // isin -> { at, details }

async function smestBond(isin) {
  try {
    const res = await fetch(SMEST + encodeURIComponent(isin), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    // A 404 from SMEST is a real "no such bond"; a 500 or a timeout is not.
    if (res.status !== 200) return { details: null, answered: res.status === 404 };
    return { details: parseSmest(await res.text()), answered: true };
  } catch (e) {
    return { details: null, answered: false };
  }
}

async function bondDetails(isin) {
  const hit = bondCache.get(isin);
  if (hit && Date.now() - hit.at < BOND_TTL) return { details: { ...hit.details }, cached: true, answered: true };
  const got = await smestBond(isin);
  if (!got.details) return { details: null, cached: false, answered: got.answered };
  bondCache.set(isin, { at: Date.now(), details: got.details });
  if (bondCache.size > 500) bondCache.delete(bondCache.keys().next().value);
  return { details: { ...got.details }, cached: false, answered: true };
}

createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || "").toLowerCase();
    if (!HOSTS.has(host)) {
      res.writeHead(421, SECURITY).end("misdirected request");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...SECURITY, Allow: "GET, HEAD" }).end("method not allowed");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__health") {
      const body = Buffer.from('{"app":"bankpipe","ok":true}');
      res.writeHead(200, { ...SECURITY, "Content-Type": "application/json",
        "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/__market/debt") {
      const isins = String(url.searchParams.get("isins") || "").toUpperCase()
        .split(",").map((x) => x.trim()).filter((x) => /^IN[A-Z0-9]{10}$/.test(x)).slice(0, 60);
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 10));
      if (!isins.length) {
        res.writeHead(400, { ...SECURITY, "Content-Type": "application/json" })
          .end('{"error":"no isins"}');
        return;
      }
      const prices = await debtPrices(isins);
      const dates = Object.values(prices).map((p) => p.date).sort();
      const body = Buffer.from(JSON.stringify({
        asOf: dates.length ? dates[dates.length - 1] : null,
        found: Object.keys(prices).length, asked: isins.length, prices }));
      res.writeHead(200, { ...SECURITY, "Content-Type": "application/json",
        "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/__market/bond") {
      const isin = String(url.searchParams.get("isin") || "").trim().toUpperCase();
      if (!/^IN[A-Z0-9]{10}$/.test(isin)) {
        res.writeHead(400, { ...SECURITY, "Content-Type": "application/json" })
          .end('{"error":"bad isin"}');
        return;
      }
      // The two lookups are independent and each is useful alone: a price with
      // no rating still updates the value, a rating with no price still fills
      // the terms. Neither failure should sink the other.
      // Bonds can go a month without a trade, so the price looks back 12
      // sessions. That can take a while on the first ask, so it is given 7s and
      // then left running: the answer is cached, and pressing again is instant.
      const timeout = new Promise((resolve) => {
        const t = setTimeout(() => resolve({}), 7000);
        if (t.unref) t.unref();
      });
      const [bond, price] = await Promise.allSettled([
        bondDetails(isin),
        Promise.race([debtPrices([isin], 12).catch(() => ({})), timeout]),
      ]);
      const found = bond.status === "fulfilled" ? bond.value.details : null;
      const answered = bond.status === "fulfilled" ? bond.value.answered : false;
      const quote = price.status === "fulfilled" ? price.value[isin] || null : null;
      if (!found && !quote) {
        const body = Buffer.from(JSON.stringify({
          isin, error: answered ? "not listed" : "unreachable" }));
        res.writeHead(answered ? 404 : 502, { ...SECURITY, "Content-Type": "application/json",
          "Content-Length": body.length, "Cache-Control": "no-store" });
        res.end(body);
        return;
      }
      const market = quote
        ? { ltp: quote.ltp, date: quote.date, face: quote.face, yield: quote.yield }
        : null;
      const details = found ? { ...found } : null;
      // The form needs one price to value a lot, so hand it the BSE trade.
      if (details && market) { details.ltp = market.ltp; details.ltpDate = market.date; }
      const body = Buffer.from(JSON.stringify({
        isin,
        details,
        detailsError: details ? null : "SMEST does not list this ISIN",
        market,
        cached: bond.status === "fulfilled" ? bond.value.cached : false,
      }));
      res.writeHead(200, { ...SECURITY, "Content-Type": "application/json",
        "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path === "/" || path === "") path = "/index.html";
    if (denied(path)) { res.writeHead(404, SECURITY).end("not found"); return; }
    const file = join(ROOT, path);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403, SECURITY).end("forbidden");
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404, SECURITY).end("not found"); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY,
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    console.error("static server:", e.message);
    res.writeHead(500, SECURITY).end("server error");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`BankPipe web: http://127.0.0.1:${PORT}/`);
});
