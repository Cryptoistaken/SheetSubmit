#!/usr/bin/env bun
// Incremental redeploy — builds/pushes only changed images, then triggers Railway.
// Usage: bun run scripts/redeploy.ts [--backend|--frontend|--all|--force] [--dry-run]
// No args = auto-detect via git diff vs HEAD + untracked files.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const envPath = join(root, "deploy.env");

function loadEnv() {
  if (!existsSync(envPath)) {
    console.error("deploy.env not found. Copy deploy.env.example to deploy.env");
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) process.env[k] = v;
  }
}
loadEnv();

const args = process.argv.slice(2);
const wantBackend = args.includes("--backend");
const wantFrontend = args.includes("--frontend");
const wantAll = args.includes("--all") || args.includes("--force");
const dryRun = args.includes("--dry-run");

function sh(cmd: string, opts: { cwd?: string } = {}) {
  console.log(`> ${cmd}`);
  if (dryRun) return 0;
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: opts.cwd ?? root });
  return r.status ?? 1;
}

function gitChanged(): string[] {
  try {
    const a = execSync("git diff --name-only HEAD", { cwd: root, encoding: "utf8" }).trim();
    const b = execSync("git ls-files --others --exclude-standard", { cwd: root, encoding: "utf8" }).trim();
    const c = execSync("git diff --name-only", { cwd: root, encoding: "utf8" }).trim();
    const all = [a, b, c].join("\n").split("\n").map(s => s.trim()).filter(Boolean);
    return [...new Set(all)];
  } catch {
    return [];
  }
}

let needBackend = false;
let needFrontend = false;

if (wantAll) {
  needBackend = needFrontend = true;
} else if (wantBackend || wantFrontend) {
  needBackend = wantBackend;
  needFrontend = wantFrontend;
} else {
  const changed = gitChanged();
  if (changed.length === 0) {
    // No git info or clean tree — build both to be safe (old behavior).
    console.log("No git changes detected — building both images.");
    needBackend = needFrontend = true;
  } else {
    console.log("Changed files:\n " + changed.join("\n "));
    const isBackend = (f: string) => f.startsWith("backend/");
    const isFrontend = (f: string) => f.startsWith("frontend/");
    const isShared = (f: string) => ["package.json", "bun.lock", "Dockerfile", ".dockerignore"].some(x => f === x || f.endsWith(x));
    needBackend = changed.some(f => isBackend(f) || isShared(f));
    needFrontend = changed.some(f => isFrontend(f) || isShared(f));
    // Root-level changes that touch both (e.g. PLAN.md only) shouldn't trigger builds.
    // If change is only docs/specs, skip both and ask.
    const onlyDocs = changed.every(f => f.endsWith(".md") || f.endsWith(".html") || f === "AUDIT-ISSUES.md" || f.startsWith("scripts/"));
    if (onlyDocs && !needBackend && !needFrontend) {
      console.log("Only docs changed — nothing to build. Use --all to force.");
      process.exit(0);
    }
    // If nothing matched but there are backend/frontend untracked new files (e.g. new pools.ts), the prefix check already covers them.
    // Fallback: if still none, build both if there are any non-doc changes.
    if (!needBackend && !needFrontend) {
      const hasCode = changed.some(f => !f.endsWith(".md") && !f.endsWith(".html"));
      if (hasCode) { needBackend = needFrontend = true; }
    }
  }
}

console.log(`Plan: backend=${needBackend} frontend=${needFrontend}${dryRun ? " (dry-run)" : ""}`);

let builtBackend = false;
let builtFrontend = false;

if (needBackend) {
  let code = sh("docker build -f backend/Dockerfile -t popyog/sheetsubmit-testmycode-backend:latest backend");
  if (code !== 0) process.exit(code);
  code = sh("docker push popyog/sheetsubmit-testmycode-backend:latest");
  if (code !== 0) process.exit(code);
  builtBackend = true;
} else {
  console.log("Skipping backend — no changes.");
}

if (needFrontend) {
  let code = sh("docker build -f frontend/Dockerfile -t popyog/sheetsubmit-testmycode-frontend:latest frontend");
  if (code !== 0) process.exit(code);
  code = sh("docker push popyog/sheetsubmit-testmycode-frontend:latest");
  if (code !== 0) process.exit(code);
  builtFrontend = true;
} else {
  console.log("Skipping frontend — no changes.");
}

if (!dryRun) {
  const token = process.env.RAILWAY_TOKEN;
  const backendUrl = process.env.BACKEND_URL;
  const frontendUrl = process.env.FRONTEND_URL;
  if (builtBackend && token && backendUrl) {
    console.log("\nTriggering Railway backend redeploy…");
    sh(`curl.exe -s -X POST -H "Authorization: Bearer ${token}" "${backendUrl}/__redeploy"`);
  } else if (needBackend) {
    console.log("Skipping backend redeploy trigger (missing RAILWAY_TOKEN/BACKEND_URL or dry-run).");
  }
  if (builtFrontend && token && frontendUrl) {
    console.log("Triggering Railway frontend redeploy…");
    sh(`curl.exe -s -X POST -H "Authorization: Bearer ${token}" "${frontendUrl}/__redeploy"`);
  } else if (needFrontend) {
    console.log("Skipping frontend redeploy trigger (missing RAILWAY_TOKEN/FRONTEND_URL or dry-run).");
  }
}

console.log("\nDone! " + (builtBackend ? "backend " : "") + (builtFrontend ? "frontend " : "") + "redeployed.");
