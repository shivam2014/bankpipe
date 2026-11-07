// Shape-only report for a CAS that did not parse. A redacted statement cannot
// prove a parser right, because the redaction removes the very values a column
// rule is tested against. What a parser actually needs is geometry: where the
// numeric columns sit, how many rows arrived, and which rows were dropped.
//
// None of that is personal. This reports counts and column positions, never a
// value, a name, an ISIN or an account number.

const CLUSTER = 24;

/**
 * @param {{pages: Array<{items: Array<{str: string, x: number, y: number}>}>}} pdf
 * @param {{holdings: Array<object>, counts: object, depository: string, demat: string}} parsed
 */
export function casShape(pdf, parsed) {
  const pages = pdf?.pages || [];
  const items = pages.flatMap((p) => p.items || []);
  const numeric = items.filter((it) => /^[\d,]+(\.\d+)?$/.test(String(it.str).trim()));
  // Numeric columns sit at fixed x. Cluster them so a parser rule can be aimed
  // at a range instead of at "the last four numbers".
  const clusters = [];
  for (const it of numeric) {
    const x = Math.round(Number(it.x) || 0);
    const hit = clusters.find((c) => Math.abs(c.x - x) <= CLUSTER);
    if (hit) { hit.count += 1; hit.x = Math.round((hit.x + x) / 2); }
    else clusters.push({ x, count: 1 });
  }
  clusters.sort((a, b) => a.x - b.x);
  const rows = parsed?.holdings || [];
  const kinds = {};
  for (const h of rows) kinds[h.kind] = (kinds[h.kind] || 0) + 1;
  return {
    version: 1,
    kind: "cas",
    pages: pages.length,
    items: items.length,
    numericItems: numeric.length,
    columns: clusters.filter((c) => c.count >= 3).slice(0, 12)
      .map((c) => `${c.x}x${c.count}`),
    depositoryFound: !!parsed?.depository,
    dematFound: !!(parsed?.demat && parsed.demat.length),
    rowsRead: rows.length,
    quarantined: Number(parsed?.counts?.quarantined) || 0,
    kinds,
    withValue: rows.filter((h) => Number(h.valuePaise) > 0).length,
    withIsin: rows.filter((h) => /^IN[A-Z0-9]{10}$/.test(String(h.isin || ""))).length,
    maturityParsed: rows.filter((h) => !!h.maturity).length,
  };
}

/** @param {object} shape from casShape @returns {string} */
export function casShapeText(shape) {
  if (!shape) return "";
  return [
    `BankPipe CAS shape · v${shape.version}`,
    `pages            ${shape.pages} · items ${shape.items} · numeric ${shape.numericItems}`,
    `columns          ${(shape.columns || []).join(" ")}`,
    `account          depository ${shape.depositoryFound ? "yes" : "no"}`
      + ` · demat number ${shape.dematFound ? "yes" : "no"}`,
    `rows             ${shape.rowsRead} read · ${shape.quarantined} quarantined`,
    `kinds            ${Object.entries(shape.kinds || {}).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}`,
    `fields           value ${shape.withValue} · isin ${shape.withIsin}`
      + ` · maturity ${shape.maturityParsed}`,
  ].join("\n");
}
