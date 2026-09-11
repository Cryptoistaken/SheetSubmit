import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { DownloadDetail, HoldRecord, PoolDetail, PoolSummary, PoolUserFile, VerifiedCounts } from "@/lib/api";
import type { PoolLivePatch } from "@/lib/poolLive";
import { usePoolLive } from "@/hooks/usePoolLive";
import { BDT_RATE, fmtMoney, inputToUsd, usdToInput, useCurrency, type Currency } from "@/lib/currency";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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

function displayName(u: PoolDetail["users"][number]) {
  const raw: Record<string, unknown> = u as unknown as Record<string, unknown>;
  const n = String(raw["name"] ?? raw["displayName"] ?? "").trim();
  const un = String(raw["username"] ?? "").trim();
  if (n && un) return { line1: n, line2: "@" + un };
  if (un) return { line1: "@" + un, line2: "" };
  if (n) return { line1: "#" + u.userId.slice(-6), line2: "" };
  return { line1: "#" + u.userId, line2: "" };
}

const REVERT_MS = 300_000; // must match REVERT_WINDOW in backend pg.ts
type PriceCurrency = Currency;
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
// window state: null = not yet actioned, >0 = ms left to flip once, 0 = locked
const revertLeft = (h: HoldRecord, now: number) => { const acts = h.actionCount ?? 0; if (acts === 0) return null; const left = h.firstActionAt ? h.firstActionAt + REVERT_MS - now : 0; return left > 0 ? left : 0; };

