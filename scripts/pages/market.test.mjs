import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  bseDates, debtPrices, handleMarket, resetMarketCache,
} from "./market.js";

// A zip with one entry, written the way the bhavcopy is: local header first,
// no data descriptor. The reader never inspects the CRC.
function zipOf(name, body, method = 8) {
  const plain = Buffer.from(body);
  const data = method === 0 ? plain : deflateRawSync(plain);
  const nameBuf = Buffer.from(name);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt32LE(0, 14);            // crc, unchecked
  head.writeUInt32LE(data.length, 18);  // compressed size
  head.writeUInt32LE(plain.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, data]);
}

const ICDM = [
  "ISIN,LTP,YIELD,FACE VALUE",
  "INE000000001,99.50,10.25,100000",
  "INE000000002,101.25,9.80,100000",
].join("\n");

const zip = zipOf("BhavCopy_ICDM.csv", ICDM);
const found = { zip, calls: 0 };

const bseOnly = async (url) => {
  if (url.includes("bseindia.com")) {
    found.calls++;
    return new Response(found.calls === 1 ? zip : "no file", { status: found.calls === 1 ? 200 : 404 });
  }
  return new Response("nope", { status: 404 });
};

test("the debt route turns a bhavcopy zip into per-ISIN prices", async () => {
  resetMarketCache();
  found.calls = 0;
  const res = await handleMarket(
    new Request("https://bankpipe.pages.dev/__market/debt?isins=INE000000001&days=3"),
    bseOnly);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.asked, 1);
  assert.equal(body.found, 1);
  assert.equal(body.prices.INE000000001.ltp, 99.5);
  assert.equal(body.prices.INE000000001.face, 100000);
  assert.equal(body.asOf.length, 10);
  // One zip read, not one per ISIN.
  assert.equal(found.calls, 1);
});

test("the bond route answers with a quote when SMEST has no page", async () => {
  resetMarketCache();
  found.calls = 0;
  const res = await handleMarket(
    new Request("https://bankpipe.pages.dev/__market/bond?isin=INE000000001"),
    bseOnly);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.details, null);
  assert.equal(body.market.ltp, 99.5);
  assert.match(body.detailsError, /SMEST/);
});

test("a bond route with neither a quote nor terms says which side failed", async () => {
  resetMarketCache();
  const res = await handleMarket(
    new Request("https://bankpipe.pages.dev/__market/bond?isin=INE000000002"),
    async () => new Response("down", { status: 500 }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "unreachable");
});

test("bad input is refused before any network call", async () => {
  resetMarketCache();
  let calls = 0;
  const spy = async () => { calls++; return new Response(""); };
  for (const path of ["/__market/debt", "/__market/bond", "/__market/bond?isin=NOPE"]) {
    const res = await handleMarket(new Request("https://x" + path), spy);
    assert.equal(res.status, 400, path);
  }
  assert.equal(calls, 0);
});

test("prices are cached across calls", async () => {
  resetMarketCache();
  found.calls = 0;
  await debtPrices(["INE000000001"], 2, bseOnly);
  const again = await debtPrices(["INE000000001"], 2, bseOnly);
  assert.equal(again.INE000000001.ltp, 99.5);
  assert.equal(found.calls, 1);
});

test("trading days skip weekends", () => {
  const days = bseDates(5, new Date("2026-11-11T00:00:00Z"));
  assert.deepEqual(days, ["2026-11-11", "2026-11-10", "2026-11-09", "2026-11-06", "2026-11-05"]);
});
