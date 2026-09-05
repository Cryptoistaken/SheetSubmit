// nuke.ts — empty the Cloudflare Worker DB via the same admin HTTP API TestApi.ts uses.
// Usage:
//   bun scripts/nuke.ts                  # wipe files + pools, keep TEST_UID user (dry-preview + confirm)
//   bun scripts/nuke.ts --yes            # skip confirm
//   bun scripts/nuke.ts --dry            # preview only, no deletes
//   bun scripts/nuke.ts --full           # also delete TEST_UID user (DB → 0 users, next Telegram login recreates)
//   bun scripts/nuke.ts --keep 8447133985,1772093705  # keep listed users
//
// Secrets auto-load from scripts/.env (TEST_SESSION_SECRET, TEST_UID) — same as TestApi.ts:1-19.
// No wrangler / deploy.env needed — hits live worker at https://sheetsubmit.traderspopy.workers.dev/api.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dirname, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (k && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
} catch {}

const BASE = "https://sheetsubmit.traderspopy.workers.dev/api";
const SECRET = process.env.TEST_SESSION_SECRET;
const DEFAULT_UID = process.env.TEST_UID || "8447133985";
if (!SECRET) throw new Error("Set TEST_SESSION_SECRET in scripts/.env (same as TestApi.ts)");

// ── CLI flags
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const getVal = (f: string) => {
  const i = argv.findIndex((a) => a === f || a.startsWith(f + "="));
  if (i === -1) return undefined;
  const v = argv[i];
  return v.includes("=") ? v.split("=").slice(1).join("=") : argv[i + 1];
};
const DRY = has("--dry") || has("--dry-run");
const YES = has("--yes") || has("-y");
const FULL = has("--full"); // delete the caller user too → 0 users
const KEEP_ARG = getVal("--keep");
const KEEP = new Set(
  (KEEP_ARG ? KEEP_ARG.split(",") : FULL ? [] : [DEFAULT_UID]).map((s) => s.trim()).filter(Boolean)
);

