import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAuth } from "../lib/session";
import { rpc } from "../lib/do";
export const wa = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
wa.use("/fb/*", requireAuth);
wa.use("/wa/*", requireAuth);
const UA_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const extractPages = (html: string) => { const pages: { name: string; type: string }[] = []; const re = /"identity_type":"FB_ADDITIONAL_PROFILE"[^}]*?"full_name":"([^"]+)"[^}]*?"identity_type_string":"([^"]+)"/g; let m: RegExpExecArray | null; while ((m = re.exec(html))) pages.push({ name: m[1], type: m[2] }); return pages; };
const extractLinkedNumber = (html: string) => html.match(/"__typename":"XFBFXSettingsContactPoint"[^}]*?"navigation_row_subtitle":"([^"]+)"/)?.[1] ?? null;
const challenged = (html: string) => html.includes("checkpointSubmitButton") || html.includes("m_login_email") || /checkpoint|login_attempt|force_login/i.test(html.substring(0, 5000));
const waCacheKey = (uid: string, cuser: string) => `wa:${uid}:${cuser}`;
async function waCacheSet(env: Env, uid: string, cuser: string, v: unknown) { await rpc(env.INDEX, "global", "metaSet", { k: waCacheKey(uid, cuser), v }).catch(() => {}); }
async function waCacheDel(env: Env, uid: string, cuser: string) { await rpc(env.INDEX, "global", "metaDel", { k: waCacheKey(uid, cuser) }).catch(() => {}); }

wa.post("/fb/check", async (c) => { const body = await c.req.json<{ uids?: unknown[] }>().catch(() => ({}) as { uids?: unknown[] }); if (!Array.isArray(body.uids) || !body.uids.length) return c.json({ error: "No UIDs provided" }, 400); const r = await fetch("https://check.fb.tools/api/check/facebook", { method: "POST", headers: { accept: "application/x-ndjson", "content-type": "application/json" }, body: JSON.stringify({ inputData: body.uids.slice(0, 500).map(String), userLang: "en", checkFriends: false }) }); const text = await r.text(); const valid: string[] = [], dead: string[] = []; for (const line of text.split("\n")) { try { const x = JSON.parse(line.slice(line.indexOf("{"))); const uid = String(x.data?.uid || x.data?.account || ""); (x.data?.status?.name === "valid" ? valid : dead).push(uid); } catch {} } return c.json({ valid, dead, uncertain: [] }); });

wa.post("/fb/page-check", async (c) => {
  const { cookie } = await c.req.json<{ cookie?: string }>().catch(() => ({}) as { cookie?: string });
  if (!cookie) return c.json({ error: "Cookie required" }, 400);
  const fail = (error: string | null) => c.json({ eligible: false, banReason: null, linkedNumber: null, pageName: null, error });
  try {
    const pageRes = await fetch("https://accountscenter.facebook.com/profiles", { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", cookie, "sec-ch-ua-mobile": "?1", "sec-ch-ua-platform": '"iOS"', "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", "upgrade-insecure-requests": "1", "user-agent": UA_IOS }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    const html = await pageRes.text();
    if (challenged(html)) return fail("Session requires 2FA or login challenge");
    const pages = extractPages(html);
    const linkedNumber = extractLinkedNumber(html);
    const cuser = cookie.match(/c_user=(\d+)/)?.[1] || "";
    if (cuser) { if (pages.length) await waCacheSet(c.env, c.get("uid"), cuser, { status: "eligible", banReason: null, pageName: pages[0].name, linkedNumber, error: null, ts: Date.now() }); else await waCacheDel(c.env, c.get("uid"), cuser); }
    return c.json({ eligible: pages.length > 0, banReason: null, linkedNumber, pageName: pages[0]?.name ?? null, error: null });
  } catch (e) { return fail(/abort|timeout|network|fetch/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)) ? "Service unavailable" : String(e instanceof Error ? e.message : e)); }
});

