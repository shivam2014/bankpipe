// Ledger rules ported from ../core.py (ingest, reconcile_run, check_statements).
// Amounts are integer paise. null means "unreadable", never zero.

const NARRATION_CHARS = 60;

// core.py compares narrations upper-cased, whitespace-collapsed, first 60 chars.
export function normNarration(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, NARRATION_CHARS);
}

function bump(map, key) {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

function triple(row) {
  return JSON.stringify([row.date || null, row.amount ?? null, row.balance ?? null]);
}

// A bank row is identified by (date, amount, running balance). Narration is the
// only fallback witness when the balance is unreadable.
function identity(row) {
  const balance = row.balance ?? null;
  return JSON.stringify([
    row.date || null,
    row.amount ?? null,
    balance,
    balance === null ? normNarration(row.narration ?? row.description) : "",
  ]);
}

// Two sources can describe the same transaction with a different running
// balance (the workbook and the bank export, for example). When the date, the
// amount and the narration agree, the statement's balance wins and the stored
// row is corrected instead of duplicated.
function looseKey(row) {
  const text = normNarration(row.narration ?? row.description);
  if (!text) return "";
  return JSON.stringify([row.date || null, row.amount ?? null, text]);
}

// Two rows are the same event only when the date, the amount, the narration
// AND the running balance agree. Three ₹3,500 ATM withdrawals on one day each
// move the balance by ₹3,500, so their balances differ and they are separate
// transactions, not copies.
export function duplicateIds(rows = []) {
  const seen = new Set();
  const drop = [];
  for (const r of rows) {
    const key = [r.date || "", r.amount ?? null, normNarration(r.narration),
      r.balance ?? null].join("|");
    if (seen.has(key)) drop.push(r.id);
    else seen.add(key);
  }
  return drop;
}

export function dedupePlan(existing = [], incoming = []) {
  const heldByKey = new Map();
  const heldByTriple = new Map();
  const heldByLoose = new Map();
  for (const row of existing) {
    bump(heldByKey, identity(row));
    bump(heldByTriple, triple(row));
    const loose = looseKey(row);
    if (!loose) continue;
    if (!heldByLoose.has(loose)) heldByLoose.set(loose, []);
    heldByLoose.get(loose).push({ id: row.id ?? null, balance: row.balance ?? null });
  }

  const seen = new Map();
  const claimed = new Set();
  let duplicates = 0;
  const updates = [];
  const insert = incoming.map((row) => {
    const key = identity(row);
    const occurrence = bump(seen, key);
    const blankNarration = (row.balance ?? null) === null && normNarration(row.narration) === "";
    // core.py's SQL falls back to the bare triple when there is no narration to compare.
    const already = blankNarration ? (heldByTriple.get(triple(row)) ?? 0) : (heldByKey.get(key) ?? 0);
    if (occurrence <= already) {
      duplicates += 1;
      updates.push(null);
      return false;
    }
    const loose = looseKey(row);
    const candidates = loose && heldByLoose.has(loose) ? heldByLoose.get(loose)
      .filter((c) => c.id !== null && !claimed.has(c.id)) : [];
    const fixable = candidates.find((c) => c.balance !== (row.balance ?? null));
    if (fixable) {
      claimed.add(fixable.id);
      updates.push({ id: fixable.id, balance: row.balance ?? null,
        narration: row.narration ?? row.description ?? null });
      return false;
    }
    updates.push(null);
    return true;
  });
  return { insert, duplicates, updates };
}

export function reconcileChain(rows = []) {
  // Some statements repeat the end-of-day balance on every row of that day.
  // Checking those rows one by one invents a break before every multi-row day.
  // When the rows carry a date, check the day's total against its closing
  // balance instead. Rows without dates keep the strict row-by-row check.
  if (rows.some((row) => row.date)) return reconcileByDay(rows);

  const breaks = [];
  let previousBalance = null;

  rows.forEach((row, index) => {
    if (row.excluded) return; // excluded rows are invisible to the chain
    const balance = row.balance ?? null;
    const amount = row.amount ?? null;
    if (balance !== null && previousBalance !== null && amount !== null && balance !== previousBalance + amount) {
      breaks.push({ id: row.id, expected: previousBalance + amount, actual: balance, index });
    }
    if (balance !== null) previousBalance = balance;
  });

  // One typo makes two rows disagree: the wrong row and the row measured against
  // it. They are equal and opposite and adjacent, so only the culprit is reported.
  const suppressed = new Set();
  for (let i = 0; i < breaks.length - 1; i += 1) {
    const a = breaks[i];
    const b = breaks[i + 1];
    if (b.index === a.index + 1 && a.actual - a.expected === b.expected - b.actual) {
      suppressed.add(i + 1);
    }
  }

  const issues = breaks
    .filter((_, i) => !suppressed.has(i))
    .map(({ id, expected, actual }) => ({ id, expected, actual, delta: actual - expected }));

  return { issues, suppressed: [...suppressed].map((i) => breaks[i].id) };
}

function reconcileByDay(rows = []) {
  const issues = [];
  let previousBalance = null;
  let i = 0;
  while (i < rows.length) {
    const date = rows[i].date ?? null;
    let j = i;
    while (j + 1 < rows.length && (rows[j + 1].date ?? null) === date) j += 1;
    const group = rows.slice(i, j + 1);
    const visible = group.filter((r) => !r.excluded);
    const amountsKnown = visible.every((r) => r.amount !== null && r.amount !== undefined);
    const withBalance = visible.filter((r) => r.balance !== null && r.balance !== undefined);
    const net = amountsKnown ? visible.reduce((sum, r) => sum + r.amount, 0) : 0;
    const last = withBalance[withBalance.length - 1];
    if (amountsKnown && withBalance.length && previousBalance !== null) {
      const expected = previousBalance + net;
      if (last.balance !== expected) {
        issues.push({ id: last.id, expected, actual: last.balance,
          delta: last.balance - expected, date, previous: previousBalance,
          dayNet: net });
      }
    } else if (amountsKnown && withBalance.length && previousBalance === null
        && visible.length > 1 && visible[0].balance !== null
        && visible[0].balance !== undefined) {
      // The first day has no row above it, but its own first row implies the
      // opening balance: balance minus that row's amount. Check the day from
      // there so a one-day statement is not silently unaudited. A file that
      // still holds a newest-first day is accepted in that direction too.
      // Rows that all repeat the end-of-day balance carry no intra-day chain,
      // so leave them alone rather than inventing a break.
      const first = visible[0];
      const repeated = withBalance.every((r) => r.balance === withBalance[0].balance);
      if (!repeated) {
        const forward = first.balance - first.amount + net;
        const backward = last.balance - last.amount + net;
        if (last.balance !== forward && first.balance !== backward) {
          issues.push({ id: last.id, expected: forward, actual: last.balance,
            delta: last.balance - forward, date, previous: null, dayNet: net });
        }
      }
    }
    if (withBalance.length) previousBalance = withBalance[withBalance.length - 1].balance;
    i = j + 1;
  }
  // A row posted one day late produces an equal-and-opposite pair of day
  // breaks. Report the first, suppress the correction, as the row-level check
  // already does.
  const suppressed = new Set();
  for (let k = 0; k < issues.length - 1; k += 1) {
    if (issues[k].delta + issues[k + 1].delta === 0) suppressed.add(k + 1);
  }
  return { issues: issues.filter((_, k) => !suppressed.has(k)),
    suppressed: issues.filter((_, k) => suppressed.has(k)).map((x) => x.id) };
}

const DAY_MS = 86_400_000;

function parseDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function statementChain(statements = []) {
  const gaps = [];
  const overlaps = [];
  let previousClosing = null;
  let previousEnd = null;

  for (const statement of statements) {
    const opening = statement.opening ?? null;
    const closing = statement.closing ?? null;

    if (previousClosing !== null && opening !== null && opening !== previousClosing) {
      gaps.push({ id: statement.id, previousClosing, opening });
    }

    // A shared boundary day is normal; a shared week means double-imported data.
    const end = parseDay(previousEnd);
    const start = parseDay(statement.start);
    const overlapDays = end === null || start === null ? 0 : (end - start) / DAY_MS;
    if (overlapDays > 3) overlaps.push({ id: statement.id, overlapDays });

    if (closing !== null) previousClosing = closing;
    previousEnd = statement.end ?? null;
  }

  return { gaps, overlaps };
}
