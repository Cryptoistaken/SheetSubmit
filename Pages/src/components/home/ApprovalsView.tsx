import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { DownloadDetail, HoldRecord } from "@/lib/api";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import { useProfileCache } from "@/stores/profileCache";
import { vibrate } from "@/lib/utils";

import { CookieIcon, FileTypeIcon, PageIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import EmptyState from "./EmptyState";
import SlideSwitch from "@/components/ui/slide-switch";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button";
import { downloadXlsx } from "@/lib/xlsx";

// Columns per pool for client-built xlsx (mirrors backend META cols).
const POOL_DL_COLS: Record<string, { key: string; label: string; width: number }[]> = {
  cookies_only: [{ key: "cookies", label: "cookies", width: 340 }],
  cookies_2fa: [
    { key: "cookies", label: "cookies", width: 340 },
    { key: "twofakey", label: "2fa key", width: 200 },
  ],
  page: [
    { key: "cookies", label: "cookies", width: 340 },
    { key: "twofakey", label: "2fa key", width: 200 },
  ],
};

const PASSWORDS = ["dgddigital", "Love@12345"] as const;
const POOL_TABS = [
  { id: "cookies_only", label: "Cookies" },
  { id: "cookies_2fa", label: "2FA" },
  { id: "page", label: "Page" },
] as const;

const POOL_META: Record<string, { label: string; Icon: typeof CookieIcon }> = {
  cookies_only: { label: "Cookies", Icon: CookieIcon },
  cookies_2fa: { label: "2FA", Icon: TwoFaIcon },
  page: { label: "Page", Icon: PageIcon },
};

function ApprPoolIcon({ poolId, size = 16 }: { poolId: string; size?: number }) {
  const Icon = (POOL_META[poolId] ?? POOL_META.cookies_only).Icon;
  return <Icon size={size} />;
}

const REVERT_MS = 300_000; // must match REVERT_WINDOW in backend pg.ts
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
// window state: null = not yet actioned, >0 = ms left to flip once, 0 = locked
const revertLeft = (h: HoldRecord, now: number) => { const acts = h.actionCount ?? 0; if (acts === 0) return null; const left = h.firstActionAt ? h.firstActionAt + REVERT_MS - now : 0; return left > 0 ? left : 0; };
const holdStatus = (h: HoldRecord) => { const s = String(h.status || "").toUpperCase(); return s === "HOLD" ? "PENDING" : s; };

type ApprFilter = "PENDING" | "APPROVED" | "REJECTED";

export default function ApprovalsView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const showToast = useToast();
  const { profiles: cachedProfiles, fetchProfiles } = useProfileCache();
  const [priceCurrency] = useCurrency();
  const ownerFallback = (uid: string) => (cachedProfiles[uid]?.name || uid).trim().charAt(0).toUpperCase();

  const apprFilter: ApprFilter = (["PENDING", "APPROVED", "REJECTED"].includes((searchParams.get("status") ?? "").toUpperCase())
    ? (searchParams.get("status")!.toUpperCase() as ApprFilter)
    : "PENDING");
  const holdParam = searchParams.get("hold");
  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([k, v]) => { if (v == null) next.delete(k); else next.set(k, v); });
    setSearchParams(next);
  };
  const setApprFilter = (s: ApprFilter) => { setApprSel([]); updateParams({ status: s === "PENDING" ? null : s.toLowerCase(), hold: null }); };

  const [holds, setHolds] = useState<HoldRecord[] | null>(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdsError, setHoldsError] = useState(false);
  const [holdActing, setHoldActing] = useState<string | null>(null);
  const [apprOpenId, setApprOpenId] = useState<string | null>(null);
  const [apprUserOpen, setApprUserOpen] = useState<string | null>(null);
  const [apprDetails, setApprDetails] = useState<Record<string, DownloadDetail | null>>({});
  const [apprLoading, setApprLoading] = useState<string | null>(null);
  const [dlBusyId, setDlBusyId] = useState<string | null>(null);
  const [apprSel, setApprSel] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());

  // prices keyed `${password}:${poolId}` so totals display for both passwords
  const [prices, setPrices] = useState<Record<string, number | null>>({});

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const loadHolds = useCallback(async () => {
    setHoldsLoading(true);
    try {
      // Backend maps PENDING->HOLD; fetch every status so the REJECTED tab works.
      const [pending, approved, rejected] = await Promise.all([
        api.getHolds("HOLD"),
        api.getHolds("APPROVED"),
        api.getHolds("REJECTED"),
      ]);
      const merged = new Map<string, HoldRecord>();
      [...(pending as unknown as HoldRecord[]), ...(approved as unknown as HoldRecord[]), ...(rejected as unknown as HoldRecord[])].forEach((h) => {
        if (h && !merged.has(h.id)) merged.set(h.id, h);
      });
      setHolds([...merged.values()]);
      setHoldsError(false);
    } catch { setHoldsError(true); } finally { setHoldsLoading(false); }
  }, []);

  const loadPrices = useCallback(async () => {
    const allPrices: Record<string, number | null> = {};
    await Promise.all(PASSWORDS.flatMap((pwd) => POOL_TABS.map(async (t) => {
      try { const pr = await api.getPoolPrice(pwd, t.id); allPrices[`${pwd}:${t.id}`] = pr.price; } catch { allPrices[`${pwd}:${t.id}`] = null; }
    })));
    setPrices(allPrices);
  }, []);

  const refreshAll = useCallback(async () => { await Promise.all([loadHolds(), loadPrices()]); }, [loadHolds, loadPrices]);

  useEffect(() => { void loadHolds(); void loadPrices(); }, [loadHolds, loadPrices]);

  useEffect(() => {
    const onFocus = () => { void loadHolds(); void loadPrices(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadHolds, loadPrices]);

  useEffect(() => { void fetchProfiles(); }, [fetchProfiles]);
  useEffect(() => { setApprSel([]); }, [apprFilter]);

  const toggleApproval = (h: HoldRecord) => {
    if (apprOpenId === h.id) { setApprOpenId(null); return; }
    setApprOpenId(h.id);
    setApprUserOpen(null);
    if (!apprDetails[h.id]) {
      setApprLoading(h.id);
      api.getDownloadDetail(h.id).then((v) => setApprDetails((p) => ({ ...p, [h.id]: v }))).catch(() => setApprDetails((p) => ({ ...p, [h.id]: null }))).finally(() => setApprLoading(null));
    }
  };

  useEffect(() => {
    if (!holdParam || !holds) return;
    const h = holds.find((x) => x.id === holdParam);
    if (h && apprOpenId !== h.id) toggleApproval(h);
  }, [holdParam, holds, apprOpenId]);

  const doBulk = async (action: "approve" | "return") => {
    if (!apprSel.length) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(apprSel.map((id) => (action === "approve" ? api.approveHold(id) : api.returnHold(id))));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      vibrate(20);
      if (fail) showToast(`${action === "approve" ? "Approved" : "Returned"} ${ok} of ${results.length}. ${fail} failed.`);
      else showToast(`${action === "approve" ? "Approved" : "Returned"} ${ok} hold${ok > 1 ? "s" : ""}.`);
      setApprSel([]);
      await refreshAll();
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); await loadHolds(); } finally { setBulkBusy(false); }
  };

  const doApprove = async (id: string) => {
    setHoldActing(id);
    try {
      const res = await api.approveHold(id);
      vibrate(20);
      const dead = Number((res as unknown as { dead?: number }).dead || 0);
      const n = Number((res as unknown as { approved?: number }).approved || 0);
      showToast(dead ? `Approved ${n} rows. ${dead} were inactive and not paid.` : "Approved. Payment will be processed in 5 minutes.");
      await refreshAll();
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setHoldActing(null); }
  };
  const doReturn = async (id: string) => {
    setHoldActing(id);
    try {
      await api.returnHold(id);
      vibrate(20);
      showToast("Rejected. Rows have been returned.");
      await refreshAll();
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setHoldActing(null); }
  };
  const doDeleteHold = async (id: string) => {
    setHoldActing(id);
    try {
      const hold = holds?.find((item) => item.id === id)
      if (String(hold?.status || "").toUpperCase() === "APPROVED") {
        try {
          await api.revertDownload(id)
        } catch (e) { showToast("Unable to return. " + (e instanceof Error ? e.message : String(e))); return; }
        try {
          await api.deleteDownload(id)
        } catch {
          showToast("Returned. Cleanup failed, please refresh.");
          await refreshAll();
          return;
        }
        showToast("Approval deleted.")
      } else {
        await api.rejectHold(id)
        showToast("Rejected. Rows have been returned.")
      }
      await refreshAll()
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setHoldActing(null); }
  };

  const doDownloadHold = async (h: HoldRecord, opts?: { srcUid?: string; srcFileId?: string; name?: string; busyKey?: string }) => {
    setDlBusyId(opts?.busyKey ?? h.id);
    try {
      // Slim path: server returns JSON rows, the client builds the xlsx
      // (same as custom downloads) — backend does zero spreadsheet compute.
      const data = await api.getDownloadJson(h.id, opts);
      const rows = Array.isArray(data.rows) ? data.rows : [];
      await downloadXlsx(rows, POOL_DL_COLS[h.poolId] ?? POOL_DL_COLS.cookies_only, data.filename || opts?.name || h.filename || "download.xlsx");
      vibrate(20);
    } catch (e) { showToast("Request failed. " + (e instanceof Error ? e.message : String(e))); } finally { setDlBusyId(null); }
  };

  const apprCounts: Record<ApprFilter, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  (holds ?? []).forEach((h) => { const s = holdStatus(h); if (s === "PENDING" || s === "APPROVED" || s === "REJECTED") apprCounts[s]++; });
  const apprShown = (holds ?? []).filter((h) => holdStatus(h) === apprFilter);
  const priceFor = (h: HoldRecord) => prices[`${h.password}:${h.poolId}`] ?? prices[h.poolId];

  if (holds === null && !holdsError) {
    return <PageSkeleton variant="pools" />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <style>{`
        .badge{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;border:1px solid var(--border);background:var(--bg3);color:var(--text2)}
        .card-list{display:flex;flex-direction:column;gap:8px}
        .pool-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .1s}
        @media(hover:hover){.pool-card:hover{border-color:var(--text3);box-shadow:var(--shadow-md);transform:translateY(-1px)}}
        .pool-card:active{transform:scale(.99)}
        .pool-card.expanded{border-color:var(--text);background:var(--sel-bg)}
        .pool-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
        .pool-card-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);display:flex;align-items:center;gap:8px}
        .pool-card-sub{font-size:12px;color:var(--text3);display:flex;align-items:center;gap:8px}
        .expand-icon{transition:transform .15s;display:inline-flex}
        .expand-icon.open{transform:rotate(90deg)}
        .file-row{animation:fadeIn .15s}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        .pool-card{content-visibility:auto;contain-intrinsic-size:auto 60px}
        .spin{animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(max-width:640px){
          .pool-card{flex-wrap:wrap;row-gap:6px}
        }
      `}</style>

      {/* status filter */}
      <div style={{ display: "flex", marginBottom: 10 }}>
        <div style={{ margin: "0 auto" }}>
          <SlideSwitch ariaLabel="Approval status" value={apprFilter} onChange={setApprFilter} options={(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => ({ value: s, label: (<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{s[0] + s.slice(1).toLowerCase()} <span className="badge" style={{ marginLeft: 2 }}>{apprCounts[s]}</span></span>) }))} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => { void refreshAll(); }} style={{ width: 36, height: 36, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--bg)", color: "var(--text2)", cursor: "pointer" }}>
          <RefreshCw size={16} className={holdsLoading ? "spin" : ""} aria-hidden />
        </button>
      </div>

      {holdsLoading && holds === null ? <Skeleton className="h-20 w-full" /> : holdsError || holds === null ? (
        <EmptyState title="Unable to load approvals." sub="Please check your connection and try again." action={{ label: "Retry", onClick: () => { void refreshAll(); } }} />
      ) : apprShown.length === 0 ? (
        <EmptyState title={`No ${apprFilter.toLowerCase()} approvals.`} sub={apprFilter === "PENDING" ? "New requests will appear here." : `Nothing ${apprFilter === "APPROVED" ? "approved" : "rejected"} yet.`} />
      ) : (
        <>
        {apprSel.length ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg3)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", marginRight: "auto" }}>{apprSel.length} selected</span>
            <button type="button" className="btn btn-primary" disabled={bulkBusy || apprFilter === "APPROVED"} onClick={() => void doBulk("approve")} style={{ minHeight: 36, fontWeight: 700 }}>Approve</button>
            <button type="button" className="btn" disabled={bulkBusy || apprFilter === "REJECTED"} onClick={() => void doBulk("return")} style={{ minHeight: 36 }}>Return</button>
            <button type="button" className="btn btn-ghost" disabled={bulkBusy} onClick={() => setApprSel([])} style={{ minHeight: 36 }}>Clear</button>
          </div>
        ) : null}
        <div className="card-list">
          {apprShown.map((h) => {
            const st = holdStatus(h);
            const dt = h.at ?? (h as unknown as { ts?: number }).ts;
            const d = dt ? new Date(dt) : null;
            const dateStr = d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "-";
            const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
            const poolLabel = POOL_META[h.poolId]?.label ?? h.poolId;
            const qty = (h as unknown as { held?: number; claimed?: number }).held ?? h.claimed ?? 0;
            const price = priceFor(h);
            const open = apprOpenId === h.id;
            const det = apprDetails[h.id];
            const fileIds = [...new Set(((h.srcFileIds ?? []) as (string | null)[]).filter(Boolean) as string[])];
            const ownerUids = det ? [...new Set(det.groups.map((g) => g.srcUid).filter(Boolean) as string[])] : ((h.srcUids ?? []).filter(Boolean) as string[]);
            const baseName = (h.filename || "approval").replace(/\.xlsx$/i, "");
            const left = revertLeft(h, nowTick);
            const locked = !!h.settled || (h.actionCount ?? 0) >= 2 || left === 0;
            return (
              <div key={h.id} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                <div className={`pool-card ${open ? "expanded" : ""}`} onClick={() => toggleApproval(h)} aria-expanded={open}>
                  <input type="checkbox" aria-label={`Select ${h.filename}`} checked={apprSel.includes(h.id)} onChange={() => setApprSel((prev) => prev.includes(h.id) ? prev.filter((x) => x !== h.id) : [...prev, h.id])} onClick={(e) => e.stopPropagation()} style={{ width: 16, height: 16, flexShrink: 0 }} />
                  {fileIds.length ? (
                    <AvatarGroup className="shrink-0" aria-label={`${fileIds.length} file${fileIds.length > 1 ? "s" : ""} in this approval`}>
                      {fileIds.slice(0, 3).map((fid) => (
                        <Avatar key={fid} className="size-7 bg-(--bg3) text-(--text2)">
                          <AvatarFallback><ApprPoolIcon poolId={h.poolId} size={13} /></AvatarFallback>
                        </Avatar>
                      ))}
                      {fileIds.length > 3 ? <AvatarGroupCount>+{fileIds.length - 3}</AvatarGroupCount> : null}
                    </AvatarGroup>
                  ) : (
                    <span title={poolLabel} style={{ flexShrink: 0, display: "inline-flex", color: "var(--text3)" }}><ApprPoolIcon poolId={h.poolId} size={16} /></span>
                  )}
                  {(h.srcUids ?? []).length ? (
                    <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, paddingLeft: 6 }} aria-label={`${(h.srcUids ?? []).length} user${(h.srcUids ?? []).length > 1 ? "s" : ""}`}>
                      {(h.srcUids ?? []).slice(0, 3).map((uid) => (
                        <span key={uid} style={{ marginLeft: -6, border: "2px solid var(--bg)", borderRadius: "50%", display: "inline-flex", lineHeight: 0 }}><ProfileAvatar photoUrl={cachedProfiles[uid]?.photoUrl} fallback={ownerFallback(uid)} className="size-6 bg-(--bg3) text-(--text2)" /></span>
                      ))}
                      {(h.srcUids ?? []).length > 3 ? <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>+{(h.srcUids ?? []).length - 3}</span> : null}
                    </span>
                  ) : null}
                  <span className="badge" style={{ background: st === "PENDING" ? "#fef3c7" : st === "APPROVED" ? "#dcfce7" : "var(--bg3)", color: st === "PENDING" ? "#92400e" : st === "APPROVED" ? "#166534" : "var(--text3)", borderColor: st === "PENDING" ? "#fde68a" : st === "APPROVED" ? "#bbf7d0" : "var(--border)" }}>{st}</span>
                  <div className="pool-card-info" style={{ gap: 4 }}>
                    <div className="pool-card-name" title={h.filename}>{h.filename} · {poolLabel}</div>
                    <div className="pool-card-sub"><span title={d ? d.toISOString() : ""}>{dateStr} {timeStr}</span><span>·</span><span>{qty} qty</span><span>·</span><span>{h.mode ?? "-"}</span><span>·</span><span>{price != null ? fmtMoney(qty * price, priceCurrency) : "-"}</span></div>
                  </div>
                  <span className={`expand-icon ${open ? "open" : ""}`} style={{ color: "var(--text3)", flexShrink: 0, display: "inline-flex" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M9 18l6-6-6-6" /></svg></span>
                </div>
                {open && (
                  <div className="file-row" style={{ padding: "6px 0 10px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--text3)", marginRight: "auto" }}>{qty} rows{price != null ? ` · ${fmtMoney(qty * price, priceCurrency)}` : ""}</span>
                    {left != null ? <span style={{ fontSize: 12, fontWeight: 600, color: locked ? "var(--text3)" : "var(--text2)" }}>{locked ? "Decision final" : `Revertable ${mmss(left)}`}</span> : null}
                    <button type="button" className="btn btn-primary" disabled={st === "APPROVED" || locked || holdActing === h.id} onClick={(e) => { e.stopPropagation(); void doApprove(h.id); }} style={{ minHeight: 36, fontWeight: 700 }}>{st === "APPROVED" ? "Approved" : "Approve"}</button>
                    <button type="button" className="btn" disabled={st === "REJECTED" || locked || holdActing === h.id} onClick={(e) => { e.stopPropagation(); void doReturn(h.id); }} style={{ minHeight: 36 }}>{st === "REJECTED" ? "Rejected" : "Reject"}</button>
                      <button type="button" className="btn" disabled={dlBusyId === h.id} onClick={(e) => { e.stopPropagation(); void doDownloadHold(h); }} style={{ minHeight: 36 }}><Download size={14} aria-hidden /> All</button>
                      {st !== "PENDING" ? <HoldToDeleteButton onConfirm={() => void doDeleteHold(h.id)} disabled={locked || holdActing === h.id} label="Delete" /> : null}
                    </div>
                    {apprLoading === h.id ? <Skeleton className="h-16 w-full" /> : !det || ownerUids.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 2px" }}>{det ? "No user details available for this approval." : "Unable to load details. Please try again."}</div>
                    ) : (
                      <div className="card-list">
                        {ownerUids.map((uid) => {
                          const groups = det.groups.filter((g) => g.srcUid === uid);
                          const rows = groups.reduce((sum, g) => sum + g.count, 0);
                          const profile = cachedProfiles[uid];
                          const label = profile?.name || "#" + uid.slice(-6);
                          const userOpen = apprUserOpen === uid;
                          return (
                            <div key={uid} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                              <div className={`pool-card ${userOpen ? "expanded" : ""}`} style={{ padding: "8px 12px" }} onClick={() => setApprUserOpen(userOpen ? null : uid)} aria-expanded={userOpen}>
                                <span className={`expand-icon ${userOpen ? "open" : ""}`} style={{ color: "var(--text3)", flexShrink: 0, display: "inline-flex" }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M9 18l6-6-6-6" /></svg></span>
                                <ProfileAvatar photoUrl={profile?.photoUrl} fallback={label.charAt(0).toUpperCase()} className="size-8 bg-(--bg3) text-(--text2)" verified={profile?.isAdmin} />
                                <div className="pool-card-info">
                                  <div className="pool-card-name">{label}</div>
                                  <div className="pool-card-sub">{rows} rows · {groups.length} file{groups.length !== 1 ? "s" : ""}{price != null ? ` · ${fmtMoney(rows * price, priceCurrency)}` : ""}</div>
                                </div>
                                <div className="pool-card-actions" onClick={(e) => e.stopPropagation()}>
                                  <button type="button" className="btn" title={`Download all of ${label}'s rows in this approval`} aria-label={`Download ${label}'s rows`} disabled={dlBusyId === `${h.id}:u:${uid}`} onClick={() => void doDownloadHold(h, { srcUid: uid, name: `${baseName} - ${label}.xlsx`, busyKey: `${h.id}:u:${uid}` })}><Download size={14} aria-hidden /></button>
                                </div>
                              </div>
                              {userOpen && (
                                <div className="files-list" style={{ padding: "4px 0 6px 36px" }}>
                                  {groups.map((g) => {
                                    const fname = g.filename || (g.srcFileId ? `#${g.srcFileId.slice(-8)}` : "Unknown file");
                                    return (
                                      <div key={g.srcFileId ?? "unknown"} className="file-card list-row" style={{ cursor: "default" }}>
                                        <div className="file-card-icon"><FileTypeIcon file={{ preset: g.preset ?? undefined, name: g.filename ?? undefined }} size={16} /></div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <div className="file-card-name" dir="auto" title={g.filename ?? undefined}>{fname}</div>
                                          <div className="file-card-meta">{g.createdAt ? new Date(g.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "-"} · {g.count} rows{price != null ? ` · ${fmtMoney(g.count * price, priceCurrency)}` : ""}</div>
                                        </div>
                                        <div className="file-card-actions">
                                          <button type="button" className="file-card-btn" title="Download this file's rows" aria-label={`Download ${fname}`} disabled={!g.srcFileId || dlBusyId === `${h.id}:f:${g.srcFileId}`} onClick={(e) => { e.stopPropagation(); void doDownloadHold(h, { srcUid: uid, srcFileId: g.srcFileId!, name: `${baseName} - ${g.filename || (g.srcFileId ?? "file").slice(-8)}.xlsx`, busyKey: `${h.id}:f:${g.srcFileId}` }); }}><Download size={14} aria-hidden /></button>
                                          {g.srcFileId ? (
                                            <button type="button" className="file-card-btn" title="Open file in browser" aria-label={`Open ${fname} in browser`} onClick={(e) => { e.stopPropagation(); navigate(`/admin/user/${uid}/file/${g.srcFileId}`); }}><ExternalLink size={14} aria-hidden /></button>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
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
        </>
        )}
    </div>
  );
}
