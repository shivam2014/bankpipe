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
export function isFolioAccount(account) {
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
 * The words that name a fund house rather than a scheme. A token is compared
 * alone, so "Axis" matches "Axis Mutual Fund" and a scheme word ("Bluechip")
 * does not make two fund houses look alike.
 */
const FUND_STOP = new Set([
  "mutual", "fund", "funds", "asset", "assets", "management", "company", "amc",
  "the", "and", "of", "ltd", "limited", "india", "indian", "bank", "capital",
  "finance", "financial", "services", "securities", "investments", "investment",
  "growth", "plan", "direct", "regular", "scheme",
]);

/** Plan and option words that are not the scheme's name. */
const SCHEME_STOP = new Set([
  "direct", "regular", "plan", "growth", "dividend", "idcw", "payout",
  "reinvestment", "option", "scheme", "fund", "mutual", "the", "and", "of",
  "ltd", "limited", "formerly", "known", "as",
]);

const wordsOf = (value) => String(value ?? "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
const fundTokens = (value) => wordsOf(value).filter((word) =>
  word.length >= 3 && !FUND_STOP.has(word));
const schemeTokens = (value) => wordsOf(value).filter((word) =>
  word.length >= 2 && !SCHEME_STOP.has(word));

function fundHouseMatches(holding, account) {
  const wanted = new Set([holding?.amcFull, holding?.amc].flatMap(fundTokens));
  if (!wanted.size) return false;
  const meta = metaOf(account);
  const have = new Set([meta.amc_full, meta.amc, account?.bank, account?.label]
    .flatMap(fundTokens));
  return [...wanted].some((word) => have.has(word));
}

function schemeMatches(holding, account) {
  const wanted = schemeTokens(holding?.label).join(" ");
  const have = schemeTokens(account?.label).join(" ");
  if (!wanted || !have) return false;
  return wanted === have || wanted.includes(have) || have.includes(wanted);
}

/**
 * The current value a value-only account counts in net worth. A manual fund
 * account stores it in meta; a register import may also fill the account's
 * value column. The first positive one is the number the person sees.
 * @param {object} account
 * @returns {number} paise, or 0 when the account has no current value
 */
export function accountCurrentValuePaise(account) {
  const meta = metaOf(account);
  for (const raw of [meta.current_value_paise, account?.value_paise]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return 0;
}

/**
 * A fund account that holds a number but no rows. This is the shape a manual
 * mutual fund account has before any statement ever wrote units into it. A
 * single disposed row is history, not a current unit, but it still makes the
 * account unsafe to adopt into: writing units beside it would mix the two
 * records. Only an account with no holding rows at all is a candidate.
 * @param {object} account
 * @param {Array<object>} [rows]
 * @returns {boolean}
 */
export function isValueOnlyFolioAccount(account, rows = []) {
  if (!isFolioAccount(account)) return false;
  if ((rows || []).length) return false;
  return accountCurrentValuePaise(account) > 0;
}

/**
 * The accounts a folio could be adopted into. The folio number decides when it
 * is known: an exact folio is `folioHome`'s job, and a different folio is a
 * different position. Only an account with no folio at all, no unit rows, a
 * current value and a matching fund house or scheme is a candidate. The caller
 * must still ask; one candidate is never enough to apply.
 * @param {object} holding
 * @param {Array<object>} [accounts]
 * @param {(id: string) => Array<object>} [rowsOf]
 * @returns {Array<object>}
 */
export function folioAdoptionCandidates(holding, accounts = [], rowsOf = () => []) {
  const folio = normalizeFolio(holding?.folio);
  if (!folio) return [];
  const found = [];
  for (const account of accounts || []) {
    if (!isFolioAccount(account)) continue;
    // An account that answers to any folio is not value-only. When it carries
    // this folio, folioHome already routes there; when it carries another, it
    // is a different position and must not be merged.
    if (accountFolios(account).length) continue;
    if (!isValueOnlyFolioAccount(account, rowsOf(account.id) || [])) continue;
    if (!fundHouseMatches(holding, account) && !schemeMatches(holding, account)) continue;
    found.push(account);
  }
  return found;
}

/**
 * The adoption choices one statement can offer. A folio with no exact home is
 * offered the value-only accounts that look like it, with the value difference.
 * A candidate shared by two folios in the same statement is blocked, because
 * adopting both would merge two positions. Nothing is applied without a choice
 * for that folio; the writer receives only the explicit targets.
 * @param {{holdings?: Array<object>, accounts?: Array<object>,
 *   rowsOf?: (id: string) => Array<object>,
 *   choices?: object|Map|((key: string) => string)}} [input]
 * @returns {{offers: Array<object>, targets: object}}
 */
export function folioAdoptionPlan({ holdings = [], accounts = [], rowsOf = () => [],
  choices = {} } = {}) {
  const choiceOf = (key) => {
    if (typeof choices === "function") return String(choices(key) || "");
    if (choices instanceof Map) return String(choices.get(key) || "");
    return String(choices?.[key] || "");
  };
  const groups = new Map();
  for (const holding of holdings || []) {
    if (holding?.kind !== "mf" && holding?.category !== "mf") continue;
    const folio = normalizeFolio(holding?.folio);
    if (!folio || !(Number(holding.quantity) > 0)) continue;
    const key = folioKey(holding);
    if (!groups.has(key)) {
      groups.set(key, { key, folioNo: String(holding.folio || "").trim(),
        amc: String(holding.amc || "").trim(),
        amcFull: String(holding.amcFull || "").trim(),
        label: String(holding.label || "").trim(),
        holdings: [], valuePaise: 0 });
    }
    const group = groups.get(key);
    group.holdings.push(holding);
    const value = Number(holding.valuePaise ?? holding.value_paise);
    if (Number.isFinite(value) && value > 0) group.valuePaise += value;
  }
  const offers = [];
  const claims = new Map();
  for (const group of groups.values()) {
    // An exact folio is already identified. Only a folio with no home is a
    // question for the person, never a silent AMC-only merge.
    if (folioHome(group.holdings[0], accounts)) continue;
    const candidates = folioAdoptionCandidates(group.holdings[0], accounts, rowsOf);
    if (!candidates.length) continue;
    const offer = {
      key: group.key,
      folioNo: group.folioNo,
      amc: group.amc,
      amcFull: group.amcFull,
      label: group.label,
      valuePaise: group.valuePaise,
      candidates: candidates.map((account) => ({
        id: String(account.id || ""),
        label: String(account.label || account.bank || account.id || ""),
        valuePaise: accountCurrentValuePaise(account),
        diffPaise: 0,
        diffPct: null,
        shared: false,
      })),
      state: "offer",
      choosable: [],
      chosen: "",
      reason: "",
    };
    for (const candidate of offer.candidates) {
      candidate.diffPaise = offer.valuePaise - candidate.valuePaise;
      candidate.diffPct = candidate.valuePaise
        ? candidate.diffPaise / candidate.valuePaise : null;
      if (!claims.has(candidate.id)) claims.set(candidate.id, []);
      claims.get(candidate.id).push(group.key);
    }
    offers.push(offer);
  }
  const targets = {};
  for (const offer of offers) {
    for (const candidate of offer.candidates) {
      candidate.shared = (claims.get(candidate.id) || []).length > 1;
    }
    offer.choosable = offer.candidates.filter((candidate) => !candidate.shared);
    const choice = choiceOf(offer.key);
    const picked = offer.choosable.find((candidate) => candidate.id === choice);
    if (!offer.choosable.length) {
      offer.state = "ambiguous";
      offer.reason = "more than one folio in this statement looks like the same account";
    } else if (picked) {
      offer.state = "adopt";
      offer.chosen = picked.id;
      targets[offer.key] = picked.id;
    } else if (offer.choosable.length > 1) {
      offer.state = "ambiguous";
      offer.reason = "more than one account looks like this folio";
    } else if (choice === "__create__") {
      offer.chosen = "__create__";
    }
    if (choice === "__create__") offer.chosen = "__create__";
  }
  return { offers, targets };
}

/**
 * The account an explicit adoption sends a folio's rows to. The route uses
 * this only after the person chose it; an account that has since gained a
 * folio or lost its current value is refused rather than guessed at.
 * @param {object} holding
 * @param {Array<object>} [accounts]
 * @param {object|Map} [adopt] folio key to account id
 * @returns {object|null}
 */
export function folioAdoptedHome(holding, accounts = [], adopt = {}) {
  const key = folioKey(holding);
  const id = adopt instanceof Map ? adopt.get(key) : (adopt?.[key] || "");
  if (!id) return null;
  const account = (accounts || []).find((item) => String(item.id || "") === String(id));
  if (!account || !isFolioAccount(account) || accountFolios(account).length) return null;
  return accountCurrentValuePaise(account) > 0 ? account : null;
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
