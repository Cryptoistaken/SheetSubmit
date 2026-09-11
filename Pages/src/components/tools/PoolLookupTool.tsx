import { useState } from "react";
import { useNavigate } from "react-router";

import { api } from "@/lib/api";
import type { PoolDiag, PoolDiagFound } from "@/lib/api";

function foundReason(f: PoolDiagFound, searched: string): string {
  if (f.archived) return "file is archived - archived files do not feed pools.";
  if (!f.poolEnabled) return "pool is switched off for this file.";
  if (!f.password) return "file has no pool password.";
  if (!f.key) return "row has neither uid nor c_user - it has no pool key.";
  if (f.key !== searched) return `pool key is ${f.key}, not ${searched} - look that key up instead.`;
  if (!f.live) return `not live (status "${f.status || "blank"}") - dead/bad or keyless rows never pool.`;
  if (!f.pool) return "not classifiable - unexpected for a live row with a key.";
  if (!f.has2fa) return `eligible for ${f.pool} only with a real 2FA key - currently keyless.`;
  return `eligible for ${f.pool} - the feed never ran for it or failed silently. Re-save the file to force a feed.`;
}

export default function PoolLookupTool() {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [result, setResult] = useState<PoolDiag | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const k = key.trim();
    if (!k || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.adminPoolDiag(k));
    } catch {
      setError("Lookup failed. Check your connection.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const fileName = (fid: string | null) =>
    (fid && result?.files.find((f) => f.fileId === fid)?.name) || (fid ? "…" + fid.slice(-6) : "-");

  const verdict = (() => {
    if (!result) return null;
    if (result.blocked.length) {
      const b = result.blocked[0];
      return b.reason === "sold"
        ? "Already sold - permanently blocked from pooling. Re-uploads are removed at feed time."
        : "Died while on hold - permanently blocked from pooling. Re-uploads are removed at feed time.";
    }
    const live = result.rows.filter((r) => r.state === "available");
    if (live.length) {
      const r = live[0];
      return `Available under ${r.password} / ${r.pool_id}${live.length > 1 ? ` (+${live.length - 1} more)` : ""} - every other password skips it while it is pooled here.`;
    }
    const taken = result.rows.filter((r) => r.state === "held" || r.state === "claimed");
    if (taken.length) {
      const r = taken[0];
      return `Taken (${r.state}) under ${r.password} / ${r.pool_id} - correctly absent from available.`;
    }
    if (result.rows.length) return "Only dead husks remain - re-save the file to force a re-feed and it should re-pool.";
    if (result.rejects.length) {
      const r = result.rejects[0];
      return `Marked invalid under ${r.password} / ${r.pool_id} - at feed time it had no real 2FA (or a No_2Fa skip).`;
    }
    if (result.downloads.length) {
      const d = result.downloads[0];
      return `Taken before (${d.status}) from ${d.password} / ${d.pool_id} - sold accounts never re-enter pools.`;
    }
    if (result.found.length) return foundReason(result.found[0], result.key);
    return "Nowhere: not in any file either - wrong key, or the row was deleted. Check uid vs c_user.";
  })();

  return (
    <div>
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate("/tools")} aria-label="Back to Tools">← Tools</button>
      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Pool lookup</h2>
      <p style={{ fontSize: 13, color: "var(--text3)", marginTop: 2, marginBottom: 16 }}>Enter a uid or c_user to see where that account lives across all pools</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="modal-input"
          style={{ flex: 1 }}
          type="text"
          aria-label="Account uid or c_user"
          placeholder="uid or c_user…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={loading || !key.trim()} onClick={() => void run()}>
          {loading ? "Looking…" : "Look up"}
        </button>
      </div>

      {error ? <div role="alert" style={{ fontSize: 13, color: "var(--red)", marginBottom: 8 }}>{error}</div> : null}
      {verdict ? <div role="status" style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{verdict}</div> : null}

      {result && result.blocked.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--red)" }}>BLOCKED ({result.blocked.length})</div>
          {result.blocked.map((b, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--red)" }}>
              <span className="font-mono text-xs">{b.reason}</span>
              <span className="text-xs text-muted-foreground">{[b.password, b.pool_id].filter(Boolean).join(" / ") || "history"}{b.hold_id ? ` · hold …${b.hold_id.slice(-6)}` : ""}</span>
            </div>
          ))}
        </div>
      ) : null}

      {result && result.rows.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)" }}>POOL ROWS</div>
          {result.rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              <span className="font-mono text-xs">{r.password} / {r.pool_id}</span>
              <span className="text-xs text-muted-foreground">{r.state} · {fileName(r.src_file_id)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {result && result.found.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)" }}>IN FILES ({result.found.length})</div>
          {result.found.map((f, i) => (
            <div key={i} className="rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{f.fileName ?? "…" + f.fileId.slice(-6)}</span>
                <span className="font-mono text-xs">{f.password || "no-password"} / {f.preset ?? "no-preset"}{f.poolEnabled ? "" : " · pool OFF"}{f.archived ? " · archived" : ""}</span>
              </div>
              <div className="text-xs text-muted-foreground" style={{ marginTop: 2 }}>
                row {f.idx + 1} · status “{f.status || "blank"}” · 2FA {f.has2fa ? "yes" : "no"} · key {f.key || "none"} · {f.pool ? `feeds ${f.pool}` : "pools nowhere"}
              </div>
              <div className="text-xs" style={{ marginTop: 2 }}>{foundReason(f, result.key)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
