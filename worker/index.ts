// Background worker — self-contained (Bun + Postgres, same DB as backend).
// Jobs (each on its own interval, sequential):
//   1. held-uid-check      — pending-approval monitoring: held rows whose UID checks dead → state='dead' (never paid)
//   2. wa-check            — WhatsApp eligibility for rows without eligible wa_status (writes data.wa_status + wa:{uid}:{cuser} cache)
//   3. page-check          — FB pages scrape for rows without wa_status (sets eligible + page name + cache)
// Available pool rows are NOT background-monitored — they are killed by user checks (POST /fb/check → markDead).
// Env: DATABASE_URL, REDIS_URL (optional), CHECK_URL, HELD_INTERVAL_MS (10min), WA_INTERVAL_MS (30min), PAGE_INTERVAL_MS (30min)
import postgres from "postgres";
import { closeRedis, redisDel, publishLiveEvent } from "./redis";

if (!Bun.env.DATABASE_URL) throw new Error("DATABASE_URL is required for worker");
const db = postgres(Bun.env.DATABASE_URL || "", { max: 2, idle_timeout: 20, connect_timeout: 10 });
const CHECK_URL = Bun.env.CHECK_URL || "https://check.fb.tools/api/check/facebook";
const UA_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const challenged = (html: string) => html.includes("checkpointSubmitButton") || html.includes("m_login_email") || /checkpoint|login_attempt|force_login/i.test(html.substring(0, 5000));
const extractPages = (html: string) => { const pages: { name: string; type: string }[] = []; const re = /"identity_type":"FB_ADDITIONAL_PROFILE"[^}]*?"full_name":"([^"]+)"[^}]*?"identity_type_string":"([^"]+)"/g; let m: RegExpExecArray | null; while ((m = re.exec(html))) pages.push({ name: m[1], type: m[2] }); return pages; };
const extractLinkedNumber = (html: string) => html.match(/"__typename":"XFBFXSettingsContactPoint"[^}]*?"navigation_row_subtitle":"([^"]+)"/)?.[1] ?? null;
const j = (v: unknown) => v;

// ── UID liveness for HELD rows (check.fb.tools, batch ≤500) → dead rows never get paid ──
async function checkUids(limit: number): Promise<number> {
  const held: { row_key: string }[] = await db`SELECT DISTINCT row_key FROM pool_rows WHERE state='held' AND row_key ~ '^\d{5,20}$' LIMIT ${limit}`;
  if (!held.length) return 0;
  const uids = held.map((r) => r.row_key);
  const res = await fetch(CHECK_URL, {
    method: "POST",
    headers: { accept: "application/x-ndjson", "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ inputData: uids, userLang: "en", checkFriends: false }),
  });
  if (!res.ok) throw new Error(`checker responded ${res.status}`);
  const dead: string[] = [];
  for (const line of (await res.text()).split("\n")) {
    try {
      const x = JSON.parse(line.slice(line.indexOf("{")));
      const uid = String(x.data?.uid || x.data?.account || "");
      if (uid && x.data?.status?.name !== "valid") dead.push(uid);
    } catch {}
  }
  if (dead.length) {
    await db`UPDATE pool_rows SET state='dead' WHERE state='held' AND row_key IN ${db(dead)}`;
    // died on hold → permanent blocklist (never re-poolable, even after file deletes)
    await db`INSERT INTO pool_blocked(row_key,reason,ts) SELECT u.k,'dead',${Date.now()} FROM unnest(${dead}::text[]) AS u(k) ON CONFLICT(row_key) DO NOTHING`;
    // wake any owner sheets watching these rows (backend relays to file rooms)
    void publishLiveEvent({ type: "dead-keys", keys: dead });
  }
  console.log(`[worker:held] checked ${uids.length} uid(s) — ${dead.length} dead`);
  return dead.length;
}

// ── WA check: business.facebook.com scrape + GraphQL eligibility ──
async function waCheck(cookie: string): Promise<{ eligible: boolean; banReason: string | null; linkedNumber: string | null; error: string | null }> {
  const fail = (error: string) => ({ eligible: false, banReason: null, linkedNumber: null, error });
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
    const text = await gqlRes.text();
    if (text.includes("Insufficient Permission") || text.includes("You do not have the necessary permission")) return fail("Not eligible for this page");
    let json: any; try { json = JSON.parse(text.replace(/^for\s*\(;;\)\s*;?\s*/, "")); } catch { return fail("Invalid GraphQL JSON"); }
    const elig = json?.data?.xfb_is_page_eligible_for_wa_link;
    if (elig === undefined || elig === null) return fail("Unexpected response structure");
    return { eligible: elig?.is_eligible === true, banReason: elig?.ban_reason || null, linkedNumber: elig?.page_whatsapp_number || null, error: null };
  } catch (e) { return fail(/abort|timeout|network|fetch/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)) ? "Service unavailable" : String(e instanceof Error ? e.message : e)); }
}