// ── HMAC session signer (mirrors worker/src/lib/session.ts and TestApi.ts:38)
const enc = new TextEncoder();
const b64 = (v: ArrayBuffer | string) =>
  btoa(typeof v === "string" ? v : String.fromCharCode(...new Uint8Array(v)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function signSession(uid: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = b64(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 }));
  const sig = b64(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${sig}`;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, { ...init, redirect: "manual" });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

async function confirm(msg: string): Promise<boolean> {
  if (YES) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((r) => rl.question(msg, r));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

const cookieFor = (s: string) => `ss_session=${s}`;

async function main() {
  const sign = await signSession(DEFAULT_UID);
  const cookie = cookieFor(sign);

  console.log(`Worker: ${BASE}  (as ${DEFAULT_UID}${KEEP.has(DEFAULT_UID) ? " — kept" : " — will be deleted with --full"})`);
  if (DRY) console.log("Mode: DRY RUN (no deletes)\n");
  if (KEEP.size) console.log(`Keep users: ${[...KEEP].join(", ")}\n`);

  // ── health + stats
  const health = await api("/health");
  console.log(`health: ${health.status} version=${health.json?.version ?? "?"}`);
  const stats = await api("/admin/stats", { headers: { Cookie: cookie } });
  if (stats.status !== 200) throw new Error(`admin/stats ${stats.status} ${stats.text.slice(0, 300)} — is TEST_UID admin?`);
  console.log(`stats: ${JSON.stringify(stats.json)}`);

  const usersRes = await api("/admin/users", { headers: { Cookie: cookie } });
  const users: any[] = Array.isArray(usersRes.json) ? usersRes.json : [];
  console.log(`\nusers (${users.length}):`);
  for (const u of users) console.log(`  ${u.id} ${u.name} @${u.username} admin=${u.isAdmin} files=${u.fileCount} arch=${u.archivedCount}${KEEP.has(String(u.id)) ? " [KEEP]" : ""}`);

  // pool overview (admin)
  const PASSWORDS = ["dgddigital", "L0VE@12345"];
  const POOLS = ["cookies_only", "cookies_2fa", "page"] as const;
  let totalAvail = 0;
  console.log(`\npools:`);
  for (const pwd of PASSWORDS) {
    for (const pool of POOLS) {
      const r = await api(`/pools/${pwd}/${pool}`, { headers: { Cookie: cookie } });
      const avail = r.json?.totals?.available ?? 0;
      totalAvail += avail;
      console.log(`  ${pwd}/${pool}: available=${avail} claimed=${r.json?.totals?.claimed ?? 0}`);
    }
  }
  const dl = await api("/pools/downloads", { headers: { Cookie: cookie } });
  const dlCount = Array.isArray(dl.json) ? dl.json.length : 0;
  console.log(`  downloads history: ${dlCount}`);

  // per-user file counts (live+archived via admin)
  console.log(`\nfiles per user (live+archived):`);
  for (const u of users) {
    const id = String(u.id);
    const detail = await api(`/admin/user/${id}`, { headers: { Cookie: cookie } });
    const arch = await api(`/admin/user/${id}/archive`, { headers: { Cookie: cookie } });
    const allFiles: any[] = Array.isArray(detail.json?.files) ? detail.json.files : [];
    const archFiles: any[] = Array.isArray(arch.json) ? arch.json : [];
    // admin/user/:id returns files with archived="all" at worker/src/routes/admin.ts:14 + IndexDO.ts:82
    console.log(`  ${id}: all=${allFiles.length} archived=${archFiles.length}`);
  }

  if (DRY) {
    console.log("\n--dry: stopping before deletes. Re-run without --dry to nuke.");
    return;
  }

  const ok = await confirm("\n⚠️  This will PERMANENTLY delete the above data. Type 'yes' to continue: ");
  if (!ok) { console.log("Aborted."); return; }

  // ── 1) Delete archived files for kept users, then live files
  // For non-kept users, DELETE /admin/user/:id wipes FileDOs via worker/src/routes/admin.ts:19
  console.log("\n── wiping users/files ──");
  for (const u of users) {
    const id = String(u.id);
    if (KEEP.has(id)) {
      // kept user: delete files individually, keep user row
      // archived first — DELETE /admin/user/:id/archive/:fileId at worker/src/routes/admin.ts:17
      const arch = await api(`/admin/user/${id}/archive`, { headers: { Cookie: cookie } });
      const archFiles: any[] = Array.isArray(arch.json) ? arch.json : [];
      for (const f of archFiles) {
        const fid = String(f.id);
        const r = await api(`/admin/user/${id}/archive/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
        console.log(`  purge archived ${fid} (${f.name}) for ${id}: ${r.status} ${r.json?.ok ? "ok" : r.text.slice(0, 120)}`);
      }
      // live files — archive then purge (two-step, same as UI: DELETE /admin/file/:id then purge)
      // GET live files: /admin/user/:id returns all, so re-fetch and filter live by archived flag via IndexDO file lookup
      // simpler: iterate all and try archive→purge; 404 means already gone
      const detail = await api(`/admin/user/${id}`, { headers: { Cookie: cookie } });
      const allFiles: any[] = Array.isArray(detail.json?.files) ? detail.json.files : [];
      // archived already purged, so remaining are live/potentially archived duplicates — attempt archive+purge for each
      for (const f of allFiles) {
        const fid = String(f.id);
        // skip if already purged as archived (check still exists)
        const exists = await api(`/admin/file/${fid}`, { headers: { Cookie: cookie } });
        if (exists.status === 404) continue;
        const a = await api(`/admin/file/${fid}`, { method: "DELETE", headers: { Cookie: cookie } }); // worker/src/routes/admin.ts:23 archives
        if (a.status !== 200) console.log(`  archive live ${fid} for ${id}: ${a.status} ${a.text.slice(0, 120)}`);
        const p = await api(`/admin/user/${id}/archive/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
        console.log(`  purge live ${fid} for ${id}: ${p.status} ${p.json?.ok ? "ok" : p.text.slice(0, 120)}`);
      }
    } else {
      // delete entire user — wipes all FileDOs at worker/src/routes/admin.ts:19 + FileDO.ts:14 wipe
      const r = await api(`/admin/user/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
      console.log(`  delete user ${id}: ${r.status} ${r.json?.ok ? "ok" : r.text.slice(0, 200)}`);
    }
  }

  // ── 2) Drain pools — POST /pools/:pwd/:pool/claim count=all drains available → claimed
  // No HTTP removeAvailable; claiming is the admin HTTP way to empty available (worker/src/routes/pools.ts, PoolDO.ts:53 claim).
  // This leaves ledger/downloads history; for true DELETE FROM pool_rows/ledger/downloads add a POST /api/admin/nuke DO op.
  console.log("\n── draining pools (claim all) ──");
  for (const pwd of PASSWORDS) {
    for (const pool of POOLS) {
      const before = await api(`/pools/${pwd}/${pool}`, { headers: { Cookie: cookie } });
      const avail = before.json?.totals?.available ?? 0;
      if (!avail) { console.log(`  ${pwd}/${pool}: already 0`); continue; }
      const r = await api(`/pools/${pwd}/${pool}/claim`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ count: "all" }),
      });
      console.log(`  ${pwd}/${pool}: claimed ${r.json?.claimed ?? "?"} / ${avail} → ${r.status} ${r.json?.downloadId ? "download " + r.json.downloadId : r.text.slice(0, 150)}`);
    }
  }

  // ── verify
  const afterStats = await api("/admin/stats", { headers: { Cookie: cookie } });
  const afterUsers = await api("/admin/users", { headers: { Cookie: cookie } });
  console.log(`\n── done ──`);
  console.log(`stats: ${JSON.stringify(afterStats.json)}`);
  console.log(`users left: ${Array.isArray(afterUsers.json) ? afterUsers.json.length : "?"}`);
  for (const pwd of PASSWORDS) {
    for (const pool of POOLS) {
      const r = await api(`/pools/${pwd}/${pool}`, { headers: { Cookie: cookie } });
      console.log(`  ${pwd}/${pool}: available=${r.json?.totals?.available ?? "?"}`);
    }
  }
  console.log("\nNote: pool ledger/downloads history remains (PoolDO.ts ledger/downloads tables). For a true SQL wipe (DELETE FROM pool_rows/ledger/downloads + IndexDO meta/sessions), deploy a one-off POST /api/admin/nuke that runs s.exec DELETE — then call it from this script.");
}

main().catch((e) => { console.error(e); process.exit(1); });
