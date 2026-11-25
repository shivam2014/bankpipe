// The hard reload: the strongest reset a page is allowed to do.
//
// A browser reload can keep three stale things: a service worker, the app shell
// cache and the document itself. This drops all three and navigates with a
// one-off query so the document is fetched again. It never opens IndexedDB and
// never writes localStorage, so the encrypted database, snapshots, settings and
// session are not part of the reset.
//
// The browser calls arrive as capabilities, so the whole sequence runs in a
// test with no browser and no network.

export const SHELL_CACHE_PREFIX = "bankpipe-shell-";
export const RELOAD_PARAM = "bp_reload";
export const OFFLINE_MESSAGE = "Can't reach the server. Nothing was changed.";
export const FAILED_MESSAGE = "Reload did not start. Your data was not changed.";

/** The current URL plus one cache-busting query, keeping path, query and hash. */
export function cacheBustedUrl(href, token = Date.now()) {
  const url = new URL(href);
  url.searchParams.set(RELOAD_PARAM, String(token));
  return url.toString();
}

/**
 * 1. Ask the network whether it is there. Offline, change nothing: deleting the
 *    shell would turn a working offline app into a browser error page.
 * 2. Unregister every worker for this origin.
 * 3. Delete every `bankpipe-shell-*` cache.
 * 4. Navigate to the cache-busted URL.
 *
 * Steps 2 and 3 are best-effort. A worker or cache that refuses to go must not
 * stop the document from being refetched. Step 4 is the only failure that
 * matters, and it is reported rather than thrown.
 */
export async function hardReload({
  href,
  online = async () => true,
  registrations = async () => [],
  unregister = async () => {},
  cacheNames = async () => [],
  deleteCache = async () => {},
  navigate = async () => {},
  now = () => Date.now(),
} = {}) {
  if (typeof href !== "string" || !href) {
    return { ok: false, reason: "no-url", unregistered: 0, deletedCaches: 0 };
  }

  let reachable = false;
  try { reachable = !!(await online()); } catch { reachable = false; }
  if (!reachable) {
    return { ok: false, reason: "offline", unregistered: 0, deletedCaches: 0 };
  }

  let workers = [];
  try { workers = (await registrations()) || []; } catch { workers = []; }
  const workerResults = await Promise.allSettled(workers.map((worker) => unregister(worker)));
  const unregistered = workerResults.filter((result) => result.status === "fulfilled").length;

  let names = [];
  try { names = (await cacheNames()) || []; } catch { names = []; }
  const shell = names.filter((name) => String(name).startsWith(SHELL_CACHE_PREFIX));
  const cacheResults = await Promise.allSettled(shell.map((name) => deleteCache(name)));
  const deletedCaches = cacheResults.filter((result) => result.status === "fulfilled").length;

  const url = cacheBustedUrl(href, now());
  try {
    await navigate(url);
  } catch {
    return { ok: false, reason: "navigate", unregistered, deletedCaches };
  }
  return { ok: true, unregistered, deletedCaches, url };
}

/** The one line the control shows when the reload could not start. */
export function reloadMessage(result) {
  return result && result.reason === "offline" ? OFFLINE_MESSAGE : FAILED_MESSAGE;
}
