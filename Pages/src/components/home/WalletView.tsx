import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SlideToConfirmButton } from "@/components/ui/slide-to-confirm-button";
import { api, type WalletTransaction, type Withdrawal } from "@/lib/api";
import { fmtMoney, loadBdtRate, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";

const METHODS = [{ id: "bKash", label: "bKash", icon: "/bKash.svg", placeholder: "BD mobile number" }, { id: "Nagad", label: "Nagad", icon: "/nagad.svg", placeholder: "BD mobile number" }, { id: "USDT", label: "USDT", icon: "/usdt.svg", placeholder: "BEP20 address" }, { id: "Binance", label: "Binance", icon: "/Binance.svg", placeholder: "Binance UID" }] as const;

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

export const shortId = (id: string) => (id.length > 20 ? id.slice(0, 16) + "…" : id);

const POOL_LABEL: Record<string, string> = { cookies_only: "Cookies", cookies_2fa: "2FA", page: "Page" };
const poolLabel = (id: unknown) => {
  const s = String(id ?? "").trim();
  return POOL_LABEL[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Sale");
};
const rowsText = (n: unknown) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `${v} ${v === 1 ? "row" : "rows"}`;
};
export const maskAccount = (account: string) => {
  const a = account.trim();
  if (!a) return "-";
  if (a.length > 12) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  if (a.length > 4) return `••• ${a.slice(-4)}`;
  return a;
};
export const txDate = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const statusLabel = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

export function WithdrawalStatusBadge({ status }: { status: string }) {
  const cls = status === "APPROVED"
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
    : status === "REJECTED"
      ? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"
      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{statusLabel(status)}</span>;
}

// Withdrawal transactions carry the request id in meta — join against the
// withdrawals list so rows can show pending/approved/rejected.
export function txWithdrawalId(tx: WalletTransaction): string | null {
  const meta = (tx.meta ?? {}) as Record<string, unknown>;
  const id = meta.withdrawal_id;
  return typeof id === "string" && id ? id : null;
}

// Turns raw backend reasons ("Earning - Page · 5 rows paid") into a
// clean title + supporting detail. Handles old rows too.
function formatTx(tx: WalletTransaction): { title: string; detail: string | null } {
  const meta = (tx.meta ?? {}) as Record<string, unknown>;
  const desc = tx.description || "";
  const pool = poolLabel((meta as Record<string, unknown>).pool_id ?? (meta as Record<string, unknown>).pool);
  if (desc.startsWith("Approved hold") || meta.settled) {
    const fromMeta = rowsText(meta.rows);
    const fromDesc = (() => { const m = desc.match(/(\d+)\s+rows?/); return m ? rowsText(Number(m[1])) : null; })();
    const dead = Number(meta.dead ?? 0);
    return {
      title: `Earning: ${pool}`,
      detail: [fromMeta ?? fromDesc ? `${fromMeta ?? fromDesc} paid` : null, dead > 0 ? `${dead} expired` : null].filter(Boolean).join(" · ") || null,
    };
  }
  if (/hold revert/i.test(desc) || /hold return/i.test(desc)) return { title: `Hold returned: ${pool}`, detail: null };
  if (/withdrawal via/i.test(desc)) {
    const method = String(meta.method ?? desc.replace(/.*via\s+/i, "")).trim() || "Withdrawal";
    const acct = String(meta.account ?? "").trim();
    return { title: `Withdrawal: ${method}`, detail: acct ? maskAccount(acct) : null };
  }
  if (/withdrawal refund/i.test(desc)) return { title: "Withdrawal refunded", detail: "Declined payout returned to balance." };
  const pretty = desc
    .replace(/\bpools?\b/gi, "")
    .replace(/(\d+)\s+rows\b/g, (_, n: string) => `${n} ${Number(n) === 1 ? "row" : "rows"}`)
    .replace(/\bcookies_only\b/g, "Cookies")
    .replace(/\bcookies_2fa\b/g, "2FA")
    .replace(/^page\b/i, "Page")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([·.,])/g, "$1")
    .trim();
  return { title: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : "Transaction", detail: null };
}

export function CopyField({ label, value, copy, display, mono, className }: { label: string; value: string; copy?: string; display?: string; mono?: boolean; className?: string }) {
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
  const [currency] = useCurrency();
  return <div className="rounded-xl border bg-card p-6 shadow-sm"><div className="text-sm text-muted-foreground">Available balance</div><div className="mt-2 text-4xl font-semibold tracking-tight">{fmtMoney(balance, currency)}</div><div className="mt-2 text-sm text-muted-foreground">Earned from approved orders</div></div>;
}

type TxFilter = "ALL" | "RECEIVED" | "SENT";

