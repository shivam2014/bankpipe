// First-run onboarding: a short welcome, then one question.
//
// The welcome is skippable and re-openable from the "?" button, so a returning
// user is never trapped and a new one gets context before a decision.
//
//   mode "local" — nothing leaves the browser
//   mode "drive" — backups go to their own Google Drive
//
// Kept separate from index.html so the app's boot path stays untouched.

const MODE_KEY = "bankpipe.mode";
const WELCOME_KEY = "bankpipe.welcome.seen";
const PROBE = "/token";

export const MODE = { DRIVE: "drive", LOCAL: "local" };

export function currentMode(storage = localStorage) {
  const v = storage.getItem(MODE_KEY);
  return v === MODE.DRIVE || v === MODE.LOCAL ? v : null;
}

export function setMode(mode, storage = localStorage) {
  storage.setItem(MODE_KEY, mode);
}

export function welcomeSeen(storage = localStorage) {
  return storage.getItem(WELCOME_KEY) === "1";
}

export function markWelcomeSeen(storage = localStorage) {
  storage.setItem(WELCOME_KEY, "1");
}

export async function isConnected(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PROBE, { method: "POST", credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function decide({ storage = localStorage, fetchImpl = fetch, params = new URLSearchParams(location.search) } = {}) {
  // ?reset=1 forgets the answers, so the whole first run plays again.
  if (params.get("reset") === "1") {
    storage.removeItem?.(MODE_KEY);
    storage.removeItem?.(WELCOME_KEY);
    return { show: true, mode: null, reason: "first-run" };
  }
  // ?demo=1 opens the sample portfolio with no questions and no storage choice.
  if (params.get("demo") === "1") {
    setMode(MODE.LOCAL, storage);
    return { show: false, mode: MODE.LOCAL, demo: true };
  }
  if (params.get("connected") === "1") {
    setMode(MODE.DRIVE, storage);
    return { show: false, mode: MODE.DRIVE };
  }
  const mode = currentMode(storage);
  if (mode === MODE.LOCAL) return { show: false, mode };
  if (mode === MODE.DRIVE) {
    const ok = await isConnected(fetchImpl);
    return ok ? { show: false, mode } : { show: true, mode, reason: "reconnect" };
  }
  return { show: true, mode: null, reason: "first-run" };
}

const CSS = `
.bp-onboard { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center;
  background: rgba(12,14,18,.55); backdrop-filter: blur(2px); padding: 20px;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.bp-onboard-card { width: min(460px, 100%); max-height: 88vh; overflow: auto; background: #fff; color: #16181d;
  border-radius: 14px; padding: 26px; box-shadow: 0 18px 50px rgba(0,0,0,.28); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .bp-onboard-card { background: #16181d; color: #e8eaee; } }
:root[data-theme="dark"] .bp-onboard-card { background: #16181d; color: #e8eaee; }
:root[data-theme="light"] .bp-onboard-card { background: #fff; color: #16181d; }
.bp-onboard h2 { margin: 0 0 6px; font-size: 1.2rem; text-transform: none; letter-spacing: -0.01em; }
.bp-onboard p { margin: 0 0 14px; opacity: .78; }
.bp-onboard ul { margin: 0 0 18px; padding-left: 18px; }
.bp-onboard li { margin: 0 0 8px; opacity: .85; }
.bp-onboard button { display: block; width: 100%; padding: 11px 14px; margin: 8px 0;
  border-radius: 9px; border: 1px solid rgba(128,128,128,.35); background: transparent;
  color: inherit; font: inherit; cursor: pointer; text-align: left; }
.bp-onboard button.primary { background: #1a6b4f; border-color: #1a6b4f; color: #fff; font-weight: 600; }
.bp-onboard button.ghost { border-color: transparent; opacity: .7; text-align: center; }
.bp-onboard small { display: block; opacity: .6; margin-top: 12px; }
.bp-note { padding: 9px 12px; border-radius: 8px; background: rgba(26,107,79,.12);
  color: #1a6b4f; font-size: 0.92rem; margin: 0 0 12px; }
@media (prefers-color-scheme: dark) { .bp-note { color: #6fd3a8; } }
.bp-help { position: fixed; right: 14px; bottom: calc(64px + env(safe-area-inset-bottom, 0px));
  z-index: 9998; width: 34px; height: 34px; border-radius: 50%;
  border: 1px solid rgba(128,128,128,.35); background: #fff; color: #16181d;
  font: 600 15px/1 -apple-system, sans-serif; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.15);
  transition: opacity .18s ease; }
.bp-onboard-card { position: relative; }
.bp-onboard .bp-close { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px;
  padding: 0; margin: 0; border-radius: 8px; border: 0; background: transparent;
  color: inherit; font: 400 18px/1 -apple-system, sans-serif; cursor: pointer; opacity: .6;
  text-align: center; display: grid; place-items: center; }
.bp-onboard .bp-close:hover { opacity: 1; background: rgba(128,128,128,.14); }
.bp-help.is-idle { opacity: 0; pointer-events: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .bp-help { background: #16181d; color: #e8eaee; } }
:root[data-theme="dark"] .bp-help { background: #16181d; color: #e8eaee; }
:root[data-theme="light"] .bp-help { background: #fff; color: #16181d; }
`;

const WELCOME = `
  <h2>Welcome to BankPipe</h2>
  <p>Your personal portfolio manager: bank accounts, bonds, fixed deposits and cash flow in one ledger. Built by a user, for a user.</p>
  <ul>
    <li><b>Import without uploading.</b> Statements are read in your browser. Nothing is sent to a server.</li>
    <li><b>One number that adds up.</b> Net worth, holdings and upcoming maturities, all from the same ledger.</li>
    <li><b>Back up to your own Drive.</b> Optional, encrypted on your device before it leaves.</li>
  </ul>`;

function welcomeBody({ withClose }) {
  return `${WELCOME}
    ${withClose
      ? '<button class="primary" data-action="close">Close</button>'
      : `<button class="primary" data-action="continue">Get started</button>
         <small>The app opens on sample numbers until you import your own.</small>`}`;
}

function chooseBody(reason, note = "") {
  return `
    <h2>${reason === "reconnect" ? "Reconnect Google Drive" : "Where should this device keep your data?"}</h2>
    ${note ? `<p class="bp-note">${note}</p>` : ""}
    <p>${reason === "reconnect"
      ? "The connection expired. Sign in once to resume backups."
      : "You can change this later. Nothing is uploaded unless you connect Drive."}</p>
    <button class="primary" data-action="drive">Connect Google Drive</button>
    <button data-action="local">Use this device only</button>
    <button data-action="import">I have a backup file from another device</button>
    <button class="ghost" data-action="close">Decide later</button>
    <small>Drive backups are encrypted on this device before upload. The app can only see files it created.</small>`;
}

let onPick = () => {};

function mount(html) {
  document.getElementById("bp-help")?.classList.add("is-idle");
  let box = document.getElementById("bp-onboard");
  if (!box) {
    ensureStyle();
    box = document.createElement("div");
    box.id = "bp-onboard";
    box.className = "bp-onboard";
    document.body.appendChild(box);
  }
  box.innerHTML = `<div class="bp-onboard-card" role="dialog" aria-modal="true">
    <button class="bp-close" data-action="close" aria-label="Close">×</button>${html}</div>`;
}

function close() {
  document.getElementById("bp-onboard")?.remove();
  document.getElementById("bp-help")?.classList.remove("is-idle");
}

function ensureStyle() {
  if (document.getElementById("bp-onboard-style")) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  style.id = "bp-onboard-style";
  document.head.appendChild(style);
}

export function helpButton(onOpen) {
  if (document.getElementById("bp-help")) return;
  ensureStyle();
  const b = document.createElement("button");
  b.id = "bp-help";
  b.className = "bp-help";
  b.type = "button";
  b.setAttribute("aria-label", "Help and getting started");
  b.textContent = "?";
  b.onclick = onOpen;
  document.body.appendChild(b);

  // A29: never sit on top of the table the user is reading. Fade out while
  // scrolling, come back when they stop.
  let idleTimer = 0;
  addEventListener("scroll", () => {
    b.classList.add("is-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => b.classList.remove("is-idle"), 700);
  }, { passive: true });
}

function wire() {
  const box = document.getElementById("bp-onboard");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) { onPick(el.dataset.action); return; }
    // Clicking the dark area outside the card dismisses it.
    if (e.target === box) onPick("close");
  });
  if (!window.bpOnboardEsc) {
    window.bpOnboardEsc = (e) => {
      if (e.key !== "Escape") return;
      if (!document.getElementById("bp-onboard")) return;
      onPick("close");
    };
    addEventListener("keydown", window.bpOnboardEsc);
  }
}

