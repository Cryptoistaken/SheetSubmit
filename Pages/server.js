// Static file server for the built SPA with a same-origin API proxy. /api/* and
// /webhook/tg are reverse-proxied to the backend (BACKEND_URL env). This keeps the
// session cookie FIRST-PARTY: the SPA and API live on different Railway sites, and
// a cross-site HttpOnly cookie written by a fetch() is dropped under browser
// third-party cookie blocking — which broke login (approve in Telegram → reload →
// login page again).
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "dist");
const PORT = Number(process.env.PORT || 80);
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

// Backend origin the proxy forwards to. VITE_API_BASE is kept as a fallback so a
// stale value can't silently point the SPA cross-site again.
let BACKEND = (process.env.BACKEND_URL || process.env.VITE_API_BASE || "").replace(/\/+$/, "");
if (BACKEND && !/^https?:\/\//i.test(BACKEND)) BACKEND = "https://" + BACKEND;

// The SPA talks to the API through this origin, so the injected base is empty.
const CONFIG_JS = "window.APP_CONFIG=" + JSON.stringify({ apiBase: "" }) + ";\n";

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function proxyRequest(req, url) {
  if (!BACKEND) {
    return json(500, { ok: false, error: "BACKEND_URL not set on web service" });
  }
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", req.headers.get("host") || "");
  // Ask the backend for an uncompressed body. Bun's fetch decompresses the body
  // but leaves the upstream `content-encoding` header in place — forwarding that
  // mismatch makes clients fail (ZlibError / empty body). identity keeps the proxy
  // deterministic: plain body in, plain body out.
  headers.set("accept-encoding", "identity");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await fetch(BACKEND + url.pathname + url.search, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });
  const out = new Headers();
  // Hop-by-hop + framing headers must NOT be forwarded (they describe the
  // upstream connection, not ours) — forwarding Transfer-Encoding made Bun treat
  // the body as pre-chunked and the response came back empty.
  for (const [k, v] of res.headers) {
    const lk = k.toLowerCase();
    if (
      lk === "transfer-encoding" ||
      lk === "connection" ||
      lk === "keep-alive" ||
      lk === "upgrade" ||
      lk === "proxy-authenticate" ||
      lk === "proxy-authorization" ||
      lk === "te" ||
      lk === "trailer" ||
      lk === "content-length" ||
      lk === "content-encoding"
    ) {
      continue;
    }
    out.set(k, v);
  }
  // Preserve every Set-Cookie — the session cookie must reach the browser first-party.
  const cookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (cookies.length) {
    out.delete("set-cookie");
    for (const c of cookies) out.append("set-cookie", c);
  }
  // Buffer the upstream body and set an explicit Content-Length. Streaming a
  // chunked body through here made Railway's edge drop the payload for some
  // responses (empty body on 200) — buffering sidesteps that entirely.
  const buf = await res.arrayBuffer();
  out.set("content-length", String(buf.byteLength));
  return new Response(buf, { status: res.status, headers: out });
}

// POST /__redeploy — redeploy THIS service on Railway (used by redeploy.bat after
// pushing the image). Self-redeploys via RAILWAY_TOKEN (env var on the service) +
// Railway's own injected RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID — no IDs or
// URLs hardcoded anywhere.
async function handleRedeploy(req) {
  const token = process.env.RAILWAY_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!token || !serviceId || !environmentId) {
    return json(503, { ok: false, error: "RAILWAY_TOKEN / RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID not set" });
  }
  if (req.headers.get("authorization") !== "Bearer " + token) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      query:
        "mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }",
      variables: { serviceId, environmentId },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) return json(502, { ok: false, errors: body.errors });
  return json(200, { ok: body.data?.serviceInstanceRedeploy === true, data: body.data });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* keep as-is */
    }
    const clean = normalize(pathname).replace(/\\/g, "/").replace(/[\\/]+\.\.[\\/]/g, "/");
    if (req.method === "POST" && clean === "/__redeploy") {
      return handleRedeploy(req);
    }
    if (clean.startsWith("/api/") || clean === "/webhook/tg") {
      return proxyRequest(req, url);
    }
    if (clean === "/config.js") {
      return new Response(CONFIG_JS, { headers: { "Content-Type": "text/javascript" } });
    }
    let file = join(ROOT, clean);
    if (!file.startsWith(ROOT)) file = join(ROOT, "index.html");
    if (extname(file) === "") file = join(ROOT, "index.html"); // SPA fallback
    let body;
    try {
      body = readFileSync(file);
    } catch {
      try {
        body = readFileSync(join(ROOT, "index.html")); // unknown route → SPA
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }
    return new Response(body, {
      headers: { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" },
    });
  },
});

console.log("[static] serving " + ROOT + " on :" + PORT);