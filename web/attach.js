// Attaching what was paid to what is held. The depository says how many bonds
// are in the account; the seller's report says what they cost. Neither file has
// both, so the join is by ISIN and only where the quantities agree — a partial
// match would put the price of thirty bonds on twenty.
//
// Pure: the caller passes the two sets of rows and applies the result itself.

const clean = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {{positions?: Array<object>, lots?: Array<object>}} input
 * @returns {{updates: Array<object>, matched: string[], skipped: Array<object>}}
 */
export function attachCost({ positions = [], lots = [] } = {}) {
  const byIsin = new Map();
  for (const lot of lots || []) {
    const isin = clean(lot.security_id);
    if (!isin) continue;
    if (!byIsin.has(isin)) byIsin.set(isin, []);
    byIsin.get(isin).push(lot);
  }
  const updates = [];
  const matched = [];
  const skipped = [];
  for (const position of positions || []) {
    const isin = clean(position.security_id);
    if (!isin) continue;
    if (position.cost_paise !== null && position.cost_paise !== undefined) {
      skipped.push({ isin, reason: "has-cost" });
      continue;
    }
    const group = byIsin.get(isin);
    if (!group || !group.length) {
      skipped.push({ isin, reason: "no-lot" });
      continue;
    }
    const lotQty = group.reduce((t, l) => t + num(l.quantity), 0);
    const heldQty = num(position.quantity);
    if (!heldQty || Math.abs(lotQty - heldQty) > 1e-6) {
      skipped.push({ isin, reason: "quantity", heldQty, lotQty });
      continue;
    }
    const known = group.filter((l) => l.cost_paise !== null && l.cost_paise !== undefined);
    if (known.length !== group.length) {
      skipped.push({ isin, reason: "lot-without-cost" });
      continue;
    }
    const cost = known.reduce((t, l) => t + num(l.cost_paise), 0);
    // The earliest purchase date is the one the holding has held longest, which
    // is what a holding period is measured from.
    const dates = group.map((l) => String(l.purchase_date || "")).filter(Boolean).sort();
    updates.push({ security_id: isin, cost_paise: Math.round(cost),
      purchase_date: dates[0] || "" });
    matched.push(isin);
  }
  return { updates, matched, skipped };
}

/**
 * Which cost sources are fully represented in the matched positions. A source
 * with even one unmatched lot has to keep counting: retiring it would drop that
 * bond's value from net worth without ever putting its cost on a depository row.
 * @param {Array<{id: string, lots: Array<object>}>} sources
 * @param {string[]} matched ISINs that found a position
 * @returns {Array<{id: string, fully: boolean}>}
 */
export function coverageBySource(sources = [], matched = []) {
  const hit = new Set((matched || []).map(clean));
  return (sources || []).map((source) => ({
    id: source.id,
    fully: (source.lots || []).length > 0
      && (source.lots || []).every((lot) => hit.has(clean(lot.security_id))),
  }));
}

/**
 * Consolidate cost across every demat at once. The statements say what is held
 * and where; the portfolios say what it cost. A bond held in two demats shares
 * its cost by quantity, and a lot larger than the holding (part sold) gives up
 * only the part still held.
 * @param {{demats?: Array<{id: string, positions: Array<object>}>,
 *   sources?: Array<{id: string, lots: Array<object>}>}} input
 * @returns {{updates: Array<object>, stats: object, retire: string[]}}
 */