export async function boot(options = {}) {
  const storage = options.storage || localStorage;
  const params = options.params || new URLSearchParams(location.search);

  // The broker sends the browser back with a reason when signing in failed.
  // Leave the URL clean, park the reason for the backup page, and go there:
  // a bare ?error= would otherwise die on the home screen with no explanation.
  const connectError = params.get("error");
  if (connectError) {
    try { sessionStorage.setItem("bankpipe.connectError", connectError); } catch {}
    try {
      const url = new URL(location.href);
      url.searchParams.delete("error");
      history.replaceState({}, "", url.pathname + url.hash);
    } catch {}
    location.replace("/backup");
    return { show: false, mode: currentMode(storage), navigating: true, error: connectError };
  }

  const state = await decide({ ...options, storage, params });

  // One-shot parameters must leave the URL. Otherwise a reload repeats them:
  // ?reset=1 kept clearing the answers the import had just written, which made
  // "I have a backup file" loop back to the welcome screen.
  if (params.has("reset") || params.has("connected")) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("reset");
      url.searchParams.delete("connected");
      history.replaceState({}, "", url.pathname + url.search + url.hash);
    } catch {}
  }

  // A hidden picker, reused by the "I have a backup file" choice. The app's own
  // importer confirms, decrypts with the existing passphrase, and reloads.
  if (!document.getElementById("bp-import")) {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "bp-import";
    input.accept = ".bpk,.db,.bin";
    input.style.display = "none";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { importSealedDb } = await import("./db.js");
        await importSealedDb(bytes);
      } catch (err) {
        const msg = String((err && err.message) || err);
        mount(chooseBody(state.reason, `Could not import that file: ${msg}`));
        wire();
        return;
      }
      // The imported database is sealed. Stand down so the app's own unlock
      // screen can ask for the database passphrase instead of sitting behind
      // this overlay. Storage can be chosen later from the backup page.
      markWelcomeSeen(storage);
      setMode(MODE.LOCAL, storage);
      // The app defaults to "demo" when this is unset, which is why importing
      // a database still showed the sample portfolio afterwards.
      storage.setItem("bp.mode", "real");
      location.reload();
    };
    document.body.appendChild(input);
  }

  const showChoose = (reason, note = "") => {
    onPick = (action) => {
      if (action === "close") { close(); return; }
      if (action === "drive") {
        setMode(MODE.DRIVE, storage);
        location.assign("/oauth/start");
        return;
      }
      if (action === "local") {
        setMode(MODE.LOCAL, storage);
        close();
        return;
      }
      if (action === "import") {
        const input = document.getElementById("bp-import");
        if (input) input.click();
      }
    };
    mount(chooseBody(reason, note));
    wire();
  };

  const showWelcome = (withClose) => {
    onPick = (action) => {
      if (action === "close") return close();
      if (action === "sample") {
        setMode(MODE.LOCAL, storage);
        return location.assign("/?demo=1");
      }
      if (action === "continue") {
        markWelcomeSeen(storage);
        showChoose(state.reason);
      }
    };
    mount(welcomeBody({ withClose }));
    wire();
  };

  if (params.get("connected") === "1") {
    // The callback already proved the grant. Leave a note for the backup page so
    // the user sees a confirmation instead of a silent jump to a form.
    try { sessionStorage.setItem("bankpipe.justConnected", "1"); } catch {}
    const { probeVault, vaultDestination } = await import("./restore.js");
    const result = await (options.probe || probeVault)();
    location.replace(vaultDestination(result));
    return { show: false, mode: MODE.DRIVE, navigating: true };
  }

  helpButton(() => showWelcome(true));

  if (!state.show) return state;

  if (welcomeSeen(storage)) showChoose(state.reason);
  else showWelcome(false);
  return state;
}

if (typeof window !== "undefined") boot();
