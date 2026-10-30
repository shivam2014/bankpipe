import test from "node:test";
import assert from "node:assert/strict";
import { buildFdGroups, fdMatured, fdHistoryValue, orderAccountsByFdTotal } from "./fd-view.js";

const TODAY = "2026-10-30";
const account = (id, label, extra = {}) =>
  ({ id, label, category: "bank", facts: 0, ...extra });
const fd = (id, valuePaise, extra = {}) =>
  ({ id, label: `FD ${id}`, category: "fd", value_paise: valuePaise, ...extra });

test("linked FDs are grouped under their own account", () => {
  const accounts = [account("a1", "HDFC savings"), account("a2", "SBI savings")];
  const groups = buildFdGroups({
    accounts,
    fds: [fd("f1", 100000, { maturity_date: "2027-01-01" }),
      fd("f2", 250000, { maturity_date: "2027-06-01" })],
    links: new Map([["f1", "a1"], ["f2", "a2"]]),
    today: TODAY,
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "account");
  assert.equal(groups[0].id, "a1");
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[0].rows[0].fd.id, "f1");
  assert.equal(groups[0].rows[0].paise, 100000);
  assert.equal(groups[1].rows[0].fd.id, "f2");
  assert.equal(groups[1].totalPaise, 250000);
});

test("group order follows the account order passed in", () => {
  const accounts = [account("b", "Beta", { facts: 4 }), account("a", "Alpha")];
  const groups = buildFdGroups({
    accounts,
    fds: [fd("f1", 100, { maturity_date: "2027-01-01" }),
      fd("f2", 200, { maturity_date: "2027-01-01" })],
    links: { f1: "a", f2: "b" },
    today: TODAY,
  });
  assert.deepEqual(groups.map((g) => g.id), ["b", "a"]);
});

test("subtotals add the deposits in each group", () => {
  const accounts = [account("a1", "HDFC savings")];
  const groups = buildFdGroups({
    accounts,
    fds: [fd("f1", 125000, { maturity_date: "2027-01-01" }),
      fd("f2", 375000, { maturity_date: "2028-01-01" })],
    links: new Map([["f1", "a1"], ["f2", "a1"]]),
    today: TODAY,
  });
  assert.equal(groups[0].totalPaise, 500000);
  assert.deepEqual(groups[0].rows.map((r) => r.fd.id), ["f1", "f2"]);
});

test("an FD with no link lands in the unlinked group", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "HDFC savings")],
    fds: [fd("f1", 100000, { maturity_date: "2027-01-01" })],
    links: new Map([["f1", ""]]),
    today: TODAY,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "unlinked");
  assert.equal(groups[0].title, "FDs without a linked account");
  assert.equal(groups[0].totalPaise, 100000);
});

test("a link to a missing account is unlinked, not dropped", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "HDFC savings")],
    fds: [fd("f1", 70000, { maturity_date: "2027-01-01" })],
    links: new Map([["f1", "deleted-account"]]),
    today: TODAY,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "unlinked");
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[0].rows[0].fd.id, "f1");
});

test("matured FDs leave the active total but stay in their own group", () => {
  const accounts = [account("a1", "HDFC savings")];
  const groups = buildFdGroups({
    accounts,
    fds: [fd("live", 100000, { maturity_date: "2027-01-01" }),
      fd("done", 40000, { maturity_date: "2025-01-01" })],
    links: new Map([["live", "a1"], ["done", "a1"]]),
    today: TODAY,
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "account");
  assert.equal(groups[0].totalPaise, 100000);
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[1].kind, "matured");
  assert.equal(groups[1].rows[0].fd.id, "done");
  assert.equal(groups[1].rows[0].matured, true);
  assert.equal(groups[1].totalPaise, 40000);
  assert.equal(groups.reduce((t, g) => t + (g.kind === "matured" ? 0 : g.totalPaise), 0), 100000);
});

test("no FDs means no groups", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "HDFC savings")],
    fds: [],
    links: new Map(),
    today: TODAY,
  });
  assert.deepEqual(groups, []);
});

test("an account with no FDs does not get an empty group", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "Empty"), account("a2", "Has an FD")],
    fds: [fd("f1", 100, { maturity_date: "2027-01-01" })],
    links: new Map([["f1", "a2"]]),
    today: TODAY,
  });
  assert.deepEqual(groups.map((g) => g.id), ["a2"]);
});

test("rows within a group are sorted by maturity", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "HDFC savings")],
    fds: [fd("late", 100, { maturity_date: "2029-01-01" }),
      fd("none", 100), fd("soon", 100, { maturity_date: "2027-01-01" })],
    links: new Map([["late", "a1"], ["none", "a1"], ["soon", "a1"]]),
    today: TODAY,
  });
  assert.deepEqual(groups[0].rows.map((r) => r.fd.id), ["soon", "late", "none"]);
});

test("a matured FD reports its value at maturity, not a dash", () => {
  const done = { id: "done", category: "fd", principal_paise: 100000,
    rate_bps: 700, start_date: "2024-01-01", maturity_date: "2025-01-01" };
  assert.equal(fdMatured(done, TODAY), true);
  assert.ok(fdHistoryValue(done) > 100000);
  const groups = buildFdGroups({ accounts: [], fds: [done], links: new Map(), today: TODAY });
  assert.equal(groups[0].kind, "matured");
  assert.equal(groups[0].rows[0].paise, fdHistoryValue(done));
  assert.equal(groups[0].totalPaise, fdHistoryValue(done));
});

test("the account header carries the label, bank and masked number", () => {
  const groups = buildFdGroups({
    accounts: [account("a1", "Salary account", { bank: "HDFC Bank", number: "001234567890" })],
    fds: [fd("f1", 100, { maturity_date: "2027-01-01" })],
    links: new Map([["f1", "a1"]]),
    today: TODAY,
  });
  assert.equal(groups[0].title, "Salary account");
  assert.equal(groups[0].subtitle, "HDFC Bank · …7890");
});

test("the FD-only order puts the largest active subtotal first, ties by label", () => {
  const accounts = [account("small", "Alpha"), account("big", "Zeta"), account("tie", "Beta")];
  const fds = [fd("f1", 100000, { maturity_date: "2027-01-01" }),
    fd("f2", 900000, { maturity_date: "2027-01-01" }),
    fd("f3", 900000, { maturity_date: "2027-01-01" })];
  const ordered = orderAccountsByFdTotal(accounts, fds,
    new Map([["f1", "small"], ["f2", "big"], ["f3", "tie"]]), TODAY);
  assert.deepEqual(ordered.map((a) => a.id), ["tie", "big", "small"]);
  assert.deepEqual(accounts.map((a) => a.id), ["small", "big", "tie"]);
});

test("matured FDs do not count towards the FD-only order", () => {
  const accounts = [account("old", "Old"), account("live", "Live")];
  const fds = [fd("done", 900000, { maturity_date: "2025-01-01" }),
    fd("now", 100000, { maturity_date: "2027-01-01" })];
  const ordered = orderAccountsByFdTotal(accounts, fds,
    new Map([["done", "old"], ["now", "live"]]), TODAY);
  assert.deepEqual(ordered.map((a) => a.id), ["live", "old"]);
});

test("an account with no FDs sorts after the accounts that have them", () => {
  const accounts = [account("empty", "Aardvark"), account("has", "Zebra")];
  const ordered = orderAccountsByFdTotal(accounts,
    [fd("f1", 1, { maturity_date: "2027-01-01" })], { f1: "has" }, TODAY);
  assert.deepEqual(ordered.map((a) => a.id), ["has", "empty"]);
});
