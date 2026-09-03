import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import type { PoolDetail, PoolSummary } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";

const PASSWORDS = ["dgddigital", "L0VE@12345"] as const;
const POOL_TABS = [
  { id: "cookies_only", label: "Cookies", badge: "Cookies" },
  { id: "cookies_2fa", label: "2FA", badge: "2FA" },
  { id: "page", label: "Page", badge: "Page" },
] as const;
type PoolId = (typeof POOL_TABS)[number]["id"];

function displayName(u: PoolDetail["users"][number]) {
  const name = (u.displayName || u.displayName === undefined ? (u as unknown as { displayName?: string }).displayName : "")?.trim() ?? "";
  const uname = (u as unknown as { username?: string }).username;
  const raw: Record<string, unknown> = u as unknown as Record<string, unknown>;
  const n = String(raw["name"] ?? raw["displayName"] ?? "").trim();
  const un = String(raw["username"] ?? "").trim();
  if (n && un) return { line1: n, line2: "@" + un };
  if (un) return { line1: "@" + un, line2: "" };
  if (n) return { line1: n, line2: "#" + u.userId.slice(-6) };
  if (name) return { line1: name, line2: uname ? "@" + uname : "#" + u.userId.slice(-6) };
  return { line1: "#" + u.userId, line2: "" };
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const w = window as unknown as { Android?: { download?: (n: string, d: string) => void } };
  if (typeof w.Android?.download === "function") {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      w.Android!.download!(filename, dataUrl);
    };
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PoolsView() {
  const params = useParams<{ password: string; poolId: string }>();
  const navigate = useNavigate();
  const showToast = useToast();
  const confirm = useConfirm();

  const curPwd = PASSWORDS.includes(params.password as never) ? params.password! : "dgddigital";
  const cur = (POOL_TABS.find((t) => t.id === params.poolId)?.id as PoolId) || "cookies_only";

  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [search, setSearch] = useState("");
  const [poolQty, setPoolQty] = useState<number | "all">(10);
  const [customQty, setCustomQty] = useState("");
  const [customFocused, setCustomFocused] = useState(false);
  const [menuUser, setMenuUser] = useState<string | null>(null);
  const [dlUser, setDlUser] = useState<PoolDetail["users"][number] | null>(null);
  const [perQty, setPerQty] = useState<number | "all">(10);
  const [perCustom, setPerCustom] = useState("");
  const [perCustomFocused, setPerCustomFocused] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloads, setDownloads] = useState<unknown[] | null>(null);
  const [reDownloading, setReDownloading] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const ps = await api.getPools();
      const list = (ps as { pools: PoolSummary[] }).pools ?? (ps as unknown as PoolSummary[]);
      setPools(list);
      const d = await api.getPoolDetail(curPwd, cur);
      setDetail(d);
      try {
        const dls = await api.getDownloads() as unknown;
        const arr: unknown[] = Array.isArray(dls) ? dls : ((dls as { downloads?: unknown[] })?.downloads ?? []);
        setDownloads((arr as unknown[]).slice(0, 10));
      } catch { /* ignore history */ }
    } catch {
      showToast("Failed to load pools");
    }
  }, [cur, curPwd, showToast]);

  useEffect(() => { load(); }, [load]);

  const poolCounts: Record<string, number> = {};
  if (pools) pools.filter((p) => (p as unknown as Record<string, unknown>)["password"] === curPwd || !(p as unknown as Record<string, unknown>)["password"]).forEach((p) => { poolCounts[p.id] = p.available; });

  const poolMeta = POOL_TABS.find((t) => t.id === cur) ?? POOL_TABS[0];
  const totals = detail?.totals ?? { available: 0, claimed: 0, users: 0 };

  const filtered = detail ? detail.users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const d = displayName(u);
    return [d.line1, d.line2, u.userId].some((s) => s.toLowerCase().includes(q));
  }) : [];

  const go = (pwd: string, pid: string) => navigate(`/pools/${pwd}/${pid}`);

  const doPoolClaim = async () => {
    const n = customQty ? Number(customQty) : poolQty;
    if (!totals.available) return showToast("No available rows");
    setDownloading(true);
    try {
      const res = await api.claimPool(curPwd, cur, { count: n });
      if (!res.claimed) return showToast("Nothing claimed");
      const filename = (res as unknown as { filename?: string }).filename || (cur === "cookies_only" ? "cookies_pool.xlsx" : cur === "cookies_2fa" ? "2fa_pool.xlsx" : "page_pool.xlsx");
      const downloadId = (res as unknown as { downloadId?: string }).downloadId;
      if (downloadId) {
        const blob = await api.getDownloadBlob(downloadId);
        triggerBlobDownload(blob, filename);
      } else {
        // fallback: client-side generation if server didn't return downloadId
        const XLSX = await import("xlsx");
        const cols = cur === "cookies_only" ? ["cookies"] : ["cookies", "twofakey"];
        const data = (res.rows as Record<string, unknown>[]).map((r) => cols.map((c) => String(r[c] ?? "")));
        const ws = XLSX.utils.aoa_to_sheet(data as string[][]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1"); XLSX.writeFile(wb, filename);
      }
      showToast(`Claimed ${res.claimed} from ${poolMeta.label} — ${filename}`);
      await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doUserClaim = async () => {
    if (!dlUser) return;
    const n = perCustom ? Number(perCustom) : perQty;
    setDownloading(true);
    try {
      const res = await api.claimPool(curPwd, cur, { count: n, userId: dlUser.userId });
      if (!res.claimed) return showToast("Nothing claimed");
      const filename = (res as unknown as { filename?: string }).filename || (cur === "cookies_only" ? "cookies_pool.xlsx" : cur === "cookies_2fa" ? "2fa_pool.xlsx" : "page_pool.xlsx");
      const downloadId = (res as unknown as { downloadId?: string }).downloadId;
      if (downloadId) {
        const blob = await api.getDownloadBlob(downloadId);
        triggerBlobDownload(blob, filename);
      } else {
        const XLSX = await import("xlsx");
        const cols = cur === "cookies_only" ? ["cookies"] : ["cookies", "twofakey"];
        const data = (res.rows as Record<string, unknown>[]).map((r) => cols.map((c) => String(r[c] ?? "")));
        const ws = XLSX.utils.aoa_to_sheet(data as string[][]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1"); XLSX.writeFile(wb, filename);
      }
      showToast(`Claimed ${res.claimed} from ${displayName(dlUser).line1}`);
      setDlUser(null); await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doRedownload = async (id: string, filename: string) => {
    setReDownloading(id);
    try {
      const blob = await api.getDownloadBlob(id);
      triggerBlobDownload(blob, filename || "download.xlsx");
      showToast(`Downloaded ${filename || id}`);
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setReDownloading(null); }
  };
  const doRevert = async (id: string) => {
    const ok = await confirm("Give back this download? Items will return to pool and Taken will be cleared.", "Give back");
    if (!ok) return;
    setReverting(id);
    try {
      const res = await api.revertDownload(id) as unknown as { reverted?: number };
      showToast(`Reverted ${res.reverted ?? ""} items — returned to pool`);
      await load();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setReverting(null); }
  };

  const openFile = async (u: PoolDetail["users"][number]) => {
    setMenuUser(null);
    try {
      const r = await api.getPoolRows(curPwd, cur, { userId: u.userId, limit: 1 });
      const first = r.rows[0] as Record<string, unknown> | undefined;
      const fid = first?.["srcFileId"] as string | undefined;
      if (fid) { navigate(`/admin/user/${u.userId}/file/${fid}`); return; }
    } catch {}
    showToast("No file found for this user in this pool");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .pool-switch{display:inline-flex;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;gap:3px}
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2)}
        .badge.page{background:#fffbeb;color:#b45309;border-color:#fde68a}
        .badge.taken{background:var(--bg3);color:var(--text3)}
        .admin-wrap{position:relative;display:inline-flex;flex-shrink:0}
        .admin-dot{position:absolute;right:-3px;bottom:-3px;width:14px;height:14px;border-radius:50%;background:var(--blue);border:2px solid var(--bg);display:grid;place-items:center;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15)}
        .taken-row td{position:relative}
        .taken-row td .cell-text{color:rgba(255,255,255,.72)!important}
        @media(max-width:640px){.pools-stack{flex-direction:column;align-items:stretch}.pools-switch{width:100%}.pools-switch button{flex:1;justify-content:center}.pools-toolbar{flex-direction:column;align-items:stretch}.pools-qty{width:100%}.pools-qty button{flex:1}.pools-download{width:100%;height:44px;justify-content:center}.pools-stats{grid-template-columns:1fr!important}}
      `}</style>

      {/* header + switches — purely pools */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em" }}>Pools <span style={{ fontWeight: 500, color: "var(--text3)", fontSize: 13 }}>— admin only</span></div>
          <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 4 }}>Auto-pooling: every save auto-classifies rows (Cookies = 1-col, 2FA/Page = 2-col). Promotion Cookies→2FA→Page is automatic.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="pool-switch" style={{ background: "#eef2ff", borderColor: "#ddd6fe" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}>{p}</button>
            ))}
          </div>
          <div className="pool-switch">
            {POOL_TABS.map((t) => (
              <button key={t.id} className={cur === t.id ? "active" : ""} onClick={() => go(curPwd, t.id)}>
                {t.label} <span className="badge" style={{ marginLeft: 6 }}>{poolCounts[t.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>Password switch is simple as you asked: <b>dgddigital | L0VE@12345</b> (Custom hidden in UI). File creation shows 2 cards only.</div>

      {/* stats */}
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Available in {poolMeta.label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.available}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>Pool: {cur === "cookies_only" ? "cookies valid, 2FA empty" : cur === "cookies_2fa" ? "cookies + 2FA" : "cookies + 2FA + green dot"}</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Claimed (Taken)</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.claimed}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>Removed from pool · blue lock in owner's file</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Users in pool</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{totals.users}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>Per-user breakdown below</div>
        </div>
      </div>

      {/* toolbar — download qty only */}
      <div className="pools-toolbar pools-stack" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", marginTop: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="pools-qty" style={{ display: "inline-flex", border: "1px solid var(--border2)", borderRadius: 8, overflow: "hidden" }}>
            {[10, 50, 100].map((n) => (
              <button key={n} onClick={() => { setPoolQty(n); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === n && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === n && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>{n}</button>
            ))}
            <button onClick={() => { setPoolQty("all"); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === "all" && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === "all" && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>All</button>
            <input
              placeholder={customFocused ? "" : "Custom"}
              aria-label="Custom quantity"
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value.replace(/\D/g, ""))}
              onFocus={(e) => { setCustomFocused(true); e.currentTarget.select(); }}
              onBlur={() => setCustomFocused(false)}
              style={{ width: 72, border: "none", padding: "7px 8px", fontSize: 13, textAlign: "center", outline: "none", background: customQty ? "var(--bg3)" : customFocused ? "var(--bg)" : "var(--bg)", borderLeft: customFocused ? "1px solid var(--border2)" : "none", cursor: customQty || customFocused ? "text" : "pointer" }}
            />
          </div>
          <button className="btn btn-primary pools-download" disabled={downloading || !totals.available} onClick={doPoolClaim} style={{ boxShadow: "0 1px 6px rgba(0,112,243,.18)", fontWeight: 600 }}>Download {customQty ? Number(customQty) || 0 : poolQty === "all" ? "All" : poolQty} from {poolMeta.label}</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>You will claim <b>{customQty ? Number(customQty) || 0 : poolQty === "all" ? totals.available : poolQty as number}</b> of <b>{totals.available}</b> — {Math.max(0, totals.available - (customQty ? Number(customQty) || 0 : poolQty === "all" ? totals.available : poolQty as number))} will remain. {poolMeta.label === "Cookies" ? "1-col XLSX (cookies)" : "2-col XLSX (cookies+2fa)"} • file: {cur === "cookies_only" ? "cookies_pool.xlsx" : cur === "cookies_2fa" ? "2fa_pool.xlsx" : "page_pool.xlsx"}</div>

      {/* search — at top of users list, separate from download */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, marginBottom: 8 }}>
        <label style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 10, color: "var(--text3)", pointerEvents: "none" }}><circle cx="11" cy="11" r="7" /><path d="M20 20L16 16" /></svg>
          <input className="admin-search-input" placeholder="Search user…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" style={{ width: 240, maxWidth: "48vw", paddingLeft: 32 }} />
        </label>
      </div>

      {/* user table */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", overflow: "auto", background: "var(--bg)", marginTop: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 520 }}>
          <thead><tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--text3)" }}><th style={{ padding: "10px 12px" }}>User</th><th style={{ padding: "10px 12px" }}>Available</th><th style={{ padding: "10px 12px" }}>Claimed</th><th style={{ width: 44 }}></th></tr></thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--text3)" }}>No users in this pool</td></tr> : filtered.map((u) => {
              const d = displayName(u);
              const isAdmin = (u as unknown as Record<string, unknown>)["isAdmin"] as boolean | undefined;
              return (
                <tr key={u.userId} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="admin-wrap">
                        {u.photoUrl ? <img src={u.photoUrl} alt="" style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)" }} /> : <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--bg3)", display: "grid", placeItems: "center", fontWeight: 700, border: "1px solid var(--border)" }}>{d.line1.charAt(0).toUpperCase()}</span>}
                        {isAdmin ? <span className="admin-dot"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M5 13l4 4L19 7" /></svg></span> : null}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.line1}</div>
                        {d.line2 ? <div style={{ fontSize: 12, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.line2}</div> : null}
                      </span>
                    </div>
                  </td>
                  <td style={{ fontFamily: "var(--mono)", padding: "10px 12px" }}>{u.available}</td>
                  <td style={{ padding: "10px 12px" }}><span className="badge taken">{u.claimed} Taken</span></td>
                  <td style={{ padding: "8px", position: "relative" }}>
                    <button className="btn" style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }} onClick={() => setMenuUser(menuUser === u.userId ? null : u.userId)}>⋯</button>
                    {menuUser === u.userId ? (
                      <div style={{ position: "absolute", right: 8, top: 40, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--rl)", boxShadow: "var(--shadow-lg)", zIndex: 10, minWidth: 160, padding: 4 }}>
                        <button style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontWeight: 500 }} onClick={() => openFile(u)}>View file</button>
                        <button style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "var(--blue)", color: "#fff", cursor: "pointer", borderRadius: 6, fontWeight: 700, marginTop: 4 }} onClick={() => { setMenuUser(null); setDlUser(u); setPerQty(10); setPerCustom(""); }}>Download</button>
                        {isAdmin ? <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 10px" }}>No delete/ban for admin</div> : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* download history — below user table, above fileView */}
      <div style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)", padding: 14, overflow: "auto" }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Recent downloads — re-download or give back</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>Up to 10 most recent claims. Re-download if file missed; <b>Give back</b> returns items to pool and clears Taken.</div>
        {!downloads || downloads.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: "12px 0", textAlign: "center" }}>{downloads === null ? "Loading…" : "No downloads yet — claim from the pool above."}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
            <thead><tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--text3)", fontSize: 12 }}><th style={{ padding: "8px 8px" }}>Date</th><th style={{ padding: "8px 8px" }}>Pool</th><th style={{ padding: "8px 8px" }}>Password</th><th style={{ padding: "8px 8px" }}>Claimed</th><th style={{ padding: "8px 8px" }}>Filename</th><th style={{ width: 200 }}></th></tr></thead>
            <tbody>
              {(downloads as unknown as { id: string; at: number; poolId: string; password: string; claimed: number; filename: string; reverted?: boolean }[]).map((d) => {
                const dt = d.at ? new Date(d.at).toLocaleString() : "—";
                const isReverted = !!(d as unknown as { reverted?: boolean }).reverted;
                return (
                  <tr key={d.id} style={{ borderBottom: "1px solid var(--border)", opacity: isReverted ? 0.6 : 1 }}>
                    <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{dt}</td>
                    <td style={{ padding: "8px" }}><span className="badge">{d.poolId}</span></td>
                    <td style={{ padding: "8px", fontFamily: "var(--mono)", fontSize: 12 }}>{d.password}</td>
                    <td style={{ padding: "8px", fontFamily: "var(--mono)" }}>{d.claimed} {isReverted ? <span style={{ fontSize: 10, color: "var(--green)", marginLeft: 6, fontWeight: 600 }}>REVERTED</span> : null}</td>
                    <td style={{ padding: "8px", fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.filename}>{d.filename}</td>
                    <td style={{ padding: "8px", display: "flex", gap: 6 }}>
                      <button className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={reDownloading === d.id || isReverted} onClick={() => doRedownload(d.id, d.filename)}>{reDownloading === d.id ? "…" : "Download"}</button>
                      <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, color: isReverted ? "var(--text3)" : "var(--red)" }} disabled={reverting === d.id || isReverted} onClick={() => doRevert(d.id)}>{reverting === d.id ? "…" : isReverted ? "Given back" : "Give back"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {dlUser ? (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setDlUser(null); }}>
          <div className="modal-box" role="dialog" aria-modal="true" style={{ width: 360 }}>
            <div className="modal-title">Download from {displayName(dlUser).line1}</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>Available: {dlUser.available} · Claimed: {dlUser.claimed}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {[10, 50].map((n) => <button key={n} className={`btn ${perQty === n && !perCustom ? "btn-primary" : ""}`} onClick={() => { setPerQty(n); setPerCustom(""); }}>{n}</button>)}
              <button className={`btn ${perQty === "all" && !perCustom ? "btn-primary" : ""}`} onClick={() => { setPerQty("all"); setPerCustom(""); }}>All</button>
              <input
                placeholder={perCustomFocused ? "" : "Custom"}
                aria-label="Custom quantity"
                value={perCustom}
                onChange={(e) => setPerCustom(e.target.value.replace(/\D/g, ""))}
                onFocus={(e) => { setPerCustomFocused(true); e.currentTarget.select(); }}
                onBlur={() => setPerCustomFocused(false)}
                style={{ width: 72, padding: "6px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: "var(--r)", outline: "none", textAlign: "center", cursor: perCustom || perCustomFocused ? "text" : "pointer", background: perCustom ? "var(--bg3)" : "var(--bg)" }}
              />
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>You will claim {perCustom ? Number(perCustom) || 0 : perQty === "all" ? dlUser.available : perQty as number} of {dlUser.available}</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDlUser(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={downloading} onClick={doUserClaim}>Download & claim</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
