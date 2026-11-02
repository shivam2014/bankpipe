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

// The bank's printed order is the truth. A statement exported newest-first can
// leave one day's rows reversed inside an otherwise chronological file; that is
// the only case worth fixing. Walk adjacent groups of the same date, flip a
// group only when it chains in reverse and not forward, and leave everything
// else exactly where the file put it. No global search, no sort by balance.
export function orderForChain(rows = [], { previousBalance = null } = {}) {
  const out = rows.slice();
  const reversed = [];
  const unresolved = [];
  let balance = previousBalance ?? null;

  let i = 0;
  while (i < out.length) {
    const date = out[i].date ?? null;
    let j = i;
    while (j + 1 < out.length && (out[j + 1].date ?? null) === date) j += 1;
    const group = out.slice(i, j + 1);
    const judged = group.filter((r) => !r.excluded
      && r.amount !== null && r.amount !== undefined
      && r.balance !== null && r.balance !== undefined);
    // Some statements repeat the end-of-day balance on every row of that day.
    // There is no intra-day chain to judge, so never call that reversed.
    const repeated = judged.length > 1 && judged.every((r) => r.balance === judged[0].balance);
    let ordered = group;

    if (date !== null && group.length > 1 && judged.length > 1 && !repeated) {
      if (!chainsFrom(group, balance)) {
        const flipped = group.slice().reverse();
        if (chainsFrom(flipped, balance)) {
          ordered = flipped;
          reversed.push({ date, ids: flipped.map((r) => r.id) });
        } else {
          unresolved.push({ date, ids: group.map((r) => r.id) });
        }
      }
    }

    if (ordered !== group) out.splice(i, group.length, ...ordered);
    const closing = ordered.filter((r) => !r.excluded
      && r.balance !== null && r.balance !== undefined).pop();
    if (closing) balance = closing.balance;
    i = j + 1;
  }

  return { rows: out, reversed, unresolved };
}

// True when each visible row with an amount and a balance follows from the
// running balance. A null start means the group's first balance is the baseline,
// so a single-row group is never called broken.
function chainsFrom(rows, start) {
  let balance = start ?? null;
  for (const row of rows) {
    if (row.excluded) continue;
    if (row.amount === null || row.amount === undefined) continue;
    if (row.balance === null || row.balance === undefined) continue;
    if (balance !== null && Math.abs(row.balance - (balance + row.amount)) > 1) return false;
    balance = row.balance;
  }
  return true;
}

const judgeableRow = (row) => !!row && !!row.date
  && row.amount !== null && row.amount !== undefined
  && row.balance !== null && row.balance !== undefined;

function dayGroups(segment) {
  const dated = segment.map((row, index) => ({ row, index }))
    .sort((a, b) => String(a.row.date).localeCompare(String(b.row.date)) || a.index - b.index);
  const days = [];
  for (const item of dated) {
    const day = String(item.row.date);
    const last = days[days.length - 1];
    if (last && last.date === day) last.rows.push(item.row);
    else days.push({ date: day, rows: [item.row] });
  }
  return days;
}

const sameCandidate = (a, b) => String(a.date) === String(b.date)
  && Number(a.amount) === Number(b.amount)
  && Number(a.balance) === Number(b.balance);

// Rows that agree on date, amount and balance are interchangeable: no order
// between them can be proven, and none is needed.
function allSame(rows) {
  return rows.length > 0 && rows.every((row) => sameCandidate(row, rows[0]));
}

function followsFrom(previous, row, convention) {
  return convention === "opening"
    ? Math.abs(row.balance - (previous.balance + previous.amount)) <= 1
    : Math.abs(row.balance - (previous.balance + row.amount)) <= 1;
}

function followsOpening(opening, row, convention) {
  return convention === "opening"
    ? Math.abs(row.balance - Number(opening)) <= 1
    : Math.abs(row.balance - (Number(opening) + row.amount)) <= 1;
}

