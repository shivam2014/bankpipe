// Bank login vault. The entries are encrypted with the user's passphrase
// before they touch storage, so the database (and every backup of it) only
// ever holds ciphertext. The passphrase is never stored, never logged and
// never sent anywhere.
//
// This is deliberately separate from the backup key envelope: losing the
// backup passphrase and losing the login passphrase are different failures.

import { encryptWithPassphrase, decryptWithPassphrase } from "./crypto.js";

export const VAULT_SETTING = "credentials.v1";
export const VAULT_VERSION = 1;

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

export function emptyVault() {
  return { v: VAULT_VERSION, entries: [] };
}

export async function sealVault(vault, passphrase) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error("the vault passphrase must be at least 8 characters");
  }
  const payload = { v: VAULT_VERSION, entries: (vault && vault.entries) || [] };
  return encryptWithPassphrase(enc(JSON.stringify(payload)), passphrase);
}

export async function openVault(blob, passphrase) {
  const plain = await decryptWithPassphrase(blob, passphrase);
  let data;
  try { data = JSON.parse(dec(plain)); } catch { throw new Error("the vault is not readable"); }
  if (!data || data.v !== VAULT_VERSION || !Array.isArray(data.entries)) {
    throw new Error("this is not a BankPipe login vault");
  }
  return { v: VAULT_VERSION, entries: data.entries };
}

// URLs are opened by the browser, so only two schemes are allowed. Anything
// else (javascript:, data:, file:) is shown as text and never linked.
export function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.href : "";
  } catch {
    return "";
  }
}

export function upsertEntry(vault, entry) {
  const list = (vault && vault.entries) || [];
  const id = entry.id || `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const next = { ...entry, id };
  const i = list.findIndex((e) => e.id === id);
  const entries = i >= 0
    ? list.map((e) => (e.id === id ? next : e))
    : [...list, next];
  return { v: VAULT_VERSION, entries };
}

export function removeEntry(vault, id) {
  return { v: VAULT_VERSION, entries: ((vault && vault.entries) || []).filter((e) => e.id !== id) };
}
