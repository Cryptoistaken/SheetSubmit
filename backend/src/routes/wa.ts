// Facebook/WhatsApp check routes — ported from the old server (API contract unchanged).
import { Router } from "express";
import { WA_CACHE_TTL_MS } from "../config/env";
import { delKey, mgetJSON, redis, setJSON } from "../services/redis";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";

export const waRouter = Router();

const FB_API_CHECK = "https://check.fb.tools/api/check/facebook";
const FB_API_HITOOLS = "https://hitools.pro/api/check-live-uid";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Per-user in-memory rate limiter for /fb/check (window 60 s, max 3 per window).
const fbCheckHits = new Map<string, number[]>();
const FB_CHECK_WINDOW_MS = 60 * 1000;
const FB_CHECK_MAX = 3;

function fbCheckLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (fbCheckHits.get(userId) || []).filter((ts) => now - ts < FB_CHECK_WINDOW_MS);
  if (hits.length >= FB_CHECK_MAX) {
    fbCheckHits.set(userId, hits);
    return true;
  }
  hits.push(now);
  fbCheckHits.set(userId, hits);
  if (fbCheckHits.size > 10000) {
    for (const [uid, arr] of fbCheckHits) {
      if (!arr.some((ts) => now - ts < FB_CHECK_WINDOW_MS)) fbCheckHits.delete(uid);
    }
  }
  return false;
}

// ── FB Account Check Proxy (auth required) ──
waRouter.post("/fb/check", requireAuth, asyncRoute(async (req, res) => {
  if (fbCheckLimited(req.userId || "")) {
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const uids = (req.body as { uids?: unknown[] }).uids;
  if (!uids || !uids.length) {
    res.status(400).json({ error: "No UIDs provided" });
    return;
  }

  const unique = [...new Set(uids.map((u) => String(u)))].slice(0, 500);
  const valid: string[] = [];
  const dead: string[] = [];
  const uncertain: string[] = [];

  // Phase 1: check.fb.tools (primary)
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    let batchOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(FB_API_CHECK, {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json",
            "cache-control": "no-cache",
          },
          body: JSON.stringify({ inputData: batch, userLang: "en", checkFriends: false }),
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) {
          if (attempt < 2) await sleep(2000);
          continue;
        }
        const text = await r.text();
        const lines = text.trim().split("\n");
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.substring(line.indexOf("{")));
            if (parsed.event === "result") {
              const uid = String(parsed.data.uid || parsed.data.account);
              const status = parsed.data.status ? parsed.data.status.name : "";
              if (status === "valid") {
                if (valid.indexOf(uid) === -1) valid.push(uid);
              } else if (dead.indexOf(uid) === -1) {
                dead.push(uid);
              }
            }
          } catch {
            // ignore malformed line
          }
        }
        batchOk = true;
        break;
      } catch {
        if (attempt < 2) await sleep(2000);
      }
    }
    if (!batchOk) {
      batch.forEach((uid) => {
        if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
      });
    }
    if (i + 20 < unique.length) await sleep(300);
  }

  // Phase 2: hitools.pro (fallback for unresolved)
  const remaining = unique.filter(
    (u) => valid.indexOf(u) === -1 && dead.indexOf(u) === -1 && uncertain.indexOf(u) === -1,
  );
  if (remaining.length > 0) {
    for (let i = 0; i < remaining.length; i += 20) {
      const batch = remaining.slice(i, i + 20);
      let batchOk = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await fetch(FB_API_HITOOLS, {
            method: "POST",
            headers: { "content-type": "application/json", referer: "https://hitools.pro/check-live-uid", origin: "https://hitools.pro" },
            body: JSON.stringify({ uids: batch }),
            signal: AbortSignal.timeout(20000),
          });
          if (!r.ok) {
            if (attempt < 2) await sleep(2000);
            continue;
          }
          const text = await r.text();
          const lines = text.trim().split("\n");
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.uid) {
                const uid = String(parsed.uid);
                if (parsed.live) {
                  if (valid.indexOf(uid) === -1) valid.push(uid);
                } else if (dead.indexOf(uid) === -1) {
                  dead.push(uid);
                }
              }
            } catch {
              // ignore malformed line
            }
          }
          batchOk = true;
          break;
        } catch {
          if (attempt < 2) await sleep(2000);
        }
      }
      if (!batchOk) {
        batch.forEach((uid) => {
          if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
        });
      }
      if (i + 20 < remaining.length) await sleep(11000);
    }
  }

  for (let i = 0; i < unique.length; i++) {
    const uid = unique[i];
    if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
  }

  res.json({ valid, dead, uncertain });
}));

