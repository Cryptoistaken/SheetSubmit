// agent/env.ts — loads secrets from agent/.env (this folder, gitignored).
// Real environment variables always win; the file only fills gaps.
// Tokens never touch git — agent/.env matches the .env gitignore rule.
export async function loadAgentEnv() {
  let text = "";
  try { text = await Bun.file(`${import.meta.dir}/.env`).text(); } catch { return; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && Bun.env[k] === undefined && v) Bun.env[k] = v;
  }
}