export default function PoolsView() {
  const params = useParams<{ password: string; poolId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const showToast = useToast();
  const curPwd = PASSWORDS.includes(params.password as never) ? params.password! : "dgddigital";
  const cur = (POOL_TABS.find((t) => t.id === params.poolId)?.id as PoolId) || "cookies_only";
  const { user: me } = useAuth();
  const meIsAdmin = Boolean(me?.isAdmin);
  const ownerFallback = (uid: string) => (cachedProfiles[uid]?.name || uid).trim().charAt(0).toUpperCase();

  const view = searchParams.get("view") === "approvals" ? "approvals" : "pool";
  const apprFilter = (["PENDING", "APPROVED", "REJECTED"].includes((searchParams.get("status") ?? "").toUpperCase())
    ? (searchParams.get("status")!.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED")
    : "PENDING");
  const holdParam = searchParams.get("hold");
  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([k, v]) => { if (v == null) next.delete(k); else next.set(k, v); });
    setSearchParams(next);
  };
  const setView = (v: "pool" | "approvals") => updateParams({ view: v === "approvals" ? "approvals" : null });
  const setApprFilter = (s: "PENDING" | "APPROVED" | "REJECTED") => { setApprSel([]); updateParams({ status: s === "PENDING" ? null : s.toLowerCase(), hold: null }); };

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
  const [holds, setHolds] = useState<HoldRecord[] | null>(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdActing, setHoldActing] = useState<string | null>(null);
  const [apprOpenId, setApprOpenId] = useState<string | null>(null);
  const [apprUserOpen, setApprUserOpen] = useState<string | null>(null);
  const [apprDetails, setApprDetails] = useState<Record<string, DownloadDetail | null>>({});
  const [apprLoading, setApprLoading] = useState<string | null>(null);
  const [dlBusyId, setDlBusyId] = useState<string | null>(null);
  const [apprSel, setApprSel] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [holdsError, setHoldsError] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  void nowTick;
  useEffect(() => {
    if (view !== "approvals") return;
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, [view]);

  // price
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceConfirm, setPriceConfirm] = useState(false);
  const [priceCurrency, setPriceCurrency] = useCurrency();
  // inputs are entered in the selected currency; stored/saved values are always USD
  const switchPriceCurrency = (c: PriceCurrency) => {
    const prev = priceCurrency;
    if (prev !== c && priceOpen) {
      setPriceInputs((p) => {
        const next: Record<string, string> = {};
        POOL_TABS.forEach((t) => {
          const raw = p[t.id] ?? "";
          if (raw.trim() === "" || !Number.isFinite(Number(raw))) { next[t.id] = raw; return; }
          const usd = inputToUsd(raw, prev);
          next[t.id] = Number.isFinite(usd) ? usdToInput(usd, c) : raw;
        });
        return next;
      });
    }
    setPriceCurrency(c);
  };

  const loadHolds = useCallback(async () => {
    setHoldsLoading(true);
    try {
      const list = await api.getHolds() as unknown as HoldRecord[];
      setHolds(Array.isArray(list) ? list : []);
      setHoldsError(false);
    } catch { setHoldsError(true); } finally { setHoldsLoading(false); }
  }, []);

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
    } catch { setLoadFailed(true); showToast("Couldn't load pools"); }
  }, [cur, curPwd, showToast]);

  const refreshAll = useCallback(async () => { await Promise.all([load(), loadHolds(), loadPrices()]); }, [load, loadHolds, loadPrices]);

  useEffect(() => { load(); loadHolds(); loadPrices(); }, [load, loadHolds, loadPrices]);

  useEffect(() => {
    const onFocus = () => { loadHolds(); loadPrices(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadHolds, loadPrices]);

  useEffect(() => {
    if (!holdParam || !holds) return;
    const h = holds.find((x) => x.id === holdParam);
    if (h && apprOpenId !== h.id) toggleApproval(h);
  }, [holdParam, holds, apprOpenId]);

  useEffect(() => {
    if (cur !== "page") { setVerified(null); return; }
    let cancelled = false;
    api.getVerifiedCounts(curPwd, cur).then((r) => { if (!cancelled) setVerified(r); }).catch(() => { if (!cancelled) setVerified(null); });
    return () => { cancelled = true; };
  }, [cur, curPwd]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);
  useEffect(() => { setSelectedUids([]); setSelectedFileIds([]); setApprSel([]); }, [cur, curPwd]);

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
  const holdStatus = (h: HoldRecord) => { const s = String(h.status || "").toUpperCase(); return s === "HOLD" ? "PENDING" : s; };
  const apprCounts: Record<"PENDING" | "APPROVED" | "REJECTED", number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  (holds ?? []).forEach((h) => { const s = holdStatus(h); if (s === "PENDING" || s === "APPROVED" || s === "REJECTED") apprCounts[s]++; });
  const apprShown = (holds ?? []).filter((h) => holdStatus(h) === apprFilter);
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
    const d = displayName(u);
    return [d.line1, d.line2, u.userId].some((s) => s.toLowerCase().includes(q));
  }) : [];

  const go = (pwd: string, pid: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete("hold");
    navigate({ pathname: `/pools/${pwd}/${pid}`, search: next.toString() });
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
    if (cur === "page" && verified && verified.verified === 0) return showToast("No verified rows");
    if (!totals.available) return showToast("No rows available to claim");
    if (!Number.isInteger(n) || n < 1) return showToast("Enter at least 1 row");
    if (holdMode === "pick" && selectedUids.length === 0 && selectedFileIds.length === 0) { showToast("Pick at least 1 user"); return; }
    if (holdMode === "pick" && pickAvail === 0) { showToast("Owners have no rows"); return; }
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; srcFileIds?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: holdMode };
      if (holdMode === "pick") { if (selectedUids.length) payload.srcUids = selectedUids; if (selectedFileIds.length) payload.srcFileIds = selectedFileIds; }
      if (cur === "page") payload.verifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? n;
      if (!held) return showToast("No rows available to claim");
      vibrate(20);
      showToast(`Held ${held} from ${poolMeta.label} — ON HOLD`);
      const holdId = (res as unknown as { holdId?: string; downloadId?: string }).holdId ?? (res as unknown as { downloadId?: string }).downloadId;
      await refreshAll();
      if (holdId) updateParams({ view: "approvals", status: null, hold: holdId });
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doUserHold = async (u: PoolDetail["users"][number]) => {
    const n = customQty ? Number(customQty) : poolQty === "all" ? u.available : (poolQty as number);
    if (cur === "page" && verified && verified.verified === 0) return showToast("No verified rows");
    if (!Number.isInteger(n) || n < 1) return showToast("Set a quantity first");
    setDownloading(true);
    try {
      const payload: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; verifiedOnly?: boolean; unverifiedOnly?: boolean } = { count: n as number | "all", mode: "fifo", srcUids: [u.userId] };
      if (cur === "page") payload.verifiedOnly = true;
      const res = await api.holdPool(curPwd, cur, payload);
      const held = (res as unknown as { held?: number; claimed?: number }).held ?? (res as unknown as { claimed?: number }).claimed ?? 0;
      if (!held) return showToast("No rows available to claim");
      vibrate(20);
      showToast(`Held ${held} from ${displayName(u).line1} — ON HOLD`);
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDownloading(false); }
  };

  const doBulk = async (action: "approve" | "return") => {
    if (!apprSel.length) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(apprSel.map((id) => (action === "approve" ? api.approveHold(id) : api.returnHold(id))));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      vibrate(20);
      if (fail) showToast(`${action === "approve" ? "Approved" : "Returned"} ${ok}/${results.length} (${fail} failed)`);
      else showToast(`${action === "approve" ? "Approved" : "Returned"} ${ok} hold${ok > 1 ? "s" : ""}`);
      setApprSel([]);
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); await loadHolds(); } finally { setBulkBusy(false); }
  };

  const doApprove = async (id: string) => {
    setHoldActing(id);
    try {
      const res = await api.approveHold(id);
      vibrate(20);
      const dead = Number((res as unknown as { dead?: number }).dead || 0);
      const n = Number((res as unknown as { approved?: number }).approved || 0);
      showToast(dead ? `Approved ${n} — ${dead} dead, not paid` : "Approved — pays in 5 min");
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doReturn = async (id: string) => {
    setHoldActing(id);
    try {
      await api.returnHold(id);
      vibrate(20);
      showToast("Rejected — rows returned");
      await refreshAll();
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };
  const doDeleteHold = async (id: string) => {
    setHoldActing(id);
    try {
      const hold = holds?.find((item) => item.id === id)
      if (String(hold?.status || "").toUpperCase() === "APPROVED") {
        try {
          await api.revertDownload(id)
        } catch (e) { showToast("Return failed: " + String(e instanceof Error ? e.message : e)); return; }
        try {
          await api.deleteDownload(id)
        } catch {
          showToast("Returned (delete failed)");
          await refreshAll();
          return;
        }
        showToast("Approval deleted")
      } else {
        await api.rejectHold(id)
        showToast("Rejected — rows returned")
      }
      await refreshAll()
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setHoldActing(null); }
  };

  const toggleApproval = (h: HoldRecord) => {
    if (apprOpenId === h.id) { setApprOpenId(null); return; }
    setApprOpenId(h.id);
    setApprUserOpen(null);
    if (!apprDetails[h.id]) {
      setApprLoading(h.id);
      api.getDownloadDetail(h.id).then((v) => setApprDetails((p) => ({ ...p, [h.id]: v }))).catch(() => setApprDetails((p) => ({ ...p, [h.id]: null }))).finally(() => setApprLoading(null));
    }
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

    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); } finally { setDlBusyId(null); }
  };

  const validatePrices = (): string[] => {
    const errors: string[] = [];
    const max = priceCurrency === "USD" ? 1000 : 1000 * BDT_RATE;
    POOL_TABS.forEach((t) => {
      const raw = priceInputs[t.id] ?? "";
      const v = Number(raw);
      if (!raw.trim() || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${POOL_META[t.id].label}: 0-${max.toLocaleString("en-US")}${priceCurrency === "BDT" ? "৳" : ""}`);
    });
    return errors;
  };

  const hasPriceChanges = POOL_TABS.some((t) => {
    const raw = priceInputs[t.id] ?? "";
    if (raw.trim() === "") return false;
    const v = inputToUsd(raw, priceCurrency);
    const old = prices[t.id];
    return Number.isFinite(v) && (old == null || Math.abs(v - old) > 1e-9);
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
        const v = inputToUsd(priceInputs[t.id] ?? "0", priceCurrency);
        try { const res = await api.setPoolPrice(curPwd, t.id, v); updated[t.id] = res.price; } catch { updated[t.id] = prices[t.id] ?? null; }
      }));
      setPrices(updated);
      setPriceConfirm(false);
      setPriceOpen(false);
      showToast("Prices saved");
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setPriceSaving(false) }
  };

  if (detail === null) {
    return loadFailed ? (
      <div style={{ padding: 24 }}>
        <EmptyState title="Could not load pools" sub="Check your connection and try again" action={{ label: "Retry", onClick: () => { void load(); } }} />
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

      {/* top-level view tabs */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16, position: "relative" }}>
        <div
          className="pool-switch"
          style={{ margin: "0 auto" }}
          role="tablist"
          aria-label="Pools page sections"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = view === "pool" ? "approvals" : "pool";
            setView(next);
            e.currentTarget.querySelector<HTMLButtonElement>(`button[data-view="${next}"]`)?.focus();
          }}
        >
          <button role="tab" data-view="pool" id="tab-pool" aria-selected={view === "pool"} aria-controls="pools-panel-pool" className={view === "pool" ? "active" : ""} onClick={() => setView("pool")}>Pool</button>
          <button role="tab" data-view="approvals" id="tab-approvals" aria-selected={view === "approvals"} aria-controls="pools-panel-approvals" className={view === "approvals" ? "active" : ""} onClick={() => setView("approvals")}>Approvals{apprCounts.PENDING ? <span className="badge" style={{ marginLeft: 6 }}>{apprCounts.PENDING}</span> : null}</button>
        </div>
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => { void refreshAll(); }} style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)", width: 36, height: 36, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--bg)", color: "var(--text2)", cursor: "pointer" }}>
          <RefreshCw size={16} className={holdsLoading ? "spin" : ""} aria-hidden />
        </button>
      </div>

      {view === "pool" ? (
      <div id="pools-panel-pool" role="tabpanel" aria-labelledby="tab-pool">
      {/* switches */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
          <div className="pool-switch stretch" style={{ background: "#eef2ff", borderColor: "#ddd6fe" }}>
            {PASSWORDS.map((p) => (
              <button key={p} className={curPwd === p ? "active" : ""} onClick={() => go(p, cur)}><PasswordIcon password={p} size={14} />{p}</button>
            ))}
          </div>
          {meIsAdmin ? <Button variant="outline" size="sm" onClick={() => { const init: Record<string, string> = {}; POOL_TABS.forEach((t) => { const v = prices[t.id] ?? prices[Object.keys(prices)[0]] ?? null; init[t.id] = v != null ? usdToInput(v, priceCurrency) : ""; }); setPriceInputs(init); setPriceOpen(true); }}>{prices[cur] != null ? `price ${fmtMoney(prices[cur]!, priceCurrency)}` : "Unit price"}</Button> : null}
          <div className="pool-switch stretch">
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
      <div className="pools-stats" style={{ display: "grid", gridTemplateColumns: `repeat(${cur === "cookies_only" ? 3 : 4},1fr)`, gap: 12, marginTop: 16 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }} aria-busy={detail === null}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Ready to take</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? (cur === "page" && verified ? verified.verified : totals.available) : "—"}</div>
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
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.claimed : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>held or claimed</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Owners</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.users : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>source users</div>
        </div>
        {cur !== "cookies_only" ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 14, background: "var(--bg)" }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Invalid</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 4 }}>{detail ? totals.invalid ?? 0 : "—"}</div>
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
          <div className="taker-cell"><small>Amount</small>{unitPrice != null ? `${effectiveN} × ${fmtMoney(unitPrice, priceCurrency)} = ${fmtMoney(effectiveN * unitPrice, priceCurrency)}` : "—"}</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={downloading || (cur === "page" ? !(verified ? verified.verified > 0 : totals.available > 0) : !totals.available)} onClick={() => void doHoldConfirm()} style={{ width: "100%", marginTop: 12, padding: "12px 24px", fontSize: 15, fontWeight: 700, borderRadius: "var(--rl)", boxShadow: "0 2px 10px rgba(0,112,243,.22)", justifyContent: "center" }}>Take {customQty ? Number(customQty) || 0 : poolQty === "all" ? (cur === "page" ? "All verified" : "All") : poolQty} from {poolMeta.label}</button>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text3)" }}>{cur === "page" ? "Page pool is verified-only. Take creates a hold. First approve/reject opens a 5-minute window to flip once; owners are paid when it settles." : "Take creates a hold. First approve/reject opens a 5-minute window to flip once; owners are paid when it settles."}</div>
      </div>

      <div style={{ display: "flex", marginTop: 16, marginBottom: 8 }}>
        <SearchInput placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search owners" containerStyle={{ width: "100%" }} />
      </div>
      <h2 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>Owners</h2>

      <div className="card-list">
        {filtered.length === 0 ? (
          <EmptyState title="No owners yet" sub={search.trim() ? "No match for your search" : "Owners appear here when they push rows"} action={search.trim() ? { label: "Clear search", onClick: () => setSearch("") } : undefined} />
        ) : filtered.map((u) => {
          const d = displayName(u);
          const isAdmin = Boolean(u.isAdmin || cachedProfiles[u.userId]?.isAdmin);
          const expanded = expandedUser === u.userId;
          const uf = getUserFilesFor(u.userId);
          const checked = selectedUids.includes(u.userId);
          return (
            <div key={u.userId} style={{ display: "flex", flexDirection: "column", gap: expanded ? 8 : 0 }}>
              <div className={`pool-card ${expanded ? "expanded" : ""}`} style={{ position: "relative" }} onClick={() => toggleExpand(u.userId)}>
                {holdMode === "pick" ? <input type="checkbox" aria-label={`Select ${d.line1}`} checked={checked} onChange={() => toggleUid(u.userId)} onClick={(e) => e.stopPropagation()} style={{ width: 16, height: 16, flexShrink: 0 }} /> : null}
                <button type="button" className={`expand-icon ${expanded ? "open" : ""}`} aria-expanded={expanded} aria-controls={`pool-files-${u.userId}`} aria-label={`${expanded ? "Hide" : "Show"} files for ${d.line1}`} onClick={(e) => { e.stopPropagation(); toggleExpand(u.userId); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(u.userId); } }} style={{ color: "var(--text3)", flexShrink: 0, background: "transparent", border: "none", cursor: "pointer", width: 32, height: 32, display: "inline-grid", placeItems: "center", padding: 0 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M9 18l6-6-6-6" /></svg></button>
                <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}><ProfileAvatar photoUrl={u.photoUrl ?? cachedProfiles[u.userId]?.photoUrl} fallback={d.line1.charAt(0).toUpperCase()} className="size-9 bg-(--bg3) text-(--text2)" verified={isAdmin} /></span>
                {uf && uf.files.length ? (
                  <AvatarGroup className="shrink-0" aria-label={`${uf.files.length} file${uf.files.length > 1 ? "s" : ""} in pool`}>
                    {uf.files.slice(0, 3).map((f) => (
                      <Avatar key={f.fileId} className="size-7 bg-(--bg3) text-(--text2)" title={f.name || f.fileId}>
                        <AvatarFallback><FileTypeIcon file={{ preset: f.preset ?? undefined, name: f.name ?? undefined }} size={13} /></AvatarFallback>
                      </Avatar>
                    ))}
                    {uf.files.length > 3 ? <AvatarGroupCount>+{uf.files.length - 3}</AvatarGroupCount> : null}
                  </AvatarGroup>
                ) : null}
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
                  <button type="button" className="btn btn-primary" style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600 }} disabled={downloading} onClick={() => void doUserHold(u)}>Take</button>
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
                            <div className="file-card-meta">{f.createdAt ? new Date(f.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"} · {f.available} avail · {f.claimed} taken</div>
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
      </div>) : (
      <section id="pools-panel-approvals" role="tabpanel" aria-labelledby="tab-approvals">
        <div style={{ display: "flex", marginBottom: 10 }}>
          <div className="pool-switch" style={{ margin: "0 auto" }}>
            {(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => (
              <button key={s} className={apprFilter === s ? "active" : ""} onClick={() => setApprFilter(s)}>{s[0] + s.slice(1).toLowerCase()} <span className="badge" style={{ marginLeft: 2 }}>{apprCounts[s]}</span></button>
            ))}
          </div>
        </div>
        {holdsLoading ? <Skeleton className="h-20 w-full" /> : holdsError ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>
            Could not load approvals. <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => { void loadHolds(); }}>Retry</button>
          </div>
        ) : !holds || apprShown.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)", padding: 24, textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)" }}>No {apprFilter.toLowerCase()} approvals</div>
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
              const dateStr = d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
              const timeStr = d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
              const poolLabel = POOL_META[h.poolId]?.label ?? h.poolId;
              const qty = (h as unknown as { held?: number; claimed?: number }).held ?? h.claimed ?? 0;
              const price = prices[h.poolId];
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
                            <AvatarFallback><PoolTypeIcon poolId={h.poolId} size={13} /></AvatarFallback>
                          </Avatar>
                        ))}
                        {fileIds.length > 3 ? <AvatarGroupCount>+{fileIds.length - 3}</AvatarGroupCount> : null}
                      </AvatarGroup>
                    ) : (
                      <span title={poolLabel} style={{ flexShrink: 0, display: "inline-flex", color: "var(--text3)" }}><PoolTypeIcon poolId={h.poolId} size={16} /></span>
                    )}
                    {(h.srcUids ?? []).length ? (
                      <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, paddingLeft: 6 }} aria-label={`${(h.srcUids ?? []).length} owner${(h.srcUids ?? []).length > 1 ? "s" : ""}`}>
                        {(h.srcUids ?? []).slice(0, 3).map((uid) => (
                          <span key={uid} style={{ marginLeft: -6, border: "2px solid var(--bg)", borderRadius: "50%", display: "inline-flex", lineHeight: 0 }}><ProfileAvatar photoUrl={cachedProfiles[uid]?.photoUrl} fallback={ownerFallback(uid)} className="size-6 bg-(--bg3) text-(--text2)" /></span>
                        ))}
                        {(h.srcUids ?? []).length > 3 ? <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>+{(h.srcUids ?? []).length - 3}</span> : null}
                      </span>
                    ) : null}
                    <span className="badge" style={{ background: st === "PENDING" ? "#fef3c7" : st === "APPROVED" ? "#dcfce7" : "var(--bg3)", color: st === "PENDING" ? "#92400e" : st === "APPROVED" ? "#166534" : "var(--text3)", borderColor: st === "PENDING" ? "#fde68a" : st === "APPROVED" ? "#bbf7d0" : "var(--border)" }}>{st}</span>
                    <div className="pool-card-info" style={{ gap: 4 }}>
                      <div className="pool-card-name" title={h.filename}>{h.filename} · {poolLabel}</div>
                      <div className="pool-card-sub"><span title={d ? d.toISOString() : ""}>{dateStr} {timeStr}</span><span>·</span><span>{qty} qty</span><span>·</span><span>{h.mode ?? "—"}</span><span>·</span><span>{price != null ? fmtMoney(qty * price, priceCurrency) : "—"}</span></div>
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
                        <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 2px" }}>{det ? "No owner breakdown for this approval" : "Could not load details"}</div>
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
                                            <div className="file-card-meta">{g.createdAt ? new Date(g.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"} · {g.count} rows{price != null ? ` · ${fmtMoney(g.count * price, priceCurrency)}` : ""}</div>
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
      </section>
      )}

      {/* price dialog */}
      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
         <DialogContent>
          <DialogHeader><DialogTitle>Unit price</DialogTitle><DialogDescription>{priceCurrency === "USD" ? `Set price per row for each pool (${curPwd}) — 0 to 1000` : `Enter BDT per row — auto-converts to USD (৳${BDT_RATE} = $1)`}</DialogDescription></DialogHeader>
          <div className="pool-switch" style={{ alignSelf: "flex-start" }} role="group" aria-label="Price entry currency">
            <button type="button" className={priceCurrency === "USD" ? "active" : ""} aria-pressed={priceCurrency === "USD"} onClick={() => switchPriceCurrency("USD")}>USD</button>
            <button type="button" className={priceCurrency === "BDT" ? "active" : ""} aria-pressed={priceCurrency === "BDT"} onClick={() => switchPriceCurrency("BDT")}>BDT</button>
          </div>
          <div className="flex flex-col gap-3">
            {POOL_TABS.map((t) => {
              const meta = POOL_META[t.id];
              const raw = priceInputs[t.id] ?? "";
              const typed = Number(raw);
              const typedOk = raw.trim() !== "" && Number.isFinite(typed);
              const other = typedOk ? (priceCurrency === "USD" ? fmtMoney(typed, "BDT") : fmtMoney(inputToUsd(raw, "BDT"), "USD")) : null;
              return <label key={t.id} className="flex flex-col gap-1.5"><span className="text-sm font-medium flex items-center gap-2"><meta.Icon size={14} />{meta.label}{prices[t.id] != null ? <span className="text-muted-foreground text-xs font-normal">· {fmtMoney(prices[t.id]!, priceCurrency)}</span> : null}</span><input aria-label={`${meta.label} price in ${priceCurrency}`} type="number" min={0} max={priceCurrency === "USD" ? 1000 : 1000 * BDT_RATE} step={0.01} value={priceInputs[t.id] ?? ""} onChange={(e) => setPriceInputs((p) => ({ ...p, [t.id]: e.target.value }))} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />{other ? <span className="text-xs text-muted-foreground">≈ {other}</span> : null}</label>;
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
              const newP = inputToUsd(priceInputs[t.id] ?? "0", priceCurrency);
              if (oldP == null || !Number.isFinite(newP) || Math.abs(oldP - newP) <= 1e-9) return null;
              return (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="flex items-center gap-2 font-medium"><meta.Icon size={14} />{meta.label}</span>
                  <span className="text-muted-foreground">{oldP != null ? fmtMoney(oldP, priceCurrency) : "—"}</span>
                  <span>→</span>
                  <span className="font-medium">{fmtMoney(newP, priceCurrency)}</span>
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
      </div>
  );
}
