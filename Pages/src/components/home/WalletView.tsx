import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button";
import { SlideToConfirmButton } from "@/components/ui/slide-to-confirm-button";
import { useAuth } from "@/contexts/AuthContext";
import { api, type Withdrawal } from "@/lib/api";
import { useToast } from "@/lib/toast";

const date = (value: number) => new Date(value).toLocaleString();

function WalletBalance({ balance }: { balance: number }) {
  return <div className="rounded-xl border bg-card p-6 shadow-sm"><div className="text-sm text-muted-foreground">Available balance</div><div className="mt-2 text-4xl font-semibold tracking-tight">${balance.toFixed(2)}</div><div className="mt-2 text-sm text-muted-foreground">Earned from approved pool activity</div></div>;
}

function WithdrawalHistory({ items }: { items: Withdrawal[] }) {
  return <div className="flex flex-col gap-2"><h2 className="text-sm font-semibold">Withdrawal history</h2>{items.length ? items.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm"><div><div className="font-medium">${Number(item.amount).toFixed(2)} via {item.method}</div><div className="text-xs text-muted-foreground">{date(item.created_at)} · {item.account}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{item.status}</span></div>) : <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No withdrawal requests yet.</div>}</div>;
}

function UserWallet() {
  const showToast = useToast();
  const [wallet, setWallet] = useState<{ balance: number; withdrawals: Withdrawal[] } | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Telegram");
  const [account, setAccount] = useState("");
  const [sending, setSending] = useState(false);
  const load = () => api.getWallet().then(setWallet).catch(() => showToast("Could not load wallet. Check your connection."));
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || !account.trim()) { showToast("Enter a valid amount and payout account."); return; }
    setSending(true);
    try { await api.withdraw({ amount: value, method, account: account.trim() }); setAmount(""); setAccount(""); showToast("Withdrawal request sent"); await load(); } catch (error) { showToast(String(error).includes("insufficient") ? "Insufficient balance." : "Could not send withdrawal request."); } finally { setSending(false); }
  };
  if (!wallet) return <div className="p-6 text-sm text-muted-foreground">Loading wallet…</div>;
  return <div className="flex flex-col gap-6"><WalletBalance balance={wallet.balance}/><form onSubmit={submit} className="rounded-xl border bg-card p-6"><h2 className="text-sm font-semibold">Request a withdrawal</h2><p className="mt-1 text-sm text-muted-foreground">Requests are reviewed before payment is sent.</p><div className="mt-4 grid gap-4 sm:grid-cols-3"><label className="flex flex-col gap-2 text-sm font-medium">Amount<input className="h-10 rounded-md border bg-background px-3 font-normal" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></label><label className="flex flex-col gap-2 text-sm font-medium">Method<select className="h-10 rounded-md border bg-background px-3 font-normal" value={method} onChange={(e) => setMethod(e.target.value)}><option>Telegram</option><option>Bank transfer</option><option>Crypto</option></select></label><label className="flex flex-col gap-2 text-sm font-medium">Payout account<input className="h-10 rounded-md border bg-background px-3 font-normal" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Username or address" /></label></div><button className="mt-4 h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50" disabled={sending} type="submit">{sending ? "Sending…" : "Request withdrawal"}</button></form><WithdrawalHistory items={wallet.withdrawals}/></div>;
}

function RequestDialog({ request, onClose, onDone }: { request: Withdrawal | null; onClose: () => void; onDone: () => void }) {
  const showToast = useToast();
  const [acting, setActing] = useState(false);
  if (!request) return null;
  const decide = async (action: "approve" | "reject") => { setActing(true); try { await api.decideWithdrawal(request.id, action); showToast(action === "approve" ? "Withdrawal approved" : "Withdrawal rejected and refunded"); onDone(); onClose(); } catch { showToast("Could not update withdrawal request."); } finally { setActing(false); } };
  return <Dialog open={!!request} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Withdrawal request</DialogTitle><DialogDescription>{request.name || request.user_id} · {date(request.created_at)}</DialogDescription></DialogHeader><div className="flex flex-col gap-2 text-sm"><div><b>Amount:</b> ${Number(request.amount).toFixed(2)}</div><div><b>Method:</b> {request.method}</div><div className="break-all"><b>Account:</b> {request.account}</div><div><b>Status:</b> {request.status}</div></div>{request.status === "PENDING" ? <div className="flex flex-col gap-3 pt-2"><SlideToConfirmButton onConfirm={() => void decide("approve")} disabled={acting} label="Slide to approve"/><HoldToDeleteButton onConfirm={() => void decide("reject")} disabled={acting} label="Hold to reject"/></div> : null}</DialogContent></Dialog>;
}

function AdminRequests() {
  const showToast = useToast();
  const [requests, setRequests] = useState<Withdrawal[] | null>(null);
  const [selected, setSelected] = useState<Withdrawal | null>(null);
  const load = () => api.getWithdrawalRequests().then(setRequests).catch(() => showToast("Could not load withdrawal requests."));
  useEffect(() => { void load(); }, []);
  return <><div className="flex flex-col gap-2"><div><h2 className="text-sm font-semibold">Withdrawal requests</h2><p className="text-sm text-muted-foreground">Open a request to review and approve or reject it.</p></div>{requests?.length ? requests.map((request) => <button type="button" key={request.id} onClick={() => setSelected(request)} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"><div><div className="font-medium">{request.name || `User ${request.user_id.slice(-8)}`} · ${Number(request.amount).toFixed(2)}</div><div className="text-xs text-muted-foreground">{request.method} · {request.account} · {date(request.created_at)}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{request.status}</span></button>) : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No pending withdrawal requests.</div>}</div><RequestDialog request={selected} onClose={() => setSelected(null)} onDone={() => void load()}/></>;
}

export default function WalletView() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"wallet" | "requests">("wallet");
  return <div className="flex flex-col gap-6"><div className="pool-switch" role="tablist" aria-label="Wallet sections"><button type="button" className={tab === "wallet" ? "active" : ""} role="tab" aria-selected={tab === "wallet"} onClick={() => setTab("wallet")}>My wallet</button>{user?.isAdmin ? <button type="button" className={tab === "requests" ? "active" : ""} role="tab" aria-selected={tab === "requests"} onClick={() => setTab("requests")}>Withdrawal requests</button> : null}</div>{tab === "wallet" ? <UserWallet/> : <AdminRequests/>}</div>;
}