function TxRow({ tx, withdrawalStatus, onOpen }: { tx: WalletTransaction; withdrawalStatus?: string | null; onOpen: () => void }) {
  const [currency] = useCurrency();
  const f = formatTx(tx);
  return <button type="button" onClick={onOpen} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted w-full"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tx.type === "CREDIT" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" : "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"}`}>{tx.type === "CREDIT" ? <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg> : <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>}</div><div className="flex-1 min-w-0"><div className="flex min-w-0 items-center gap-2"><div className="text-sm font-medium truncate">{f.title}</div>{withdrawalStatus ? <WithdrawalStatusBadge status={withdrawalStatus} /> : null}</div><div className="text-xs text-muted-foreground truncate">{[f.detail, txDate(tx.created_at)].filter(Boolean).join(" · ")}</div></div><div className="text-right shrink-0"><div className={`text-sm font-semibold ${tx.type === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{tx.type === "CREDIT" ? "+" : "-"}{fmtMoney(tx.amount, currency)}</div></div></button>;
}

function TxMetaRows({ tx, withdrawalStatus }: { tx: WalletTransaction; withdrawalStatus?: string | null }) {
  const meta = (tx.meta ?? {}) as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  if (meta.pool_id ?? meta.pool) rows.push({ label: "Category", value: poolLabel(meta.pool_id ?? meta.pool) });
  if (withdrawalStatus) rows.push({ label: "Status", value: statusLabel(withdrawalStatus) });
  if (meta.rows != null) { const r = rowsText(meta.rows); if (r) rows.push({ label: "Rows paid", value: r }); }
  if (Number(meta.dead ?? 0) > 0) rows.push({ label: "Expired", value: rowsText(meta.dead) ?? String(meta.dead) });
  if (meta.method) rows.push({ label: "Method", value: String(meta.method) });
  if (meta.account) rows.push({ label: "Account", value: maskAccount(String(meta.account)) });
  return <>{rows.map((r) => <div key={r.label} className="flex justify-between"><span className="text-muted-foreground">{r.label}</span><span>{r.value}</span></div>)}</>;
}

