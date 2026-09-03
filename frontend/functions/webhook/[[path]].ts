interface Env {
  BACKEND_URL?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function proxyHeaders(headers: Headers, response = false): Headers {
  const connectionHeaders = new Set(
    (headers.get("connection") || "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
  const forwarded = new Headers();

  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (
      lowerName === "host" ||
      lowerName === "content-length" ||
      lowerName === "set-cookie" ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      connectionHeaders.has(lowerName) ||
      (response && lowerName === "content-encoding")
    ) {
      continue;
    }
    forwarded.append(name, value);
  }

  return forwarded;
}

function setCookies(headers: Headers): string[] {
  const cookieHeaders = headers as Headers & {
    getAll?: (name: string) => string[];
    getSetCookie?: () => string[];
  };

  if (typeof cookieHeaders.getSetCookie === "function") return cookieHeaders.getSetCookie();
  if (typeof cookieHeaders.getAll === "function") return cookieHeaders.getAll("set-cookie");
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

export const onRequest = async ({ request, env }: PagesContext): Promise<Response> => {
  let backend = env.BACKEND_URL?.replace(/\/+$/, "");
  if (backend && !/^https?:\/\//i.test(backend)) backend = `https://${backend}`;
  if (!backend) {
    return Response.json({ ok: false, error: "BACKEND_URL not set on Pages" }, { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  const headers = proxyHeaders(request.headers);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", incomingUrl.host);
  // Cloudflare may decode an upstream response before exposing its body.
  headers.set("accept-encoding", "identity");

  const upstream = await fetch(`${backend}${incomingUrl.pathname}${incomingUrl.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  const responseHeaders = proxyHeaders(upstream.headers, true);
  for (const cookie of setCookies(upstream.headers)) responseHeaders.append("set-cookie", cookie);

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};