export function planConsolidation({ demats = [], sources = [] } = {}) {
  const lots = (sources || []).flatMap((s) => (s.lots || [])
    .map((lot) => ({ ...lot, source: s.id })));
  const byIsin = new Map();
  for (const lot of lots) {
    const isin = clean(lot.security_id);
    if (!isin) continue;
    if (!byIsin.has(isin)) byIsin.set(isin, []);
    byIsin.get(isin).push(lot);
  }
  const held = new Map();
  for (const demat of demats || []) {
    for (const position of demat.positions || []) {
      const isin = clean(position.security_id);
      if (!isin) continue;
      held.set(isin, (held.get(isin) || 0) + num(position.quantity));
    }
  }
  const updates = [];
  const stats = { exact: 0, prorata: 0, noLot: 0, alreadyPriced: 0, orphan: 0 };
  for (const isin of byIsin.keys()) if (!held.has(isin)) stats.orphan += 1;
  for (const demat of demats || []) {
    for (const position of demat.positions || []) {
      const isin = clean(position.security_id);
      if (!isin) continue;
      if (position.cost_paise !== null && position.cost_paise !== undefined) {
        stats.alreadyPriced += 1;
        continue;
      }
      const group = byIsin.get(isin);
      const heldQty = num(position.quantity);
      if (!group || !(heldQty > 0)) { stats.noLot += 1; continue; }
      const lotQty = group.reduce((t, l) => t + num(l.quantity), 0);
      const lotCost = group.reduce((t, l) => t + num(l.cost_paise), 0);
      if (!(lotQty > 0)) { stats.noLot += 1; continue; }
      // Every held unit carries the same share of the lot's cost; when the
      // statement shows fewer units than the lot (part sold) the rest drops out.
      const base = Math.max(lotQty, held.get(isin) || 0);
      const dates = group.map((l) => String(l.purchase_date || "")).filter(Boolean).sort();
      updates.push({
        assetId: demat.id,
        security_id: isin,
        cost_paise: Math.round(lotCost * (heldQty / base)),
        purchase_date: dates[0] || "",
      });
      if (Math.abs(lotQty - (held.get(isin) || 0)) < 1e-6) stats.exact += 1;
      else stats.prorata += 1;
    }
  }
  const retire = (sources || [])
    .filter((s) => (s.lots || []).some((l) => held.has(clean(l.security_id))))
    .map((s) => s.id);
  return { updates, stats, retire };
}

/**
 * Merge a cost file into an account filled from a statement.
 *
 * The statement is a snapshot of one day. A file that carries dated purchases
 * can therefore say two different things:
 *  - a unit the statement no longer lists was sold, so the statement wins;
 *  - a unit bought after the statement's date is simply too new to appear in
 *    it, so the file wins and the unit is added.
 * @param {{positions?: Array<object>, rows?: Array<object>, asOf?: string}} input
 * @returns {{rows: Array<object>, attached: number, added: number, stale: number}}
 */
export function planCostFile({ positions = [], rows = [], asOf = "" } = {}) {
  const plan = planConsolidation({
    demats: [{ id: "account", positions }],
    sources: [{ id: "file", lots: rows }],
  });
  const merged = applyCost(positions, plan.updates);
  const held = new Set((positions || []).map((p) => clean(p.security_id)));
  const missing = (rows || []).filter((r) => r && r.security_id && !held.has(clean(r.security_id)));
  const newer = missing.filter((r) => !asOf || String(r.purchase_date || "") > asOf);
  const added = newer.map((r) => {
    const isin = clean(r.security_id);
    return {
      security_id: isin,
      label: r.label || "",
      category: r.category || (/^INF/.test(isin) ? "mf" : "equity"),
      quantity: r.quantity === undefined ? null : r.quantity,
      cost_paise: r.cost_paise === undefined ? null : r.cost_paise,
      // No statement has priced it yet, so it carries its cost until one does.
      value_paise: r.value_paise === undefined || r.value_paise === null
        ? (r.cost_paise === undefined ? null : r.cost_paise) : r.value_paise,
      purchase_date: r.purchase_date || "",
    };
  });
  return {
    rows: [...merged, ...added],
    attached: plan.updates.length,
    added: added.length,
    stale: missing.length - added.length,
  };
}

/**
 * Merge the cost updates into the position rows, so the caller can write the
 * whole snapshot back without losing the fields it does not own.
 * @param {Array<object>} positions
 * @param {Array<object>} updates from attachCost
 * @returns {Array<object>}
 */
export function applyCost(positions = [], updates = []) {
  const byIsin = new Map(updates.map((u) => [clean(u.security_id), u]));
  return (positions || []).map((p) => {
    const hit = byIsin.get(clean(p.security_id));
    return hit ? { ...p, cost_paise: hit.cost_paise,
      purchase_date: hit.purchase_date || p.purchase_date } : p;
  });
}
