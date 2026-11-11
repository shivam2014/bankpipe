// Advanced-mode Pages worker.
//
// Serves the static app for normal paths and delegates the OAuth broker routes
// to the same handler used by the standalone Worker. Running the broker on the
// same origin as the app makes the refresh-token cookie first-party, which is
// the point: no CORS, no SameSite=None, nothing for Safari to block.
//
// Two deployment facts this file encodes:
//   - The market-price routes need a server that can reach BSE and SMEST. The
//     browser cannot read either (BSE wants a Referer, SMEST is cross-origin),
//     so this worker answers them from the same origin as the app.
//   - Pages sets no security headers. Add the ones that cannot break inline
//     handlers. Deliberately no Content-Security-Policy: the app relies on
//     inline onclick and one inline module script.

import broker from "./broker/index.js";
import { handleMarket } from "./market.js";

const API = new Set(["/token", "/disconnect", "/health"]);
const isBroker = (p) => API.has(p) || p.startsWith("/oauth/");
const isMarket = (p) => p.startsWith("/__market/");

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (isBroker(pathname)) return broker.fetch(request, env);

    if (isMarket(pathname)) return handleMarket(request);

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
