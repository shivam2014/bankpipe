// The CAS write path, as pure functions. A depository statement is a dated
// snapshot: it owns quantity and value, while the latest broker report owns
// cost and terms. This module builds the rows for that write, decides whether
// the statement is safe to apply, and says what happens to rows the statement
// does not name. Nothing here touches the DOM or the database.

import { casTotals } from "./cas.js";
import { bondHomeOf, carryBrokerFields, isLiveBondRow, parseBondLabel } from "./bonds.js";
import { boId } from "./bo-id.js";
import { folioKey, normalizeFolio } from "./folio.js";

/**
 * The label a CAS row is stored under. The label carries the coupon and the
 * maturity because the bond card reads them from there.
 * @param {object} h a parsed CAS holding
 * @returns {string}
 */
export function casHoldingLabel(h) {
  const name = String(h.label || h.isin).replace(/\s+/g, " ").trim();
  if (h.kind !== "bond") return name;
  if (/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(name)) return name;
  const when = h.maturity
    ? new Date(`${h.maturity}T00:00:00Z`).toLocaleDateString("en-IN",
      { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : "";
  const coupon = h.couponPct === null || h.couponPct === undefined ? "" : `${h.couponPct}% `;
  return `${coupon}${name}${when ? ` ${when}` : ""}`.trim();
}

// --- CAS movements ----------------------------------------------------------
//
// A statement's transactions table is the only place an off-platform sale is
// written down. The holdings table is a snapshot, and a broker report is another
// snapshot; neither can say "40 units left on 12 August" by itself. So a trade
// is an event with a stable key, applied once to whatever holding it names. A
// full sale leaves a disposed record, never a silent deletion.

const TOL = 1e-9;
const tidyText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const laterDate = (a, b) => {
  const one = String(a || "").slice(0, 10);
  const two = String(b || "").slice(0, 10);
  return one > two ? one : two;
};

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A stable key for one printed movement. Re-importing the same statement finds
 * the same key, so the same sale is never applied twice. The description is
 * hashed because a remark can be long and can carry punctuation a PDF splits.
 * The scope is the account id: one statement can name a security in two demats,
 * and both sold records belong in the same unique column.
 * @param {object} event a parsed CAS transaction
 * @param {string} [scope] account or asset id
 * @returns {string}
 */
export function casEventKey(event, scope = "") {
  const isin = String(event?.isin || "").toUpperCase().replace(/\s+/g, "");
  const date = String(event?.date || "").slice(0, 10);
  const type = tidyText(event?.type || "").toLowerCase();
  const quantity = Number(event?.quantity) || 0;
  // The printed balances separate two genuine same-day trades with the same
  // security, type, units and remark. They are stable across a re-import.
  const balance = (value) => (value === null || value === undefined
    ? "" : Number(value) || 0);
  const opening = balance(event?.openingPaise);
  const closing = balance(event?.closingPaise);
  const hash = fnv1a(tidyText(event?.description || event?.type || "").toLowerCase());
  const stem = [isin, date, type, quantity, opening, closing, hash].join("|");
  return scope ? `${String(scope)}|${stem}` : stem;
}

/**
 * The event key used before the printed balances joined it. Rows imported by the
 * earlier build carry this key, so a re-import must still recognise them.
 * @param {object} event
 * @param {string} [scope]
 * @returns {string}
 */
export function casLegacyEventKey(event, scope = "") {
  const isin = String(event?.isin || "").toUpperCase().replace(/\s+/g, "");
  const date = String(event?.date || "").slice(0, 10);
  const type = tidyText(event?.type || "").toLowerCase();
  const quantity = Number(event?.quantity) || 0;
  const hash = fnv1a(tidyText(event?.description || event?.type || "").toLowerCase());
  const stem = [isin, date, type, quantity, hash].join("|");
  return scope ? `${String(scope)}|${stem}` : stem;
}

/**
 * Whether a parsed holding is a closed position the write should drop. A zero
 * unit row with no value is closed, except a matured bond, which is history and
 * stays on the account. The preview and the writer share this rule.
 * @param {object} holding a parsed CAS holding
 * @param {string} [importDay] ISO day of the import
 * @returns {boolean}
 */
export function casClosedRow(holding, importDay = new Date().toISOString().slice(0, 10)) {
  if (!(holding?.quantity !== null && holding?.quantity !== undefined
    && Number.isFinite(Number(holding.quantity)) && Number(holding.quantity) <= 0
    && !(Number(holding.valuePaise) > 0))) return false;
  const maturity = (parseBondLabel(casHoldingLabel(holding)) || {}).maturity || "";
  return !(maturity && maturity < importDay);
}

/**
 * The movements this target may apply. A movement that names its account is
 * only this target's when the target is that account. A movement with no
 * account belongs to the account that holds the security. `route` turns the
 * filter on; without it the caller gets every movement.
 * @param {Array<object>} events
 * @param {{accounts?: Array<string>, route?: boolean, rows?: Array<object>,
 *   manualTarget?: boolean}} [opts]
 * @returns {Array<object>}
 */
export function casMovementEvents(events, { accounts = [], route = false, rows = [],
  manualTarget = false } = {}) {
  const targetAccounts = (Array.isArray(accounts) ? accounts : [accounts])
    .map((value) => boId(value).boId).filter(Boolean);
  const held = new Set((rows || []).map(isinOf).filter(Boolean));
  return (events || []).filter((event) => {
    const isin = isinOf({ security_id: event?.isin });
    if (!isin) return false;
    const named = boId(event?.account || "").boId;
    if (named && targetAccounts.length) return targetAccounts.includes(named);
    return !route || manualTarget || held.has(isin);
  });
}

/**
 * The account ids that can take a statement's movements, with the BO IDs to
 * scope them. `routeAccounts` covers the accounts named by the holdings table;
 * a movement can name a demat that table does not list, and that account must
 * still receive its disposal. A bonds cost portfolio is never a movement target.
 * @param {{accounts?: Array<object>, routeAccounts?: Array<object>,
 *   movements?: Array<object>}} input
 * @returns {Map<string, Array<string>>}
 */
export function casMovementAccountBos({ accounts = [], routeAccounts = [], movements = [] } = {}) {
  const out = new Map();
  const add = (assetId, bo) => {
    if (!assetId || !bo) return;
    if (!out.has(assetId)) out.set(assetId, []);
    if (!out.get(assetId).includes(bo)) out.get(assetId).push(bo);
  };
  for (const account of routeAccounts || []) add(account.assetId, account.boId);
  const movementBos = new Set((movements || [])
    .map((event) => boId(event?.account || "").boId).filter(Boolean));
  for (const account of accounts || []) {
    if (!movementBos.size) break;
    if (String(account.category || "") !== "demat") continue;
    add(account.id, boId(account.number || account.bo_id || "").boId);
  }
  return out;
}

/**
 * The accounts a CAS preview must show. The holdings route names the accounts
 * the statement holds; a movement can name a demat the holdings table omits, and
 * that account still needs its disposal in the preview.
 * @param {{accounts?: Array<object>, routeAccounts?: Array<object>,
 *   movements?: Array<object>}} input
 * @returns {Array<object>}
 */
export function casPreviewAccounts({ accounts = [], routeAccounts = [], movements = [] } = {}) {
  const out = (routeAccounts || []).map((account) => ({ ...account }));
  const seen = new Set(out.map((account) => boId(account.boId).boId).filter(Boolean));
  const movementBos = new Set((movements || [])
    .map((event) => boId(event?.account || "").boId).filter(Boolean));
  for (const bo of movementBos) {
    if (seen.has(bo)) continue;
    const asset = (accounts || []).find((account) =>
      String(account.category || "") === "demat"
      && boId(account.number || account.bo_id || "").boId === bo);
    if (!asset) continue;
    out.push({ boId: bo, dpName: "", assetId: asset.id, synthetic: true });
    seen.add(bo);
  }
  return out;
}

/**
 * The account picks the CAS writer starts with. Every route account and folio is
 * ticked, plus a demat named only by a movement so its disposal is written.
 * @param {{accounts?: Array<object>, routeAccounts?: Array<object>,
 *   groups?: Array<object>, movements?: Array<object>}} input
 * @returns {Set<string>}
 */
export function casImportUnits({ accounts = [], routeAccounts = [], groups = [],
  movements = [] } = {}) {
  const units = new Set();
  for (const account of routeAccounts || []) units.add(`bo:${account.boId}`);
  for (const group of groups || []) {
    if (group.kind === "mf" && group.folio) units.add(folioKey(group));
  }
  for (const account of casPreviewAccounts({ accounts, routeAccounts, movements })) {
    units.add(`bo:${account.boId}`);
  }
  return units;
}

/**
 * The fund holdings a folio card can show. A zero-unit fund keeps a value but
 * is not a folio the route or the writer can place, so the card must not show a
 * phantom unit for it.
 * @param {Array<object>} holdings
 * @returns {Array<object>}
 */
export function casFolioHoldings(holdings = []) {
  return (holdings || []).filter((holding) => holding.kind === "mf" && holding.folio
    && Number(holding.quantity) > 0);
}

/**
 * The rows the writer replaces per asset. The same closed and zero-unit folio
 * rules the card uses decide what goes in, so the ticked unit and the write
 * cannot disagree.
 * @param {{holdings?: Array<object>, groups?: Array<object>, importDay?: string,
 *   picked?: Set<string>|null}} input
 * @returns {Map<string, Array<object>>}
 */
export function casGroupByAsset({ holdings = [], groups = [],
  importDay = new Date().toISOString().slice(0, 10), picked = null } = {}) {
  const out = new Map();
  for (const holding of holdings || []) {
    if (casClosedRow(holding, importDay)) continue;
    // Mirror casRoute exactly. A positive folio row belongs to the folio group
    // with its own number, never to a group that only shares its AMC. Every
    // other row, including a zero-unit folio row the route left in the demat,
    // belongs to a non-folio group matched by account. Offering the folio group
    // to the fallback made the result depend on which group the route happened
    // to insert first.
    const isFolioRow = holding.kind === "mf" && holding.folio
      && Number(holding.quantity) > 0;
    const folio = normalizeFolio(holding.folio);
    const owners = isFolioRow
      ? (groups || []).filter((item) => item.kind === "mf" && item.folio
        && normalizeFolio(item.folioNo) === folio)
      : [];
    let group = null;
    if (isFolioRow) {
      // Two AMCs can print the same folio string. When both groups are present,
      // the AMC decides; with one group the folio alone is enough.
      if (owners.length > 1) {
        const amc = String(holding.amc || "").trim().toLowerCase();
        group = owners.find((item) =>
          String(item.amc || "").trim().toLowerCase() === amc) || null;
      } else {
        group = owners[0] || null;
      }
    } else {
      group = (groups || []).find((item) => !item.folio && item.kind === holding.kind
        && (!holding.account || !item.boId
          || String(item.boId) === String(holding.account))) || null;
    }
    if (!group) continue;
    const key = group.kind === "mf" && group.folio
      ? folioKey(group) : `bo:${String(group.boId || "")}`;
    if (picked && !picked.has(key)) continue;
    if (!out.has(group.assetId)) out.set(group.assetId, []);
    out.get(group.assetId).push(holding);
  }
  return out;
}

/**
 * The demat rows a card unit counts. A positive folio row belongs to the folio
 * unit; a zero-unit folio row the route left in the demat is still this
 * account's row.
 * @param {Array<object>} holdings
 * @param {string} bo
 * @returns {Array<object>}
 */
export function casDematRows(holdings = [], bo = "") {
  return (holdings || []).filter((holding) =>
    String(holding.account || "") === String(bo || "")
    && !(holding.kind === "mf" && holding.folio && Number(holding.quantity) > 0));
}

/**
 * The parsed holdings a write would keep. A closed position is dropped, except
 * a matured bond. The inbox count and the writer use the same list.
 * @param {Array<object>} holdings
 * @param {string} [importDay]
 * @returns {Array<object>}
 */
export function casWritableHoldings(holdings, importDay = new Date().toISOString().slice(0, 10)) {
  return (holdings || []).filter((holding) => !casClosedRow(holding, importDay));
}

const SALE_WORD = /\b(sale|sold|sell|selling|redemption|redeemed|switch\s*out|withdrawal|withdrawn)\b/i;
const TRANSFER_OUT_WORD = /\b(transfer(?:red|s)?\s*(?:out|to)|transferred\s+out|off.?market|debit\s+transfer|inter.?depository|remateriali[sz](?:ed|ation)?|remat)\b/i;
const TRANSFER_IN_WORD = /\b(transfer(?:red|s)?\s*(?:in|from)|credit\s+transfer|remateriali[sz]ed\s+in)\b/i;
const PURCHASE_WORD = /\b(purchase[ds]?|buy|bought|allot(?:ted|ment)?|acquisition|subscri(?:bed|ption)|sip|systematic\s+investment|switch\s*in|reinvest(?:ed|ment)?)\b/i;

/**
 * Which side of the ledger a row moves and why. A debit is a sale only when the
 * statement says so. "Transfer out" is its own state, and anything unreadable is
 * a disposal with the printed reason, never a guessed sale.
 * @param {object} event
 * @returns {{side: string, kind: string, reason: string}}
 */
export function classifyCasEvent(event) {
  const credit = Math.abs(Number(event?.creditPaise) || 0);
  const debit = Math.abs(Number(event?.debitPaise) || 0);
  // A mutual fund row carries its side from the description because it has no
  // credit/debit balance columns.
  const side = event?.side === "debit" || event?.side === "credit"
    ? event.side : debit > 0 ? "debit" : credit > 0 ? "credit" : "";
  const text = `${event?.type || ""} ${event?.description || ""}`.trim();
  const reason = tidyText(event?.description || event?.type || "");
  if (side === "debit") {
    if (TRANSFER_OUT_WORD.test(text)) return { side, kind: "transfer-out", reason };
    if (SALE_WORD.test(text)) return { side, kind: "sale", reason };
    return { side, kind: "disposed", reason };
  }
  if (side === "credit") {
    if (TRANSFER_IN_WORD.test(text)) return { side, kind: "transfer-in", reason };
    if (PURCHASE_WORD.test(text)) return { side, kind: "purchase", reason };
    return { side, kind: "", reason };
  }
  return { side: "", kind: "", reason };
}

function isinOf(row) {
  return String(row?.security_id || row?.isin || "").toUpperCase().replace(/\s+/g, "");
}

function scaledPaise(value, ratio) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Math.round(n * ratio);
}

/**
 * The record a sale or transfer leaves behind. It is a holding row with zero
 * units, so the same table, backup and export carry it, and `disposed_at` keeps
 * it out of every live total. Cost stays on the record only, never in
 * `cost_paise`, or a sold lot would be counted a second time.
 */
function disposalRow(base, event, cls, { key, costPaise, source, asOf, quantity }) {
  const row = base ? { ...base } : {};
  delete row.id;
  return {
    ...row,
    security_id: String(event.isin || row.security_id || "").toUpperCase(),
    label: row.label || tidyText(event.security) || String(event.isin || "Holding"),
    category: row.category || "",
    issuer: row.issuer || "",
    quantity: 0,
    cost_paise: 0,
    value_paise: 0,
    value_source: "CAS",
    as_of: String(event.date || asOf || "").slice(0, 10),
    source: row.source || "report",
    txn_key: key,
    disposed_at: String(event.date || "").slice(0, 10),
    disposed_quantity: Number(quantity) || 0,
    disposed_type: cls.kind,
    disposed_source: source,
    disposed_reason: cls.reason,
    disposed_cost_paise: costPaise,
  };
}

/**
 * The live row a re-buy after a sale starts again. The sold record is the only
 * place the label, issuer and terms survive a full sale, so the new lot inherits
 * them. Cost and value are unknown until a broker report or the next statement
 * prices it, and the purchase date is the day the credit was printed.
 */
function rebuyRow(prior, event, { key, quantity, asOf }) {
  const row = { ...prior };
  delete row.id;
  const sold = Number(prior.disposed_quantity) || 0;
  const ratio = sold > 0 ? quantity / sold : 0;
  return {
    ...row,
    quantity,
    cost_paise: null,
    value_paise: null,
    value_source: "",
    // Face value is per unit, so a different lot size does not scale it.
    face_paise: prior.face_paise ?? null,
    payout_paise: scaledPaise(prior.payout_paise, ratio),
    future_interest_paise: scaledPaise(prior.future_interest_paise, ratio),
    future_principal_paise: scaledPaise(prior.future_principal_paise, ratio),
    returned_paise: null,
    returned_at: "",
    returned_record_date: "",
    returned_source: "",
    purchase_date: String(event.date || "").slice(0, 10),
    as_of: String(event.date || asOf || "").slice(0, 10),
    txn_key: key,
    disposed_at: "",
    disposed_quantity: null,
    disposed_type: "",
    disposed_source: "",
    disposed_reason: "",
    disposed_cost_paise: null,
  };
}

/**
 * Apply CAS movements to holdings. Pure: the same rows and events always give
 * the same plan, which is what lets the preview and the writer share it.
 *
 * A debit reduces the units across the live lots, floors at zero and leaves a
 * disposal record. A credit increases units only when the statement says
 * purchase or transfer in. An event the snapshot already reflects (the row's
 * date is on or after the event, and its units already sit at that event's
 * closing balance) is recorded but not subtracted twice. A later snapshot that
 * still shows the old units is surfaced as a disagreement, because the sale is
 * the fact and the snapshot is the claim.
 *
 * A statement can cover several demats. `accounts` names the BO IDs the target
 * holds; `route` turns on account routing for a preview or write. A movement
 * with an account belongs only to that account, and a movement with none
 * belongs to the account that holds the security. `known` is the parsed
 * holdings table, used to name a disposal that has no live row.
 * @param {Array<object>} rows holding rows
 * @param {Array<object>} events parsed CAS transactions
 * @param {{asOf?: string, source?: string, assetId?: string,
 *   accounts?: Array<string>, route?: boolean, known?: Array<object>}} [opts]
 * @returns {{rows: Array<object>, applied: Array<object>, sold: Array<object>,
 *   skipped: Array<object>, warnings: Array<string>, conflicts: Array<object>}}
 */
export function applyCasEvents(rows, events, { asOf = "", source = "CAS", assetId = "",
  accounts = [], route = false, known = [], manualTarget = false } = {}) {
  const out = (rows || []).map((row) => ({ ...row }));
  const applied = [];
  const sold = [];
  const skipped = [];
  const warnings = [];
  const conflicts = [];
  const seen = new Set(out.map((row) => row.txn_key).filter(Boolean));
  const parsedByIsin = new Map();
  for (const holding of known || []) {
    const isin = isinOf(holding);
    if (isin && !parsedByIsin.has(isin)) parsedByIsin.set(isin, holding);
  }
  const allowed = new Set(casMovementEvents(events,
    { accounts, route, rows: out, manualTarget }));
  const ordered = (events || []).map((event, index) => ({ event, index }))
    .filter(({ event }) => allowed.has(event))
    .sort((a, b) => String(a.event.date || "").localeCompare(String(b.event.date || ""))
      || a.index - b.index);
  const groups = new Map();
  for (const item of ordered) {
    const isin = isinOf({ security_id: item.event.isin });
    if (!groups.has(isin)) groups.set(isin, []);
    groups.get(isin).push(item);
  }

  for (const [isin, group] of groups) {
    let live = out.filter((row) => !row.disposed_at && isinOf(row) === isin
      && (Number(row.quantity) || 0) > 0);
    live.sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    let target = live[0] || null;
    // The statement's closing balance is the account's total, so the plan works
    // on the sum of the live lots, not on the largest one alone.
    let current = live.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const rowAsOf = live.reduce((latest, row) => {
      const when = String(row.as_of || "").slice(0, 10);
      return when > latest ? when : latest;
    }, "");
    const startQty = current;
    const lastDate = String(group[group.length - 1]?.event?.date || "").slice(0, 10);
    const lastClosing = (() => {
      for (let i = group.length - 1; i >= 0; i -= 1) {
        const value = group[i].event?.closingPaise;
        if (value !== null && value !== undefined) return Number(value) / 100;
      }
      return null;
    })();
    // A row dated on or after the last movement claims to include every one of
    // them. When its units equal the statement's final closing balance, the
    // movement is already in the row and must not be subtracted a second time.
    const postAll = !!rowAsOf && !!lastDate && rowAsOf >= lastDate;
    const matchesFinal = postAll && lastClosing !== null
      && Math.abs(current - lastClosing) <= TOL;

    for (const { event } of group) {
      const key = casEventKey(event, assetId);
      const legacyKey = casEventKey(event);
      const priorKey = casLegacyEventKey(event, assetId);
      const priorUnscoped = casLegacyEventKey(event);
      const cls = classifyCasEvent(event);
      const quantity = Number(event.quantity) || 0;
      // The applied entry is what planLinkedSales keys back to the demat sold
      // row, so it must carry the same balances the key was built from.
      const base = { txn_key: key, isin, date: event.date || "", type: event.type || "",
        description: event.description || "", side: cls.side, kind: cls.kind, quantity,
        openingPaise: event.openingPaise ?? null, closingPaise: event.closingPaise ?? null };
      if (!cls.side || !(quantity > 0)) {
        skipped.push({ ...base, reason: "no movement to apply" });
        continue;
      }
      if (seen.has(key) || (legacyKey !== key && seen.has(legacyKey))
        || seen.has(priorKey) || seen.has(priorUnscoped)) {
        applied.push({ ...base, status: "already", from: current, to: current });
        continue;
      }
      if (cls.side === "credit" && !["purchase", "transfer-in"].includes(cls.kind)) {
        const reason = "a credit with no purchase or transfer-in wording is not added";
        skipped.push({ ...base, reason });
        warnings.push(`${isin}: ${reason}${cls.reason ? ` (${cls.reason})` : ""}.`);
        continue;
      }
      if (!target) {
        if (cls.side === "credit") {
          // A full sale and a re-buy can print in the same statement. The credit
          // has no live row to add to because the sale removed it, so the sold
          // record is the only base: restart a live lot with the closing units
          // and leave cost and value empty until a report prices them.
          const prior = [...out].reverse()
            .find((row) => row.disposed_at && isinOf(row) === isin);
          const closing = event.closingPaise === null || event.closingPaise === undefined
            ? null : Number(event.closingPaise) / 100;
          const restored = closing !== null && closing > 0 ? closing : quantity;
          if (prior && restored > 0) {
            const row = rebuyRow(prior, event, { key, quantity: restored, asOf });
            out.push(row);
            target = row;
            current = restored;
            seen.add(key);
            applied.push({ ...base, status: "restored", from: 0, to: restored,
              reason: "re-bought after a recorded sale" });
            continue;
          }
          const reason = prior
            ? "a credit after a sale closes at zero; no live row is added"
            : "no holding to add this purchase to";
          skipped.push({ ...base, reason });
          warnings.push(`${isin}: ${reason}${cls.reason ? ` (${cls.reason})` : ""}.`);
          continue;
        }
        // A sale can arrive before any holding row exists: the bond was bought
        // and sold inside the statement period, so the holdings table never
        // printed it. The transaction is still the record; the parsed holding,
        // when the statement prints one, supplies its name and class.
        const parsedHolding = parsedByIsin.get(isin) || null;
        const record = disposalRow(parsedHolding ? {
          security_id: isin,
          label: casHoldingLabel(parsedHolding),
          category: parsedHolding.kind || "",
          issuer: "",
        } : null, event, cls, { key, costPaise: null, source, asOf, quantity });
        out.push(record);
        sold.push(record);
        seen.add(key);
        applied.push({ ...base, status: "recorded", from: 0, to: 0 });
        continue;
      }

      const closing = event.closingPaise === null || event.closingPaise === undefined
        ? null : Number(event.closingPaise) / 100;
      // A mutual fund trade has no closing balance to compare. Its holdings row
      // is the post-period snapshot, so a row dated on or after the trade already
      // includes it: record the sale, never subtract it a second time. A fund
      // that is absent from the statement keeps its older row and the debit is
      // applied below.
      const included = matchesFinal
        || (closing === null && !!rowAsOf && !!event.date && event.date <= rowAsOf)
        || (!!rowAsOf && !!event.date && event.date <= rowAsOf && !postAll);
      // A row older than the movement cannot already include it, even when its
      // units happen to sit below the printed closing balance. Only a row dated
      // on or after the last movement can be "already at closing".
      const atClosing = postAll && closing !== null && (cls.side === "debit"
        ? current <= closing + TOL
        : current >= closing - TOL);
      const change = !(included || atClosing);
      const before = current;
      let disposedCost = null;
      if (cls.side === "debit") {
        // A debit larger than one lot is sold across every lot the account
        // holds, largest first, so no lot is left live beside a sold record.
        // A reflected sale is different: the row is the post-sale remainder, so
        // the record keeps the printed units and prices them off the row's basis.
        const unitsSold = change ? Math.min(quantity, before) : quantity;
        let remaining = Math.min(unitsSold, before);
        const consumed = [];
        for (const lot of live) {
          if (remaining <= TOL) break;
          const have = Number(lot.quantity) || 0;
          const take = Math.min(remaining, have);
          if (take <= 0) continue;
          const cost = lot.cost_paise === null || lot.cost_paise === undefined
            ? null : Number(lot.cost_paise);
          const takeCost = cost === null ? null
            : (take >= have - TOL ? cost : Math.round(cost * take / have));
          consumed.push({ lot, have, take, takeCost });
          remaining -= take;
        }
        const costKnown = consumed.every(({ takeCost }) => takeCost !== null);
        const consumedCost = costKnown
          ? consumed.reduce((sum, { takeCost }) => sum + takeCost, 0) : null;
        // The post-sale row prices the remaining units, so a reflected sale is
        // costed at the same per-unit basis. `consumedCost` already covers
        // min(unitsSold, before) units; only a printed sale larger than the
        // post-sale row needs the extra scaling.
        const costScale = !change && before > 0
          ? unitsSold / Math.min(unitsSold, before) : 1;
        disposedCost = consumedCost === null ? null
          : Math.round(consumedCost * costScale);
        // A sold record cannot claim more units than the account held. The
        // transaction still says what was printed; the record floors at the
        // units actually consumed, and the difference is a named conflict. A
        // reflected sale is already the post-sale row, so the floor does not
        // apply and no conflict is raised.
        if (change && quantity > before + TOL) {
          conflicts.push({
            isin,
            txn_key: key,
            date: event.date || "",
            message: `The statement records ${quantity} ${cls.kind === "sale"
              ? "sold" : cls.kind === "transfer-out" ? "transferred out"
                : `disposed (${cls.reason || "no reason"})`} on ${event.date}, but this `
              + `account held ${before} units; ${unitsSold} were recorded.`,
            from: before,
            expected: Math.max(0, before - quantity),
          });
        }
        const after = change ? Math.max(0, before - quantity) : before;
        const record = disposalRow(target, event, cls, { key, costPaise: disposedCost,
          source, asOf, quantity: unitsSold });
        out.push(record);
        sold.push(record);
        if (change) {
          for (const { lot, have, take, takeCost } of consumed) {
            const left = Math.max(0, have - take);
            const ratio = have > 0 ? left / have : 0;
            const terms = carryBrokerFields(lot, left);
            lot.quantity = left;
            lot.as_of = laterDate(lot.as_of, event.date || asOf);
            lot.value_paise = scaledPaise(lot.value_paise, ratio);
            if (takeCost !== null && lot.cost_paise !== null && lot.cost_paise !== undefined) {
              lot.cost_paise = Math.max(0, Number(lot.cost_paise) - takeCost);
            }
            Object.assign(lot, terms);
            if (left <= TOL) {
              const at = out.indexOf(lot);
              if (at >= 0) out.splice(at, 1);
            }
          }
          if (!costKnown) {
            warnings.push(`${isin}: a consumed lot has no cost; the sold cost basis is not known.`);
          }
          live = out.filter((row) => !row.disposed_at && isinOf(row) === isin
            && (Number(row.quantity) || 0) > 0);
          live.sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
          target = live[0] || null;
        }
        current = after;
        applied.push({ ...base, status: change ? "applied" : "reflected",
          from: before, to: after, costPaise: disposedCost });
      } else {
        const after = change ? before + quantity : before;
        if (change) {
          // The credit lands on the largest lot; the account's total gains the
          // same units. A lot added to one row must not be set to the total.
          const have = Number(target.quantity) || 0;
          const nextQty = have + quantity;
          const ratio = have > 0 ? nextQty / have : 0;
          const terms = carryBrokerFields(target, nextQty);
          target.quantity = nextQty;
          target.as_of = laterDate(target.as_of, event.date || asOf);
          target.value_paise = scaledPaise(target.value_paise, ratio);
          Object.assign(target, terms);
        }
        current = after;
        applied.push({ ...base, status: change ? "applied" : "reflected",
          from: before, to: after });
      }
      seen.add(key);
    }

    if (lastClosing !== null && Math.abs(current - lastClosing) > TOL) {
      warnings.push(`${isin}: the statement closes at ${lastClosing} units, but this `
        + `account would hold ${current}. Check the opening balance against the statement.`);
    }
    if (postAll && lastClosing !== null && !matchesFinal
      && startQty > lastClosing + TOL
      && group.some(({ event }) => classifyCasEvent(event).side === "debit")) {
      const sale = group.map(({ event }) => event)
        .filter((event) => classifyCasEvent(event).side === "debit")
        .sort((a, b) => String(a.date).localeCompare(String(b.date))).pop();
      const saleCls = classifyCasEvent(sale);
      const moved = saleCls.kind === "sale" ? "sold"
        : saleCls.kind === "transfer-out" ? "transferred out"
          : `disposed${saleCls.reason ? ` (${saleCls.reason})` : ""}`;
      conflicts.push({
        isin,
        txn_key: casEventKey(sale, assetId),
        date: sale.date || "",
        message: `The holding on file is dated ${rowAsOf} and still shows `
          + `${startQty} units. The statement records `
          + `${Number(sale.quantity)} ${moved} on ${sale.date}, so it now holds `
          + `${lastClosing}.`,
        from: startQty,
        expected: lastClosing,
      });
    }
  }
  return { rows: out, applied, sold, skipped, warnings, conflicts };
}

/**
 * Whether a CAS may replace a demat. A row that did not parse is a partial
 * statement, and a partial statement must never delete a holding. The printed
 * total is the second check: when the parser exposes one, the rows must add up
 * to it.
 * @param {{holdings?: Array<object>, counts?: object, printedTotalPaise?: number|null}} parsed
 * @param {number|null} [statedTotalPaise]
 * @returns {{blocked: boolean, complete: boolean, quarantined: number,
 *   totals: object, reasons: Array<string>}}
 */
export function casSafety(parsed = {}, statedTotalPaise = parsed?.printedTotalPaise) {
  const quarantined = Number(parsed?.counts?.quarantined) || 0;
  const totals = casTotals(parsed, statedTotalPaise);
  const reasons = [];
  if (quarantined > 0) {
    reasons.push(`${quarantined} row${quarantined === 1 ? "" : "s"} could not be read; the statement is not safe to replace this account.`);
  }
  if (!totals.ok) {
    reasons.push("The rows do not add up to the total the statement prints; the statement is not safe to replace this account.");
  }
  return { blocked: reasons.length > 0, complete: reasons.length === 0,
    quarantined, totals, reasons };
}

/**
 * Build the rows a CAS writes. Existing broker cost and purchase date carry to
 * the new quantity; a row the CAS does not name is preserved by default, so a
 * partial or older statement cannot silently delete a holding. A row with a
 * disposal record is history and always survives, whatever the statement says.
 * @param {{existing?: Array<object>, holdings?: Array<object>, asOf?: string,
 *   preserveAbsent?: boolean, keepAbsent?: Iterable<string>}} input
 * @returns {{rows: Array<object>, absent: Array<object>, dropped: Array<object>,
 *   manualKept: number, keptNewer: number, keptEvents: number, carried: number}}
 */
export function casApplyRows({ existing = [], holdings = [], asOf = "",
  preserveAbsent = true, keepAbsent = [] } = {}) {
  const keepForEvent = new Set([...keepAbsent].map((isin) =>
    String(isin || "").toUpperCase()));
  const oldByIsin = new Map();
  const withCost = new Map();
  for (const old of existing || []) {
    const isin = String(old.security_id || old.isin || "").toUpperCase();
    if (!isin) continue;
    // A disposal is history. It must never shadow the live row for the same
    // ISIN, or a re-import would take the sold record's empty cost as the lot's.
    if (old.disposed_at) continue;
    oldByIsin.set(isin, old);
    if (old.cost_paise !== null && old.cost_paise !== undefined) withCost.set(isin, old);
  }
  const rows = [];
  const stamped = new Set();
  let carried = 0;
  for (const h of holdings || []) {
    const isin = String(h.isin || h.security_id || "").toUpperCase();
    if (isin) stamped.add(isin);
    const old = withCost.get(isin);
    const oldRow = oldByIsin.get(isin);
    const qty = Number(h.quantity) || 0;
    const oldQty = old ? Number(old.quantity) || 0 : 0;
    // A sale changes the units, not the price per unit: carry the broker cost
    // rather than dropping it on the floor.
    const carriedCost = old && qty > 0 && oldQty > 0
      ? Math.round(Number(old.cost_paise) * (qty / oldQty)) : null;
    if (carriedCost) carried += 1;
    const nextLabel = casHoldingLabel(h);
    // The CAS often has the maturity but not the coupon; a broker label has both.
    const keepOld = h.kind === "bond" && !/\d+(?:\.\d+)?%/.test(nextLabel)
      && /\d+(?:\.\d+)?%/.test(oldRow?.label || "");
    rows.push({
      security_id: h.isin || h.security_id || "",
      label: keepOld ? oldRow.label : nextLabel,
      issuer: oldRow?.issuer || "",
      category: h.kind,
      frequency: h.frequency || oldRow?.frequency || "",
      quantity: h.quantity,
      face_paise: h.faceValuePaise ?? oldRow?.face_paise ?? null,
      cost_paise: h.costPaise ?? carriedCost ?? null,
      value_paise: h.valuePaise,
      value_source: "CAS",
      purchase_date: carriedCost && old ? old.purchase_date || "" : "",
      source: oldRow?.source || "",
      ...carryBrokerFields(oldRow, h.quantity),
      as_of: asOf,
    });
  }

  const absent = [];
  const dropped = [];
  let manualKept = 0;
  let keptNewer = 0;
  let keptEvents = 0;
  for (const old of existing || []) {
    const isin = String(old.security_id || old.isin || "").toUpperCase();
    if (!isin) continue;
    // A disposal is a record of a movement that happened, not a holding the next
    // statement can take away. A re-purchase adds a new live row beside it.
    if (old.disposed_at) {
      rows.push({ ...old });
      keptEvents += 1;
      continue;
    }
    if (stamped.has(isin)) continue;
    // A manually added holding is normally outside the statement's reach, but a
    // movement in the statement names it, so the event pass has to see the row
    // and reduce it instead of leaving it untouched.
    if (old.source === "manual" && !keepForEvent.has(isin)) {
      manualKept += 1;
      continue;
    }
    // A bond or fund bought after the statement date is too new for the paper,
    // not missing from the demat.
    const boughtAfter = !!asOf && !!old.purchase_date && old.purchase_date > asOf;
    if (boughtAfter || preserveAbsent || keepForEvent.has(isin)) {
      rows.push({ ...old });
      if (boughtAfter) keptNewer += 1;
      if (keepForEvent.has(isin) && !boughtAfter) keptEvents += 1;
      absent.push({ isin, label: old.label || "", action: "flag",
        reason: boughtAfter ? "bought after the statement date; kept"
          : keepForEvent.has(isin) ? "not in this statement; kept for a recorded movement"
            : "not in this statement; kept" });
    } else {
      dropped.push({ isin, label: old.label || "", action: "remove",
        reason: "not in the complete statement" });
    }
  }
  return { rows, absent, dropped, manualKept, keptNewer, keptEvents, carried };
}

/**
 * The one decision the preview and the writer share. A blocked statement
 * returns the existing rows unchanged, so calling it is safe even when the UI
 * has not checked first. Absent rows are preserved unless the statement is
 * complete and the replace was explicitly confirmed. Movements are applied to
 * the rows this plan will write, so the sale a person sees is the sale stored.
 * @param {{parsed?: object, existing?: Array<object>, holdings?: Array<object>,
 *   events?: Array<object>, assetId?: string, asOf?: string, confirmed?: boolean,
 *   merge?: boolean, safety?: object, accounts?: Array<string>,
 *   route?: boolean, manualTarget?: boolean}} input
 * @returns {object}
 */
export function casReplacePlan({ parsed = {}, existing = [], holdings = [], events = null,
  assetId = "", asOf = parsed?.asOf || "", confirmed = false, merge = false,
  safety = null, accounts = [], route = false, manualTarget = false } = {}) {
  const verdict = safety || casSafety(parsed);
  if (verdict.blocked) {
    return { ok: false, blocked: true, safety: verdict, rows: existing, absent: [],
      dropped: [], manualKept: 0, keptNewer: 0, keptEvents: 0, carried: 0,
      preserveAbsent: true, events: [], sold: [], conflicts: [], warnings: [] };
  }
  const movements = events === null ? (parsed?.transactions || []) : (events || []);
  // Only this target's movements can pin a row it does not name. A sale that
  // belongs to another demat must not keep an absent row here.
  const scoped = casMovementEvents(movements, { accounts, route, manualTarget,
    rows: [...(existing || []), ...(holdings || [])] });
  const eventIsins = new Set(scoped.map((event) =>
    String(event?.isin || "").toUpperCase()).filter(Boolean));
  // A statement that printed no holdings table is a movements-only statement,
  // not a complete zero-row snapshot. A confirmed replace must not drop every
  // live row it does not name.
  const printedHoldings = Array.isArray(parsed?.holdings) && parsed.holdings.length > 0;
  const preserveAbsent = merge || !(confirmed && verdict.complete && printedHoldings);
  const applied = casApplyRows({ existing, holdings, asOf, preserveAbsent,
    keepAbsent: eventIsins });
  // An event already on file was applied by an earlier import. The holdings
  // table inside the statement can be older than the rows that import wrote, so
  // a rebuilt row must not resurrect units the sale already removed. Keep the
  // live rows on file for the ISINs whose events are already recorded.
  const priorKeys = new Set((existing || []).map((row) => row.txn_key).filter(Boolean));
  const priorIsins = new Set();
  for (const event of scoped) {
    const key = casEventKey(event, assetId);
    if (priorKeys.has(key) || priorKeys.has(casEventKey(event))
      || priorKeys.has(casLegacyEventKey(event, assetId))
      || priorKeys.has(casLegacyEventKey(event))) {
      priorIsins.add(String(event?.isin || "").toUpperCase());
    }
  }
  let baseRows = applied.rows;
  if (priorIsins.size) {
    baseRows = applied.rows.filter((row) => row.disposed_at
      || !priorIsins.has(String(row.security_id || "").toUpperCase()));
    for (const row of existing || []) {
      const isin = String(row.security_id || row.isin || "").toUpperCase();
      if (row.disposed_at || !priorIsins.has(isin)) continue;
      // A zero-unit row is a matured or closed position, not a resurrected
      // sale. Keep it so a re-import writes the same rows as the first import.
      baseRows.push({ ...row });
    }
  }
  if (!movements.length) {
    return { ok: true, blocked: false, safety: verdict, preserveAbsent, ...applied,
      events: [], sold: [], conflicts: [], warnings: [] };
  }
  const result = applyCasEvents(baseRows, movements, { asOf, assetId, accounts, route,
    manualTarget, known: parsed?.holdings || [] });
  return {
    ok: true, blocked: false, safety: verdict, preserveAbsent, ...applied,
    rows: result.rows,
    events: result.applied,
    sold: result.sold,
    skipped: result.skipped,
    conflicts: result.conflicts,
    warnings: result.warnings,
  };
}

/**
 * The parsed accounts and holdings the writer may write. A target the holding
 * plan marked identity-only contributes no rows, and every other account keeps
 * only the ISINs its own plan did not skip. Using one global ISIN set let an
 * identity-only account write a security another target shares.
 * @param {{parsed?: object, targets?: Array<object>}} input
 * @returns {{accounts: Array<object>, holdings: Array<object>}}
 */
export function casImportHoldings({ parsed = {}, targets = [] } = {}) {
  const byBo = new Map();
  for (const target of targets || []) {
    const bo = String(target?.boId || "");
    if (!bo || bo.startsWith("mf:")) continue;
    byBo.set(bo, target);
  }
  const keptOf = (target) => {
    if (!Array.isArray(target?.plan?.decisions)) return null;
    return new Set(target.plan.decisions
      .filter((decision) => decision.action !== "skip")
      .map((decision) => String(decision.isin || "").toUpperCase()).filter(Boolean));
  };
  const importTargets = (targets || []).filter((target) => !target.plan?.identityOnly);
  const identityBos = new Set((targets || []).filter((target) => target.plan?.identityOnly)
    .map((target) => String(target.boId || "")).filter(Boolean));
  const keepAll = new Set();
  for (const target of importTargets) {
    for (const isin of keptOf(target) || []) keepAll.add(isin);
  }
  // A folio target plans rows that sit inside a demat's holdings table. The
  // demat's own plan never reads them, so its keep set has to include the folio
  // rows the folio target kept, or the scoping drops them before routing.
  const isFolioRow = (holding) => holding.kind === "mf" && holding.folio
    && Number(holding.quantity) > 0;
  const keptFolioRows = new Map();
  for (const target of importTargets) {
    if (!String(target?.boId || "").startsWith("mf:")) continue;
    const kept = keptOf(target);
    for (const row of target.rows || []) {
      const isin = String(row?.isin || "").toUpperCase();
      if (!isin || (kept && !kept.has(isin))) continue;
      const account = String(row?.account || "");
      if (!keptFolioRows.has(account)) keptFolioRows.set(account, new Set());
      keptFolioRows.get(account).add(isin);
    }
  }
  const accounts = (parsed.accounts || [])
    .filter((account) => !identityBos.has(String(account.boId || "")))
    .map((account) => {
      const target = byBo.get(String(account.boId || ""));
      const only = target ? keptOf(target) : null;
      const folioKept = keptFolioRows.get(String(account.boId || "")) || new Set();
      return { ...account, holdings: (account.holdings || []).filter((holding) => {
        const isin = String(holding.isin || "").toUpperCase();
        return keepAll.has(isin) && (!only || only.has(isin)
          || (isFolioRow(holding) && folioKept.has(isin)));
      }) };
    })
    .filter((account) => account.holdings.length);
  const holdings = (parsed.holdings || []).filter((holding) =>
    keepAll.has(String(holding.isin || "").toUpperCase()));
  return { accounts, holdings };
}

/**
 * The parsed holdings the inbox writer passes on. A new folio row is written by
 * its folio plan even when that plan lists no field changes (action "add"), so
 * its cost must survive. A row a plan keeps or asks about keeps the cost already
 * on file, and only a plan that names a cost change may replace it.
 * @param {{holdings?: Array<object>, targets?: Array<object>}} input
 * @returns {Array<object>}
 */
export function casCostedImportHoldings({ holdings = [], targets = [] } = {}) {
  const targetFor = (holding) => {
    const folio = normalizeFolio(holding.folio);
    if (folio) {
      const owners = (targets || []).filter((target) => target.folio
        && normalizeFolio(target.folioNo) === folio);
      if (owners.length === 1) return owners[0];
      if (owners.length > 1) {
        const amc = String(holding.amc || "").trim().toLowerCase();
        const named = owners.find((target) =>
          String(target.amc || "").trim().toLowerCase() === amc);
        if (named) return named;
      }
    }
    return (targets || []).find((target) =>
      target.boId === (holding.account || "")) || null;
  };
  return (holdings || []).map((holding) => {
    if (holding.costPaise === null || holding.costPaise === undefined) return holding;
    const target = targetFor(holding);
    const decision = target?.plan?.decisions?.find((item) =>
      String(item.isin || "").toUpperCase() === String(holding.isin || "").toUpperCase());
    const wrote = decision?.action === "add";
    const tookCost = decision?.changes?.some((change) =>
      change.group === "cost" && change.field === "cost");
    return wrote || tookCost ? holding : { ...holding, costPaise: null };
  });
}

/**
 * The bond cost portfolios that feed one demat. The link is the same one the
 * bond reconcile uses: the explicit linked_asset, then the demat number, then
 * the demat holding most of the portfolio's ISINs.
 * @param {string} dematId
 * @param {Array<object>} accounts
 * @param {(id: string) => Array<object>} holdingsOf
 * @returns {Array<object>} the linked bond account rows
 */
export function linkedCostPortfolios(dematId, accounts = [], holdingsOf = () => []) {
  const demat = accounts.find((account) => account.id === dematId);
  if (!demat || String(demat.category || "") !== "demat"
    || /mutual\s*fund|^mf$/i.test(String(demat.subtype || ""))) return [];
  const demats = accounts.filter((account) => String(account.category || "") === "demat"
    && !/mutual\s*fund|^mf$/i.test(String(account.subtype || "")));
  const liveLots = (id) => (holdingsOf(id) || []).filter(isLiveBondRow)
    .filter((row) => row.quantity === null || row.quantity === undefined
      || Number(row.quantity) > 0);
  const positionsOf = new Map();
  for (const account of demats) {
    positionsOf.set(account.id, liveLots(account.id));
  }
  return accounts.filter((account) => String(account.category || "") === "bonds")
    .filter((account) => liveLots(account.id).length > 0)
    .filter((account) => bondHomeOf(liveLots(account.id), account, demats,
      positionsOf) === dematId);
}

/**
 * Apply the same sales to a linked bond cost portfolio. Lots are consumed FIFO
 * by purchase date, then the date on file, then the largest. A lot with no
 * purchase date is not guessed at: it stays in place with a warning. The sold
 * cost basis is the sum of the consumed lots, and each sold row keeps its own
 * account-scoped txn_key.
 * @param {Array<object>} rows the portfolio's holding rows
 * @param {Array<object>} events the demat plan's events
 * @param {{asOf?: string, assetId?: string, source?: string}} [opts]
 * @returns {{rows: Array<object>, applied: Array<object>, sold: Array<object>,
 *   skipped: Array<object>, warnings: Array<string>}}
 */
export function applyCasEventsToPortfolio(rows, events, { asOf = "", assetId = "",
  source = "CAS" } = {}) {
  const out = (rows || []).map((row) => ({ ...row }));
  const applied = [];
  const sold = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set(out.map((row) => row.txn_key).filter(Boolean));
  const ordered = (events || []).map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.side === "debit" && Number(event.quantity) > 0)
    .sort((a, b) => String(a.event.date || "").localeCompare(String(b.event.date || ""))
      || a.index - b.index);
  for (const { event } of ordered) {
    const isin = String(event.isin || "").toUpperCase();
    const key = casEventKey(event, assetId);
    const priorKey = casLegacyEventKey(event, assetId);
    const base = { txn_key: key, event, isin, date: event.date || "",
      kind: event.kind || "", quantity: Number(event.quantity) || 0,
      openingPaise: event.openingPaise ?? null, closingPaise: event.closingPaise ?? null };
    if (seen.has(key) || seen.has(priorKey)) {
      applied.push({ ...base, status: "already", costPaise: null });
      continue;
    }
    const lots = out.filter((row) => !row.disposed_at && isinOf(row) === isin
      && (Number(row.quantity) || 0) > 0);
    if (!lots.length) {
      skipped.push({ ...base, reason: "no lot in the linked cost portfolio" });
      warnings.push(`${isin}: no lot in the linked cost portfolio carries this sale.`);
      continue;
    }
    const dated = lots.filter((row) => String(row.purchase_date || "").trim())
      .sort((a, b) => String(a.purchase_date).localeCompare(String(b.purchase_date))
        || String(a.as_of || "").localeCompare(String(b.as_of || ""))
        || (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    const undated = lots.filter((row) => !String(row.purchase_date || "").trim());
    if (undated.length) {
      warnings.push(`${isin}: ${undated.length} lot${undated.length === 1 ? "" : "s"} `
        + "have no purchase date; FIFO left them in place.");
    }
    let remaining = Number(event.quantity) || 0;
    const consumed = [];
    for (const lot of dated) {
      if (remaining <= TOL) break;
      const have = Number(lot.quantity) || 0;
      const take = Math.min(remaining, have);
      if (take <= 0) continue;
      const cost = lot.cost_paise === null || lot.cost_paise === undefined
        ? null : Number(lot.cost_paise);
      const takeCost = cost === null ? null
        : (take >= have - TOL ? cost : Math.round(cost * take / have));
      consumed.push({ lot, have, take, takeCost });
      remaining -= take;
    }
    if (!consumed.length) {
      skipped.push({ ...base, reason: "no dated lot to match the sale" });
      continue;
    }
    if (remaining > TOL) {
      warnings.push(`${isin}: the sale is ${base.quantity} units but only `
        + `${base.quantity - remaining} matched a dated lot; the rest stays in place.`);
    }
    const baseLot = { ...consumed[0].lot };
    let costKnown = true;
    let costTotal = 0;
    for (const { lot, have, take, takeCost } of consumed) {
      if (takeCost === null) costKnown = false;
      else costTotal += takeCost;
      const left = Math.max(0, have - take);
      const ratio = have > 0 ? left / have : 0;
      lot.quantity = left;
      lot.value_paise = scaledPaise(lot.value_paise, ratio);
      if (takeCost !== null && lot.cost_paise !== null && lot.cost_paise !== undefined) {
        lot.cost_paise = Math.max(0, Number(lot.cost_paise) - takeCost);
      }
      if (lot.quantity <= TOL) {
        const at = out.indexOf(lot);
        if (at >= 0) out.splice(at, 1);
      }
    }
    const cls = { side: "debit", kind: event.kind || "disposed",
      reason: event.description || event.type || "" };
    const costPaise = costKnown ? costTotal : null;
    if (!costKnown) {
      warnings.push(`${isin}: a consumed lot has no cost; the sold cost basis is not known.`);
    }
    const record = disposalRow(baseLot, event, cls, { key, costPaise, source, asOf,
      quantity: base.quantity });
    out.push(record);
    sold.push(record);
    seen.add(key);
    const liveRows = out.filter((row) => !row.disposed_at && isinOf(row) === isin
      && (Number(row.quantity) || 0) > 0);
    const remainingCostPaise = liveRows.some((row) => row.cost_paise === null
      || row.cost_paise === undefined)
      ? null : liveRows.reduce((sum, row) => sum + Number(row.cost_paise || 0), 0);
    applied.push({ ...base, status: "applied", matchedQuantity: base.quantity - remaining,
      costPaise, remainingCostPaise });
  }
  return { rows: out, applied, sold, skipped, warnings };
}

/**
 * The one plan the CAS preview and writer use for linked cost portfolios. The
 * demat's sold rows are reconciled to the FIFO cost of the lots actually
 * consumed, and the live demat row's cost is reduced by the same amount.
 * Mutates the demat plan's sold rows on purpose; the caller writes those rows.
 * @param {{dematPlan: object, dematAssetId: string, asOf?: string,
 *   portfolios?: Array<{account: object, rows: Array<object>}>}} input
 * @returns {{portfolios: Array<object>, warnings: Array<string>,
 *   reconciliations: Array<object>}}
 */
export function planLinkedSales({ dematPlan = {}, dematAssetId = "", asOf = "",
  portfolios = [] } = {}) {
  const plans = [];
  const warnings = [];
  const reconciliations = [];
  for (const entry of portfolios) {
    const account = entry.account || entry;
    const plan = applyCasEventsToPortfolio(entry.rows || [], dematPlan.events || [],
      { assetId: account.id, asOf });
    plans.push({ account, plan });
    warnings.push(...plan.warnings);
    for (const sale of plan.applied) {
      if (sale.status !== "applied" || sale.costPaise === null) continue;
      const event = sale.event || sale;
      // A sold row written before the balance key carries the legacy key. It is
      // still this sale, so reconcile it rather than leave its cost stale. The
      // row can be in `sold` (built this run) or already in `rows` (history).
      // Scoped keys are exact. An older unscoped key is only accepted when it
      // identifies one disposed row, so two accounts cannot claim each other.
      const keys = [casEventKey(event, dematAssetId),
        casLegacyEventKey(event, dematAssetId)];
      const disposed = [...new Set([...(dematPlan.sold || []),
        ...(dematPlan.rows || []).filter((row) => row.disposed_at)])];
      let dematSold = disposed.find((row) => keys.includes(row.txn_key)) || null;
      if (!dematSold) {
        const unscoped = disposed.filter((row) =>
          row.txn_key === casLegacyEventKey(event) || row.txn_key === casEventKey(event));
        // `disposed` is a Set of row references, so two distinct rows that
        // share one unscoped key are ambiguous. Never pick one at random, and
        // say why the reconciliation did not happen.
        if (unscoped.length === 1) dematSold = unscoped[0];
        else if (unscoped.length > 1) {
          warnings.push(`${sale.isin}: ${unscoped.length} old sold rows share this `
            + "movement's key; the demat sold cost is not reconciled.");
        }
      }
      if (!dematSold) continue;
      const before = dematSold.disposed_cost_paise;
      dematSold.disposed_cost_paise = sale.costPaise;
      const live = (dematPlan.rows || []).find((row) => !row.disposed_at
        && String(row.security_id || "").toUpperCase() === sale.isin
        && (Number(row.quantity) || 0) > 0);
      if (live) {
        // A row with no cost has no basis to adjust; the linked portfolio's
        // remaining cost is the only basis it can take. A known live cost is
        // never overwritten with it.
        if (live.cost_paise === null || live.cost_paise === undefined) {
          if (sale.remainingCostPaise !== null && sale.remainingCostPaise !== undefined) {
            live.cost_paise = sale.remainingCostPaise;
          }
        } else if (before !== null && before !== undefined && Number(before) > 0) {
          live.cost_paise = Math.max(0, (Number(live.cost_paise) || 0)
            + Number(before) - Number(sale.costPaise));
        }
        const liveCost = live.cost_paise === null || live.cost_paise === undefined
          ? null : Number(live.cost_paise);
        if (sale.remainingCostPaise !== null && sale.remainingCostPaise !== undefined
          && liveCost !== null
          && Math.abs(sale.remainingCostPaise - liveCost) > 0.5) {
          warnings.push(`${sale.isin}: the linked cost portfolio holds `
            + `${(sale.remainingCostPaise / 100).toFixed(2)} in cost after the sale, but `
            + `the demat row holds ${(liveCost / 100).toFixed(2)}. The demat row keeps its `
            + "own basis; the difference is not overwritten.");
        }
      }
      if (Number(before) !== Number(sale.costPaise)) {
        reconciliations.push({ isin: sale.isin, date: sale.date, from: before,
          to: sale.costPaise });
      }
    }
  }
  return { portfolios: plans, warnings, reconciliations };
}
