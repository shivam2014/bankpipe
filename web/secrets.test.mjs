import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyVault, sealVault, openVault, safeUrl, upsertEntry, removeEntry,
} from "./secrets.js";

const entries = [
  { id: "a", bank: "HDFC Bank", url: "https://netbanking.hdfc.com",
    username: "dad_hdfc", password: "hunter2-not-real", notes: "" },
  { id: "b", bank: "ICICI", url: "https://icicibank.com",
    username: "dad_icici", password: "another-secret", notes: "customer id" },
];

test("a vault round-trips entries", async () => {
  const vault = { v: 1, entries };
  const blob = await sealVault(vault, "correct horse battery");
  const opened = await openVault(blob, "correct horse battery");
  assert.deepEqual(opened.entries, entries);
});

test("the ciphertext contains no bank name, username or password", async () => {
  const blob = await sealVault({ v: 1, entries }, "correct horse battery");
  const text = Buffer.from(blob).toString("latin1");
  for (const secret of ["HDFC", "dad_hdfc", "hunter2-not-real", "another-secret"]) {
    assert.equal(text.includes(secret), false, `leaked: ${secret}`);
  }
});

test("the wrong passphrase does not open the vault", async () => {
  const blob = await sealVault({ v: 1, entries }, "correct horse battery");
  await assert.rejects(() => openVault(blob, "wrong passphrase"), /passphrase|decrypt|operation/i);
});

test("a short passphrase is refused at seal time", async () => {
  await assert.rejects(() => sealVault(emptyVault(), "short"), /at least 8/);
});

test("only http and https URLs become links", () => {
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeUrl("http://example.com"), "http://example.com/");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("not a url"), "");
});

test("entries can be added, edited and removed", () => {
  let v = upsertEntry(emptyVault(), { bank: "SBI", username: "a", password: "b" });
  assert.equal(v.entries.length, 1);
  const id = v.entries[0].id;
  v = upsertEntry(v, { ...v.entries[0], password: "c" });
  assert.equal(v.entries.length, 1);
  assert.equal(v.entries[0].password, "c");
  v = removeEntry(v, id);
  assert.equal(v.entries.length, 0);
});
