// A mutual fund folio is identified by its number, not by the AMC that prints
// beside it. Two folios of one AMC are two positions with their own units and
// value, and a folio the app has never seen is a new position. Matching on the
// AMC label alone merged an NSDL folio into a CDSL account that held a different
// folio of the same fund house. Pure: no storage, no DOM, no network.
import { boId } from "./bo-id.js";

const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const amcOf = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * One spelling of a folio number for comparison. Caseless, spaceless, and
 * without the soft hyphens and zero-width spaces a PDF leaves inside numbers.
 * @param {string} value
 * @returns {string}
 */
export function normalizeFolio(value) {
  return String(value ?? "")
    .replace(/[\u00AD\u200B]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function metaOf(account) {
  const meta = account?.meta;
  if (meta && typeof meta === "object") return meta;
  try {
    return typeof meta === "string" ? JSON.parse(meta) : {};
  } catch (e) {
    return {};
  }
}

/** A fund account is the only kind that can own a folio. */
function isFolioAccount(account) {
  return /mutual\s*fund|^mf$/i.test(String(account?.subtype || ""))
    || /^mf$/i.test(String(account?.type || ""));
}

/**
 * Every folio an account answers to. A fund account's number is its folio; meta
 * carries the rest. A demat's number is a BO ID or a broker code, never a folio,
 * so it is skipped rather than taught to answer to a fund holding.
 * @param {object} account
 * @returns {Array<string>} normalized folios
 */
export function accountFolios(account) {
  const meta = metaOf(account);
  const raw = Array.isArray(meta.folios) ? [...meta.folios] : [];
  raw.push(meta.folio, meta.folio_no);
  if (isFolioAccount(account)) raw.push(account?.number, account?.folio, account?.folio_no);
  const out = [];
  for (const value of raw) {
    const text = tidy(value);
    if (!text || boId(text).kind === "bo") continue;
    const folio = normalizeFolio(text);
    if (folio && !out.includes(folio)) out.push(folio);
  }
  return out;
}

function declaredAmc(account) {
  const meta = metaOf(account);
  return amcOf(meta.amc || "");
}

/**
 * The account a fund folio belongs to. The folio number decides; the AMC only
 * breaks a tie between two or more accounts that carry the same folio. A single
 * on-file account carrying the exact folio is the home whatever AMC it declares:
 * a fund-house rename and a reused folio number cannot be told apart without a
 * second account, and orphaning a renamed account would create a duplicate. No
 * AMC-only and no ISIN fallback: an unmatched folio is a new position.
 * @param {{folio?: string, amc?: string}} holding
 * @param {Array<object>} accounts
 * @returns {object|null}
 */
export function folioHome(holding, accounts = []) {
  const folio = normalizeFolio(holding?.folio);
  if (!folio) return null;
  const owners = (accounts || []).filter((account) =>
    isFolioAccount(account) && accountFolios(account).includes(folio));
  if (!owners.length) return null;
  if (owners.length === 1) return owners[0];
  const amc = amcOf(holding?.amc);
  const named = owners.filter((account) => {
    if (!amc) return false;
    const declared = declaredAmc(account);
    return declared ? declared === amc
      : String(account.label || "").toLowerCase().includes(amc);
  });
  return named[0] || null;
}

/**
 * The key one folio's tick, writer group and account creation share. A folio
 * key carries the AMC because two fund houses can use the same folio string; a
 * group without a folio keeps the old AMC key so a pre-folio statement routes.
 * @param {{amc?: string, folioNo?: string, folio?: string}} group
 * @returns {string}
 */
export function folioKey(group = {}) {
  const raw = group.folioNo
    || (typeof group.folio === "string" ? group.folio : "");
  const folio = normalizeFolio(raw);
  const amc = amcOf(group.amc);
  return folio ? `mf:${amc}:${folio}` : `mf:${amc}`;
}

/**
 * The last four characters of a folio, enough to tell two folios of one AMC
 * apart in a label.
 * @param {string} folio
 * @returns {string}
 */
export function folioTail(folio) {
  return normalizeFolio(folio).slice(-4);
}