function BalanceHistory({ items, withdrawals }: { items: WalletTransaction[]; withdrawals?: Withdrawal[] }) {
  const [currency] = useCurrency();
  const [filter, setFilter] = useState<TxFilter>("ALL");
  const [detail, setDetail] = useState<WalletTransaction | null>(null);
  const filtered = items.filter((tx) => filter === "RECEIVED" ? tx.type === "CREDIT" : filter === "SENT" ? tx.type === "DEBIT" : true);
  const counts = { ALL: items.length, RECEIVED: items.filter((t) => t.type === "CREDIT").length, SENT: items.filter((t) => t.type === "DEBIT").length };
  const filters: { key: TxFilter; label: string }[] = [{ key: "ALL", label: "All" }, { key: "RECEIVED", label: "Received" }, { key: "SENT", label: "Sent" }];
  const groups = groupByDate(filtered);
  const statusByWithdrawal = new Map((withdrawals ?? []).map((w) => [w.id, w.status]));
  const statusOf = (tx: WalletTransaction): string | null => {
    const id = txWithdrawalId(tx);
    return id ? statusByWithdrawal.get(id) ?? null : null;
  };

  return <>
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2"><h2 className="text-sm font-semibold">Balance history</h2><div className="flex flex-wrap gap-1.5">{filters.map((f) => <button type="button" key={f.key} onClick={() => setFilter(f.key)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>{f.label}<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">{counts[f.key]}</span></button>)}</div></div>
      {groups.length ? groups.map((g) => <div key={g.label} className="flex flex-col gap-1.5"><div className="text-xs font-medium text-muted-foreground px-1">{g.label}</div>{g.items.map((tx) => <TxRow key={tx.id} tx={tx} withdrawalStatus={statusOf(tx)} onOpen={() => setDetail(tx)} />)}</div>) : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No transactions yet.</div>}
    </div>
    <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Transaction details</DialogTitle></DialogHeader>
        {detail && <div className="flex flex-col gap-4">
          <div className={`flex items-center gap-3 rounded-lg p-4 ${detail.type === "CREDIT" ? "bg-emerald-50 dark:bg-emerald-950/50" : "bg-red-50 dark:bg-red-950/50"}`}>
            <div className={`flex h-10 w-10 items-center justify-center rounded-full ${detail.type === "CREDIT" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400" : "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400"}`}>{detail.type === "CREDIT" ? <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg> : <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>}</div>
            <div><div className={`text-2xl font-bold ${detail.type === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{detail.type === "CREDIT" ? "+" : "-"}{fmtMoney(detail.amount, currency)}</div><div className="text-xs text-muted-foreground">{detail.type === "CREDIT" ? "Received" : "Sent"}</div></div>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span className="text-right font-medium">{formatTx(detail).title}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(detail.created_at).toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Balance after</span><span>{fmtMoney(detail.balance_after, currency)}</span></div>
            <TxMetaRows tx={detail} withdrawalStatus={statusOf(detail)} />
          </div>
          {formatTx(detail).detail ? <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{formatTx(detail).detail}</div> : null}
          <CopyField label="Transaction ID" value={detail.id} display={shortId(detail.id)} mono className="border-t pt-2 text-xs text-muted-foreground" />
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}

function UserWallet() {
  const showToast = useToast();
  const [wallet, setWallet] = useState<{ balance: number; transactions: WalletTransaction[]; withdrawals?: Withdrawal[] } | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("bKash");
  const [account, setAccount] = useState("");
  const [sending, setSending] = useState(false);
  const [savedMethods, setSavedMethods] = useState<Record<string, string>>({});
  const [saveAccount, setSaveAccount] = useState(true);
  const [slideKey, setSlideKey] = useState(0);
  const load = () => api.getWallet().then(setWallet).catch(() => showToast("Unable to load wallet. Please try again."));
  useEffect(() => { void load(); api.getPaymentMethods().then(setSavedMethods).catch(() => {}); }, []);
  useEffect(() => { setAccount(savedMethods[method] ?? ""); }, [method, savedMethods]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > (wallet?.balance ?? 0) || !validAccount(method, account)) { showToast(value > (wallet?.balance ?? 0) ? "Amount exceeds your available balance." : "Please check the amount and account details."); return; }
    setSending(true);
    try {
      await api.withdraw({ amount: value, method, account: account.trim() });
      if (saveAccount && account.trim() !== (savedMethods[method] ?? "")) {
        const updated = { ...savedMethods, [method]: account.trim() };
        await api.setPaymentMethods(updated);
        setSavedMethods(updated);
      }
      setAmount(""); setAccount(""); showToast("Withdrawal request submitted successfully."); await load();
    } catch (error) { showToast(String(error).includes("insufficient") ? "Insufficient balance." : "Unable to submit request. Please try again."); } finally { setSending(false); setSlideKey((k) => k + 1); }
  };
  if (!wallet) return <div className="p-6 text-sm text-muted-foreground">Loading wallet…</div>;
  const value = Number(amount);
  const amountOk = Number.isFinite(value) && value > 0 && value <= wallet.balance;
  const accountOk = validAccount(method, account);
  const isBD = method === "bKash" || method === "Nagad";
  return <div className="flex flex-col gap-6"><WalletBalance balance={wallet.balance}/><form onSubmit={submit} className="rounded-xl border bg-card p-6"><h2 className="text-sm font-semibold">Request a withdrawal</h2><p className="mt-1 text-sm text-muted-foreground">Requests are reviewed before payment is sent.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="flex flex-col gap-2 text-sm font-medium"><span className="flex items-center justify-between">Amount<button type="button" className="text-xs font-semibold text-primary" onClick={() => setAmount(wallet.balance.toFixed(2))}>Max</button></span><input className="h-10 rounded-md border bg-background px-3 font-normal" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />{isBD && value > 0 && <span className="text-xs font-normal text-muted-foreground">≈ ৳{Math.round(value * loadBdtRate()).toLocaleString()} <span className="opacity-70">(৳{loadBdtRate()}/$)</span></span>}</label><label className="flex flex-col gap-2 text-sm font-medium">Payout account<input className="h-10 rounded-md border bg-background px-3 font-normal" value={account} onChange={(e) => setAccount(e.target.value)} placeholder={METHODS.find((m) => m.id === method)?.placeholder ?? "Account"} /></label></div><div className="mt-4 flex flex-col gap-2 text-sm font-medium">Method<div className="flex gap-3">{METHODS.map((m) => <button key={m.id} type="button" onClick={() => setMethod(m.id)} className={`flex items-center justify-center rounded-lg border px-3 py-2.5 transition-colors ${method === m.id ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted"}`}><img src={m.icon} alt={m.label} className="h-8 w-8" /></button>)}</div></div><label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"><input type="checkbox" checked={saveAccount} onChange={(e) => setSaveAccount(e.target.checked)} className="h-3.5 w-3.5 rounded border-input" />Save account for {METHODS.find((m) => m.id === method)?.label ?? method}</label><div className="mt-4"><SlideToConfirmButton key={slideKey} label="Slide to withdraw" disabled={sending || !amountOk || !accountOk} onConfirm={() => void submit(new Event("submit") as any)} /></div></form><BalanceHistory items={wallet.transactions} withdrawals={wallet.withdrawals}/></div>;
}

export default function WalletView() {
  return <div className="flex flex-col gap-6"><UserWallet /></div>;
}
