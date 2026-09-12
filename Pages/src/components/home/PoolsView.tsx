import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ExternalLink, MoreVertical } from "lucide-react";
import { api } from "@/lib/api";
import type { PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import type { PoolLivePatch } from "@/lib/poolLive";
import { usePoolLive } from "@/hooks/usePoolLive";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import { useProfileCache } from "@/stores/profileCache";
import { useAuth } from "@/contexts/AuthContext";
import { vibrate } from "@/lib/utils";

import { CookieIcon, FileTypeIcon, PageIcon, PasswordIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import { FacebookIcon } from "@/components/icons/FacebookIcon";
import EmptyState from "./EmptyState";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import SearchInput from "@/components/ui/search-input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const PASSWORDS = ["dgddigital", "L0VE@12345"] as const;
const POOL_TABS = [
  { id: "cookies_only", label: "Cookies", badge: "Cookies" },
  { id: "cookies_2fa", label: "2FA", badge: "2FA" },
  { id: "page", label: "Page", badge: "Page" },
] as const;
type PoolId = (typeof POOL_TABS)[number]["id"];

const POOL_META: Record<string, { label: string; Icon: typeof CookieIcon }> = {
  cookies_only: { label: "Cookies", Icon: CookieIcon },
  cookies_2fa: { label: "2FA", Icon: TwoFaIcon },
  page: { label: "Page", Icon: PageIcon },
};

const PoolTypeIcon = ({ poolId, size = 16 }: { poolId: string; size?: number }) => {
  const Icon = (POOL_META[poolId] ?? POOL_META.cookies_only).Icon;
  return <Icon size={size} />;
};
export { PoolTypeIcon };

// Owners list shows the name only (first two words) — never the username.
function shortOwnerName(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
}
function displayName(u: PoolDetail["users"][number]) {
  const raw: Record<string, unknown> = u as unknown as Record<string, unknown>;
  const n = String(raw["name"] ?? raw["displayName"] ?? "").trim();
  if (n) return { line1: shortOwnerName(n), line2: "" };
  return { line1: "#" + u.userId, line2: "" };
}

export default function PoolsView() {
  const params = useParams<{ password: string; poolId: string }>();
  const navigate = useNavigate();
  const showToast = useToast();
  const curPwd = PASSWORDS.includes(params.password as never) ? params.password! : "dgddigital";
  const cur = (POOL_TABS.find((t) => t.id === params.poolId)?.id as PoolId) || "cookies_only";
  const { user: me } = useAuth();
  const meIsAdmin = Boolean(me?.isAdmin);

  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [search, setSearch] = useState("");
  const [poolQty, setPoolQty] = useState<number | "all">(10);
  const [customQty, setCustomQty] = useState("");
  const [customFocused, setCustomFocused] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userFiles, setUserFiles] = useState<PoolUserFile[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [verified, setVerified] = useState<VerifiedCounts | null>(null);
  const { profiles: cachedProfiles, fetchProfiles } = useProfileCache();


  const [holdMode, setHoldMode] = useState<"fifo" | "pick">("fifo");
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  // prices (read-only here — editing lives on the Settings page)
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [priceCurrency] = useCurrency();

  const loadPrices = useCallback(async () => {
    const allPrices: Record<string, number | null> = {};
    await Promise.all(POOL_TABS.map(async (t) => {
      try { const pr = await api.getPoolPrice(curPwd, t.id); allPrices[t.id] = pr.price; } catch { allPrices[t.id] = null; }
    }));
    setPrices(allPrices);
  }, [curPwd]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [ps, d, uf] = await Promise.all([
        api.getPools(),
        api.getPoolDetail(curPwd, cur),
        api.getUserFiles(curPwd, cur).catch(() => ({ users: [] }) as unknown as { users: [] }),
      ]);
      const list = (ps as { pools: PoolSummary[] }).pools ?? (ps as unknown as PoolSummary[]);
      setPools(list);
      setDetail(d);
      try { useProfileCache.getState().setProfiles(d.users as unknown[]); } catch {}
      setUserFiles((uf as { users: never[] }).users ?? []);
    } catch { setLoadFailed(true); showToast("Unable to load pools. Please try again."); }
  }, [cur, curPwd, showToast]);

  const refreshAll = useCallback(async () => { await Promise.all([load(), loadPrices()]); }, [load, loadPrices]);

  useEffect(() => { load(); loadPrices(); }, [load, loadPrices]);

  useEffect(() => {
    const onFocus = () => { loadPrices(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadPrices]);

  useEffect(() => {
    if (cur !== "page") { setVerified(null); return; }
    let cancelled = false;
    api.getVerifiedCounts(curPwd, cur).then((r) => { if (!cancelled) setVerified(r); }).catch(() => { if (!cancelled) setVerified(null); });
    return () => { cancelled = true; };
  }, [cur, curPwd]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);
  useEffect(() => { setSelectedUids([]); setSelectedFileIds([]); }, [cur, curPwd]);

  // Live pool counts: patch badges + totals + verified split + users[]
  // in place on every push — never a full load(). Keyed on (curPwd, cur).
  const applyPoolPatch = useCallback((patch: PoolLivePatch) => {
    if (patch.badges) {
      const avail = new Map(patch.badges.map((b) => [b.id, b.available]));
      setPools((prev) => (prev ? prev.map((p) => {
        if ((p as unknown as Record<string, unknown>).password !== undefined
          && (p as unknown as Record<string, unknown>).password !== curPwd) return p;
        return avail.has(p.id) ? { ...p, available: avail.get(p.id) ?? p.available } : p;
      }) : prev));
    }
    if (patch.totals || patch.usersList) {
      setDetail((prev) => {
        if (!prev || prev.password !== curPwd || prev.pool.id !== cur) return prev;
        return {
          ...prev,
          totals: { ...prev.totals, ...(patch.totals ?? {}) },
          users: patch.usersList ?? prev.users,
        };
      });
      if (patch.usersList) {
        try { useProfileCache.getState().setProfiles(patch.usersList as unknown[]); } catch {}
      }
    }
    if (patch.verified && cur === "page") {
      const v = patch.verified;
      setVerified((prev) => (prev
        ? { ...prev, verified: v.verified, unverified: v.unverified, totalAvailable: v.totalAvailable }
        : { pool: cur, verified: v.verified, unverified: v.unverified, totalAvailable: v.totalAvailable, truncated: false, scanCap: 0 }));
    }
  }, [cur, curPwd]);
  usePoolLive(curPwd, cur, detail !== null, applyPoolPatch);

  const poolCounts: Record<string, number> = {};
  if (pools) pools.filter((p) => (p as unknown as Record<string, unknown>)["password"] === curPwd || !(p as unknown as Record<string, unknown>)["password"]).forEach((p) => { poolCounts[p.id] = p.available; });

  const poolMeta = POOL_TABS.find((t) => t.id === cur) ?? POOL_TABS[0];
  const totals = detail?.totals ?? { available: 0, claimed: 0, users: 0 };
  const takeN = customQty ? Number(customQty) || 0 : poolQty === "all" ? (cur === "page" && verified ? verified.verified : totals.available) : poolQty as number;
  const pickAvail = useMemo(() => {
    if (selectedFileIds.length) {
      return userFiles?.reduce((sum, u) => sum + u.files.filter((f) => selectedFileIds.includes(f.fileId)).reduce((s, f) => s + f.available, 0), 0) ?? 0;
    }
    return detail?.users.filter((u) => selectedUids.includes(u.userId)).reduce((s, u) => s + u.available, 0) ?? 0;
  }, [selectedFileIds, selectedUids, userFiles, detail]);
  const effectiveN = holdMode === "pick" && (selectedUids.length || selectedFileIds.length) ? Math.min(takeN, pickAvail) : takeN;
  const unitPrice = prices[cur];

  const filtered = detail ? detail.users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const raw = u as unknown as Record<string, unknown>;
    const d = displayName(u);
    return [d.line1, String(raw["name"] ?? raw["displayName"] ?? ""), String(raw["username"] ?? ""), u.userId].some((s) => s.toLowerCase().includes(q));
  }) : [];

  const go = (pwd: string, pid: string) => {
    navigate(`/pools/${pwd}/${pid}`);
  };

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    if (!userFiles?.find((x) => x.userId === userId)) {
      setLoadingFiles(true);
      try { const uf = await api.getUserFiles(curPwd, cur); setUserFiles(uf.users); } catch {}
      setLoadingFiles(false);
    }
  };

  const getUserFilesFor = (userId: string) => userFiles?.find((u) => u.userId === userId);

  // fixed: avoid nested state update
  const toggleUid = (uid: string) => {
    const isSelected = selectedUids.includes(uid);
    if (isSelected) {
      setSelectedUids((prev) => prev.filter((x) => x !== uid));
      const files = getUserFilesFor(uid)?.files.map((f) => f.fileId) ?? [];
      if (files.length) setSelectedFileIds((pf) => pf.filter((fid) => !files.includes(fid)));
    } else {
      setSelectedUids((prev) => [...prev, uid]);
    }
  };

  const toggleFile = (fileId: string, uid: string) => {
    setSelectedFileIds((prev) => (prev.includes(fileId) ? prev.filter((x) => x !== fileId) : [...prev, fileId]));
    setSelectedUids((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
  };

  const selectAllPick = () => {
    setSelectedUids(filtered.map((u) => u.userId));
    const allFiles = filtered.flatMap((u) => getUserFilesFor(u.userId)?.files.map((f) => f.fileId) ?? []);
    setSelectedFileIds(allFiles);
  };
  const clearPick = () => { setSelectedUids([]); setSelectedFileIds([]); };

  const doHoldConfirm = async () => {
    const n = customQty ? Number(customQty) : poolQty === "all" ? (cur === "page" && verified ? verified.verified : totals.available) : (poolQty as number);
    if (cur === "page" && verified && verified.verified === 0) return showToast("No verified rows available.");
    if (!totals.available) return showToast("No rows available.");
    if (!Number.isInteger(n) || n < 1) return showToast("Please enter at least 1 row.");
    if (holdMode === "pick" && selectedUids.length === 0 && selectedFileIds.length === 0) { showToast("Please select at least one owner."); return; }
    if (holdMode === "pick" && pickAvail === 0) { showToast("Selected owners have no available rows."); return; }
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; srcFileIds?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: holdMode };
      if (holdMode === "pick") { if (selectedUids.length) payload.srcUids = selectedUids; if (selectedFileIds.length) payload.srcFileIds = selectedFileIds; }
      if (cur === "page") payload.verifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? n;
      if (!held) return showToast("No rows available.");
      vibrate(20);
      showToast(`Held ${held} rows from ${poolMeta.label}. Status: on hold.`);
      const holdId = (res as unknown as { holdId?: string; downloadId?: string }).holdId ?? (res as unknown as { downloadId?: string }).downloadId;
      await refreshAll();
      if (holdId) navigate(`/approvals?hold=${encodeURIComponent(holdId)}`);
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setDownloading(false); }
  };

  const doUserHold = async (u: PoolDetail["users"][number]) => {
    const n = customQty ? Number(customQty) : poolQty === "all" ? u.available : (poolQty as number);
    if (cur === "page" && verified && verified.verified === 0) return showToast("No verified rows available.");
    if (!Number.isInteger(n) || n < 1) return showToast("Please set a quantity first.");
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: "fifo", srcUids: [u.userId] };
      if (cur === "page") payload.verifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? 0;
      if (!held) return showToast("No rows available.");
      vibrate(20);
      showToast(`Held ${held} rows from ${displayName(u).line1}. Status: on hold.`);
      await refreshAll();
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setDownloading(false); }
  };

  if (detail === null) {
    return loadFailed ? (
      <div style={{ padding: 24 }}>
        <EmptyState title="Unable to load pools." sub="Please check your connection and try again." action={{ label: "Retry", onClick: () => { void load(); } }} />
      </div>
    ) : <PageSkeleton variant="pools" />;
  }

  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .pool-switch{display:inline-flex;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;gap:3px;max-width:100%;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
        .pool-switch::-webkit-scrollbar{display:none}
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:0}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .pool-switch.stretch{flex:1 1 260px;min-width:0}
        .pool-switch.stretch button{flex:1 1 0;justify-content:center;min-width:0;padding-left:8px;padding-right:8px}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2)}
        .card-list{display:flex;flex-direction:column;gap:8px}
        .pool-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.pool-card:hover{border-color:var(--text3);box-shadow:var(--shadow-md);transform:translateY(-1px)}}
        .pool-card:active{transform:scale(.99)}
        .pool-card.expanded{border-color:var(--text);background:var(--sel-bg)}
        .pool-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
        .pool-card-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);display:flex;align-items:center;gap:8px}
        .pool-card-sub{font-size:12px;color:var(--text3);display:flex;align-items:center;gap:8px}
        .pool-card-stats{display:flex;align-items:center;gap:10px;flex-shrink:0}
        .pool-card-stat{font-size:12px;font-family:var(--mono);font-weight:600;white-space:nowrap}
        .expand-icon{transition:transform .15s;display:inline-flex}
        .expand-icon.open{transform:rotate(90deg)}
        .file-row{animation:fadeIn .15s}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        .taker-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:stretch}
        .taker-cell{flex:1;min-width:120px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg3);padding:8px 10px;font-size:13px;font-family:var(--mono);font-weight:600}
        .taker-cell small{display:block;font-family:var(--sans);font-weight:500;color:var(--text3);font-size:10px;margin-bottom:2px}
        .pool-card{content-visibility:auto;contain-intrinsic-size:auto 60px}
        .spin{animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(max-width:640px){
          .pools-stats{grid-template-columns:1fr!important}
          .pool-card{flex-wrap:wrap;row-gap:6px}
          .pool-card-stats{margin-left:34px}
          .pool-card-actions{margin-left:auto}
          .taker-row{flex-direction:column}
          .taker-cell{min-width:0}
        }
      `}</style>

      <div id="pools-panel-pool">
      {/* switches */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
          <div className="pool-switch stretch" style={{ background: "var(--bg3)", borderColor: "var(--border)" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}><PasswordIcon password={p} size={14} />{p}</button>
            ))}
          </div>
          <div className="pool-switch stretch">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              const Icon = meta.Icon;
              return (
                <button key={t.id} className={cur === t.id ? "active" : ""} onClick={() => go(curPwd, t.id)}>
                  <Icon size={14} style={{ flexShrink: 0 }} /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span> <span className="badge" style={{ marginLeft: 2 }}>{poolCounts[t.id] ?? 0}</span>
                </button>
              );
            })}
          </div>
      </div>

      {/* stats */}
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: `repeat(${cur === "cookies_only" ? 3 : 4},1fr)`, gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Ready to take</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? (cur === "page" && verified ? verified.verified : totals.available) : "-"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>{cur === "page" ? "verified accounts (unverified cannot be taken)" : "available accounts"}</div>
          {cur === "page" && verified ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--green)", fontFamily: "var(--mono)" }}>{verified.verified}</span> verified</span>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--text3)", fontFamily: "var(--mono)" }}>{verified.unverified}</span> unverified</span>
              {verified.truncated ? <span style={{ fontSize: 11, color: "var(--text3)" }} title={`scan cap ${verified.scanCap}`}>· approx</span> : null}
            </div>
          ) : null}
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Taken</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.claimed : "-"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>held or claimed</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Owners</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.users : "-"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>source users</div>
        </div>
        {cur !== "cookies_only" ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Invalid</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.invalid ?? 0 : "-"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>missing / incomplete 2fa</div>
        </div>
        ) : null}
      </div>

      {/* taker card */}
      <div style={{ marginTop: 16, border: "1px solid var(--border2)", borderRadius: "var(--rl)", background: "var(--bg)", padding: "12px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text3)" }}>Taker card</div>
        <div role="group" aria-label="Take mode" style={{ marginTop: 10, display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3, background: "var(--bg3)" }}>
          <button type="button" aria-pressed={holdMode === "fifo"} className={holdMode === "fifo" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 36 }} onClick={() => setHoldMode("fifo")}>Pool FIFO</button>
          <button type="button" aria-pressed={holdMode === "pick"} className={holdMode === "pick" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 36 }} onClick={() => setHoldMode("pick")}>Pick users</button>
        </div>
        {holdMode === "fifo" ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>Oldest rows first across all owners.</div>
        ) : (
          <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn" style={{ padding: "6px 10px", fontSize: 12, minHeight: 36 }} onClick={selectAllPick}>All</button>
            <button type="button" className="btn" style={{ padding: "6px 10px", fontSize: 12, minHeight: 36 }} onClick={clearPick}>Clear</button>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>{selectedUids.length} selected{selectedFileIds.length ? ` · ${selectedFileIds.length} files` : ""}</span>
          </div>
        )}
        <div className="taker-row">
          <div className="taker-cell"><small>Pool</small>{poolMeta.label}</div>
          {cur === "page" ? (
            <div className="taker-cell">
              <small>Pages</small>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>Verified only</span>
            </div>
          ) : null}
          <div className="taker-cell" style={{ minWidth: 200 }}>
            <small>Quantity</small>
            <span style={{ display: "inline-flex", border: "1px solid var(--border2)", borderRadius: 6, overflow: "hidden", background: "var(--bg)", maxWidth: "100%" }}>
              {[10, 50, 100].map((n) => (
                <button key={n} onClick={() => { setPoolQty(n); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === n && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === n && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>{n}</button>
              ))}
              <button onClick={() => { setPoolQty("all"); setCustomQty(""); }} style={{ padding: "7px 10px", fontSize: 13, fontWeight: 600, background: poolQty === "all" && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === "all" && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 36 }}>All</button>
              <input name="custom-qty" placeholder={customFocused ? "" : "Custom"} aria-label="Custom quantity" inputMode="numeric" value={customQty} onChange={(e) => setCustomQty(e.target.value.replace(/\D/g, ""))} onFocus={(e) => { setCustomFocused(true); e.currentTarget.select(); }} onBlur={() => setCustomFocused(false)} style={{ width: 72, border: "none", padding: "6px 8px", fontSize: 13, textAlign: "center", outline: "none", background: customQty ? "var(--bg3)" : "var(--bg)", borderLeft: customFocused ? "1px solid var(--border2)" : "none", cursor: customQty || customFocused ? "text" : "pointer" }} />
            </span>
          </div>
          <div className="taker-cell"><small>Amount</small>{unitPrice != null ? `${effectiveN} × ${fmtMoney(unitPrice, priceCurrency)} = ${fmtMoney(effectiveN * unitPrice, priceCurrency)}` : "-"}</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={downloading || (cur === "page" ? !(verified ? verified.verified > 0 : totals.available > 0) : !totals.available)} onClick={() => void doHoldConfirm()} style={{ width: "100%", marginTop: 12, padding: "12px 24px", fontSize: 15, fontWeight: 700, borderRadius: "var(--rl)", boxShadow: "0 2px 10px rgba(0,0,0,.25)", justifyContent: "center" }}>Take {customQty ? Number(customQty) || 0 : poolQty === "all" ? (cur === "page" ? "All verified" : "All") : poolQty} from {poolMeta.label}</button>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>{cur === "page" ? "Page pool is verified-only. Take creates a hold. First approve/reject opens a 5-minute window to flip once; owners are paid when it settles." : "Take creates a hold. First approve/reject opens a 5-minute window to flip once; owners are paid when it settles."}</div>
      </div>

      <div style={{ display: "flex", marginTop: 16, marginBottom: 8 }}>
        <SearchInput placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search owners" containerStyle={{ width: "100%" }} />
      </div>
      <h2 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>Owners</h2>

      <div className="card-list">
        {filtered.length === 0 ? (
          <EmptyState title="No owners yet." sub={search.trim() ? "No match for your search." : "Owners appear here when they push rows."} action={search.trim() ? { label: "Clear search", onClick: () => setSearch("") } : undefined} />
        ) : filtered.map((u) => {
          const d = displayName(u);
          const cachedName = String(cachedProfiles[u.userId]?.name ?? "").trim();
          const title = d.line1.startsWith("#") && cachedName ? shortOwnerName(cachedName) : d.line1;
          const isAdmin = Boolean(u.isAdmin || cachedProfiles[u.userId]?.isAdmin);
          const expanded = expandedUser === u.userId;
          const uf = getUserFilesFor(u.userId);
          return (
            <div key={u.userId} style={{ display: "flex", flexDirection: "column", gap: expanded ? 8 : 0 }}>
              <div className={`pool-card ${expanded ? "expanded" : ""}`} style={{ position: "relative" }} onClick={() => toggleExpand(u.userId)} role="button" tabIndex={0} aria-expanded={expanded} aria-controls={`pool-files-${u.userId}`} aria-label={`Show files for ${title}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(u.userId); } }}>
                <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}><ProfileAvatar photoUrl={u.photoUrl ?? cachedProfiles[u.userId]?.photoUrl} fallback={title.charAt(0).toUpperCase()} className="size-9 bg-(--bg3) text-(--text2)" verified={isAdmin} /></span>
                <div className="pool-card-info">
                  <div className="pool-card-name">{title}</div>
                </div>
                <div className="pool-card-stats">
                  {uf ? (<>
                    <span className="pool-card-stat" style={{ color: "var(--text2)" }}>{uf.files.length} file{uf.files.length === 1 ? "" : "s"}</span>
                    <span className="pool-card-stat" style={{ color: "var(--text3)" }}>·</span>
                  </>) : null}
                  <span className="pool-card-stat" style={{ color: "var(--green)" }}>{u.available}</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>/</span>
                  <span className="pool-card-stat" style={{ color: u.claimed ? "var(--red)" : "var(--text3)" }}>{u.claimed} taken</span>
                </div>
                <div className="pool-card-actions" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="file-card-btn" aria-label={`Actions for ${title}`}><MoreVertical size={14} aria-hidden /></button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={downloading} onSelect={() => void doUserHold(u)}>Take</DropdownMenuItem>
                      {holdMode === "pick" ? (
                        <DropdownMenuCheckboxItem checked={selectedUids.includes(u.userId)} onCheckedChange={() => toggleUid(u.userId)}>
                          Select owner
                        </DropdownMenuCheckboxItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {expanded && (
                <div id={`pool-files-${u.userId}`} className="file-row" style={{ padding: "4px 0 6px 32px" }}>
                  {loadingFiles && !uf ? <Skeleton className="h-4 w-20" /> : !uf || uf.files.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>No files in pool</div> : (
                    <div className="files-list">
                      {uf.files.map((f) => {
                        const canOpen = meIsAdmin || me?.id === u.userId;
                        const openPath = !canOpen ? null : meIsAdmin ? `/admin/user/${u.userId}/file/${f.fileId}` : `/file/${f.fileId}`;
                        return (
                        <div key={f.fileId} className="file-card list-row" role="group" aria-label={`File ${f.name || f.fileId}, ${f.available} available`} style={{ touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", width: "100%", margin: 0 } as React.CSSProperties}>
                          {holdMode === "pick" ? <input type="checkbox" aria-label={`Select file ${f.name || f.fileId}`} checked={selectedFileIds.includes(f.fileId)} onChange={() => toggleFile(f.fileId, u.userId)} style={{ width: 16, height: 16, flexShrink: 0 }} /> : null}
                          <div className="file-card-icon"><FileTypeIcon file={{ preset: f.preset ?? undefined, name: f.name ?? undefined }} size={16} /></div>
                          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                            <div className="file-card-name" dir="auto" title={f.name ?? undefined}>{f.name || `#${f.fileId.slice(-8)}`}</div>
                            <div className="file-card-meta">{f.createdAt ? new Date(f.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "-"} · {f.available} avail · {f.claimed} taken</div>
                          </div>
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            <span className="file-type-badge" title="Facebook" aria-label="Facebook" style={{ display: "inline-flex", alignItems: "center" }}><FacebookIcon size={10} /></span>
                            <span className="file-type-badge" style={{ fontSize: 10, padding: "2px 6px", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={curPwd}><PasswordIcon password={curPwd} size={12} /></span>
                          </div>
                          {openPath ? (
                          <div className="file-card-actions">
                            <button type="button" className="file-card-btn" title="Open file in browser" aria-label={`Open ${f.name || f.fileId} in browser`} onClick={(e) => { e.stopPropagation(); navigate(openPath); }}><ExternalLink size={14} aria-hidden /></button>
                          </div>
                          ) : null}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>
      </div>
  );
}