// ── Page Check (auth required) ──
// Detects whether the FB account owns a Facebook Page and extracts the linked
// mobile number by fetching the Accounts Center profiles page and scanning the
// linked identities + contact point settings.
function extractPages(html: string): { name: string; type: string }[] {
  const pages: { name: string; type: string }[] = [];
  const re = /"identity_type":"FB_ADDITIONAL_PROFILE"[^}]*?"full_name":"([^"]+)"[^}]*?"identity_type_string":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    pages.push({ name: m[1], type: m[2] });
  }
  return pages;
}

function extractLinkedNumber(html: string): string | null {
  const re = /"__typename":"XFBFXSettingsContactPoint"[^}]*?"navigation_row_subtitle":"([^"]+)"/;
  const m = html.match(re);
  return m ? m[1] : null;
}

waRouter.post("/fb/page-check", requireAuth, asyncRoute(async (req, res) => {
  const cookie = String((req.body as { cookie?: unknown }).cookie || "");
  if (!cookie) {
    res.status(400).json({ error: "Cookie required" });
    return;
  }
  try {
    const pageRes = await fetch("https://accountscenter.facebook.com/profiles", {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie,
        "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"iOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "viewport-width": "833",
      },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    const html = await pageRes.text();
    if (html.includes("checkpointSubmitButton") || html.includes("m_login_email") || /checkpoint|login_attempt|force_login/i.test(html.substring(0, 5000))) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, pageName: null, error: "Session requires 2FA or login challenge" });
      return;
    }
    const pages = extractPages(html);
    const linkedNumber = extractLinkedNumber(html);
    const cuser = (cookie.match(/c_user=(\d+)/) || [])[1] || "";
    const result = {
      eligible: pages.length > 0,
      banReason: null,
      linkedNumber,
      pageName: pages.length ? pages[0].name : null,
      error: null,
    };
    if (cuser) {
      if (result.eligible) {
        await setJSON("wa:" + req.userId + ":" + cuser, {
          status: "eligible",
          banReason: null,
          pageName: result.pageName,
          linkedNumber,
          error: null,
          ts: Date.now(),
          checkedAt: Date.now(),
        });
      } else {
        // definitive "no page" — never cache it; drop any stale entry so the
        // next load re-checks live instead of trusting an old result.
        await delKey("wa:" + req.userId + ":" + cuser);
      }
    }
    res.json(result);
  } catch (e) {
    const err = e as Error & { name?: string };
    if (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      (err.message && (err.message.includes("fetch") || err.message.includes("network")))
    ) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, pageName: null, error: "Service unavailable" });
    } else {
      res.json({ eligible: false, banReason: null, linkedNumber: null, pageName: null, error: err.message });
    }
  }
}));

function extractWaPageId(html: string, finalUrl: string, cookie: string): string | null {
  let m = finalUrl.match(/[?&]asset_id[=_]\d{14,17}/);
  if (m) return m[0].match(/\d{14,17}/)![0];
  m = finalUrl.match(/[?&]page_id[=_]\d{14,17}/);
  if (m) return m[0].match(/\d{14,17}/)![0];
  m = finalUrl.match(/\/pages\/\d{14,17}\//);
  if (m) return m[0].match(/\d{14,17}/)![0];
  const patterns = [
    /"pageID"\s*:\s*"(\d{14,17})"/,
    /"page_id"\s*:\s*(\d{14,17})/,
    /"localScopeID"\s*:\s*"(\d{14,17})"/,
    /"assetID"\s*:\s*"(\d{14,17})"/,
    /"selectedPageId"\s*:\s*"(\d{14,17})"/,
    /"ownerId"\s*:\s*"(\d{14,17})"/,
    /"business_id"\s*:\s*(\d{14,17})/,
    /"actorID"\s*:\s*"(\d{14,17})"/,
    /"id"\s*:\s*"(\d{15,17})"[^}]{0,80}(?:page|business|Page)/i,
  ];
  for (const pattern of patterns) {
    m = html.match(pattern);
    if (m) return m[1];
  }
  const cuser = (cookie.match(/c_user=(\d+)/) || [])[1];
  if (cuser) return cuser;
  return null;
}

