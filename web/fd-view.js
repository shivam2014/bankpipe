// The "Only FDs" view keeps each deposit under the bank account that funded
// it. The caller passes accounts already in display order, so this module owns
// the grouping and the totals but never reads the page's sort state.
// orderAccountsByFdTotal is the one exception: the FD-only view asks for that
// order explicitly, and the Everything view keeps using the sort bar's.

import { assetMetrics } from "./finance.js";

const isoDay = (v) => v instanceof Date
  ? v.toISOString().slice(0, 10)
  : String(v || "").slice(0, 10);

const asOfDate = (today) => {
  const d = new Date(`${isoDay(today) || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return isNaN(d.getTime()) ? new Date() : d;
};

// A deposit is history once its maturity date is behind us, even though the
// money was real; the active total must not count it.
export function fdMatured(fd, today) {
  const maturity = isoDay(fd?.maturity_date);
  return !!(maturity && maturity < (isoDay(today) || new Date().toISOString().slice(0, 10)));
}

// A matured FD has no current value, so the page shows what it was worth at
// maturity instead of a dash. Same fallback as the account page and demo view.
export function fdHistoryValue(fd, today) {
  const m = assetMetrics(fd, "fd", asOfDate(today));
  return m.expectedAtMaturity ?? m.value ?? m.invested ?? null;
}

// The last four digits are enough to tell two accounts at one bank apart
// without printing the full number on a page someone may share.
export function fdAccountTail(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "";
}

const byMaturity = (a, b) => String(a.maturity_date || "9999")
  .localeCompare(String(b.maturity_date || "9999"));

const rowOf = (fd, matured, asOf) => ({
  fd,
  matured,
  paise: matured ? fdHistoryValue(fd, asOf) : assetMetrics(fd, "fd", asOf).value,
});

const totalOf = (rows, key) =>
  rows.reduce((total, r) => total + (r[key] ?? 0), 0);

const linkOf = (fd, links) =>
  links instanceof Map ? links.get(fd.id) : links?.[fd.id];

const accountLabel = (acc) => String(acc.label || acc.number || acc.id);

// The FD-only view puts the account with the biggest active deposit book
// first: the bar's Balance sort counts savings plus FDs, which is not the same
// question. Matured deposits are history and never move an account up.
export function orderAccountsByFdTotal(accounts, fds, links, today) {
  const asOf = asOfDate(today);
  const todayIso = asOf.toISOString().slice(0, 10);
  const list = (accounts || []).filter((acc) => acc && acc.id);
  const totals = new Map(list.map((acc) => [acc.id, { paise: 0, count: 0 }]));
  for (const fd of (fds || [])) {
    if (!fd || fdMatured(fd, todayIso)) continue;
    const linked = linkOf(fd, links);
    const slot = linked ? totals.get(linked) : null;
    // A link to an account outside this list is not in the FD-only view.
    if (!slot) continue;
    slot.paise += assetMetrics(fd, "fd", asOf).value ?? 0;
    slot.count += 1;
  }
  return list.slice().sort((a, b) => {
    const ta = totals.get(a.id);
    const tb = totals.get(b.id);
    // An account with deposits outranks one without, even if the deposits have
    // no value recorded yet.
    if (!!ta.count !== !!tb.count) return ta.count ? -1 : 1;
    return (tb.paise - ta.paise) || accountLabel(a).localeCompare(accountLabel(b));
  });
}

export function buildFdGroups({ accounts, fds, links, today } = {}) {
  const asOf = asOfDate(today);
  const todayIso = asOf.toISOString().slice(0, 10);
  const accountList = (accounts || []).filter((acc) => acc && acc.id);
  const byAccount = new Map(accountList.map((acc) => [acc.id, []]));
  const unlinked = [];
  const matured = [];
  for (const fd of (fds || [])) {
    if (!fd) continue;
    if (fdMatured(fd, todayIso)) { matured.push(fd); continue; }
    const linked = linkOf(fd, links);
    // A link to an account that no longer exists is not a group: the deposit
    // stays visible under "without a linked account".
    if (linked && byAccount.has(linked)) byAccount.get(linked).push(fd);
    else unlinked.push(fd);
  }

  const groups = [];
  for (const acc of accountList) {
    const list = byAccount.get(acc.id) || [];
    if (!list.length) continue;
    list.sort(byMaturity);
    const rows = list.map((fd) => rowOf(fd, false, asOf));
    groups.push({
      key: `account:${acc.id}`,
      kind: "account",
      id: acc.id,
      title: acc.label || acc.number || acc.bank || acc.id,
      subtitle: [acc.bank, fdAccountTail(acc.number)].filter(Boolean).join(" · "),
      totalPaise: totalOf(rows, "paise"),
      rows,
    });
  }

  if (unlinked.length) {
    unlinked.sort(byMaturity);
    const rows = unlinked.map((fd) => rowOf(fd, false, asOf));
    groups.push({
      key: "unlinked",
      kind: "unlinked",
      title: "FDs without a linked account",
      subtitle: "No matching debit in the accounts above",
      totalPaise: totalOf(rows, "paise"),
      rows,
    });
  }

  if (matured.length) {
    matured.sort((a, b) => String(b.maturity_date || "").localeCompare(String(a.maturity_date || "")));
    const rows = matured.map((fd) => rowOf(fd, true, asOf));
    groups.push({
      key: "matured",
      kind: "matured",
      title: "Matured FDs",
      subtitle: "History · not in the FD total",
      totalPaise: totalOf(rows, "paise"),
      rows,
    });
  }

  return groups;
}
