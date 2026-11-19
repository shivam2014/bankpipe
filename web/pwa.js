// Install, and the one storage fact that survives a cache clear.
//
// The page decides when to show this; the module holds the copy, the state and
// the browser calls, so every branch can be tested without a browser.
//
// The blunt part is not decoration. Installing gives the app its own window and
// asks the browser to keep the database, but a manual "clear site data" deletes
// IndexedDB on every platform. A backup file is the only copy that survives it.

export const INSTALL_LABEL = "Install BankPipe";
export const IOS_HINT = "Share → Add to Home Screen";
export const INSTALLED_LINE = "Installed on this device.";
export const STORAGE_PROTECTED = "Storage: protected";
export const STORAGE_CLEARABLE = "Storage: can be cleared by the browser";
export const BACKUP_TRUTH =
  "Clearing site data still deletes everything. A backup is the only copy that survives.";

/** iPadOS 13 reports a Macintosh user agent; the touch count is the tell. */
export function isIOS(userAgent = "", maxTouchPoints = 0) {
  const ua = String(userAgent || "");
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && Number(maxTouchPoints) > 1);
}

/**
 * What this device can offer:
 *   installed  already running from the home screen
 *   prompt     the browser handed us a real install prompt
 *   ios        no prompt exists; the share sheet is the only route
 *   none       a desktop browser with nothing to offer
 */
export function installState({
  standalone = false, prompt = false, userAgent = "", maxTouchPoints = 0,
} = {}) {
  if (standalone) return "installed";
  if (prompt) return "prompt";
  if (isIOS(userAgent, maxTouchPoints)) return "ios";
  return "none";
}

export function storageLabel(persisted) {
  return persisted ? STORAGE_PROTECTED : STORAGE_CLEARABLE;
}

/**
 * Ask the browser to keep this origin's storage, at most once per device.
 *
 * `persisted()` is a read, not a request: it can turn true later, because
 * installing the app grants persistence. So it is checked on every call, and
 * `persist()` is the only thing that is spent once. A browser that does not
 * implement the API is reported as clearable rather than as an error.
 */
export async function ensurePersistence({ storage, asked = false } = {}) {
  const api = storage || (typeof navigator === "undefined" ? null : navigator.storage);
  if (!api || typeof api.persisted !== "function") {
    return { persisted: false, asked: true, supported: false };
  }

  let persisted = false;
  try {
    persisted = await api.persisted();
  } catch { /* a denied read is the same as unprotected */ }
  if (persisted || asked) return { persisted, asked: true, supported: true };

  let granted = false;
  try {
    granted = typeof api.persist === "function" ? !!(await api.persist()) : false;
  } catch { /* a refused request is the same as unprotected */ }
  return { persisted: granted, asked: true, supported: true };
}

/**
 * The install card on Settings. The storage line is filled in later by the
 * page, because the permission is asynchronous.
 */
export function pwaCard({ state = "none", backupHref = "backup.html" } = {}) {
  const installed = state === "installed";
  const title = installed ? "App and storage" : "Install BankPipe";
  const pitch = installed
    ? ""
    : `<p class="pwa-hint">A home-screen app opens without the browser around it, and the
    browser keeps its local data longer.</p>`;
  let action = "";
  if (state === "prompt") {
    action = `<button class="btn pwa-install" onclick="bpInstall()">${INSTALL_LABEL}</button>`;
  } else if (state === "ios") {
    action = `<p class="pwa-hint">${IOS_HINT}</p>`;
  } else if (state === "installed") {
    action = `<p class="pwa-hint">${INSTALLED_LINE}</p>`;
  }

  return `<div class="card pad pwa-card">
    <h2 class="pwa-title">${title}</h2>
    ${pitch}
    ${action}
    <div class="pwa-storage" id="storage-state" data-protected="">Storage: checking…</div>
    <p class="pwa-backup">${BACKUP_TRUTH}</p>
    <a class="btn pwa-backup-link" href="${backupHref}">Open backup</a>
  </div>`;
}