// ── WA Onboarding Eligibility Check (auth required) ──
waRouter.post("/fb/wa-check", requireAuth, asyncRoute(async (req, res) => {
  const cookie = String((req.body as { cookie?: unknown }).cookie || "");
  if (!cookie) {
    res.status(400).json({ error: "Cookie required" });
    return;
  }
  try {
    const pageRes = await fetch("https://business.facebook.com/latest/inbox/wec", {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie,
        "sec-fetch-site": "none",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await pageRes.text();
    const pageID = extractWaPageId(html, pageRes.url, cookie);
    if (html.includes("checkpointSubmitButton") || html.includes("m_login_email") || /checkpoint|login_attempt|force_login/i.test(html.substring(0, 5000))) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Session requires 2FA or login challenge" });
      return;
    }
    if (html.includes("Insufficient Permission") || html.includes("You do not have the necessary permission")) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Not eligible for this page" });
      return;
    }
    if (!/^\d+$/.test(pageID || "")) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Invalid pageID" });
      return;
    }
    const dtsgMatch = html.match(/"DTSGInitData"[,\[\]\s]*\{[^}]*"token"\s*:\s*"([^"]+)"/);
    const fb_dtsg = dtsgMatch ? dtsgMatch[1] : null;
    if (!fb_dtsg) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Could not extract fb_dtsg" });
      return;
    }
    const cuser = (cookie.match(/c_user=(\d+)/) || [])[1] || "";
    const dprVal = (cookie.match(/dpr=([\d.]+)/) || [])[1] || "3";
    const body = [
      "av=" + pageID,
      "__user=" + cuser,
      "dpr=" + Math.round(parseFloat(dprVal)),
      "fb_dtsg=" + encodeURIComponent(fb_dtsg),
      "__crn=comet.bizweb.BusinessCometBizSuiteInboxWhatsAppRoute",
      "fb_api_caller_class=RelayModern",
      "fb_api_req_friendly_name=WhatsAppOnboardingUnifiedInboxSurfaceQuery",
      "server_timestamps=true",
      "variables=" + encodeURIComponent(JSON.stringify({ pageID, wabaID: "", hasWabaID: false })),
      "doc_id=27161030553583658",
    ].join("&");
    const gqlRes = await fetch("https://business.facebook.com/api/graphql/", {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": "WhatsAppOnboardingUnifiedInboxSurfaceQuery",
        cookie,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (gqlRes.status === 429) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Rate limited" });
      return;
    }
    if (!gqlRes.ok) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "GraphQL returned " + gqlRes.status });
      return;
    }
    const text = await gqlRes.text();
    if (text.includes("Insufficient Permission") || text.includes("You do not have the necessary permission")) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Not eligible for this page" });
      return;
    }
    let jsonStr = text.trim();
    if (jsonStr.startsWith("for(;;);")) jsonStr = jsonStr.replace(/^for\s*\(;;\)\s*;?\s*/, "");
    let json: any;
    try {
      json = JSON.parse(jsonStr);
    } catch {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Invalid GraphQL JSON" });
      return;
    }
    const eligibleData = json?.data?.xfb_is_page_eligible_for_wa_link;
    if (eligibleData === undefined || eligibleData === null) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Unexpected response structure" });
      return;
    }
    const result = {
      eligible: eligibleData?.is_eligible === true,
      banReason: eligibleData?.ban_reason || null,
      linkedNumber: eligibleData?.page_whatsapp_number || null,
      error: null,
    };
    if (cuser) {
      if (result.eligible) {
        await setJSON("wa:" + req.userId + ":" + cuser, {
          status: "eligible",
          banReason: result.banReason || null,
          error: result.error || null,
          ts: Date.now(),
          checkedAt: Date.now(),
        });
      } else if (result.error === null) {
        await delKey("wa:" + req.userId + ":" + cuser);
      }
    }
    res.json(result);
  } catch (e) {
    const err = e as Error & { name?: string };
    if (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      (err.message && (err.message.includes("fetch") || err.message.includes("network")))
    ) {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: "Service unavailable" });
    } else {
      res.json({ eligible: false, banReason: null, linkedNumber: null, error: err.message });
    }
  }
}));

// ── WA eligibility cache ──
waRouter.get("/wa/cache", requireAuth, asyncRoute(async (req, res) => {
  try {
    const uids = String(req.query.uids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 1000);
    const cache: Record<string, unknown> = {};
    if (uids.length) {
      const vals = await mgetJSON<{
        status?: string | null;
        banReason?: string | null;
        error?: string | null;
        pageName?: string | null;
        linkedNumber?: string | null;
        ts?: number;
      }>(uids.map((u) => "wa:" + req.userId + ":" + u));
      const stale: string[] = [];
      uids.forEach((uid, i) => {
        const val = vals[i];
        if (!val) return;
        if (WA_CACHE_TTL_MS > 0 && val.ts && Date.now() - val.ts > WA_CACHE_TTL_MS) {
          stale.push("wa:" + req.userId + ":" + uid);
          return;
        }
        if (val.status !== "eligible") {
          // stale legacy entry (old server cached ineligible/error) — purge, never serve
          stale.push("wa:" + req.userId + ":" + uid);
          return;
        }
        cache[uid] = { status: val.status || null, banReason: val.banReason || null, error: val.error || null, pageName: val.pageName || null, linkedNumber: val.linkedNumber || null, ts: val.ts || null };
      });
      if (stale.length) await redis.del(stale.map((k) => "ss:" + k));
    }
    res.json({ cache });
  } catch (e) {
    console.error("[WaCache] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to read wa cache" });
  }
}));
