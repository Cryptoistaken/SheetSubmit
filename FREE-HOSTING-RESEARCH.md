# Free hosting research — frontend + backend (Sep 2026)

Question: fastest free-forever host for SheetSubmit (React/Vite SPA + Express-on-Bun backend with background loops, Telegram bot, Upstash Redis, xlsx parse/export, 10MB JSON uploads), ~20 users. Railway trial expires (~30 days), so "free forever" is the hard requirement. Banned: Render, Oracle, Fly.io. All numbers from official docs (Sep 2026).

## Comparison

| Platform | Free tier | Bandwidth | Requests | CPU | Sleep/cold start | Long-running backend? |
|---|---|---|---|---|---|---|
| **Cloudflare Pages** | Lifetime, no card | **Unlimited** (static serving unmetered — no limit listed in docs) | Unlimited (static); Functions share Workers quota | n/a (static) | none | No |
| **Cloudflare Workers Free** | Lifetime, no card | n/a | 100k/day | **10 ms/req, 10 ms cron** | none | No (CPU cap kills 10MB JSON.parse + xlsx) |
| **Vercel Hobby** | Lifetime | 100 GB/mo | Generous | Functions 10s default/60s max | n/a | No; **cannot connect org-owned Git repos** (Cryptoistaken is an org) |
| **Netlify Free** | Lifetime | ~15 GB/mo (new credit system: 300 credits, 20 credits/GB) | 2 credits/10k req | credits-based | n/a | No |
| **Deno Deploy Free** | Lifetime | 20 GiB/mo | 1M/mo | 10 active CPU-hrs/mo; idle-shutdown ~20–30 s | cold start per request | Rewrite to Deno required; loops impossible |
| **Google Cloud Run** (requests-based) | Always-free tier, needs billing account (card, $0 within tier) | 1 GiB/mo free egress | **2M/mo** + 180k vCPU-s + 360k GiB-s | full container | scale-to-zero cold start (~1–5 s) | **Runs existing Docker image unchanged** |
| Koyeb | **Free tier removed** (Pro $29/mo; joining Mistral AI) | — | — | — | — | — |
| HF Spaces Docker | **Now requires PRO** ($9/mo) for Docker/Gradio compute | — | — | 2 vCPU/16 GB when paid | sleeps on free | — |
| Railway (baseline) | Trial $5 one-time credit, then Hobby $5/mo | — | — | — | — | Yes (current host) |

## Key sources
- CF Workers limits (100k req/day, 10 ms CPU free, cron 10 ms, body 100 MB): https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-07-28)
- CF Pages limits (500 builds/mo, 20k files, unlimited collaborators; static unmetered): https://developers.cloudflare.com/pages/platform/limits/ (2026-07-16)
- Vercel limits (Hobby: functions 10s/60s, 100 deploys/day; Hobby cannot connect Git org repos): https://vercel.com/docs/limits/overview (2026-08-25)
- Netlify credit pricing (Free = 300 credits; bandwidth 20 credits/GB ≈ 15 GB): https://www.netlify.com/pricing/
- Deno Deploy (Free: 1M req/mo, 20 GiB egress, 10 CPU-hrs, idle-shutdown): https://deno.com/deploy/pricing
- Cloud Run free tier (2M req/mo, 180k vCPU-s, 360k GiB-s, requests-based billing): https://cloud.google.com/run/pricing
- Upstash Redis Free (256 MB, 10 GB bandwidth, 500k commands/mo): https://upstash.com/pricing
- Koyeb (no free tier; Pro $29/mo): https://www.koyeb.com/pricing
- HF Spaces (Docker requires PRO; static free only): https://huggingface.co/docs/hub/spaces-overview

## Verdict

**Frontend → Cloudflare Pages. Uncontested winner.**
- Free forever, no credit card, `*.pages.dev` domain, unlimited static requests/bandwidth, 500 builds/mo, unlimited team collaborators, fastest global CDN of the three.
- Vercel Hobby: 100 GB cap, non-commercial ToS, and hard-blocked for org repos (Cryptoistaken/…) — disqualified.
- Netlify's new credit model ≈ 15 GB/mo — disqualified.

**Backend → no truly free-forever host survives this codebase unchanged.** Ranked:
1. **Google Cloud Run** — best free-forever option: runs the existing `backend/Dockerfile` image with zero code change (app already reads `PORT`). 2M req/mo free is ~10× a 20-user team's needs. Trade-offs: GCP billing account required (card on file, $0 billed in free tier), scale-to-zero cold starts, and background loops (backup/GC/bot-polling) only run while an instance is warm → switch bot to webhook mode + optionally a Cloud Scheduler ping (free 3 jobs/mo) to keep it warm.
2. **Cloudflare Workers rewrite** ($0, no card) — only viable if we move xlsx import/export fully client-side (frontend already has `lib/xlsx.ts` build/download) and cap persist payloads well under 10 MB; 10 ms CPU/req will throw error 1102 on big `JSON.parse`. Highest effort, real risk.
3. **Stay on Railway Hobby** — $5/mo, zero work, most reliable. Cheapest "do nothing" fallback.

DB: Upstash Free (existing) = 256 MB / 500k commands-mo — adequate for ~20 users, but history snapshots + pool ops burn commands; watch usage or accept Pay-As-You-Go ($0.20/100k cmd) later.

## DB alternatives on Cloudflare (free tier) — Sep 2026

| Store | Free limits | Fit for SheetSubmit |
|---|---|---|
| **Upstash Redis (keep)** | 256 MB, 10 GB bw, 500k cmd/mo | Zero data-model change; REST works natively from Workers; **WATCH/MULTI unsupported via REST** → port atomic ops (files/pools/history) to Lua `EVAL` (supported) |
| **Durable Objects (SQLite)** | 5 GB/account, 100 classes, unlimited objects, DOs on free plan | Best CF-native fit: single-threaded DO per file/pool = atomic updates without WATCH/MULTI; alarms replace backup/GC loops; biggest rewrite |
| **D1 (SQLite)** | 500 MB/DB, 5 GB/account, 10 DBs, 2 MB row size, 50 queries/invocation | Solid general DB; row-per-row sheet storage needed (2 MB row cap vs current whole-file JSON docs); daily row quotas per D1 pricing (5M reads/100k writes per day on free) |
| **Workers KV** | 100k reads/day, **1,000 writes/day** | ❌ Dead on arrival for primary store — cache-only |
| R2 | 10 GB free | Object storage (export dumps), not a DB |

Sources: https://developers.cloudflare.com/d1/platform/limits/ · https://developers.cloudflare.com/kv/platform/limits/ · https://developers.cloudflare.com/durable-objects/platform/limits/ (2026-04/06)

**Convex** (free: 1M function calls/mo, 1 GB storage, built-in crons) — possible but = full backend rewrite into Convex functions; no advantage over Workers+D1/DO for this app. https://www.convex.dev/pricing
**Supabase** (free: 500 MB Postgres, projects **pause after 1 week of inactivity**) — not recommended; Redis-shaped code → Postgres rewrite + pause risk. https://supabase.com/pricing

### Cloudflare-only $0 stack (recommended)
1. **Frontend:** CF Pages (unlimited static, 500 builds/mo)
2. **Backend:** Hono on CF Workers — Express→Hono mechanical port; bot → webhook; Cron Triggers (5 free) for GC/backup; xlsx moved client-side (frontend already has `lib/xlsx.ts`); persist payloads capped well under limits (10 ms CPU/req on free)
3. **DB:** Upstash REST (smallest change) → later D1 or Durable Objects if 256 MB/500k cmd/mo gets tight
