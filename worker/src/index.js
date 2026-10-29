// OAuth broker. Holds the client secret so the browser never has to.
// It exchanges authorisation codes for tokens and hands back short-lived
// access tokens. It never sees portfolio data — Drive calls go browser→Google.

import {
  buildAuthUrl, clearCookie, cookie, corsHeaders, json, pkce, randomState,
  readCookie, seal, unseal, STATE_COOKIE, STATE_MAX_AGE, TOKEN_COOKIE, TOKEN_MAX_AGE,
} from "./lib.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      switch (url.pathname) {
        case "/":
          // A human can land here. Send them to the app instead of raw JSON.
          return new Response(null, {
            status: 302,
            headers: { location: env.APP_RETURN || "https://bankpipe.bankpipe.workers.dev/", "cache-control": "no-store" },
          });
        case "/health":
          return json({ ok: true, service: "bankpipe-auth" }, 200, cors);
        case "/oauth/start":
          return await start(request, env, url);
        case "/oauth/callback":
          return await callback(request, env, url);
        case "/token":
          return await token(request, env, cors);
        case "/disconnect":
          return await disconnect(request, env, cors);
        default:
          return json({ error: "not_found" }, 404, cors);
      }
    } catch (err) {
      return json({ error: "server_error", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

async function start(request, env, url) {
  const { verifier, challenge } = await pkce();
  const state = randomState();
  const sealed = await seal({ state, verifier }, env.COOKIE_KEY);
  const redirectUri = `${url.origin}/oauth/callback`;
  const target = buildAuthUrl({
    clientId: env.CLIENT_ID,
    redirectUri,
    state,
    challenge,
    loginHint: url.searchParams.get("login_hint") || undefined,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "set-cookie": cookie(STATE_COOKIE, sealed, STATE_MAX_AGE),
      "cache-control": "no-store",
    },
  });
}

async function callback(request, env, url) {
  const err = url.searchParams.get("error");
  if (err) return redirectBack(env, url, `error=${encodeURIComponent(err)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const sealed = readCookie(request.headers.get("cookie"), STATE_COOKIE);
  const saved = await unseal(sealed, env.COOKIE_KEY);

  if (!code || !state || !saved || saved.state !== state) {
    // The browser is waiting, not an API client. Send it back to the app with a
    // reason instead of a blank JSON page: the state cookie expires after ten
    // minutes, so a slow sign-in lands here, and raw JSON gives the user no way
    // to recover. Clear the stale cookie so the next attempt starts clean.
    const res = redirectBack(env, url, "error=state_mismatch");
    res.headers.append("set-cookie", clearCookie(STATE_COOKIE));
    return res;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      redirect_uri: `${url.origin}/oauth/callback`,
      grant_type: "authorization_code",
      code_verifier: saved.verifier,
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    return json({ error: "exchange_failed", detail: body }, 502);
  }

  const sealedToken = await seal({ refresh_token: body.refresh_token }, env.COOKIE_KEY);
  const headers = new Headers({
    location: redirectBackUrl(env, "connected=1"),
    "cache-control": "no-store",
  });
  headers.append("set-cookie", cookie(TOKEN_COOKIE, sealedToken, TOKEN_MAX_AGE));
  headers.append("set-cookie", clearCookie(STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function token(request, env, cors) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  const sealed = readCookie(request.headers.get("cookie"), TOKEN_COOKIE);
  const saved = await unseal(sealed, env.COOKIE_KEY);
  if (!saved || !saved.refresh_token) return json({ error: "not_connected" }, 401, cors);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: saved.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.access_token) {
    // The grant is gone: tell the client to reconnect rather than loop forever.
    const headers = new Headers(cors);
    headers.append("set-cookie", clearCookie(TOKEN_COOKIE));
    return json({ error: "reconnect_required", detail: body }, 401, Object.fromEntries(headers));
  }

  return json(
    { access_token: body.access_token, expires_in: body.expires_in, scope: body.scope },
    200,
    cors,
  );
}

async function disconnect(request, env, cors) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  const sealed = readCookie(request.headers.get("cookie"), TOKEN_COOKIE);
  const saved = await unseal(sealed, env.COOKIE_KEY);
  if (saved && saved.refresh_token) {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: saved.refresh_token }),
    }).catch(() => {});
  }

  const headers = { ...cors, "set-cookie": clearCookie(TOKEN_COOKIE) };
  return json({ ok: true }, 200, headers);
}

function redirectBackUrl(env, query) {
  const base = env.APP_RETURN || "/";
  const u = new URL(base);
  for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
  return u.toString();
}

const redirectBack = (env, url, query) =>
  new Response(null, { status: 302, headers: { location: redirectBackUrl(env, query) } });
