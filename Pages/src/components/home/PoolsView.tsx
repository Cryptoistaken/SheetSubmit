import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "@/lib/api";
import type { HoldRecord, PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useProfileCache } from "@/stores/profileCache";

import { CookieIcon, PageIcon, PasswordIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import EmptyState from "./EmptyState";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";
import { ApprovalDetailDialog } from "./ApprovalDetailDialog";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import SearchInput from "@/components/ui/search-input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { InkStamp } from "@/components/ui/ink-stamp";

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

function displayName(u: PoolDetail["users"][number]) {
  const raw: Record<string, unknown> = u as unknown as Record<string, unknown>;
  const n = String(raw["name"] ?? raw["displayName"] ?? "").trim();
  const un = String(raw["username"] ?? "").trim();
  if (n && un) return { line1: n, line2: "@" + un };
  if (un) return { line1: "@" + un, line2: "" };
  if (n) return { line1: n, line2: "#" + u.userId.slice(-6) };
  return { line1: "#" + u.userId, line2: "" };
}

export default function PoolsView() {
  const params = useParams<{ password: string; poolId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const showToast = useToast();
  const curPwd = PASSWORDS.includes(params.password as never) ? params.password! : "dgddigital";
  const cur = (POOL_TABS.find((t) => t.id === params.poolId)?.id as PoolId) || "cookies_only";
  const view = searchParams.get("view") === "approvals" ? "approvals" : "pool";
  const setView = (v: "pool" | "approvals") => setSearchParams(v === "approvals" ? { view: "approvals" } : {});

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
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userFiles, setUserFiles] = useState<PoolUserFile[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [verified, setVerified] = useState<VerifiedCounts | null>(null);
  const { profiles: cachedProfiles, fetchProfiles } = useProfileCache();
  const [verifiedFilter, setVerifiedFilter] = useState<"all" | "verified" | "unverified">("all");
  const [apprFilter, setApprFilter] = useState<"PENDING" | "APPROVED" | "REJECTED">("PENDING");


  const [holdMode, setHoldMode] = useState<"fifo" | "pick">("fifo");
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [holds, setHolds] = useState<HoldRecord[] | null>(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdConfirmOpen, setHoldConfirmOpen] = useState(false);
  const [holdActing, setHoldActing] = useState<string | null>(null);
  const [selectedHold, setSelectedHold] = useState<HoldRecord | null>(null);

  // price
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceConfirm, setPriceConfirm] = useState(false);

  useEffect(() => {
    if (!menuUser) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") { setMenuUser(null); return; }
      const target = event.target as Node;
      if (!(target instanceof Element) || (!target.closest(`[data-pool-menu="${menuUser}"]`) && !target.closest('button[aria-haspopup="menu"]'))) setMenuUser(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); };
  }, [menuUser]);

  const loadHolds = useCallback(async () => {
    setHoldsLoading(true);
    try {
      const list = await api.getHolds() as unknown as HoldRecord[];
      const arr: HoldRecord[] = Array.isArray(list) ? list : [];
      setHolds(arr.slice(0, 50));
    } catch { setHolds([]); } finally { setHoldsLoading(false); }
  }, []);

  const load = useCallback(async () => {
    try {
      const ps = await api.getPools();
      const list = (ps as { pools: PoolSummary[] }).pools ?? (ps as unknown as PoolSummary[]);
      setPools(list);
      const d = await api.getPoolDetail(curPwd, cur);
      setDetail(d);
      try { useProfileCache.getState().setProfiles(d.users as unknown[]); } catch {}
      try {
        const uf = await api.getUserFiles(curPwd, cur);
        setUserFiles(uf.users);
       } catch { setUserFiles([]); }
      // prices for all pools
      try {
        const allPrices: Record<string, number | null> = {};
        await Promise.all(POOL_TABS.map(async (t) => {
          try { const pr = await api.getPoolPrice(curPwd, t.id); allPrices[t.id] = pr.price; } catch { allPrices[t.id] = null; }
        }));
        setPrices(allPrices);
      } catch { setPrices({}); }
    } catch { showToast("Could not load pools. Check your connection."); }
  }, [cur, curPwd, showToast]);

  const refreshAll = useCallback(async () => { await load(); await loadHolds(); }, [load, loadHolds]);

  useEffect(() => { load(); loadHolds(); }, [load, loadHolds]);

  useEffect(() => {
    if (cur !== "page") { setVerified(null); return; }
    let cancelled = false;
    api.getVerifiedCounts(curPwd, cur).then((r) => { if (!cancelled) setVerified(r); }).catch(() => { if (!cancelled) setVerified(null); });
    return () => { cancelled = true; };
  }, [cur, curPwd]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);
  useEffect(() => { setVerifiedFilter("all"); setSelectedUids([]); setSelectedFileIds([]); }, [cur, curPwd]);

  const poolCounts: Record<string, number> = {};
  if (pools) pools.filter((p) => (p as unknown as Record<string, unknown>)["password"] === curPwd || !(p as unknown as Record<string, unknown>)["password"]).forEach((p) => { poolCounts[p.id] = p.available; });

  const poolMeta = POOL_TABS.find((t) => t.id === cur) ?? POOL_TABS[0];
  const totals = detail?.totals ?? { available: 0, claimed: 0, users: 0 };
  const holdStatus = (h: HoldRecord) => { const s = String(h.status || "").toUpperCase(); return s === "HOLD" ? "PENDING" : s; };
  const apprCounts: Record<"PENDING" | "APPROVED" | "REJECTED", number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  (holds ?? []).forEach((h) => { const s = holdStatus(h); if (s === "PENDING" || s === "APPROVED" || s === "REJECTED") apprCounts[s]++; });
  const apprShown = (holds ?? []).filter((h) => holdStatus(h) === apprFilter);
  const takeN = customQty ? Number(customQty) || 0 : poolQty === "all" ? totals.available : poolQty as number;
  const unitPrice = prices[cur];

  const filtered = detail ? detail.users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const d = displayName(u);
    return [d.line1, d.line2, u.userId].some((s) => s.toLowerCase().includes(q));
  }) : [];

  const go = (pwd: string, pid: string) => navigate(`/pools/${pwd}/${pid}`);

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    if (!userFiles) {
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
    const n = customQty ? Number(customQty) : poolQty === "all" ? totals.available : (poolQty as number);
    if (!totals.available) return showToast("No rows available to claim");
    if (!Number.isInteger(n) || n < 1) return showToast("Enter at least 1 row");
    if (holdMode === "pick" && selectedUids.length === 0 && selectedFileIds.length === 0) { showToast("Pick at least 1 user"); return; }
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; srcFileIds?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: holdMode };
      if (holdMode === "pick") { if (selectedUids.length) payload.srcUids = selectedUids; if (selectedFileIds.length) payload.srcFileIds = selectedFileIds; }
      if (cur === "page" && verifiedFilter === "verified") payload.verifiedOnly = true;
      if (cur === "page" && verifiedFilter === "unverified") payload.unverifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? n;
      if (!held) return showToast("No rows available to claim");
      showToast(`Held ${held} from ${poolMeta.label} — ON HOLD`);
      setHoldConfirmOpen(false);
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doUserHold = async () => {
    if (!dlUser) return;
    const n = perCustom ? Number(perCustom) : perQty === "all" ? dlUser.available : (perQty as number);
    if (!Number.isInteger(n) || n < 1) return showToast("Enter at least 1 row");
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: "fifo", srcUids: [dlUser.userId] };
      if (cur === "page" && verifiedFilter === "verified") payload.verifiedOnly = true;
      if (cur === "page" && verifiedFilter === "unverified") payload.unverifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? 0;
      if (!held) return showToast("No rows available to claim");
      showToast(`Held ${held} from ${displayName(dlUser).line1} — ON HOLD`);
      setDlUser(null);
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doApprove = async (id: string) => {
    setHoldActing(id);
    try { await api.approveHold(id); showToast("Approved"); await refreshAll(); setSelectedHold(null); } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doReturn = async (id: string) => {
    setHoldActing(id);
    try { await api.returnHold(id); showToast("Rows returned to pool"); await refreshAll(); setSelectedHold(null); } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doDeleteHold = async (id: string) => {
    setHoldActing(id);
    try {
      const hold = holds?.find((item) => item.id === id)
      if (String(hold?.status || "").toUpperCase() === "APPROVED") {
        await api.revertDownload(id)
        await api.deleteDownload(id)
        showToast("Approval deleted — rows returned")
      } else {
        await api.rejectHold(id)
        showToast("Rejected — rows returned")
      }
      await refreshAll()
      setSelectedHold(null)
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };

  const openFile = async (u: PoolDetail["users"][number]) => {
    setMenuUser(null);
    try {
      const r = await api.getPoolRows(curPwd, cur, { userId: u.userId, limit: 1 });
      const first = r.rows[0] as Record<string, unknown> | undefined;
      const fid = first?.["srcFileId"] as string | undefined;
      if (fid) { navigate(`/admin/user/${u.userId}/file/${fid}`); return; }
    } catch {}
    showToast("No file found for this user");
  };

  const validatePrices = (): string[] => {
    const errors: string[] = [];
    POOL_TABS.forEach((t) => {
      const raw = priceInputs[t.id] ?? "";
      const v = Number(raw);
      if (!raw.trim() || !Number.isFinite(v) || v < 0 || v > 1000) errors.push(`${POOL_META[t.id].label}: 0-1000`);
    });
    return errors;
  };

  const hasPriceChanges = POOL_TABS.some((t) => {
    const raw = priceInputs[t.id] ?? "";
    const v = Number(raw);
    return raw.trim() !== "" && Number.isFinite(v) && v !== prices[t.id];
  });

  const openPriceConfirm = () => {
    const errors = validatePrices();
    if (errors.length) { showToast(`Invalid: ${errors.join(", ")}`); return; }
    if (!hasPriceChanges) { showToast("No changes to save"); return; }
    setPriceConfirm(true);
  };

  const savePrice = async () => {
    setPriceSaving(true);
    try {
      const updated: Record<string, number | null> = {};
      await Promise.all(POOL_TABS.map(async (t) => {
        const v = Number(priceInputs[t.id] ?? "0");
        try { const res = await api.setPoolPrice(curPwd, t.id, v); updated[t.id] = res.price; } catch { updated[t.id] = prices[t.id] ?? null; }
      }));
      setPrices(updated);
      setPriceConfirm(false);
      setPriceOpen(false);
      showToast("Prices saved");
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setPriceSaving(false) }
  };

  if (detail === null) return <PageSkeleton variant="pools" />;

  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .pool-switch{display:inline-flex;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;gap:3px}
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px;display:inline-flex;align-items:center;gap:6px}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2)}
        .card-list{display:flex;flex-direction:column;gap:8px}
        .pool-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.pool-card:hover{border-color:var(--text3);box-shadow:var(--shadow-md);transform:translateY(-1px)}}
        .pool-card:active{transform:scale(.99)}
        .pool-card.expanded{border-color:var(--blue);background:var(--blue-light)}
        .pool-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
        .pool-card-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);display:flex;align-items:center;gap:8px}
        .pool-card-sub{font-size:12px;color:var(--text3);display:flex;align-items:center;gap:8px}
        .pool-card-stats{display:flex;align-items:center;gap:10px;flex-shrink:0}
        .pool-card-stat{font-size:12px;font-family:var(--mono);font-weight:600;white-space:nowrap}
        .expand-icon{transition:transform .15s;display:inline-flex}
        .expand-icon.open{transform:rotate(90deg)}
        .file-row{animation:fadeIn .15s}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        .file-card{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r)}
        .file-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
        .file-card-id{font-size:12px;font-family:var(--mono);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .file-card-stats{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .file-card-stat{font-size:12px;font-family:var(--mono);font-weight:600}
        .taker-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:stretch}
        .taker-cell{flex:1;min-width:120px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg3);padding:8px 10px;font-size:13px;font-family:var(--mono);font-weight:600}
        .taker-cell small{display:block;font-family:var(--sans);font-weight:500;color:var(--text3);font-size:10px;margin-bottom:2px}
        @media(max-width:640px){
          .pools-stats{grid-template-columns:1fr!important}
          .pool-switch{flex-wrap:wrap;justify-content:center}
          .pool-card{flex-wrap:wrap;row-gap:6px}
          .pool-card-stats{margin-left:34px}
          .pool-card-actions{margin-left:auto}
          .taker-row{flex-direction:column}
          .taker-cell{min-width:0}
        }
      `}</style>

      {/* top-level view tabs */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <div className="pool-switch" role="tablist" aria-label="Pools page sections">
          <button role="tab" aria-selected={view === "pool"} className={view === "pool" ? "active" : ""} onClick={() => setView("pool")}>Pool</button>
          <button role="tab" aria-selected={view === "approvals"} className={view === "approvals" ? "active" : ""} onClick={() => setView("approvals")}>Approvals{apprCounts.PENDING ? <span className="badge" style={{ marginLeft: 6 }}>{apprCounts.PENDING}</span> : null}</button>
        </div>
      </div>

      {view === "pool" ? (<>
      {/* switches */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
          <div className="pool-switch" style={{ background: "#eef2ff", borderColor: "#ddd6fe" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}><PasswordIcon password={p} size={14} />{p}</button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => { const init: Record<string, string> = {}; POOL_TABS.forEach((t) => { const v = prices[t.id] ?? prices[Object.keys(prices)[0]] ?? null; init[t.id] = v != null ? String(v) : ""; }); setPriceInputs(init); setPriceOpen(true); }}>{prices[cur] != null ? `price $${prices[cur]}` : "Unit price"}</Button>
          <div className="pool-switch">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              const Icon = meta.Icon;
              return (
                <button key={t.id} className={cur === t.id ? "active" : ""} onClick={() => go(curPwd, t.id)}>
                  <Icon size={14} />{t.label} <span className="badge" style={{ marginLeft: 2 }}>{poolCounts[t.id] ?? 0}</span>
                </button>
              );
            })}
          </div>
      </div>

      {/* stats */}
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Ready to take</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.available : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>available accounts</div>
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
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.claimed : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>held or claimed</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Owners</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.users : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>source users</div>
        </div>
      </div>

      {/* taker card */}
      <div style={{ marginTop: 16, border: "1px solid var(--border2)", borderRadius: "var(--rl)", background: "var(--bg)", padding: "12px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text3)" }}>Taker card</div>
        <div role="group" aria-label="Take mode" style={{ marginTop: 10, display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3, background: "var(--bg3)" }}>
          <button type="button" aria-pressed={holdMode === "fifo"} className={holdMode === "fifo" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 36 }} onClick={() => setHoldMode("fifo")}>Pool FIFO</button>
          <button type="button" aria-pressed={holdMode === "pick"} className={holdMode === "pick" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 36 }} onClick={() => setHoldMode("pick")}>Pick users</button>
        </div>
        {holdMode === "fifo" ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>Oldest rows first across all delegators.</div>
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
              <select aria-label="Page verified filter" value={verifiedFilter} onChange={(e) => setVerifiedFilter(e.target.value as never)} style={{ padding: "4px 6px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", minHeight: 32, maxWidth: "100%" }}>
                <option value="all">All pages</option>
                <option value="verified">Verified only</option>
                <option value="unverified">Unverified only</option>
              </select>
            </div>
          ) : null}
          <div className="taker-cell" style={{ minWidth: 200 }}>
            <small>Quantity</small>
            <span style={{ display: "inline-flex", border: "1px solid var(--border2)", borderRadius: 6, overflow: "hidden", background: "var(--bg)", maxWidth: "100%" }}>
              {[10, 50, 100].map((n) => (
                <button key={n} onClick={() => { setPoolQty(n); setCustomQty(""); }} style={{ padding: "6px 10px", fontSize: 13, fontWeight: 600, background: poolQty === n && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === n && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 32 }}>{n}</button>
              ))}
              <button onClick={() => { setPoolQty("all"); setCustomQty(""); }} style={{ padding: "6px 10px", fontSize: 13, fontWeight: 600, background: poolQty === "all" && !customQty ? "var(--text)" : "var(--bg)", color: poolQty === "all" && !customQty ? "var(--bg)" : "var(--text2)", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", minHeight: 32 }}>All</button>
              <input name="custom-qty" placeholder={customFocused ? "" : "Custom"} aria-label="Custom quantity" inputMode="numeric" value={customQty} onChange={(e) => setCustomQty(e.target.value.replace(/\D/g, ""))} onFocus={(e) => { setCustomFocused(true); e.currentTarget.select(); }} onBlur={() => setCustomFocused(false)} style={{ width: 72, border: "none", padding: "6px 8px", fontSize: 13, textAlign: "center", outline: "none", background: customQty ? "var(--bg3)" : "var(--bg)", borderLeft: customFocused ? "1px solid var(--border2)" : "none", cursor: customQty || customFocused ? "text" : "pointer" }} />
            </span>
          </div>
          <div className="taker-cell"><small>Amount</small>{unitPrice != null ? `${takeN} × $${unitPrice.toFixed(2)} = $${(takeN * unitPrice).toFixed(2)}` : "—"}</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={downloading || !totals.available} onClick={() => setHoldConfirmOpen(true)} style={{ width: "100%", marginTop: 12, padding: "12px 24px", fontSize: 15, fontWeight: 700, borderRadius: "var(--rl)", boxShadow: "0 2px 10px rgba(0,112,243,.22)", justifyContent: "center" }}>Take {customQty ? Number(customQty) || 0 : poolQty === "all" ? "All" : poolQty} from {poolMeta.label}</button>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>Take creates a hold. Approval credits the owners. Reject returns the rows.</div>
      </div>

      <h2 style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>Users</h2>
      <div style={{ display: "flex", marginBottom: 8 }}>
        <SearchInput placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" containerStyle={{ width: "100%" }} />
      </div>

      <div className="card-list" style={{ marginTop: 12 }}>
        {filtered.length === 0 ? (
          <EmptyState title="No delegators yet" sub={search.trim() ? "No match for your search" : "Delegators appear here when they push rows"} action={search.trim() ? { label: "Clear search", onClick: () => setSearch("") } : undefined} />
        ) : filtered.map((u) => {
          const d = displayName(u);
          const isAdmin = Boolean(u.isAdmin || cachedProfiles[u.userId]?.isAdmin);
          const expanded = expandedUser === u.userId;
          const uf = getUserFilesFor(u.userId);
          const checked = selectedUids.includes(u.userId);
          return (
            <div key={u.userId} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div className={`pool-card ${expanded ? "expanded" : ""}`} style={{ position: "relative" }} role="button" tabIndex={0} aria-expanded={expanded} aria-controls={`pool-files-${u.userId}`} onClick={() => toggleExpand(u.userId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(u.userId); } }}>
                {holdMode === "pick" ? <input type="checkbox" aria-label={`Select ${d.line1}`} checked={checked} onChange={() => toggleUid(u.userId)} onClick={(e) => e.stopPropagation()} style={{ width: 16, height: 16, flexShrink: 0 }} /> : null}
                <span className={`expand-icon ${expanded ? "open" : ""}`} style={{ color: "var(--text3)", flexShrink: 0 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg></span>
                <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}><ProfileAvatar photoUrl={u.photoUrl ?? cachedProfiles[u.userId]?.photoUrl} fallback={d.line1.charAt(0).toUpperCase()} className="size-9 bg-(--bg3) text-(--text2)" verified={isAdmin} /></span>
                <div className="pool-card-info">
                  <div className="pool-card-name">{d.line1}{uf ? <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>{uf.files.length} file{uf.files.length !== 1 ? "s" : ""}</span> : null}</div>
                  {d.line2 ? <div className="pool-card-sub">{d.line2}</div> : null}
                </div>
                <div className="pool-card-stats">
                  <span className="pool-card-stat" style={{ color: "var(--green)" }}>{u.available}</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>/</span>
                  <span className="pool-card-stat" style={{ color: u.claimed ? "var(--red)" : "var(--text3)" }}>{u.claimed} taken</span>
                </div>
                <div className="pool-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} onClick={() => { setDlUser(u); setPerQty(10); setPerCustom(""); }}>Take</button>
                  <button type="button" className="btn" title="More options" aria-label={`More options for ${d.line1}`} aria-haspopup="menu" aria-expanded={menuUser === u.userId} style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }} onClick={() => setMenuUser(menuUser === u.userId ? null : u.userId)}>⋯</button>
                  {menuUser === u.userId ? (
                    <div data-pool-menu={u.userId} role="menu" aria-label={`Actions for ${d.line1}`} style={{ position: "absolute", right: 8, top: 40, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--rl)", boxShadow: "var(--shadow-lg)", zIndex: 10, minWidth: 160, padding: 4 }}>
                      <button type="button" role="menuitem" style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontWeight: 500 }} onClick={() => openFile(u)}>View file</button>
                      <button type="button" role="menuitem" style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "var(--blue)", color: "#fff", cursor: "pointer", borderRadius: 6, fontWeight: 700, marginTop: 4 }} onClick={() => { setMenuUser(null); setDlUser(u); setPerQty(10); setPerCustom(""); }}>Take</button>
                    </div>
                  ) : null}
                </div>
              </div>
              {expanded && (
                <div id={`pool-files-${u.userId}`} className="file-row" style={{ padding: "4px 0 8px 42px" }}>
                  {loadingFiles && !uf ? <Skeleton className="h-4 w-20" /> : !uf || uf.files.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>No files in pool</div> : (
                    <div className="card-list">
                      {uf.files.map((f) => (
                        <div key={f.fileId} className="file-card" style={{ cursor: "default" }}>
                          {holdMode === "pick" ? <input type="checkbox" aria-label={`Select file ${f.fileId.slice(-8)}`} checked={selectedFileIds.includes(f.fileId)} onChange={() => toggleFile(f.fileId, u.userId)} style={{ width: 16, height: 16, flexShrink: 0 }} /> : null}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text3)", flexShrink: 0 }}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                          <div className="file-card-info"><div className="file-card-id">#{f.fileId.slice(-8)}</div></div>
                          <div className="file-card-stats">
                            <span className="file-card-stat" style={{ color: "var(--green)" }}>{f.available} avail</span>
                            <span className="file-card-stat" style={{ color: "var(--text3)" }}>/</span>
                            <span className="file-card-stat" style={{ color: "var(--red)" }}>{f.claimed} taken</span>
                          </div>
                          <button type="button" className="btn" style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, flexShrink: 0 }} onClick={() => navigate(`/admin/user/${u.userId}/file/${f.fileId}`)}>View file</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>) : (
      <section aria-labelledby="holds-title">
        <div className="pool-switch" style={{ marginBottom: 10 }}>
          {(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => (
            <button key={s} className={apprFilter === s ? "active" : ""} onClick={() => setApprFilter(s)}>{s[0] + s.slice(1).toLowerCase()} <span className="badge" style={{ marginLeft: 2 }}>{apprCounts[s]}</span></button>
          ))}
        </div>
        {holdsLoading ? <Skeleton className="h-20 w-full" /> : !holds || apprShown.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>No {apprFilter.toLowerCase()} approvals</div>
        ) : (
          <div className="card-list">
            {apprShown.map((h) => {
              const st = holdStatus(h);
              const dt = h.at ?? (h as unknown as { ts?: number }).ts;
              const d = dt ? new Date(dt) : null;
              const dateStr = d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
              const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
              const poolLabel = POOL_META[h.poolId]?.label ?? h.poolId;
              const qty = (h as unknown as { claimed?: number; held?: number }).held ?? h.claimed ?? 0;
              const isApproved = st === "APPROVED";
              return (
                <div key={h.id} className="pool-card" role="button" tabIndex={0} aria-label={`View approval ${h.filename}`} onClick={() => setSelectedHold(h)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedHold(h) } }}>
                  <span className="badge" style={{ background: st === "PENDING" ? "#fef3c7" : isApproved ? "#dcfce7" : "var(--bg3)", color: st === "PENDING" ? "#92400e" : isApproved ? "#166534" : "var(--text3)", borderColor: st === "PENDING" ? "#fde68a" : isApproved ? "#bbf7d0" : "var(--border)" }}>{st}</span>
                  <div className="pool-card-info" style={{ gap: 4 }}>
                    <div className="pool-card-name" title={h.filename}>{h.filename} · {poolLabel} {isApproved ? <InkStamp label="APPROVED" /> : null}</div>
                    <div className="pool-card-sub"><span title={d ? d.toISOString() : ""}>{dateStr} {timeStr}</span><span>·</span><span>{qty} qty</span><span>·</span><span>{h.mode ?? "—"}</span><span>·</span><span>{prices[h.poolId] != null ? `$${(qty * prices[h.poolId]!).toFixed(2)}` : "—"}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
          )}
      </section>
      )}

      {/* hold confirm dialog */}
      <Dialog open={holdConfirmOpen} onOpenChange={setHoldConfirmOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Take accounts</DialogTitle><DialogDescription>Rows go ON HOLD. Approve to credit balance, Reject to return rows.</DialogDescription></DialogHeader>
          <div style={{ fontSize: 12, color: "var(--text3)" }}>Taking {takeN} from {poolMeta.label}{holdMode === "pick" ? ` · ${selectedUids.length} users${selectedFileIds.length ? ` · ${selectedFileIds.length} files` : ""}` : ""}</div>
          <DialogFooter><Button variant="ghost" onClick={() => setHoldConfirmOpen(false)}>Cancel</Button><Button disabled={downloading} onClick={doHoldConfirm}>Confirm hold</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* per-user take dialog */}
      <Dialog open={!!dlUser} onOpenChange={(o) => { if (!o) setDlUser(null) }}>
         <DialogContent>
          <DialogHeader><DialogTitle>Take accounts</DialogTitle><DialogDescription>Rows go ON HOLD. Approve to credit balance, Reject to return rows.</DialogDescription></DialogHeader>
          {dlUser ? <div style={{ fontSize: 12, color: "var(--text3)" }}>{displayName(dlUser).line1} · {dlUser.available} available</div> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
           {[10, 50].map((n) => <Button key={n} variant={perQty === n && !perCustom ? "default" : "outline"} size="sm" onClick={() => { setPerQty(n); setPerCustom(""); }}>{n}</Button>)}
             <Button variant={perQty === "all" && !perCustom ? "default" : "outline"} size="sm" onClick={() => { setPerQty("all"); setPerCustom(""); }}>All</Button>
            <input placeholder={perCustomFocused ? "" : "Custom"} aria-label="Custom quantity" inputMode="numeric" pattern="[0-9]*" value={perCustom} onChange={(e) => setPerCustom(e.target.value.replace(/\D/g, ""))} onFocus={(e) => { setPerCustomFocused(true); e.currentTarget.select(); }} onBlur={() => setPerCustomFocused(false)} style={{ width: 72, padding: "6px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: "var(--r)", outline: "none", textAlign: "center" }} />
          </div>
          {dlUser ? <div style={{ fontSize: 12, color: "var(--text3)" }}>Taking {perCustom ? Number(perCustom) || 0 : perQty === "all" ? dlUser.available : perQty as number} of {dlUser.available} available</div> : null}
          <DialogFooter><Button variant="ghost" onClick={() => setDlUser(null)}>Cancel</Button><Button disabled={downloading} onClick={doUserHold}>Confirm hold</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* price dialog */}
      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
         <DialogContent>
          <DialogHeader><DialogTitle>Unit price</DialogTitle><DialogDescription>Set price per row for each pool ({curPwd}) — 0 to 1000</DialogDescription></DialogHeader>
          <div className="flex flex-col gap-3">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              return <label key={t.id} className="flex flex-col gap-1.5"><span className="text-sm font-medium flex items-center gap-2"><meta.Icon size={14} />{meta.label}{prices[t.id] != null ? <span className="text-muted-foreground text-xs font-normal">· ${prices[t.id]!.toFixed(2)}</span> : null}</span><input aria-label={`${meta.label} price`} type="number" min={0} max={1000} step={0.01} value={priceInputs[t.id] ?? ""} onChange={(e) => setPriceInputs((p) => ({ ...p, [t.id]: e.target.value }))} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>;
            })}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setPriceOpen(false)}>Cancel</Button><Button disabled={!hasPriceChanges} onClick={openPriceConfirm}>Save all</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* price confirm dialog */}
      <AlertDialog open={priceConfirm} onOpenChange={setPriceConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm price change</AlertDialogTitle>
            <AlertDialogDescription>Review changes before saving.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              const oldP = prices[t.id];
              const newP = Number(priceInputs[t.id] ?? "0");
              if (oldP === newP) return null;
              return (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="flex items-center gap-2 font-medium"><meta.Icon size={14} />{meta.label}</span>
                  <span className="text-muted-foreground">${oldP != null ? oldP.toFixed(2) : "—"}</span>
                  <span>→</span>
                  <span className="font-medium">${newP.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={priceSaving} onClick={savePrice}>{priceSaving ? "Saving…" : "OK"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ApprovalDetailDialog hold={selectedHold} open={!!selectedHold} onClose={() => setSelectedHold(null)} onApprove={doApprove} onReturn={doReturn} onDelete={doDeleteHold} acting={holdActing} />
      </div>
  );
}
