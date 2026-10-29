// Advanced-mode Pages worker.
//
// Serves the static app for normal paths and delegates the OAuth broker routes
// to the same handler used by the standalone Worker. Running the broker on the
// same origin as the app makes the refresh-token cookie first-party, which is
// the point: no CORS, no SameSite=None, nothing for Safari to block.
//
// Two deployment facts this file encodes:
//   - The market-price route needs a server that can reach BSE. A static host
//     has none, and the SPA fallback would answer it with index.html, so the
//     app's fetch would succeed and then fail to parse. Answer with JSON 501
//     instead, so the failure is legible.
//   - Pages sets no security headers. Add the ones that cannot break inline
//     handlers. Deliberately no Content-Security-Policy: the app relies on
//     inline onclick and one inline module script.

import broker from "./broker/index.js";

const API = new Set(["/token", "/disconnect", "/health"]);
const isBroker = (p) => API.has(p) || p.startsWith("/oauth/");
const isMarket = (p) => p.startsWith("/__market/");

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (isBroker(pathname)) return broker.fetch(request, env);

    if (isMarket(pathname)) {
      return json({
        error: "market_data_unavailable",
        detail: "This host serves the app as static files, so it cannot reach an exchange feed. "
          + "Enter prices manually, or run the desktop build which has a local server.",
      }, 501);
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
