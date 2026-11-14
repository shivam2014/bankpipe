// The CAS write path, as pure functions. A depository statement is a dated
// snapshot: it owns quantity and value, while the latest broker report owns
// cost and terms. This module builds the rows for that write, decides whether
// the statement is safe to apply, and says what happens to rows the statement
// does not name. Nothing here touches the DOM or the database.

import { casTotals } from "./cas.js";
import { carryBrokerFields } from "./bonds.js";

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
 * @param {object} event a parsed CAS transaction
 * @returns {string}
 */
export function casEventKey(event) {
  const isin = String(event?.isin || "").toUpperCase().replace(/\s+/g, "");
  const date = String(event?.date || "").slice(0, 10);
  const type = tidyText(event?.type || "").toLowerCase();
  const quantity = Number(event?.quantity) || 0;
  const hash = fnv1a(tidyText(event?.description || event?.type || "").toLowerCase());
  return [isin, date, type, quantity, hash].join("|");
}

const SALE_WORD = /\b(sale|sold|sell|selling)\b/i;
const TRANSFER_OUT_WORD = /\b(transfer(?:red|s)?\s*(?:out|to)|transferred\s+out|off.?market|debit\s+transfer|inter.?depository|remateriali[sz](?:ed|ation)?|remat)\b/i;
const TRANSFER_IN_WORD = /\b(transfer(?:red|s)?\s*(?:in|from)|credit\s+transfer|remateriali[sz]ed\s+in)\b/i;
const PURCHASE_WORD = /\b(purchase[ds]?|buy|bought|allot(?:ted|ment)?|acquisition|subscri(?:bed|ption))\b/i;

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
  const side = debit > 0 ? "debit" : credit > 0 ? "credit" : "";
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
 * Apply CAS movements to holdings. Pure: the same rows and events always give
 * the same plan, which is what lets the preview and the writer share it.
 *
 * A debit reduces the units, floors at zero and leaves a disposal record. A
 * credit increases units only when the statement says purchase or transfer in.
 * An event the snapshot already reflects (the row's date is on or after the
 * event, and its units already sit at that event's closing balance) is recorded
 * but not subtracted twice. A later snapshot that still shows the old units is
 * surfaced as a disagreement, because the sale is the fact and the snapshot is
 * the claim.
 * @param {Array<object>} rows holding rows
 * @param {Array<object>} events parsed CAS transactions
 * @param {{asOf?: string, source?: string}} [opts]
 * @returns {{rows: Array<object>, applied: Array<object>, sold: Array<object>,
 *   skipped: Array<object>, warnings: Array<string>, conflicts: Array<object>}}
 */
export function applyCasEvents(rows, events, { asOf = "", source = "CAS" } = {}) {
  const out = (rows || []).map((row) => ({ ...row }));
  const applied = [];
  const sold = [];
  const skipped = [];
  const warnings = [];
  const conflicts = [];
  const seen = new Set(out.map((row) => row.txn_key).filter(Boolean));
  const ordered = (events || []).map((event, index) => ({ event, index }))
    .filter(({ event }) => isinOf({ security_id: event?.isin }))
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
    let current = target ? Number(target.quantity) || 0 : 0;
    const rowAsOf = target ? String(target.as_of || "").slice(0, 10) : "";
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
      const key = casEventKey(event);
      const cls = classifyCasEvent(event);
      const quantity = Number(event.quantity) || 0;
      const base = { txn_key: key, isin, date: event.date || "", type: event.type || "",
        description: event.description || "", side: cls.side, kind: cls.kind, quantity };
      if (!cls.side || !(quantity > 0)) {
        skipped.push({ ...base, reason: "no movement to apply" });
        continue;
      }
      if (seen.has(key)) {
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
          const reason = "no holding to add this purchase to";
          skipped.push({ ...base, reason });
          warnings.push(`${isin}: ${reason}${cls.reason ? ` (${cls.reason})` : ""}.`);
          continue;
        }
        // A sale can arrive before any holding row exists: the bond was bought
        // and sold inside the statement period, so the holdings table never
        // printed it. The transaction is still the record.
        const record = disposalRow(null, event, cls, { key, costPaise: null, source,
          asOf, quantity });
        out.push(record);
        sold.push(record);
        seen.add(key);
        applied.push({ ...base, status: "recorded", from: 0, to: 0 });
        continue;
      }

      const closing = event.closingPaise === null || event.closingPaise === undefined
        ? null : Number(event.closingPaise) / 100;
      // The row is on or after this movement's date, but it may belong to an
      // earlier movement group (a mid-period broker report). Then only the
      // movements printed after that date are new.
      const included = matchesFinal
        || (!!rowAsOf && !!event.date && event.date <= rowAsOf && !postAll);
      const atClosing = closing !== null && (cls.side === "debit"
        ? current <= closing + TOL
        : current >= closing - TOL);
      const change = !(included || atClosing);
      const before = current;
      const costPaise = target.cost_paise === null || target.cost_paise === undefined
        ? null : Number(target.cost_paise);
      let disposedCost = null;
      if (cls.side === "debit") {
        const unitsSold = Math.min(quantity, before);
        if (costPaise !== null && before > 0 && unitsSold > 0) {
          disposedCost = Math.round(costPaise * (unitsSold / before));
        }
        const after = change ? Math.max(0, before - quantity) : before;
        const record = disposalRow(target, event, cls, { key, costPaise: disposedCost,
          source, asOf, quantity });
        out.push(record);
        sold.push(record);
        if (change) {
          const ratio = before > 0 ? after / before : 0;
          const terms = carryBrokerFields(target, after);
          target.quantity = after;
          target.as_of = target.as_of || event.date || asOf;
          target.value_paise = scaledPaise(target.value_paise, ratio);
          target.face_paise = scaledPaise(target.face_paise, ratio);
          if (costPaise !== null) {
            target.cost_paise = Math.max(0, costPaise - (disposedCost || 0));
          }
          Object.assign(target, terms);
          if (after <= 0) {
            const at = out.indexOf(target);
            if (at >= 0) out.splice(at, 1);
            target = null;
          }
        }
        current = after;
        applied.push({ ...base, status: change ? "applied" : "reflected",
          from: before, to: after, costPaise: disposedCost });
      } else {
        const after = change ? before + quantity : before;
        if (change) {
          const ratio = before > 0 ? after / before : 0;
          const terms = carryBrokerFields(target, after);
          target.quantity = after;
          target.as_of = target.as_of || event.date || asOf;
          target.value_paise = scaledPaise(target.value_paise, ratio);
          target.face_paise = scaledPaise(target.face_paise, ratio);
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
      conflicts.push({
        isin,
        txn_key: casEventKey(sale),
        date: sale.date || "",
        message: `The holding on file is dated ${rowAsOf} and still shows `
          + `${startQty} units. The statement records `
          + `${Number(sale.quantity)} sold on ${sale.date}, so it now holds `
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
    if (old.source === "manual") {
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
 *   merge?: boolean, safety?: object}} input
 * @returns {object}
 */
export function casReplacePlan({ parsed = {}, existing = [], holdings = [], events = null,
  assetId = "", asOf = "", confirmed = false, merge = false, safety = null } = {}) {
  const verdict = safety || casSafety(parsed);
  if (verdict.blocked) {
    return { ok: false, blocked: true, safety: verdict, rows: existing, absent: [],
      dropped: [], manualKept: 0, keptNewer: 0, keptEvents: 0, carried: 0,
      preserveAbsent: true, events: [], sold: [], conflicts: [], warnings: [] };
  }
  const movements = events === null ? (parsed?.transactions || []) : (events || []);
  const eventIsins = new Set(movements.map((event) =>
    String(event?.isin || "").toUpperCase()).filter(Boolean));
  const preserveAbsent = merge || !(confirmed && verdict.complete);
  const applied = casApplyRows({ existing, holdings, asOf, preserveAbsent,
    keepAbsent: eventIsins });
  if (!movements.length) {
    return { ok: true, blocked: false, safety: verdict, preserveAbsent, ...applied,
      events: [], sold: [], conflicts: [], warnings: [] };
  }
  const result = applyCasEvents(applied.rows, movements, { asOf, assetId });
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