wa.post("/fb/wa-check", async (c) => {
  const { cookie } = await c.req.json<{ cookie?: string }>().catch(() => ({}) as { cookie?: string });
  if (!cookie) return c.json({ error: "Cookie required" }, 400);
  const fail = (error: string) => c.json({ eligible: false, banReason: null, linkedNumber: null, error });
  try {
    const pageRes = await fetch("https://business.facebook.com/latest/inbox/wec", { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", cookie, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(15000) });
    const html = await pageRes.text();
    if (challenged(html)) return fail("Session requires 2FA or login challenge");
    if (html.includes("Insufficient Permission") || html.includes("You do not have the necessary permission")) return fail("Not eligible for this page");
    const pageIdPatterns = [pageRes.url.match(/[?&](?:asset_id|page_id)[=_](\d{14,17})/)?.[1], pageRes.url.match(/\/pages\/(\d{14,17})\//)?.[1], ...[/"pageID"\s*:\s*"(\d{14,17})"/, /"page_id"\s*:\s*(\d{14,17})/, /"localScopeID"\s*:\s*"(\d{14,17})"/, /"assetID"\s*:\s*"(\d{14,17})"/, /"selectedPageId"\s*:\s*"(\d{14,17})"/, /"ownerId"\s*:\s*"(\d{14,17})"/, /"business_id"\s*:\s*(\d{14,17})/, /"actorID"\s*:\s*"(\d{14,17})"/].map((p) => html.match(p)?.[1]), cookie.match(/c_user=(\d+)/)?.[1]];
    const pageID = pageIdPatterns.find((x): x is string => !!x && /^\d+$/.test(x));
    if (!pageID) return fail("Invalid pageID");
    const fb_dtsg = html.match(/"DTSGInitData"[,\[\]\s]*\{[^}]*"token"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    if (!fb_dtsg) return fail("Could not extract fb_dtsg");
    const cuser = cookie.match(/c_user=(\d+)/)?.[1] || "";
    const dpr = Math.round(parseFloat(cookie.match(/dpr=([\d.]+)/)?.[1] || "3"));
    const body = new URLSearchParams({ av: pageID, __user: cuser, dpr: String(dpr), fb_dtsg, __crn: "comet.bizweb.BusinessCometBizSuiteInboxWhatsAppRoute", fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "WhatsAppOnboardingUnifiedInboxSurfaceQuery", server_timestamps: "true", variables: JSON.stringify({ pageID, wabaID: "", hasWabaID: false }), doc_id: "27161030553583658" });
    const gqlRes = await fetch("https://business.facebook.com/api/graphql/", { method: "POST", headers: { accept: "*/*", "content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": "WhatsAppOnboardingUnifiedInboxSurfaceQuery", cookie }, body, signal: AbortSignal.timeout(15000) });
    if (gqlRes.status === 429) return fail("Rate limited");
    if (!gqlRes.ok) return fail(`GraphQL returned ${gqlRes.status}`);
    let text = await gqlRes.text();
    if (text.includes("Insufficient Permission") || text.includes("You do not have the necessary permission")) return fail("Not eligible for this page");
    let json: any; try { json = JSON.parse(text.replace(/^for\s*\(;;\)\s*;?\s*/, "")); } catch { return fail("Invalid GraphQL JSON"); }
    const elig = json?.data?.xfb_is_page_eligible_for_wa_link;
    if (elig === undefined || elig === null) return fail("Unexpected response structure");
    const result = { eligible: elig?.is_eligible === true, banReason: elig?.ban_reason || null, linkedNumber: elig?.page_whatsapp_number || null, error: null };
    if (cuser) { if (result.eligible) await waCacheSet(c.env, c.get("uid"), cuser, { status: "eligible", banReason: result.banReason, error: null, ts: Date.now() }); else if (result.error === null) await waCacheDel(c.env, c.get("uid"), cuser); }
    return c.json(result);
  } catch (e) { return fail(/abort|timeout|network|fetch/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)) ? "Service unavailable" : String(e instanceof Error ? e.message : e)); }
});

// ponytail: WA cache served only when fresh+eligible, mirroring backend purge-on-read
const WA_TTL = 86400_000;
wa.get("/wa/cache", async (c) => {
  const uids = (c.req.query("uids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 1000);
  const uid = c.get("uid");
  const cache: Record<string, unknown> = {};
  for (const u of uids) {
    const v: any = await rpc(c.env.INDEX, "global", "metaGet", { k: waCacheKey(uid, u) }).catch(() => null);
    if (!v || v.status !== "eligible" || (v.ts && Date.now() - v.ts > WA_TTL)) { if (v) await waCacheDel(c.env, uid, u); continue; }
    cache[u] = { status: v.status ?? null, banReason: v.banReason ?? null, error: v.error ?? null, pageName: v.pageName ?? null, linkedNumber: v.linkedNumber ?? null, ts: v.ts ?? null };
  }
  return c.json({ cache });
});