// Rebuild one day under a balance convention. Post-entry uses the next row's
// amount (balance[i] == balance[i-1] + amount[i]); opening uses the previous
// row's amount (balance[i] == balance[i-1] + amount[i-1]). A day that revisits
// a balance has no head; the printed opening or the previous day's closing row
// then names the row that starts it. A tie is ambiguous only when the
// candidates differ in date, amount or balance.
function orderDay(rows, convention, previous, opening) {
  if (rows.length < 2) return { rows: rows.slice(), reason: "" };
  if (rows.every((row) => row.balance === rows[0].balance)) {
    return { rows: [], reason: "repeated end-of-day balance" };
  }
  const follows = (prev, next) => followsFrom(prev, next, convention);
  const hasPredecessor = (row) => rows.some((other) => other !== row
    && (convention === "opening"
      ? Math.abs(row.balance - (other.balance + other.amount)) <= 1
      : Math.abs(row.balance - (other.balance + row.amount)) <= 1));
  const heads = rows.filter((row) => !hasPredecessor(row));
  const baseline = previous
    ? (row) => followsFrom(previous, row, convention)
    : opening !== null && opening !== undefined
      ? (row) => followsOpening(opening, row, convention)
      : null;
  let start = null;
  if (heads.length === 1) {
    start = heads[0];
  } else if (heads.length > 1) {
    const viable = baseline ? heads.filter(baseline) : heads;
    const pool = viable.length ? viable : heads;
    if (pool.length > 1 && !allSame(pool)) {
      return { rows: [], reason: "ambiguous within-day order" };
    }
    start = pool[0];
  } else if (baseline) {
    const viable = rows.filter(baseline);
    if (!viable.length) return { rows: [], reason: "chain does not reconcile" };
    if (viable.length > 1 && !allSame(viable)) {
      return { rows: [], reason: "ambiguous within-day order" };
    }
    start = viable[0];
  } else {
    return { rows: [], reason: "ambiguous within-day order" };
  }
  const ordered = [start];
  const remaining = rows.filter((row) => row !== start);
  while (remaining.length) {
    const current = ordered[ordered.length - 1];
    const matches = remaining.filter((row) => follows(current, row));
    if (!matches.length) return { rows: [], reason: "chain does not reconcile" };
    if (matches.length > 1 && !allSame(matches)) {
      return { rows: [], reason: "ambiguous within-day order" };
    }
    const next = matches[0];
    ordered.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return { rows: ordered, reason: "" };
}

function orderFor(segment, convention, opening = null) {
  const rows = [];
  let previous = null;
  for (const day of dayGroups(segment)) {
    const result = orderDay(day.rows, convention, previous, opening);
    if (result.reason) return { rows: [], reason: result.reason };
    rows.push(...result.rows);
    previous = result.rows[result.rows.length - 1] || previous;
  }
  return { rows, reason: "" };
}

function verifyOrder(rows, convention, opening) {
  for (let i = 1; i < rows.length; i++) {
    const expected = convention === "opening"
      ? rows[i - 1].balance + rows[i - 1].amount
      : rows[i - 1].balance + rows[i].amount;
    if (Math.abs(rows[i].balance - expected) > 1) return false;
  }
  if (opening !== null && opening !== undefined && rows.length) {
    const implied = convention === "opening"
      ? rows[0].balance
      : rows[0].balance - rows[0].amount;
    if (Math.abs(Number(opening) - implied) > 1) return false;
  }
  return true;
}

// The balance column proves each sign outright. Opening rows use
// delta = balance[i+1] - balance[i]; post-entry rows use
// delta = balance[i] - balance[i-1]. Every magnitude must match before a flip
// is considered, then all disagreeing rows flip in one pass. The last opening
// row has no successor, so its sign stays as parsed. The first post-entry row
// is proven only when the printed opening supplies its predecessor.
function requiredSigns(rows, convention, opening) {
  const flips = [];
  const prove = (index, delta) => {
    const amount = Number(rows[index].amount);
    if (Math.abs(delta) !== Math.abs(amount)) return false;
    if (Math.sign(amount) !== Math.sign(delta)) flips.push(index);
    return true;
  };
  if (convention === "opening") {
    if (opening !== null && opening !== undefined
        && Math.abs(rows[0].balance - Number(opening)) > 1) return null;
    for (let i = 0; i < rows.length - 1; i++) {
      if (!prove(i, rows[i + 1].balance - rows[i].balance)) return null;
    }
  } else {
    if (opening !== null && opening !== undefined) {
      if (!prove(0, rows[0].balance - Number(opening))) return null;
    }
    for (let i = 1; i < rows.length; i++) {
      if (!prove(i, rows[i].balance - rows[i - 1].balance)) return null;
    }
  }
  return flips;
}

// Convention first, then sign repair. A convention is adopted only when the
// whole ordered run verifies. A sign repair is attempted only on a run that
// ordered cleanly but broke the chain; it is kept only when the flipped rows
// verify from scratch. Ambiguous or repeated days are never sign-repaired.
function reorderSegment(segment, { opening = null, convention = "" } = {}) {
  const empty = { rows: segment, moved: 0, reason: "", convention: "",
    conventionSource: "", adopted: "", signCorrected: 0 };
  if (segment.length < 2) return empty;
  const reasons = [];
  const orders = [];
  const conventions = convention ? [convention] : ["post", "opening"];
  for (const each of conventions) {
    const order = orderFor(segment, each, opening);
    orders.push({ convention: each, order });
    if (order.reason) { reasons.push(order.reason); continue; }
    if (verifyOrder(order.rows, each, opening)) {
      const moved = order.rows.reduce((n, row, i) => n + (segment[i] === row ? 0 : 1), 0);
      return { rows: moved ? order.rows : segment, moved, reason: "",
        convention: each === "opening" ? "opening" : "",
        conventionSource: convention ? "formula"
          : (each === "opening" ? "inferred" : ""),
        adopted: each,
        signCorrected: 0 };
    }
  }
  for (const { convention: each, order } of orders) {
    if (order.reason) continue;
    const flips = requiredSigns(order.rows, each, opening);
    if (!flips || !flips.length) continue;
    const fixed = order.rows.map((row, i) =>
      flips.includes(i) ? { ...row, amount: -row.amount } : row);
    if (verifyOrder(fixed, each, opening)) {
      const moved = order.rows.reduce((n, row, i) => n + (segment[i] === row ? 0 : 1), 0);
      return { rows: fixed, moved, reason: "",
        convention: each === "opening" ? "opening" : "",
        conventionSource: convention ? "formula"
          : (each === "opening" ? "inferred" : ""),
        adopted: each,
        signCorrected: flips.length };
    }
    reasons.push("chain does not reconcile");
  }
  const reason = reasons.includes("ambiguous within-day order") ? "ambiguous within-day order"
    : reasons.includes("repeated end-of-day balance") ? "repeated end-of-day balance"
      : "chain does not reconcile";
  return { ...empty, reason };
}

// A block typed newest-first cannot be repaired by dates alone: a wrong date
// and a genuine gap look the same. The running balance is the authority. Rows
// without a date, amount or balance are anchors: they stay where the file put
// them and split the sheet into contiguous judgeable runs. Each run is sorted
// by date, rebuilt from its chain, and adopted only when it reconciles; the
// printed opening is checked on the first run only.
// `moved` is the number of positions that changed, so the receipt can say how
// much was repaired without naming a row. A reason is returned for every run
// that declined and for every anchored row, so silence means "nothing needed
// to move", never "the pass gave up".
export function reorderByChain(rows = [], { opening = null, runs = null } = {}) {
  const list = rows || [];
  const out = [];
  const missing = { date: 0, amount: 0, balance: 0 };
  const declined = [];
  let moved = 0;
  let signCorrected = 0;
  let segment = [];
  let start = 0;
  let segmentRun = null;
  const defaultRun = { from: 0, to: 0, formula: false, convention: "",
    mixed: false, unreadable: false };
  if (!Array.isArray(runs) || !runs.length) {
    const numbers = list.map((row, i) => Number(row?.source_row) || i + 1);
    defaultRun.from = numbers.length ? Math.min(...numbers) : 0;
    defaultRun.to = numbers.length ? Math.max(...numbers) : 0;
  }
  const activeRuns = Array.isArray(runs) && runs.length ? runs : [defaultRun];
  const states = new Map();
  const stateFor = (run) => {
    if (!states.has(run)) states.set(run, { moved: 0, sign: 0,
      reasons: new Set(), adopted: new Set() });
    return states.get(run);
  };
  const runFor = (row) => {
    if (!Array.isArray(runs) || !runs.length) return defaultRun;
    const rowNo = Number(row?.source_row);
    return runs.find((run) => rowNo >= run.from && rowNo <= run.to) || null;
  };
  const flush = () => {
    if (!segment.length) return;
    const fixed = segmentRun && segmentRun.formula && segmentRun.convention
      ? segmentRun.convention : "";
    const result = reorderSegment(segment, {
      opening: start === 0 ? opening : null, convention: fixed,
    });
    out.push(...result.rows);
    moved += result.moved;
    signCorrected += result.signCorrected || 0;
    if (result.reason) declined.push(result.reason);
    if (segmentRun) {
      const state = stateFor(segmentRun);
      state.moved += result.moved;
      state.sign += result.signCorrected || 0;
      if (result.reason) state.reasons.add(result.reason);
      if (segmentRun.formula && segmentRun.convention) {
        state.adopted.add(segmentRun.convention);
      } else if (result.adopted) {
        state.adopted.add(result.adopted);
      }
    }
    segment = [];
  };
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (judgeableRow(row)) {
      const run = runFor(row);
      if (segment.length && run !== segmentRun) flush();
      if (!segment.length) { start = i; segmentRun = run; }
      segment.push(row);
      continue;
    }
    flush();
    out.push(row);
    if (!row?.date) missing.date += 1;
    else if (row.amount === null || row.amount === undefined) missing.amount += 1;
    else missing.balance += 1;
  }
  flush();

  const reports = activeRuns.map((run) => {
    const state = stateFor(run);
    const adopted = new Set(state.adopted);
    if (run.formula && run.convention) adopted.add(run.convention);
    let convention = "";
    if (run.formula && run.convention) convention = run.convention;
    else if (adopted.size === 1) convention = [...adopted][0];
    else if (adopted.size > 1) convention = "mixed";
    return {
      from: run.from, to: run.to,
      formula: !!run.formula, mixed: !!run.mixed, unreadable: !!run.unreadable,
      convention, moved: state.moved, signCorrected: state.sign,
      reason: [...state.reasons].join(" · "),
    };
  });
  const openingRun = reports.find((run) => run.convention === "opening");
  const conventionOut = openingRun ? "opening" : "";
  const conventionSource = openingRun
    ? (openingRun.formula && !openingRun.mixed && !openingRun.unreadable
      ? "formula" : "inferred") : "";

  const anchors = [];
  const rowsWith = (n, text) => `${n} row${n === 1 ? "" : "s"} ${text}`;
  if (missing.date) anchors.push(rowsWith(missing.date, "without a date"));
  if (missing.amount) anchors.push(rowsWith(missing.amount, "without an amount"));
  if (missing.balance) anchors.push(rowsWith(missing.balance, "without a balance"));
  const reason = [...anchors, ...new Set(declined)].join(" · ");
  const sameOrder = moved === 0 && signCorrected === 0 && out.length === list.length
    && out.every((row, i) => row === list[i]);
  return { rows: sameOrder ? list : out, reordered: moved > 0, moved, reason,
    convention: conventionOut, conventionSource, signCorrected, runs: reports };
}

