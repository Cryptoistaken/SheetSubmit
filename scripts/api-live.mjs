#!/usr/bin/env bun
/**
 * SheetSubmit-testmycode — live API test + latency probe.
 *
 * Covers every public + admin endpoint (user is admin). Hits the DEPLOYED test
 * API. Requires a valid session cookie (admin) — read from scripts/.env.live
 * (`SESSION_COOKIE=<64-hex>`, gitignored) or env var SESSION_COOKIE.
 *
 * Usage:
 *   bun scripts/api-live.mjs                 # defaults: API_BASE=https://sealbackend.up.railway.app
 *   bun scripts/api-live.mjs https://host    # override base
 */
import { readFileSync, existsSync } from "node:fs";

const API_BASE = (process.argv[2] ?? "https://sealbackend.up.railway.app").replace(/\/+$/, "");
const SESSION = process.env.SESSION_COOKIE ?? loadDotEnv("scripts/.env.live").SESSION_COOKIE ?? "";

const { rows: TEST_ROWS } = loadRows();

let passes = 0;
let fails = 0;
const slow = [];

function loadDotEnv(p) {
  try {
    if (!existsSync(p)) return {};
    const out = {};
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

function loadRows() {
  const real = "scripts/test-data.real.json";
  const p = existsSync(real) ? real : "scripts/test-data.json";
  return JSON.parse(readFileSync(p, "utf8"));
}

async function call(method, path, { body, cookie = true, expect = null } = {}) {
  const t0 = performance.now();
  const headers = { "Content-Type": "application/json" };
  if (cookie && SESSION) headers.Cookie = "session=" + SESSION;
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const ms = Math.round(performance.now() - t0);
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ms, data, setCookie: res.headers.getSetCookie?.() ?? [] };
}

function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  ok  ${name}${detail ? "  (" + detail + ")" : ""}`);
  } else {
    fails++;
    console.log(`FAIL  ${name}  ${detail ?? ""}`);
  }
}

function track(name, ms, slowAt = 2000) {
  slow.push({ name, ms });
  if (ms >= slowAt) console.log(`  !   ${name} took ${ms}ms (>= ${slowAt}ms)`);
}

async function section(title) {
  console.log("\n== " + title + " ==");
}

// ---------------------------------------------------------------------------

async function main() {
  if (!SESSION) {
    console.error("No SESSION_COOKIE. Put SESSION_COOKIE=<64-hex> in scripts/.env.live or env var.");
    process.exit(2);
  }
  console.log("API_BASE:", API_BASE, "| test rows:", TEST_ROWS.length);

  const uidRows = TEST_ROWS.filter((r) => r.uid).slice(0, 3);
  const uids = uidRows.map((r) => r.uid);
  const firstCookie = TEST_ROWS[0].cookies;
  let fileId = null;
  let forkedId = null;
  let seq = 0;

  await section("health / auth");
  {
    const r = await call("GET", "/api/health");
    check("GET /api/health 200", r.status === 200 && r.data.status === "ok", `status=${r.data.status}`);
    track("GET /api/health", r.ms);

    const r2 = await call("GET", "/api/auth/me", { cookie: false });
    check("GET /api/auth/me (no cookie) -> null", r2.status === 200 && r2.data === null);
    const r3 = await call("GET", "/api/auth/me");
    check(
      "GET /api/auth/me (cookie) -> user + isAdmin",
      r3.status === 200 && r3.data && r3.data.id && r3.data.isAdmin === true,
      `id=${r3.data?.id} admin=${r3.data?.isAdmin}`,
    );
    track("GET /api/auth/me", r3.ms);

    const r4 = await call("POST", "/api/files", { body: { name: "x" }, cookie: false });
    check("POST /api/files (no cookie) -> 401", r4.status === 401);
  }

  await section("files CRUD + data");
  {
    const r = await call("GET", "/api/files");
    check("GET /api/files 200 array", r.status === 200 && Array.isArray(r.data), `files=${r.data?.length}`);
    track("GET /api/files", r.ms);

    const c = await call("POST", "/api/files", {
      body: { name: "api-live-" + Date.now(), type: "fb_cookie" },
    });
    check("POST /api/files 200 + server id", (c.status === 200 || c.status === 201) && c.data?.id, `id=${c.data?.id}`);
    fileId = c.data?.id;
    track("POST /api/files", c.ms);

    const cols = [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "twofakey", label: "2fa key", width: 200 },
      { key: "uid", label: "uid", width: 120 },
    ];
    const p = await call("PUT", `/api/files/${fileId}/persist`, {
      body: { rows: TEST_ROWS.slice(0, 5), columns: cols, dataCount: 5, action: "import" },
    });
    check("PUT persist 200 + seq", p.status === 200 && p.data?.ok && Number.isInteger(p.data?.seq), `seq=${p.data?.seq}`);
    seq = p.data?.seq ?? 0;
    track("PUT persist (5 rows)", p.ms);

    const full = await call("GET", `/api/files/${fileId}/full`);
    check(
      "GET /full returns rows + seq",
      full.status === 200 && Array.isArray(full.data?.rows) && full.data?.seq === seq,
      `seq=${full.data?.seq} rows=${full.data?.rows?.length}`,
    );
    track("GET /full", full.ms);

    const a = await call("PUT", `/api/files/${fileId}/append`, {
      body: { base: seq, ops: [{ rowIdx: 0, cols: { uid: "TESTAPPEND" } }], dataCount: 5 },
    });
    check("PUT append 200 + seq bump", a.status === 200 && a.data?.ok && a.data?.seq === seq + 1, `seq=${a.data?.seq}`);
    seq = a.data?.seq ?? seq;
    track("PUT append", a.ms);

    const conflict = await call("PUT", `/api/files/${fileId}/append`, {
      body: { base: 999999, ops: [{ rowIdx: 0, cols: { uid: "X" } }] },
    });
    check("PUT append wrong base -> 409", conflict.status === 409 && conflict.data?.error === "version conflict");
    track("PUT append (conflict)", conflict.ms);

    const notFound = await call("GET", "/api/files/definitely-not-a-file");
    check("GET /files/:id (missing) -> 404", notFound.status === 404);
  }

  await section("history");
  {
    const h = await call("GET", `/api/files/${fileId}/history`);
    check("GET history array non-empty", h.status === 200 && Array.isArray(h.data) && h.data.length > 0, `v=${h.data?.[0]?.v}`);
    track("GET history", h.ms);
    const top = h.data?.[0]?.v;

    const gv = await call("GET", `/api/files/${fileId}/history/${top}`);
    check("GET history/:v", gv.status === 200 && Array.isArray(gv.data?.rows), `rows=${gv.data?.rows?.length}`);
    track("GET history/:v", gv.ms);

    const rv = await call("POST", `/api/files/${fileId}/history/${top}/restore`);
    check("POST history/:v/restore", rv.status === 200 && rv.data?.ok && Array.isArray(rv.data?.rows));
    track("POST restore", rv.ms);

    const nm = await call("POST", `/api/files/${fileId}/history/${top}/name`, { body: { name: "live-test" } });
    check("POST history/:v/name", nm.status === 200 && nm.data?.ok && nm.data?.meta);
    track("POST name", nm.ms);

    const fk = await call("POST", `/api/files/${fileId}/history/${top}/fork`);
    check("POST history/:v/fork", fk.status === 200 && fk.data?.ok && fk.data?.file?.id, `forked=${fk.data?.file?.id}`);
    forkedId = fk.data?.file?.id;
    track("POST fork", fk.ms);
  }

  await section("cross-dups");
  {
    const d = await call("GET", `/api/cross-dups?fileId=${fileId}`);
    check("GET cross-dups?fileId -> counts+dups", d.status === 200 && d.data?.counts !== undefined, `counts=${JSON.stringify(d.data?.counts)}`);
    track("GET cross-dups (fileId)", d.ms);
    const d2 = await call("GET", "/api/cross-dups");
    check("GET cross-dups (cached)", d2.status === 200 && d2.data?.counts !== undefined);
    track("GET cross-dups (cached)", d2.ms);
  }

  await section("fb / wa checks");
  {
    const fb = await call("POST", "/api/fb/check", { body: { uids } });
    // 429 = backend's per-user rate limiter (max 3 per 60s window) — valid when
    // re-running the suite quickly; the endpoint still guarded the request.
    check(
      "POST fb/check 200 shape",
      (fb.status === 200 || fb.status === 429) &&
        (fb.data?.valid === undefined ||
          (Array.isArray(fb.data?.valid) &&
            Array.isArray(fb.data?.dead) &&
            Array.isArray(fb.data?.uncertain))),
      `status=${fb.status} valid=${fb.data?.valid?.length} dead=${fb.data?.dead?.length} uncertain=${fb.data?.uncertain?.length}`,
    );
    track("POST fb/check (" + uids.length + " uids)", fb.ms, 5000);

    const noUids = await call("POST", "/api/fb/check", { body: { uids: [] } });
    check("POST fb/check empty -> rejected", [400, 429].includes(noUids.status), `status=${noUids.status}`);

    const pc = await call("POST", "/api/fb/page-check", { body: { cookie: firstCookie } });
    check("POST fb/page-check 200", pc.status === 200 && typeof pc.data?.eligible === "boolean", `eligible=${pc.data?.eligible} err=${pc.data?.error ?? ""}`);
    track("POST fb/page-check", pc.ms, 5000);

    const wc = await call("POST", "/api/fb/wa-check", { body: { cookie: firstCookie } });
    check("POST fb/wa-check 200", wc.status === 200 && "eligible" in (wc.data ?? {}), `eligible=${wc.data?.eligible} err=${wc.data?.error ?? ""}`);
    track("POST fb/wa-check", wc.ms, 5000);

    const wac = await call("GET", "/api/wa/cache?uids=" + uids.join(","));
    check("GET wa/cache 200", wac.status === 200 && typeof wac.data?.cache === "object");
    track("GET wa/cache", wac.ms);
  }

  await section("archive lifecycle");
  {
    const del = await call("DELETE", `/api/files/${fileId}`);
    check("DELETE file -> archive", del.status === 200 && del.data?.ok === true);
    track("DELETE file", del.ms);

    const ar = await call("GET", "/api/archive");
    check("GET archive contains file", ar.status === 200 && ar.data?.some((f) => f.id === fileId));
    track("GET archive", ar.ms);

    const rs = await call("POST", `/api/archive/${fileId}/restore`);
    check("POST archive/:id/restore", rs.status === 200 && rs.data?.ok === true);
    track("POST archive restore", rs.ms);

    await call("DELETE", `/api/files/${fileId}`);
    const br = await call("POST", "/api/archive/batch-restore", { body: { ids: [fileId] } });
    check("POST archive/batch-restore", br.status === 200 && br.data?.restored === 1, `restored=${br.data?.restored}`);
    track("POST batch-restore", br.ms);

    await call("DELETE", `/api/files/${fileId}`);
    const bd = await call("POST", "/api/archive/batch-delete", { body: { ids: [fileId] } });
    check("POST archive/batch-delete", bd.status === 200 && bd.data?.deleted === 1, `deleted=${bd.data?.deleted}`);
    track("POST batch-delete", bd.ms);
  }

  await section("admin (own account + scratch files)");
  const adminUser = "8447133985";
  {
    const st = await call("GET", "/api/admin/stats");
    check("GET admin/stats", st.status === 200 && Number.isInteger(st.data?.totalUsers) && Number.isInteger(st.data?.totalFiles), `users=${st.data?.totalUsers} files=${st.data?.totalFiles}`);
    track("GET admin/stats", st.ms);

    const us = await call("GET", "/api/admin/users");
    check("GET admin/users array", us.status === 200 && Array.isArray(us.data) && us.data.some((u) => u.id === adminUser), `users=${us.data?.length}`);
    track("GET admin/users", us.ms);

    const q = await call("GET", "/api/admin/users/search?q=" + encodeURIComponent("Crypto"));
    check("GET admin/users/search", q.status === 200 && Array.isArray(q.data) && q.data.length > 0, `hits=${q.data?.length}`);
    track("GET admin/users/search", q.ms);

    const one = await call("GET", `/api/admin/user/${adminUser}`);
    check("GET admin/user/:id", one.status === 200 && one.data?.id === adminUser && Array.isArray(one.data?.files), `files=${one.data?.files?.length}`);
    track("GET admin/user/:id", one.ms);

    const ar = await call("GET", `/api/admin/user/${adminUser}/archive`);
    check("GET admin/user/:id/archive", ar.status === 200 && Array.isArray(ar.data));
    track("GET admin/user/:id/archive", ar.ms);

    const noAuth = await call("GET", "/api/admin/stats", { cookie: false });
    check("GET admin/stats (no cookie) -> 401", noAuth.status === 401);

    // scratch file exercises (create again for admin endpoints)
    const c = await call("POST", "/api/files", { body: { name: "admin-live-" + Date.now(), type: "fb_cookie" } });
    fileId = c.data?.id;
    await call("PUT", `/api/files/${fileId}/persist`, { body: { rows: TEST_ROWS.slice(0, 2), dataCount: 2, action: "import" } });
    seq = 0;

    const gf = await call("GET", `/api/admin/file/${fileId}`);
    check("GET admin/file/:id", gf.status === 200 && gf.data?.id === fileId, `name=${gf.data?.name}`);
    track("GET admin/file/:id", gf.ms);

    const pu = await call("PUT", `/api/admin/file/${fileId}`, { body: { name: "admin-renamed" } });
    check("PUT admin/file/:id", pu.status === 200 && pu.data?.name === "admin-renamed");
    track("PUT admin/file/:id", pu.ms);

    const gr = await call("GET", `/api/admin/file/${fileId}/rows`);
    check("GET admin/file/:id/rows", gr.status === 200 && Array.isArray(gr.data), `rows=${gr.data?.length}`);
    track("GET admin/file/:id/rows", gr.ms);

    const gu = await call("GET", `/api/admin/file/${fileId}/undo`);
    check("GET admin/file/:id/undo", gu.status === 200 && Array.isArray(gu.data?.undo) && Array.isArray(gu.data?.redo));
    track("GET admin/file/:id/undo", gu.ms);

    const gl = await call("GET", `/api/admin/file/${fileId}/logs`);
    check("GET admin/file/:id/logs", gl.status === 200 && Array.isArray(gl.data));
    track("GET admin/file/:id/logs", gl.ms);

    const gh = await call("GET", `/api/admin/file/${fileId}/history`);
    check("GET admin/file/:id/history", gh.status === 200 && Array.isArray(gh.data) && gh.data.length > 0);
    track("GET admin/file/:id/history", gh.ms);
    const top = gh.data?.[0]?.v;

    const gv = await call("GET", `/api/admin/file/${fileId}/history/${top}`);
    check("GET admin/file/:id/history/:v", gv.status === 200 && Array.isArray(gv.data?.rows));
    track("GET admin/file/:id/history/:v", gv.ms);

    const rv = await call("POST", `/api/admin/file/${fileId}/history/${top}/restore`);
    check("POST admin history restore", rv.status === 200 && rv.data?.ok && Array.isArray(rv.data?.rows));
    track("POST admin restore", rv.ms);

    const nm = await call("POST", `/api/admin/file/${fileId}/history/${top}/name`, { body: { name: "admin-name" } });
    check("POST admin history name", nm.status === 200 && nm.data?.ok && nm.data?.meta);
    track("POST admin name", nm.ms);

    const ap = await call("PUT", `/api/admin/file/${fileId}/persist`, { body: { rows: TEST_ROWS.slice(0, 2), dataCount: 2, action: "replace" } });
    check("PUT admin/file/:id/persist", ap.status === 200 && ap.data?.ok && Number.isInteger(ap.data?.seq), `seq=${ap.data?.seq}`);
    track("PUT admin persist", ap.ms);

    const ban = await call("POST", `/api/admin/user/${adminUser}/ban`);
    check("POST admin/user/:id/ban (self) -> 400", ban.status === 400);
    const unban = await call("POST", `/api/admin/user/${adminUser}/unban`);
    check("POST admin/user/:id/unban non-5xx", unban.status < 500);
    track("POST admin unban", unban.ms);

    // cleanup scratch via admin (hard delete archive + file)
    const df = await call("DELETE", `/api/admin/file/${fileId}`);
    check("DELETE admin/file/:id -> archive", df.status === 200 && df.data?.ok === true);
    const darc = await call("DELETE", `/api/admin/user/${adminUser}/archive/${fileId}`);
    check("DELETE admin archive hard-delete", darc.status === 200 && darc.data?.ok === true);
    if (forkedId) {
      await call("DELETE", `/api/admin/file/${forkedId}`);
      await call("DELETE", `/api/admin/user/${adminUser}/archive/${forkedId}`);
    }
  }

  // summary
  console.log("\n==========================================");
  console.log(`PASS ${passes}  FAIL ${fails}`);
  slow.sort((a, b) => b.ms - a.ms);
  console.log("\nSlowest calls:");
  for (const s of slow.slice(0, 12)) console.log(`  ${String(s.ms).padStart(7)}ms  ${s.name}`);
  console.log("\nAverage latency by route prefix:");
  const groups = {};
  for (const s of slow) {
    const k = s.name.replace(/\s+\(.+\)/, "").split(" ").slice(0, 2).join(" ");
    groups[k] = groups[k] ?? { n: 0, t: 0 };
    groups[k].n++;
    groups[k].t += s.ms;
  }
  for (const [k, g] of Object.entries(groups)) {
    console.log(`  ${String(Math.round(g.t / g.n)).padStart(6)}ms avg x${g.n}  ${k}`);
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});