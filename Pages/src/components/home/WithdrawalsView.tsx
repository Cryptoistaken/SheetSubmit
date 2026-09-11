import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SlideToConfirmButton } from "@/components/ui/slide-to-confirm-button";
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button";
import { useAuth } from "@/contexts/AuthContext";
import { api, type Withdrawal } from "@/lib/api";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import { CopyField, maskAccount, shortId, statusLabel, txDate } from "./WalletView";

function WithdrawalHistory({ items }: { items: Withdrawal[] }) {
  const [currency] = useCurrency();
  if (!items.length) return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No withdrawals yet.</div>;
  const badge = (s: string) => s === "APPROVED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : s === "REJECTED" ? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return <div className="flex flex-col gap-2"><h2 className="text-sm font-semibold">Withdrawal history</h2>{items.map((w) => <div key={w.id} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"><div className="min-w-0"><div className="text-sm font-medium truncate">{w.method} · {maskAccount(w.account)}</div><div className="truncate text-xs text-muted-foreground">{txDate(w.created_at)}</div></div><div className="flex shrink-0 flex-col items-end gap-1"><div className="text-sm font-semibold">{fmtMoney(Number(w.amount), currency)}</div><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge(w.status)}`}>{statusLabel(w.status)}</span></div></div>)}</div>;
}

function RequestDialog({ request, onClose, onDone }: { request: Withdrawal | null; onClose: () => void; onDone: () => void }) {
  const [currency] = useCurrency();
  const showToast = useToast();
  const [acting, setActing] = useState(false);
  if (!request) return null;
  const decide = async (action: "approve" | "reject") => { setActing(true); try { await api.decideWithdrawal(request.id, action); showToast(action === "approve" ? "Withdrawal approved" : "Rejected + refunded"); onDone(); onClose(); } catch { showToast("Update failed"); } finally { setActing(false); } };
  return <Dialog open={!!request} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Withdrawal request</DialogTitle><DialogDescription>{request.name || request.user_id} · {new Date(request.created_at).toLocaleString()}</DialogDescription></DialogHeader><div className="flex flex-col gap-2 text-sm"><CopyField label="Amount" value={fmtMoney(Number(request.amount), currency)} copy={Number(request.amount).toFixed(2)} /><CopyField label="Method" value={request.method} /><CopyField label="Account" value={request.account} /><div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{request.status}</span></div><CopyField label="Withdrawal ID" value={request.id} display={shortId(request.id)} mono className="border-t pt-2 text-xs text-muted-foreground" /></div>{request.status === "PENDING" ? <div className="flex flex-col gap-3 pt-2"><SlideToConfirmButton onConfirm={() => void decide("approve")} disabled={acting} label="Slide to approve"/><HoldToDeleteButton onConfirm={() => void decide("reject")} disabled={acting} label="Hold to reject"/></div> : null}</DialogContent></Dialog>;
}

type FilterStatus = "ALL" | "PENDING" | "APPROVED" | "REJECTED";

function AdminRequests() {
  const [currency] = useCurrency();
  const showToast = useToast();
  const [requests, setRequests] = useState<Withdrawal[] | null>(null);
  const [selected, setSelected] = useState<Withdrawal | null>(null);
  const [filter, setFilter] = useState<FilterStatus>("ALL");
  const load = () => api.getWithdrawalRequests().then(setRequests).catch(() => showToast("Couldn't load requests"));
  useEffect(() => { void load(); }, []);
  const filtered = requests?.filter((r) => filter === "ALL" || r.status === filter) ?? [];
  const counts = { ALL: requests?.length ?? 0, PENDING: requests?.filter((r) => r.status === "PENDING").length ?? 0, APPROVED: requests?.filter((r) => r.status === "APPROVED").length ?? 0, REJECTED: requests?.filter((r) => r.status === "REJECTED").length ?? 0 };
  const filters: { key: FilterStatus; label: string }[] = [{ key: "ALL", label: "All" }, { key: "PENDING", label: "Pending" }, { key: "APPROVED", label: "Approved" }, { key: "REJECTED", label: "Rejected" }];
  return <><div className="flex flex-col gap-2"><div><h2 className="text-sm font-semibold">Withdrawal requests</h2><p className="text-sm text-muted-foreground">Open a request to review and approve or reject it.</p></div><div className="flex flex-wrap gap-1.5">{filters.map((f) => <button type="button" key={f.key} onClick={() => setFilter(f.key)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>{f.label}<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">{counts[f.key]}</span></button>)}</div>{filtered.length ? filtered.map((request) => <button type="button" key={request.id} onClick={() => setSelected(request)} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"><div><div className="font-medium">{request.name || `User ${request.user_id.slice(-8)}`} · {fmtMoney(Number(request.amount), currency)}</div><div className="text-xs text-muted-foreground">{request.method} · {request.account} · {new Date(request.created_at).toLocaleString()}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{statusLabel(request.status)}</span></button>) : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No {filter === "ALL" ? "" : filter.toLowerCase() + " "}withdrawal requests.</div>}</div><RequestDialog request={selected} onClose={() => setSelected(null)} onDone={() => void load()}/></>;
}

function OwnWithdrawals() {
  const showToast = useToast();
  const [withdrawals, setWithdrawals] = useState<Withdrawal[] | null>(null);
  useEffect(() => { api.getWallet().then((w) => setWithdrawals(w.withdrawals ?? [])).catch(() => showToast("Couldn't load withdrawals")); }, [showToast]);
  if (!withdrawals) return <div className="p-6 text-sm text-muted-foreground">Loading withdrawals…</div>;
  return <WithdrawalHistory items={withdrawals} />;
}

export default function WithdrawalsView() {
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Withdrawals</h2>
        <p style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 0" }}>{user?.isAdmin ? "Review and approve or reject payout requests" : "Your payout requests"}</p>
      </div>
      {user?.isAdmin ? <AdminRequests /> : <OwnWithdrawals />}
    </div>
  );
}