export function reconcileChain(rows = []) {
  // A break is more than one paise, the same tolerance the file audit uses, so
  // a one-paise rounding difference does not invent an error.
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
    if (balance !== null && previousBalance !== null && amount !== null
        && Math.abs(balance - (previousBalance + amount)) > 1) {
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
      if (Math.abs(last.balance - expected) > 1) {
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
        if (Math.abs(last.balance - forward) > 1 && Math.abs(first.balance - backward) > 1) {
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

// Where the new run lands in the stored order. The store prints runs by their
// earliest transaction date; a run with no date follows every dated run. A new
// run has the highest run id, so it follows an older run that starts on the
// same day. Without run metadata the held rows are treated as one run.
function insertAt(held, start) {
  const carriesRuns = held.some((row) => "run_first_date" in row || "run_id" in row);
  if (!carriesRuns) {
    if (start === null) return held.length;
    const first = held.map((row) => row.date).filter(Boolean).sort()[0] || null;
    return first !== null && start < first ? 0 : held.length;
  }
  if (start === null) {
    const legacy = held.findIndex((row) => row.run_id === null || row.run_id === undefined);
    return legacy < 0 ? held.length : legacy;
  }
  const at = held.findIndex((row) => {
    const first = row.run_first_date ?? null;
    return first === null || first > start;
  });
  return at < 0 ? held.length : at;
}

function mergeRuns(held, incoming) {
  if (!incoming.length) return held.slice();
  const first = incoming.map((row) => row.date).filter(Boolean).sort()[0] || null;
  const at = insertAt(held, first);
  return [...held.slice(0, at), ...incoming, ...held.slice(at)];
}

// One plan for the preview and the write. `held` is the account's rows in the
// order the ledger prints them; `incoming` is the file's rows oldest-first, the
// same list importRows stores. The returned `insert` has one flag per incoming
// row, and `updates` the correction for the rows that replace a held balance.
// `today` is carried for the caller's report; it does not change the rules.
export function planImport({ held = [], incoming = [], today = null, closing = null } = {}) {
  const dedupe = dedupePlan(held, incoming);
  const updates = dedupe.updates || [];
  const correctedIds = new Set(updates.filter(Boolean).map((fix) => fix.id));
  const kept = held.filter((row) => row.id === null || row.id === undefined
    || !correctedIds.has(row.id));
  // A correction deletes the held row and stores the file's row in the new run,
  // so it joins the chain at the file's position, not the old one.
  const landed = incoming.filter((_, i) => dedupe.insert[i] || updates[i]);
  const chain = orderForChain(mergeRuns(kept, landed)).rows;
  const breaks = reconcileChain(chain).issues;

  let previousDate = "";
  let noDate = 0;
  let outOfOrder = 0;
  for (const row of chain) {
    if (!row.date) {
      noDate += 1;
      continue;
    }
    if (previousDate && row.date < previousDate) outOfOrder += 1;
    previousDate = row.date;
  }

  const latest = chain.reduce((found, row) => (!row.excluded
    && row.balance !== null && row.balance !== undefined ? row : found), null);
  const printed = closing ?? null;
  return {
    insert: dedupe.insert,
    duplicates: dedupe.duplicates,
    corrected: updates.filter(Boolean).length,
    updates,
    merged: chain,
    breaks,
    noDate,
    outOfOrder,
    closing: printed === null ? null : {
      printed,
      actual: latest ? latest.balance : null,
      matches: latest !== null && Math.abs(printed - latest.balance) <= 1,
    },
    today,
  };
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
