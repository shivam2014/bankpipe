// The "Only FDs" view keeps each deposit under the bank account that funded
// it. The caller passes accounts already in display order, so this module owns
// the grouping and the totals but never reads the page's sort state.

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
    const linked = links instanceof Map ? links.get(fd.id) : links?.[fd.id];
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
