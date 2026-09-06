import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/lib/api";
import type { HoldRecord, PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { useProfileCache } from "@/stores/profileCache";
import { useModalA11y } from "@/hooks/useModalA11y";
import { CookieIcon, PageIcon, PasswordIcon, TwoFaIcon, UnknownUserIcon, VerifiedIcon } from "@/components/icons/FileTypeIcons";
import EmptyState from "./EmptyState";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";
import DownloadDetailModal from "./DownloadDetailModal";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import SearchInput from "@/components/ui/search-input";

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
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userFiles, setUserFiles] = useState<PoolUserFile[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [verified, setVerified] = useState<VerifiedCounts | null>(null);
  const { profiles: cachedProfiles, fetchProfiles } = useProfileCache();
  const adminMap = useMemo(() => {
    const m = new Map<string, { name: string; username?: string; photoUrl?: string | null; isAdmin?: boolean }>();
    for (const [k, v] of Object.entries(cachedProfiles)) m.set(k, { name: v.name, username: v.username ?? undefined, photoUrl: v.photoUrl ?? null, isAdmin: v.isAdmin });
    return m;
  }, [cachedProfiles]);
  const [srcUid, setSrcUid] = useState<string>("");
  const [srcFileId, setSrcFileId] = useState<string>("");
  const [verifiedFilter, setVerifiedFilter] = useState<"all" | "verified" | "unverified">("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const dlModalRef = useModalA11y(!!dlUser, () => setDlUser(null));

  // hold mode + pick selections
  const [holdMode, setHoldMode] = useState<"fifo" | "pick">("fifo");
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [holds, setHolds] = useState<HoldRecord[] | null>(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdConfirmOpen, setHoldConfirmOpen] = useState(false);
  const holdModalRef = useModalA11y(holdConfirmOpen, () => setHoldConfirmOpen(false));
  const [holdActing, setHoldActing] = useState<string | null>(null);

  useEffect(() => {
    if (!menuUser) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setMenuUser(null);
        return;
      }
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
    } catch {
      setHolds([]);
    } finally { setHoldsLoading(false); }
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
        const dls = await api.getDownloads() as unknown;
        const arr: unknown[] = Array.isArray(dls) ? dls : ((dls as { downloads?: unknown[] })?.downloads ?? []);
        setDownloads((arr as unknown[]).slice(0, 10));
       } catch { setDownloads([]); }
      try {
        const uf = await api.getUserFiles(curPwd, cur);
        setUserFiles(uf.users);
       } catch { setUserFiles([]); }
    } catch {
      showToast("Could not load pools. Check your connection.");
    }
  }, [cur, curPwd, showToast]);

  const refreshAll = useCallback(async () => {
    await load();
    await loadHolds();
  }, [load, loadHolds]);

  useEffect(() => { load(); loadHolds(); }, [load, loadHolds]);

  // verified counts only on page tab — bounded scan, safe
  useEffect(() => {
    if (cur !== "page") { setVerified(null); return; }
    let cancelled = false;
    api.getVerifiedCounts(curPwd, cur).then((r) => { if (!cancelled) setVerified(r); }).catch(() => { if (!cancelled) setVerified(null); });
    return () => { cancelled = true; };
  }, [cur, curPwd]);

  // claimer avatars — cached globally so pool/admin switches don't refetch
  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  // reset file selector when contributor changes or pool changes
  useEffect(() => { setSrcFileId(""); }, [srcUid]);
  useEffect(() => { setSrcUid(""); setSrcFileId(""); setVerifiedFilter("all"); setSelectedUids([]); setSelectedFileIds([]); }, [cur, curPwd]);

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

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    if (!userFiles) {
      setLoadingFiles(true);
      try {
        const uf = await api.getUserFiles(curPwd, cur);
        setUserFiles(uf.users);
      } catch { /* ignore */ }
      setLoadingFiles(false);
    }
  };

  const getUserFilesFor = (userId: string) => userFiles?.find((u) => u.userId === userId);

  const srcFileOptions = useMemo(() => {
    if (!srcUid) return [];
    const u = userFiles?.find((x) => x.userId === srcUid);
    return u?.files ?? [];
  }, [srcUid, userFiles]);

  const toggleUid = (uid: string) => {
    setSelectedUids((prev) => {
      if (prev.includes(uid)) {
        const next = prev.filter((x) => x !== uid);
        // also remove files belonging to this user from selectedFileIds
        const files = getUserFilesFor(uid)?.files.map((f) => f.fileId) ?? [];
        if (files.length) setSelectedFileIds((pf) => pf.filter((fid) => !files.includes(fid)));
        return next;
      }
      return [...prev, uid];
    });
  };

  const toggleFile = (fileId: string, uid: string) => {
    setSelectedFileIds((prev) => (prev.includes(fileId) ? prev.filter((x) => x !== fileId) : [...prev, fileId]));
    setSelectedUids((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
  };

  const selectAllPick = () => {
    setSelectedUids(filtered.map((u) => u.userId));
  };
  const clearPick = () => {
    setSelectedUids([]);
    setSelectedFileIds([]);
  };

  const doHoldConfirm = async () => {
    const n = customQty ? Number(customQty) : poolQty === "all" ? totals.available : (poolQty as number);
    if (!totals.available) return showToast("No rows available to claim");
    if (!Number.isInteger(n) || n < 1) return showToast("Enter at least 1 row");
    if (holdMode === "pick" && selectedUids.length === 0 && selectedFileIds.length === 0) {
      showToast("Pick at least 1 user");
      return;
    }
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; srcFileIds?: string[]; srcUid?: string | null; srcFileId?: string | null; verifiedOnly?: boolean; unverifiedOnly?: boolean } = {
        count: n as number | "all",
        mode: holdMode,
      };
      if (holdMode === "fifo") {
        if (srcUid) payload.srcUid = srcUid;
        if (srcFileId) payload.srcFileId = srcFileId;
      } else {
        if (selectedUids.length) payload.srcUids = selectedUids;
        if (selectedFileIds.length) payload.srcFileIds = selectedFileIds;
      }
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
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = {
        count: n as number | "all",
        mode: "fifo",
        srcUids: [dlUser.userId],
      };
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
    try {
      await api.approveHold(id);
      showToast("Approved");
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doReject = async (id: string) => {
    const ok = await confirm("Reject this hold and return rows to pool?", "Reject");
    if (!ok) return;
    setHoldActing(id);
    try {
      await api.rejectHold(id);
      showToast("Rejected — rows returned");
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doReturn = async (id: string) => {
    const ok = await confirm("Return these rows to the pool?", "Return");
    if (!ok) return;
    setHoldActing(id);
    try {
      await api.returnHold(id);
      showToast("Rows returned to pool");
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
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
    const ok = await confirm("Return these rows to the pool?", "Return");
    if (!ok) return;
    setReverting(id);
    try {
      await api.revertDownload(id);
      showToast("Rows returned to pool");
      await refreshAll();
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
    showToast("No file found for this user");
  };

  if (detail === null) return <PageSkeleton variant="pools" />;

  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .pool-switch{display:inline-flex;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;gap:3px}
        .pool-switch button{padding:7px 14px;border-radius:6px;border:1px solid transparent;background:transparent;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;min-height:36px;display:inline-flex;align-items:center;gap:6px}
        .pool-switch button.active{background:var(--bg);border-color:var(--border2);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04)}
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);box-shadow:none;filter:none}
        .badge.page{background:#fffbeb;color:#b45309;border-color:#fde68a;box-shadow:none;filter:none}
        .badge.taken{background:var(--bg3);color:var(--text3)}
        .admin-wrap{position:relative;display:inline-flex;flex-shrink:0}
        .admin-dot{position:absolute;right:-4px;bottom:-4px;width:18px;height:18px;display:grid;place-items:center;color:#1d9bf0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.15));background:transparent;border:none;}
        .taken-row td{position:relative}
        .taken-row td .cell-text{color:rgba(255,255,255,.72)!important}
        .user-row{cursor:pointer;transition:background .1s}
        .user-row:hover{background:var(--bg2)}
        .expand-icon{transition:transform .15s;display:inline-flex}
        .expand-icon.open{transform:rotate(90deg)}
        .file-row{animation:fadeIn .15s}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
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
        .pool-card-actions{display:flex;gap:6px;flex-shrink:0}
        .file-card{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.file-card:hover{border-color:var(--text3);box-shadow:var(--shadow-sm)}}
        .file-card:active{transform:scale(.99)}
        .file-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
        .file-card-id{font-size:12px;font-family:var(--mono);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .file-card-stats{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .file-card-stat{font-size:12px;font-family:var(--mono);font-weight:600}
        .dl-card{display:grid;grid-template-columns:auto 36px 1fr auto;gap:12px;align-items:center}
        .dl-card .pool-card-actions{justify-self:end}
        @media(max-width:640px){.dl-card{grid-template-columns:36px 1fr;gap:10px}.dl-card .badge{grid-column:1/-1;justify-self:start}.dl-card .pool-card-actions{grid-column:1/-1;width:100%;justify-content:flex-end}}
        @media(max-width:640px){.pools-stack{flex-direction:column;align-items:stretch}.pools-switch{width:100%}.pools-switch button{flex:1;justify-content:center}.pools-toolbar{flex-direction:column;align-items:stretch}.pools-qty{width:100%}.pools-qty button{flex:1}.pools-download{width:100%;height:44px;justify-content:center}.pools-stats{grid-template-columns:1fr!important}.pool-card{flex-wrap:wrap}.pool-card-actions{width:100%;justify-content:flex-end}}
      `}</style>

      {/* header + switches */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.02em" }}>Pools</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="pool-switch" style={{ background: "#eef2ff", borderColor: "#ddd6fe" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}><PasswordIcon password={p} size={14} />{p}</button>
            ))}
          </div>
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
      </div>

      {/* stats */}
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Available in {poolMeta.label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.available : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>{cur === "cookies_only" ? "Cookies only" : cur === "cookies_2fa" ? "Cookies + 2FA" : "Full"}</div>
          {cur === "page" && verified ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--green)", fontFamily: "var(--mono)" }}>{verified.verified}</span> verified</span>
              <span style={{ fontSize: 12, color: "var(--text2)" }}><span style={{ fontWeight: 700, color: "var(--text3)", fontFamily: "var(--mono)" }}>{verified.unverified}</span> unverified</span>
              {verified.truncated ? <span style={{ fontSize: 11, color: "var(--text3)" }} title={`scan cap ${verified.scanCap}`}>· approx</span> : null}
            </div>
          ) : null}
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Claimed</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.claimed : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>By contributors</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Contributors</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.users : "—"}</div>
        </div>
      </div>

      {/* mode switch */}
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div role="group" aria-label="Take mode" style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3, background: "var(--bg3)", alignSelf: "flex-start" }}>
          <button type="button" aria-pressed={holdMode === "fifo"} className={holdMode === "fifo" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 32 }} onClick={() => setHoldMode("fifo")}>Pool FIFO</button>
          <button type="button" aria-pressed={holdMode === "pick"} className={holdMode === "pick" ? "btn btn-primary" : "btn btn-ghost"} style={{ padding: "6px 12px", fontSize: 13, fontWeight: 600, minHeight: 32 }} onClick={() => setHoldMode("pick")}>Pick users</button>
        </div>
        {holdMode === "fifo" ? (
          <div style={{ fontSize: 12, color: "var(--text3)" }}>Oldest rows first (FIFO) — takes the oldest available rows first across all contributors.</div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={selectAllPick}>All</button>
            <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={clearPick}>Clear</button>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>{selectedUids.length} selected{selectedFileIds.length ? ` · ${selectedFileIds.length} files` : ""}</span>
          </div>
        )}
      </div>

      {/* toolbar — source selector before main Download */}
      <div className="pools-toolbar pools-stack" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {holdMode === "fifo" ? (
            <>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>
                Source
                <select
                  aria-label="Source contributor"
                  value={srcUid}
                  onChange={(e) => setSrcUid(e.target.value)}
                  style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36, maxWidth: 160 }}
                >
                  <option value="">All contributors</option>
                  {(((userFiles as unknown as { userId: string }[] | null) ?? (detail?.users as unknown as { userId: string }[] | null) ?? []) as { userId: string }[]).map((u) => {
                    const du = detail?.users.find((x) => x.userId === u.userId);
                    const label = du ? displayName(du).line1 : u.userId.slice(-6);
                    return <option key={u.userId} value={u.userId}>{label} · {u.userId.slice(-6)}</option>;
                  })}
                </select>
              </label>
              {srcUid ? (
                <select
                  aria-label="Source file"
                  value={srcFileId}
                  onChange={(e) => setSrcFileId(e.target.value)}
                  style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36, maxWidth: 160 }}
                >
                  <option value="">All files</option>
                  {srcFileOptions.map((f) => (
                    <option key={f.fileId} value={f.fileId}>#{f.fileId.slice(-8)} · {f.available} avail</option>
                  ))}
                </select>
              ) : null}
            </>
          ) : null}
          {cur === "page" ? (
            <select
              aria-label="Page verified filter"
              value={verifiedFilter}
              onChange={(e) => setVerifiedFilter(e.target.value as never)}
              style={{ padding: "7px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", minHeight: 36 }}
            >
              <option value="all">All pages</option>
              <option value="verified">Verified only</option>
              <option value="unverified">Unverified only</option>
            </select>
          ) : null}
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
          <button className="btn btn-primary pools-download" disabled={downloading || !totals.available} onClick={() => setHoldConfirmOpen(true)} style={{ boxShadow: "0 1px 6px rgba(0,112,243,.18)", fontWeight: 600 }}>Take {customQty ? Number(customQty) || 0 : poolQty === "all" ? "All" : poolQty} from {poolMeta.label}</button>
        </div>
      </div>

      {/* search */}
      <div style={{ display: "flex", marginTop: 16, marginBottom: 8 }}>
        <SearchInput placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" containerStyle={{ width: "100%" }} />
      </div>

      {/* user list */}
      <div className="card-list" style={{ marginTop: 12 }}>
        {filtered.length === 0 ? (
          <EmptyState title="No contributors yet" sub={search.trim() ? "No match for your search" : "Contributors appear here when they push rows"} action={search.trim() ? { label: "Clear search", onClick: () => setSearch("") } : undefined} />
        ) : filtered.map((u) => {
          const d = displayName(u);
           const isAdmin = Boolean(u.isAdmin || cachedProfiles[u.userId]?.isAdmin);
          const expanded = expandedUser === u.userId;
          const uf = getUserFilesFor(u.userId);
          const checked = selectedUids.includes(u.userId);
          return (
            <div key={u.userId} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div className={`pool-card ${expanded ? "expanded" : ""}`} style={{ position: "relative" }} role="button" tabIndex={0} aria-expanded={expanded} aria-controls={`pool-files-${u.userId}`} onClick={() => toggleExpand(u.userId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(u.userId); } }}>
                {holdMode === "pick" ? (
                  <input type="checkbox" aria-label={`Select ${d.line1}`} checked={checked} onChange={() => toggleUid(u.userId)} onClick={(e) => e.stopPropagation()} style={{ width: 16, height: 16, flexShrink: 0 }} />
                ) : null}
                <span className={`expand-icon ${expanded ? "open" : ""}`} style={{ color: "var(--text3)", flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
                </span>
                <span className="admin-wrap">
                   <ProfileAvatar photoUrl={u.photoUrl ?? cachedProfiles[u.userId]?.photoUrl} fallback={d.line1.charAt(0).toUpperCase()} className="size-9 bg-[var(--bg3)] text-[var(--text2)]" verified={isAdmin} />
                </span>
                <div className="pool-card-info">
                  <div className="pool-card-name">{d.line1}{uf ? <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>{uf.files.length} file{uf.files.length !== 1 ? "s" : ""}</span> : null}</div>
                  {d.line2 ? <div className="pool-card-sub">{d.line2}</div> : null}
                </div>
                <div className="pool-card-stats">
                  <span className="pool-card-stat" style={{ color: "var(--green)" }}>{u.available}</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>/</span>
                  <span className="pool-card-stat" style={{ color: "var(--text3)" }}>{u.claimed}</span>
                </div>
                <div className="pool-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} onClick={() => { setDlUser(u); setPerQty(10); setPerCustom(""); }}>Take</button>
                  <button type="button" className="btn" title="More options" aria-label={`More options for ${d.line1}`} aria-haspopup="menu" aria-expanded={menuUser === u.userId} style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }} onClick={() => setMenuUser(menuUser === u.userId ? null : u.userId)}>⋯</button>
                  {menuUser === u.userId ? (
                    <div data-pool-menu={u.userId} role="menu" aria-label={`Actions for ${d.line1}`} style={{ position: "absolute", right: 8, top: 40, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--rl)", boxShadow: "var(--shadow-lg)", zIndex: 10, minWidth: 160, padding: 4 }}>
                      <button type="button" role="menuitem" style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontWeight: 500 }} onClick={() => openFile(u)}>View file</button>
                      <button type="button" role="menuitem" style={{ display: "flex", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "var(--blue)", color: "#fff", cursor: "pointer", borderRadius: 6, fontWeight: 700, marginTop: 4 }} onClick={() => { setMenuUser(null); setDlUser(u); setPerQty(10); setPerCustom(""); }}>Take</button>
                      {isAdmin ? <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 10px" }}>Admin</div> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              {expanded && (
                <div id={`pool-files-${u.userId}`} className="file-row" style={{ padding: "4px 0 8px 42px" }}>
                  {loadingFiles && !uf ? (
                    <Skeleton className="h-4 w-20" />
                  ) : !uf || uf.files.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>No files in pool</div>
                  ) : (
                    <div className="card-list">
                      {uf.files.map((f) => (
                        <div key={f.fileId} className="file-card" style={{ cursor: "default" }}>
                          {holdMode === "pick" ? (
                            <input type="checkbox" aria-label={`Select file ${f.fileId.slice(-8)}`} checked={selectedFileIds.includes(f.fileId)} onChange={() => toggleFile(f.fileId, u.userId)} style={{ width: 16, height: 16, flexShrink: 0 }} />
                          ) : null}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text3)", flexShrink: 0 }}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>
                          <div className="file-card-info">
                            <div className="file-card-id">#{f.fileId.slice(-8)}</div>
                          </div>
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

      {/* Holds & approvals */}
       <section style={{ marginTop: 16 }} aria-labelledby="holds-title">
         <h2 id="holds-title" style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Holds & approvals</h2>
        {holdsLoading ? <Skeleton className="h-20 w-full" /> : !holds || holds.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>No holds yet</div>
        ) : (
          <div className="card-list">
            {(holds as HoldRecord[]).map((h) => {
              const st = String(h.status || "").toUpperCase();
              const dt = h.at ?? (h as unknown as { ts?: number }).ts;
              const d = dt ? new Date(dt) : null;
              const dateStr = d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
              const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
              const poolLabel = POOL_META[h.poolId]?.label ?? h.poolId;
              const qty = (h as unknown as { claimed?: number; held?: number }).held ?? h.claimed ?? 0;
              const srcUids = (h as unknown as { srcUids?: string[] | null }).srcUids ?? null;
              const srcFileIds = (h as unknown as { srcFileIds?: string[] | null }).srcFileIds ?? null;
              const isHold = st === "HOLD";
              return (
                <div key={h.id} className="pool-card" style={{ cursor: "default" }}>
                  <span className="badge" style={{ background: isHold ? "#fef3c7" : st === "APPROVED" ? "#dcfce7" : "var(--bg3)", color: isHold ? "#92400e" : st === "APPROVED" ? "#166534" : "var(--text3)", borderColor: isHold ? "#fde68a" : st === "APPROVED" ? "#bbf7d0" : "var(--border)" }}>{st}</span>
                  <div className="pool-card-info" style={{ gap: 4 }}>
                    <div className="pool-card-name" title={h.filename}>{h.filename} · {poolLabel}</div>
                    <div className="pool-card-sub">
                      <span title={d ? d.toISOString() : ""}>{dateStr} {timeStr}</span>
                      <span>·</span>
                      <span>{qty} qty</span>
                      <span>·</span>
                      <span>{h.mode ?? "—"}</span>
                      {srcUids && srcUids.length ? <><span>·</span><span title={srcUids.join(", ")}>src: {srcUids.map((s) => s.slice(-6)).join(", ")}</span></> : null}
                      {srcFileIds && srcFileIds.length ? <><span>·</span><span title={srcFileIds.join(", ")}>files: {srcFileIds.map((s) => s.slice(-6)).join(", ")}</span></> : null}
                    </div>
                  </div>
                  <div className="pool-card-actions">
                    {isHold ? (
                      <>
                        <button className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={holdActing === h.id} onClick={() => doApprove(h.id)}>{holdActing === h.id ? "…" : "Approve"}</button>
                        <button className="btn" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, color: "var(--red)" }} disabled={holdActing === h.id} onClick={() => doReject(h.id)}>{holdActing === h.id ? "…" : "Reject"}</button>
                        <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={holdActing === h.id} onClick={() => doReturn(h.id)}>{holdActing === h.id ? "…" : "Return"}</button>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>{st}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
         )}
       </section>

      {/* download history */}
       <section style={{ marginTop: 16 }} aria-labelledby="recent-downloads-title">
         <h2 id="recent-downloads-title" style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Recent downloads</h2>
        {!downloads || downloads.length === 0 ? (
          downloads === null ? <Skeleton className="h-20 w-full" /> : <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>No downloads yet</div>
        ) : (
          <div className="card-list">
            {(downloads as unknown as { id: string; at: number; ts?: number; poolId: string; password: string; claimed: number; filename: string; reverted?: boolean; claimedBy?: string | null; status?: string }[]).map((d) => {
                const rawAt = d.at ?? (d as unknown as { ts?: number }).ts;
                const dt = rawAt != null ? new Date(rawAt) : null;
               const dateStr = dt ? dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
               const timeStr = dt ? dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
               const isReverted = !!(d as unknown as { reverted?: boolean }).reverted;
               const statusUpper = String((d as unknown as { status?: string }).status || (isReverted ? "REVERTED" : "CLAIMED")).toUpperCase();
               const isHold = statusUpper === "HOLD";
               const isApproved = statusUpper === "APPROVED";
               const poolLabel = d.poolId || (d.filename?.includes("page_") ? "page" : d.filename?.includes("2fa") ? "cookies_2fa" : "cookies_only");
              const claimer = d.claimedBy ? adminMap.get(String(d.claimedBy)) : null;
              const claimerId = d.claimedBy ? String(d.claimedBy) : "";
              const claimerIsAdmin = claimerId ? Boolean(claimer?.isAdmin ?? cachedProfiles[claimerId]?.isAdmin) : false;
              const initials = claimer?.name?.charAt(0)?.toUpperCase() || (d.claimedBy ? String(d.claimedBy).charAt(0).toUpperCase() : "");
              return (
                <div
                  key={d.id}
                  className={`pool-card dl-card ${isReverted ? "reverted" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`View download ${d.filename}`}
                  onClick={() => setDetailId(d.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailId(d.id); } }}
                  style={{ cursor: "pointer" }}
                >
                  {(() => { const PoolIcon = (POOL_META[poolLabel] ?? POOL_META.cookies_only).Icon; return (
                  <span title={poolLabel} style={{ flexShrink: 0, display: "inline-flex" }}><PoolIcon size={16} /></span>
                  ); })()}
                  <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                  <span title={claimer?.name ?? (d.claimedBy ? String(d.claimedBy) : "Claimer unknown — before tracking")} style={{ width: 36, height: 36, borderRadius: "50%", overflow: "hidden", display: "grid", placeItems: "center", background: "var(--bg3)", border: "1.5px solid var(--border)", flexShrink: 0, color: "var(--text2)" }}>
                     {claimer ? <ProfileAvatar photoUrl={claimer.photoUrl} fallback={initials || "?"} className="size-9 border-0" /> : <UnknownUserIcon size={16} />}
                  </span>
                  {claimerIsAdmin ? <span title="Verified" style={{ position: "absolute", right: -4, bottom: -4, width: 14, height: 14, display: "grid", placeItems: "center", color: "#1d9bf0", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))" }}><VerifiedIcon size={14} /></span> : null}
                  </span>
                  <div className="pool-card-info">
                    <div className="pool-card-name" title={d.filename}>{d.filename}</div>
                    <div className="pool-card-sub">
                        <span title={dt ? dt.toISOString() : ""}>{dateStr} {timeStr}</span>
                       <span>·</span>
                       <span>{d.claimed} claimed</span>
                       {isHold ? <><span>·</span><span style={{ color: "#92400e", fontWeight: 600 }}>HOLD</span></> : isApproved ? <><span>·</span><span style={{ color: "#166534", fontWeight: 600 }}>APPROVED</span></> : null}
                       {claimer?.name ? <><span>·</span><span title={String(d.claimedBy)} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{claimer.name}</span></> : d.claimedBy ? <><span>·</span><span title={String(d.claimedBy)}>#{String(d.claimedBy).slice(-6)}</span></> : null}
                       {isReverted && !isHold ? <><span>·</span><span style={{ color: "var(--green)", fontWeight: 600 }}>REVERTED</span></> : null}
                       </div>
                    </div>
                   <div className="pool-card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                     <button className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={reDownloading === d.id || isReverted || isHold} onClick={() => doRedownload(d.id, d.filename)}>{isHold ? "On hold" : reDownloading === d.id ? "…" : "Download"}</button>
                      <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, color: isReverted || isHold ? "var(--text3)" : "var(--red)" }} disabled={reverting === d.id || isReverted || isHold} onClick={() => doRevert(d.id)}>{isHold ? "Awaiting" : reverting === d.id ? "…" : isReverted ? "Returned" : "Return"}</button>
                    </div>
                </div>
              );
            })}
          </div>
         )}
       </section>

      {holdConfirmOpen ? (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setHoldConfirmOpen(false); }}>
          <div ref={holdModalRef} className="modal-box" role="dialog" aria-modal="true" aria-labelledby="take-accounts-title" style={{ width: 360 }}>
            <div id="take-accounts-title" className="modal-title">Take accounts</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6, marginBottom: 12 }}>Rows go ON HOLD. Approve to credit balance, Reject to return rows.</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>Taking {customQty ? Number(customQty) || 0 : poolQty === "all" ? totals.available : poolQty as number} from {poolMeta.label}{holdMode === "pick" ? ` · ${selectedUids.length} users${selectedFileIds.length ? ` · ${selectedFileIds.length} files` : ""}` : ""}</div>
            <div className="modal-footer">
               <button type="button" className="btn btn-ghost" onClick={() => setHoldConfirmOpen(false)}>Cancel</button>
               <button type="button" className="btn btn-primary" aria-busy={downloading} disabled={downloading} onClick={doHoldConfirm}>Confirm hold</button>
            </div>
          </div>
        </div>
      ) : null}

      {dlUser ? (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setDlUser(null); }}>
          <div ref={dlModalRef} className="modal-box" role="dialog" aria-modal="true" aria-labelledby="pool-take-title" style={{ width: 360 }}>
            <div id="pool-take-title" className="modal-title">Take accounts</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6, marginBottom: 12 }}>Rows go ON HOLD. Approve to credit balance, Reject to return rows.</div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>{displayName(dlUser).line1} &middot; {dlUser.available} available</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
             {[10, 50].map((n) => <button type="button" key={n} className={`btn ${perQty === n && !perCustom ? "btn-primary" : ""}`} aria-pressed={perQty === n && !perCustom} onClick={() => { setPerQty(n); setPerCustom(""); }}>{n}</button>)}
               <button type="button" className={`btn ${perQty === "all" && !perCustom ? "btn-primary" : ""}`} aria-pressed={perQty === "all" && !perCustom} onClick={() => { setPerQty("all"); setPerCustom(""); }}>All</button>
              <input
                placeholder={perCustomFocused ? "" : "Custom"}
                 aria-label="Custom quantity"
                 inputMode="numeric"
                 pattern="[0-9]*"
                value={perCustom}
                onChange={(e) => setPerCustom(e.target.value.replace(/\D/g, ""))}
                onFocus={(e) => { setPerCustomFocused(true); e.currentTarget.select(); }}
                onBlur={() => setPerCustomFocused(false)}
                style={{ width: 72, padding: "6px 8px", fontSize: 13, border: "1px solid var(--border2)", borderRadius: "var(--r)", outline: "none", textAlign: "center", cursor: perCustom || perCustomFocused ? "text" : "pointer", background: perCustom ? "var(--bg3)" : "var(--bg)" }}
              />
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>Taking {perCustom ? Number(perCustom) || 0 : perQty === "all" ? dlUser.available : perQty as number} of {dlUser.available} available</div>
            <div className="modal-footer">
               <button type="button" className="btn btn-ghost" onClick={() => setDlUser(null)}>Cancel</button>
               <button type="button" className="btn btn-primary" aria-busy={downloading} disabled={downloading} onClick={doUserHold}>Confirm hold</button>
            </div>
          </div>
        </div>
      ) : null}
      <DownloadDetailModal downloadId={detailId} onClose={() => setDetailId(null)} />
      </div>
  );
}
