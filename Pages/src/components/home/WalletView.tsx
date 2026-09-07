import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SlideToConfirmButton } from "@/components/ui/slide-to-confirm-button";
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button";
import { useAuth } from "@/contexts/AuthContext";
import { api, type Withdrawal, type WalletTransaction } from "@/lib/api";
import { useToast } from "@/lib/toast";

const METHODS = [{ id: "bKash", label: "bKash", icon: "/bKash.svg", placeholder: "BD mobile number" }, { id: "Nagad", label: "Nagad", icon: "/nagad.svg", placeholder: "BD mobile number" }, { id: "USDT", label: "USDT", icon: "/usdt.svg", placeholder: "BEP20 address" }, { id: "Binance", label: "Binance", icon: "/Binance.svg", placeholder: "Binance UID" }] as const;

const BDT_RATE = 125;
const ACCOUNT_RE: Record<string, RegExp> = {
  bKash: /^(?:\+?880|0)?1[3-9]\d{8}$/,
  Nagad: /^(?:\+?880|0)?1[3-9]\d{8}$/,
  USDT: /^0x[a-fA-F0-9]{40}$/,
  Binance: /^\d{9,10}$/,
};
const validAccount = (method: string, account: string) => Boolean(ACCOUNT_RE[method]?.test(account.trim()));

function copyText(text: string) {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text); return; }
  const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
}

const shortId = (id: string) => (id.length > 20 ? id.slice(0, 16) + "…" : id);