// ── Page check: accountscenter scrape → pages ──
async function pageCheck(cookie: string): Promise<{ eligible: boolean; pageName: string | null; linkedNumber: string | null; error: string | null }> {
  try {
    const pageRes = await fetch("https://accountscenter.facebook.com/profiles", { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", cookie, "sec-ch-ua-mobile": "?1", "sec-ch-ua-platform": '"iOS"', "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", "upgrade-insecure-requests": "1", "user-agent": UA_IOS }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    const html = await pageRes.text();
    if (challenged(html)) return { eligible: false, pageName: null, linkedNumber: null, error: "Session requires 2FA or login challenge" };
    const pages = extractPages(html);
    return { eligible: pages.length > 0, pageName: pages[0]?.name ?? null, linkedNumber: extractLinkedNumber(html), error: null };
  } catch (e) { return { eligible: false, pageName: null, linkedNumber: null, error: /abort|timeout|network|fetch/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)) ? "Service unavailable" : String(e instanceof Error ? e.message : e) }; }
}

type PoolRowRef = { password: string; pool_id: string; row_key: string; src_uid: string | null; cookies: string; cuser: string };
async function rowsNeedingCheck(kind: "wa" | "page", limit: number): Promise<PoolRowRef[]> {
  const q = kind === "wa"
    ? db`SELECT password,pool_id,row_key,src_uid,data->>'cookies' AS cookies FROM pool_rows WHERE state='available' AND data->>'cookies' LIKE '%c_user=%' AND (data->>'wa_status' IS NULL OR (data->>'wa_status' NOT IN ('eligible','ineligible'))) LIMIT ${limit}`
    : db`SELECT password,pool_id,row_key,src_uid,data->>'cookies' AS cookies FROM pool_rows WHERE state='available' AND data->>'cookies' LIKE '%c_user=%' AND (data->>'wa_status' IS NULL OR data->>'wa_status' <> 'eligible') LIMIT ${limit}`;
  const rows: any[] = await q;
  return rows.map((r) => ({ password: r.password, pool_id: r.pool_id, row_key: r.row_key, src_uid: r.src_uid, cookies: r.cookies, cuser: String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || "" })).filter((r) => r.cuser);
}
async function applyResult(r: PoolRowRef, patch: Record<string, unknown>, cache: Record<string, unknown> | null) {
  await db`UPDATE pool_rows SET data=data||${j(patch)}::jsonb WHERE password=${r.password} AND pool_id=${r.pool_id} AND row_key=${r.row_key}`;
  if (r.src_uid && cache) { const k = `wa:${r.src_uid}:${r.cuser}`; await db`INSERT INTO meta(k,v) VALUES(${k},${j({ ...cache, ts: Date.now() })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; void redisDel(`ss:meta:${k}`); }
}

async function sweepWa(limit: number) {
  const rows = await rowsNeedingCheck("wa", limit);
  for (const r of rows) {
    const res = await waCheck(r.cookies);
    if (res.error) continue; // challenges/rate limits: leave row untouched, retry next sweep
    const patch: Record<string, unknown> = { wa_status: res.eligible ? "eligible" : "ineligible" };
    if (res.banReason) patch.wa_ban_reason = res.banReason;
    if (res.linkedNumber) patch.wa_linked_number = res.linkedNumber;
    await applyResult(r, patch, res.eligible ? { status: "eligible", banReason: res.banReason, error: null } : null);
    if (!res.eligible && r.src_uid) { const k = `wa:${r.src_uid}:${r.cuser}`; await db`DELETE FROM meta WHERE k=${k}`; void redisDel(`ss:meta:${k}`); }
  }
  console.log(`[worker:wa-check] swept ${rows.length} row(s)`);
}

async function sweepPages(limit: number) {
  const rows = await rowsNeedingCheck("page", limit);
  for (const r of rows) {
    const res = await pageCheck(r.cookies);
    if (res.error) continue;
    if (!res.eligible) continue; // page-check finds nothing → leave for wa-check to decide
    await applyResult(r, { wa_status: "eligible", ...(res.pageName ? { wa_page_name: res.pageName } : {}), ...(res.linkedNumber ? { wa_linked_number: res.linkedNumber } : {}) }, { status: "eligible", banReason: null, error: null, pageName: res.pageName, linkedNumber: res.linkedNumber });
  }
  console.log(`[worker:page-check] swept ${rows.length} row(s)`);
}

const interval = (k: string, def: number) => Math.max(60_000, Number(Bun.env[k]) || def);
const JOBS = [
  { name: "held-uid-check", every: interval("HELD_INTERVAL_MS", 600_000), limit: Number(Bun.env.UID_BATCH) || 500, run: (n: number) => checkUids(n) },
  { name: "page-check", every: interval("PAGE_INTERVAL_MS", 1_800_000), limit: Number(Bun.env.CHECK_BATCH) || 25, run: (n: number) => sweepPages(n) },
  { name: "wa-check", every: interval("WA_INTERVAL_MS", 1_800_000), limit: Number(Bun.env.CHECK_BATCH) || 25, run: (n: number) => sweepWa(n) },
];

// backend owns schema bootstrap (worker's build context has no /backend) — if tables are missing,
// jobs fail harmlessly and retry each tick until the backend has bootstrapped the database
console.log(`[worker] started — jobs: ${JOBS.map((j) => `${j.name}@${j.every / 1000}s`).join(", ")}`);
const last = new Map<string, number>();
const lastError = new Map<string, string>();
// tiny HTTP API so the backend (WORKER_URL) and Railway health checks can confirm the worker is alive
const startedAt = Date.now();
let stopping = false;
process.once("SIGTERM", () => { stopping = true; console.log("[worker] SIGTERM — finishing current tick"); });
process.once("SIGINT", () => { stopping = true; console.log("[worker] SIGINT — finishing current tick"); });
// ponytail: Railway sets a dynamic $PORT, but the backend dials worker.railway.internal:3000 —
// serve both so neither side needs to know the other's port. 0.0.0.0 or private-net dials fail.
const healthFetch = (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname !== "/health") return new Response("not found", { status: 404 });
  const token = Bun.env.WORKER_TOKEN;
  const detailed = !token || req.headers.get("authorization") === `Bearer ${token}`;
  return Response.json({
    ok: true,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    jobs: JOBS.map((jn) => ({ name: jn.name, everyMs: jn.every, lastRunAt: last.get(jn.name) ?? null, lastRunAgoMs: last.has(jn.name) ? Date.now() - (last.get(jn.name) as number) : null, lastError: detailed ? (lastError.get(jn.name) ?? null) : undefined })),
  });
};
const publicPort = Number(Bun.env.PORT) || 3000;
Bun.serve({ port: publicPort, hostname: "0.0.0.0", fetch: healthFetch });
if (publicPort !== 3000) Bun.serve({ port: 3000, hostname: "0.0.0.0", fetch: healthFetch });
for (;;) {
  if (stopping) { await db.end().catch(() => {}); await closeRedis().catch(() => {}); break; }
  // single-leader: only one replica sweeps at a time; losers skip the tick
  let leader = false;
  try {
    const r: any[] = await db`SELECT pg_try_advisory_lock(918273645) AS locked`;
    leader = !!r[0]?.locked;
  } catch { leader = true; }
  if (!leader) { await new Promise((r) => setTimeout(r, 30_000)); continue; }
  try {
    // held-uid-check first: dead held rows must stop being payable ASAP, don't let slow sweeps starve it
    const heldJob = JOBS[0];
    if ((last.get(heldJob.name) ?? 0) + heldJob.every <= Date.now()) {
      last.set(heldJob.name, Date.now());
      try { await heldJob.run(heldJob.limit); lastError.delete(heldJob.name); } catch (e) { lastError.set(heldJob.name, String((e as Error)?.message ?? e).slice(0, 200)); console.error(`[worker:${heldJob.name}]`, (e as Error)?.message ?? e); }
    }
    for (const job of JOBS.slice(1)) {
      if (stopping) break;
      const due = (last.get(job.name) ?? 0) + job.every <= Date.now();
      if (!due) continue;
      last.set(job.name, Date.now());
      try { await job.run(job.limit); lastError.delete(job.name); } catch (e) { lastError.set(job.name, String((e as Error)?.message ?? e).slice(0, 200)); console.error(`[worker:${job.name}]`, (e as Error)?.message ?? e); }
    }
  } finally {
    try { await db`SELECT pg_advisory_unlock(918273645)`; } catch {}
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