function CopyField({ label, value, copy, display, mono, className }: { label: string; value: string; copy?: string; display?: string; mono?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title="Tap to copy" onClick={() => { copyText(copy ?? value); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className={`group flex w-full cursor-pointer items-center justify-between gap-3 text-left transition-colors hover:text-foreground active:scale-[0.99] ${className ?? ""}`}><span className="shrink-0 text-muted-foreground capitalize">{label}</span><span className={`ml-4 inline-flex min-w-0 items-center gap-1.5 ${mono ? "font-mono" : ""}`}><span className="break-all">{display ?? value}</span>{copied ? <><span className="shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">Copied</span><Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /></> : <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />}</span></button>;
}

function groupByDate(items: WalletTransaction[]) {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1); const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const groups: { label: string; items: WalletTransaction[] }[] = []; const map = new Map<string, WalletTransaction[]>();
  for (const tx of items) { const d = new Date(tx.created_at); let label: string; if (d >= today) label = "Today"; else if (d >= yesterday) label = "Yesterday"; else if (d >= weekAgo) label = "This week"; else label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" }); const arr = map.get(label) || []; arr.push(tx); map.set(label, arr); }
  for (const [label, txs] of map) groups.push({ label, items: txs });
  return groups;
}

function WalletBalance({ balance }: { balance: number }) {
  return <div className="rounded-xl border bg-card p-6 shadow-sm"><div className="text-sm text-muted-foreground">Available balance</div><div className="mt-2 text-4xl font-semibold tracking-tight">${balance.toFixed(2)}</div><div className="mt-2 text-sm text-muted-foreground">Earned from approved pool activity</div></div>;
}

type TxFilter = "ALL" | "RECEIVED" | "SENT";

function BalanceHistory({ items }: { items: WalletTransaction[] }) {
  const [filter, setFilter] = useState<TxFilter>("ALL");
  const [detail, setDetail] = useState<WalletTransaction | null>(null);
  const filtered = items.filter((tx) => filter === "RECEIVED" ? tx.type === "CREDIT" : filter === "SENT" ? tx.type === "DEBIT" : true);
  const counts = { ALL: items.length, RECEIVED: items.filter((t) => t.type === "CREDIT").length, SENT: items.filter((t) => t.type === "DEBIT").length };
  const filters: { key: TxFilter; label: string }[] = [{ key: "ALL", label: "All" }, { key: "RECEIVED", label: "Received" }, { key: "SENT", label: "Sent" }];
  const groups = groupByDate(filtered);

  return <>
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Balance history</h2><div className="flex gap-1.5">{filters.map((f) => <button type="button" key={f.key} onClick={() => setFilter(f.key)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>{f.label}<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">{counts[f.key]}</span></button>)}</div></div>
      {groups.length ? groups.map((g) => <div key={g.label} className="flex flex-col gap-1.5"><div className="text-xs font-medium text-muted-foreground px-1">{g.label}</div>{g.items.map((tx) => <button type="button" key={tx.id} onClick={() => setDetail(tx)} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted w-full"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tx.type === "CREDIT" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" : "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"}`}>{tx.type === "CREDIT" ? <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg> : <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>}</div><div className="flex-1 min-w-0"><div className="text-sm font-medium truncate">{tx.description}</div><div className="text-xs text-muted-foreground">{new Date(tx.created_at).toLocaleTimeString()}</div></div><div className="text-right shrink-0"><div className={`text-sm font-semibold ${tx.type === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{tx.type === "CREDIT" ? "+" : "-"}${tx.amount.toFixed(2)}</div></div></button>)}</div>) : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No transactions yet.</div>}
    </div>
    <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Transaction details</DialogTitle></DialogHeader>
        {detail && <div className="flex flex-col gap-4">
          <div className={`flex items-center gap-3 rounded-lg p-4 ${detail.type === "CREDIT" ? "bg-emerald-50 dark:bg-emerald-950/50" : "bg-red-50 dark:bg-red-950/50"}`}>
            <div className={`flex h-10 w-10 items-center justify-center rounded-full ${detail.type === "CREDIT" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400" : "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400"}`}>{detail.type === "CREDIT" ? <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg> : <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>}</div>
            <div><div className={`text-2xl font-bold ${detail.type === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{detail.type === "CREDIT" ? "+" : "-"}${detail.amount.toFixed(2)}</div><div className="text-xs text-muted-foreground">{detail.type === "CREDIT" ? "Received" : "Sent"}</div></div>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(detail.created_at).toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Balance after</span><span>${detail.balance_after.toFixed(2)}</span></div>
            {detail.meta && Object.entries(detail.meta).map(([k, v]) => <CopyField key={k} label={k.replace(/_/g, " ")} value={String(v)} />)}
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{detail.description}</div>
          <CopyField label="Transaction ID" value={detail.id} display={shortId(detail.id)} mono className="border-t pt-2 text-xs text-muted-foreground" />
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}

function UserWallet() {
  const showToast = useToast();
  const [wallet, setWallet] = useState<{ balance: number; withdrawals: Withdrawal[]; transactions: WalletTransaction[] } | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("bKash");
  const [account, setAccount] = useState("");
  const [sending, setSending] = useState(false);
  const [savedMethods, setSavedMethods] = useState<Record<string, string>>({});
  const [saveAccount, setSaveAccount] = useState(true);
  const [slideKey, setSlideKey] = useState(0);
  const load = () => api.getWallet().then(setWallet).catch(() => showToast("Could not load wallet. Check your connection."));
  useEffect(() => { void load(); api.getPaymentMethods().then(setSavedMethods).catch(() => {}); }, []);
  useEffect(() => { setAccount(savedMethods[method] ?? ""); }, [method, savedMethods]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > (wallet?.balance ?? 0) || !validAccount(method, account)) { showToast(value > (wallet?.balance ?? 0) ? "Amount exceeds your available balance." : "Enter a valid amount and payout account."); return; }
    setSending(true);
    try {
      await api.withdraw({ amount: value, method, account: account.trim() });
      if (saveAccount && account.trim() !== (savedMethods[method] ?? "")) {
        const updated = { ...savedMethods, [method]: account.trim() };
        await api.setPaymentMethods(updated);
        setSavedMethods(updated);
      }
      setAmount(""); setAccount(""); showToast("Withdrawal request sent"); await load();
    } catch (error) { showToast(String(error).includes("insufficient") ? "Insufficient balance." : "Could not send withdrawal request."); } finally { setSending(false); setSlideKey((k) => k + 1); }
  };
  if (!wallet) return <div className="p-6 text-sm text-muted-foreground">Loading wallet…</div>;
  const value = Number(amount);
  const amountOk = Number.isFinite(value) && value > 0 && value <= wallet.balance;
  const accountOk = validAccount(method, account);
  const isBD = method === "bKash" || method === "Nagad";
  return <div className="flex flex-col gap-6"><WalletBalance balance={wallet.balance}/><form onSubmit={submit} className="rounded-xl border bg-card p-6"><h2 className="text-sm font-semibold">Request a withdrawal</h2><p className="mt-1 text-sm text-muted-foreground">Requests are reviewed before payment is sent.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="flex flex-col gap-2 text-sm font-medium"><span className="flex items-center justify-between">Amount<button type="button" className="text-xs font-semibold text-primary" onClick={() => setAmount(wallet.balance.toFixed(2))}>Max</button></span><input className="h-10 rounded-md border bg-background px-3 font-normal" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />{isBD && value > 0 && <span className="text-xs font-normal text-muted-foreground">≈ ৳{Math.round(value * BDT_RATE).toLocaleString()} <span className="opacity-70">(৳{BDT_RATE}/$)</span></span>}</label><label className="flex flex-col gap-2 text-sm font-medium">Payout account<input className="h-10 rounded-md border bg-background px-3 font-normal" value={account} onChange={(e) => setAccount(e.target.value)} placeholder={METHODS.find((m) => m.id === method)?.placeholder ?? "Account"} /></label></div><div className="mt-4 flex flex-col gap-2 text-sm font-medium">Method<div className="flex gap-3">{METHODS.map((m) => <button key={m.id} type="button" onClick={() => setMethod(m.id)} className={`flex items-center justify-center rounded-lg border px-3 py-2.5 transition-colors ${method === m.id ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted"}`}><img src={m.icon} alt={m.label} className="h-8 w-8" /></button>)}</div></div><label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"><input type="checkbox" checked={saveAccount} onChange={(e) => setSaveAccount(e.target.checked)} className="h-3.5 w-3.5 rounded border-input" />Save account for {METHODS.find((m) => m.id === method)?.label ?? method}</label><div className="mt-4"><SlideToConfirmButton key={slideKey} label="Slide to withdraw" disabled={sending || !amountOk || !accountOk} onConfirm={() => void submit(new Event("submit") as any)} /></div></form><BalanceHistory items={wallet.transactions}/></div>;
}

function RequestDialog({ request, onClose, onDone }: { request: Withdrawal | null; onClose: () => void; onDone: () => void }) {
  const showToast = useToast();
  const [acting, setActing] = useState(false);
  if (!request) return null;
  const decide = async (action: "approve" | "reject") => { setActing(true); try { await api.decideWithdrawal(request.id, action); showToast(action === "approve" ? "Withdrawal approved" : "Withdrawal rejected and refunded"); onDone(); onClose(); } catch { showToast("Could not update withdrawal request."); } finally { setActing(false); } };
  return <Dialog open={!!request} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Withdrawal request</DialogTitle><DialogDescription>{request.name || request.user_id} · {new Date(request.created_at).toLocaleString()}</DialogDescription></DialogHeader><div className="flex flex-col gap-2 text-sm"><CopyField label="Amount" value={`$${Number(request.amount).toFixed(2)}`} copy={Number(request.amount).toFixed(2)} /><CopyField label="Method" value={request.method} /><CopyField label="Account" value={request.account} /><div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{request.status}</span></div><CopyField label="Withdrawal ID" value={request.id} display={shortId(request.id)} mono className="border-t pt-2 text-xs text-muted-foreground" /></div>{request.status === "PENDING" ? <div className="flex flex-col gap-3 pt-2"><SlideToConfirmButton onConfirm={() => void decide("approve")} disabled={acting} label="Slide to approve"/><HoldToDeleteButton onConfirm={() => void decide("reject")} disabled={acting} label="Hold to reject"/></div> : null}</DialogContent></Dialog>;
}

type FilterStatus = "ALL" | "PENDING" | "APPROVED" | "REJECTED";

function AdminRequests() {
  const showToast = useToast();
  const [requests, setRequests] = useState<Withdrawal[] | null>(null);
  const [selected, setSelected] = useState<Withdrawal | null>(null);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  const load = () => api.getWithdrawalRequests().then(setRequests).catch(() => showToast("Could not load withdrawal requests."));
  useEffect(() => { void load(); }, []);
  const filtered = requests?.filter((r) => filter === "ALL" || r.status === filter) ?? [];
  const counts = { ALL: requests?.length ?? 0, PENDING: requests?.filter((r) => r.status === "PENDING").length ?? 0, APPROVED: requests?.filter((r) => r.status === "APPROVED").length ?? 0, REJECTED: requests?.filter((r) => r.status === "REJECTED").length ?? 0 };
  const filters: { key: FilterStatus; label: string }[] = [{ key: "ALL", label: "All" }, { key: "PENDING", label: "Pending" }, { key: "APPROVED", label: "Approved" }, { key: "REJECTED", label: "Rejected" }];
  return <><div className="flex flex-col gap-2"><div><h2 className="text-sm font-semibold">Withdrawal requests</h2><p className="text-sm text-muted-foreground">Open a request to review and approve or reject it.</p></div><div className="flex flex-wrap gap-1.5">{filters.map((f) => <button type="button" key={f.key} onClick={() => setFilter(f.key)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>{f.label}<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">{counts[f.key]}</span></button>)}</div>{filtered.length ? filtered.map((request) => <button type="button" key={request.id} onClick={() => setSelected(request)} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"><div><div className="font-medium">{request.name || `User ${request.user_id.slice(-8)}`} · ${Number(request.amount).toFixed(2)}</div><div className="text-xs text-muted-foreground">{request.method} · {request.account} · {new Date(request.created_at).toLocaleString()}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{request.status}</span></button>) : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No {filter === "ALL" ? "" : filter.toLowerCase() + " "}withdrawal requests.</div>}</div><RequestDialog request={selected} onClose={() => setSelected(null)} onDone={() => void load()}/></>;
}

export default function WalletView() {
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;
  const [tab, setTab] = useState<"wallet" | "requests">("wallet");

  if (!isAdmin) {
    return <div className="flex flex-col gap-6"><UserWallet /></div>;
  }

  return <div className="flex flex-col gap-6"><div className="flex justify-center"><div className="pool-switch" role="tablist" aria-label="Wallet sections"><button type="button" className={tab === "wallet" ? "active" : ""} role="tab" aria-selected={tab === "wallet"} onClick={() => setTab("wallet")}>My wallet</button><button type="button" className={tab === "requests" ? "active" : ""} role="tab" aria-selected={tab === "requests"} onClick={() => setTab("requests")}>Withdrawal</button></div></div>{tab === "wallet" ? <UserWallet/> : <AdminRequests/>}</div>;
}
