import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { DbHealth, DownloadMeta, HoldRecord, NeonUsage, Withdrawal } from "@/lib/api";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import PageSkeleton from "@/components/ui/page-skeleton";

const PASSWORDS = ["dgddigital", "Love@12345"] as const;
const POOLS = [
  { id: "cookies_only", label: "Cookies" },
  { id: "cookies_2fa", label: "2FA" },
  { id: "page", label: "Page" },
] as const;

interface PoolStock { password: string; poolId: string; available: number; claimed: number; invalid: number }

type FeedItem =
  | { kind: "hold"; ts: number; id: string; label: string; sub: string; to: string }
  | { kind: "take"; ts: number; id: string; label: string; sub: string; to: string }
  | { kind: "withdrawal"; ts: number; id: string; label: string; sub: string; to: string };

function holdTs(h: HoldRecord): number { return Number(h.at ?? h.ts ?? 0) || 0; }

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
const fmtInt = (n: number) => Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";

export default function AnalysisView() {
  const navigate = useNavigate();
  const showToast = useToast();
  const [currency] = useCurrency();

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [stock, setStock] = useState<PoolStock[]>([]);
  const [holds, setHolds] = useState<HoldRecord[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [downloads, setDownloads] = useState<DownloadMeta[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [stats, setStats] = useState<{ totalUsers: number; totalFiles: number } | null>(null);
  const [dbHealth, setDbHealth] = useState<DbHealth | null>(null);
  const [neonUsage, setNeonUsage] = useState<NeonUsage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [views, pending, approved, rejected, priceRes, dls, reqs, s, db, neon] = await Promise.all([
        Promise.all(PASSWORDS.flatMap((pwd) => POOLS.map((p) => api.getPoolView(pwd, p.id).then(
          (v) => ({ password: pwd, poolId: p.id, available: v.totals.available, claimed: v.totals.claimed, invalid: v.totals.invalid ?? 0 }),
          (): PoolStock => ({ password: pwd, poolId: p.id, available: 0, claimed: 0, invalid: 0 }),
        )))),
        api.getHolds("HOLD"),
        api.getHolds("APPROVED"),
        api.getHolds("REJECTED"),
        api.getPoolPrices().catch(() => ({ prices: [] as { password: string | null; poolId: string; price: number }[] })),
        api.getDownloads().catch((): DownloadMeta[] => []),
        api.getWithdrawalRequests().catch((): Withdrawal[] => []),
        api.adminStats().catch(() => null),
        api.adminDbHealth().catch(() => null),
        api.adminNeonUsage().catch(() => null),
      ]);
      const merged = new Map<string, HoldRecord>();
      [...pending, ...approved, ...rejected].forEach((h) => { if (h && !merged.has(h.id)) merged.set(h.id, h); });
      const priceMap: Record<string, number> = {};
      for (const p of priceRes.prices) priceMap[`${p.password}:${p.poolId}`] = Number(p.price) || 0;
      setStock(views);
      setHolds([...merged.values()]);
      setPrices(priceMap);
      setDownloads(dls);
      setWithdrawals(reqs);
      setStats(s);
      setDbHealth(db);
      setNeonUsage(neon);
    } catch {
      setFailed(true);
      showToast("Unable to load analysis. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <PageSkeleton variant="admin" />;
  if (failed) return (
    <div style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
      <p className="text-sm text-muted-foreground">Unable to load analysis.</p>
      <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void load()}>Retry</button>
    </div>
  );

  const statusOf = (h: HoldRecord) => String(h.status || "").toUpperCase() === "HOLD" ? "PENDING" : String(h.status || "").toUpperCase();
  const byStatus = (s: string) => holds.filter((h) => statusOf(h) === s);
  const moneyInFlight = byStatus("PENDING").reduce((sum, h) => sum + (Number(h.claimed) || 0) * (prices[`${h.password}:${h.poolId}`] ?? 0), 0);
  const paid = downloads.filter((d) => String(d.status || "").toUpperCase() === "APPROVED");
  const paidTotal = paid.reduce((sum, d) => sum + (Number(d.total) || 0), 0);
  const openWd = withdrawals.filter((w) => w.status === "PENDING");
  const openWdTotal = openWd.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
  const stockTotal = stock.reduce((a, s) => ({ available: a.available + s.available, claimed: a.claimed + s.claimed, invalid: a.invalid + s.invalid }), { available: 0, claimed: 0, invalid: 0 });

  const feed: FeedItem[] = [
    ...holds.map((h): FeedItem => ({
      kind: "hold", ts: holdTs(h), id: "hold:" + h.id,
      label: `${statusOf(h)} hold · ${Number(h.claimed) || 0} rows · ${h.password}/${h.poolId}`,
      sub: new Date(holdTs(h)).toLocaleString(), to: `/approvals?hold=${encodeURIComponent(h.id)}`,
    })),
    ...downloads.filter((d) => String(d.status || "").toUpperCase() === "CLAIMED").map((d): FeedItem => ({
      kind: "take", ts: Number(d.at) || 0, id: "take:" + d.id,
      label: `Take · ${Number(d.claimed) || 0} rows · ${d.password}/${d.poolId}`,
      sub: new Date(Number(d.at) || 0).toLocaleString(), to: `/pools/${encodeURIComponent(d.password)}/${encodeURIComponent(d.poolId)}`,
    })),
    ...withdrawals.map((w): FeedItem => ({
      kind: "withdrawal", ts: Number(w.created_at) || 0, id: "wd:" + w.id,
      label: `${w.status} withdrawal · ${fmtMoney(Number(w.amount), currency)} · ${w.name || w.user_id}`,
      sub: new Date(Number(w.created_at) || 0).toLocaleString(), to: "/withdrawals",
    })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 50);

  const card = (label: string, value: string, sub?: string) => (
    <div key={label} className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );

  return (
    <div style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }} className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Analysis</h2>
          <p style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 0" }}>Business overview and recent activity</p>
        </div>
        <button type="button" className="btn btn-ghost" aria-label="Refresh analysis" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </div>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>Business overview</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {card("Pool stock · available", String(stockTotal.available), `claimed ${stockTotal.claimed} · invalid ${stockTotal.invalid}`)}
          {card("Holds · pending", String(byStatus("PENDING").length), `approved ${byStatus("APPROVED").length} · rejected ${byStatus("REJECTED").length}`)}
          {card("Money in flight", fmtMoney(moneyInFlight, currency), "pending holds × pool price")}
          {card("Payouts paid", fmtMoney(paidTotal, currency), `${paid.length} settled approvals`)}
          {card("Open withdrawals", `${openWd.length} · ${fmtMoney(openWdTotal, currency)}`)}
          {card("Users / files", `${stats?.totalUsers ?? "—"} / ${stats?.totalFiles ?? "—"}`)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" style={{ marginTop: 8 }}>
          {stock.map((s) => (
            <div key={`${s.password}:${s.poolId}`} className="rounded-lg border bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground">{s.password} · {s.poolId}</div>
              <div className="text-lg font-semibold">{s.available}</div>
              <div className="text-xs text-muted-foreground">available · {s.claimed} claimed · {s.invalid} invalid</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>DB health</h3>
        {!dbHealth ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">DB health unavailable.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground" style={{ marginBottom: 6 }}>Tables by size</div>
              {dbHealth.tables.slice(0, 10).map((t) => (
                <div key={t.table} className="flex items-center justify-between gap-3 text-sm" style={{ padding: "2px 0" }}>
                  <span className="font-mono text-xs">{t.table}</span>
                  <span className="text-xs text-muted-foreground">{fmtBytes(t.bytes)} · {fmtInt(t.rows)} rows</span>
                </div>
              ))}
            </div>
            {dbHealth.statements.statsAvailable ? (
              <div className="rounded-lg border bg-card px-4 py-3">
                <div className="text-xs text-muted-foreground" style={{ marginBottom: 6 }}>Slowest queries</div>
                {dbHealth.statements.byTime.slice(0, 5).map((q, i) => (
                  <div key={i} className="text-sm" style={{ padding: "2px 0" }}>
                    <div className="font-mono text-xs" title={q.query} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.query}</div>
                    <div className="text-xs text-muted-foreground">{fmtInt(q.calls)} calls · {fmtInt(q.totalMs)} ms total · {fmtInt(q.meanMs)} ms mean</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Query stats unavailable — pg_stat_statements extension is not installed.</div>
            )}
            <div className="rounded-lg border bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground" style={{ marginBottom: 6 }}>Seq scans per table</div>
              {dbHealth.seqScans.slice(0, 8).map((t) => (
                <div key={t.table} className="flex items-center justify-between gap-3 text-sm" style={{ padding: "2px 0" }}>
                  <span className="font-mono text-xs">{t.table}</span>
                  <span className="text-xs text-muted-foreground">{fmtInt(t.seqScans)} scans · {fmtInt(t.seqTuples)} tuples · {fmtInt(t.idxScans)} idx</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>Cost tracker</h3>
        {!neonUsage ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Usage data unavailable.</div>
        ) : neonUsage.configured === false ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Neon usage is not configured — set NEON_API_KEY + NEON_PROJECT_ID on the backend.</div>
        ) : "error" in neonUsage ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Neon API unavailable — please try again later.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {card("Compute used", `${fmtInt((neonUsage.computeTimeSeconds ?? 0) / 3600)} CU-hours`, `active ${fmtInt((neonUsage.activeTimeSeconds ?? 0) / 3600)} h`)}
              {card("Storage", fmtBytes(neonUsage.syntheticStorageSize ?? NaN), `written ${fmtBytes(neonUsage.writtenDataBytes ?? NaN)}`)}
              {card("Egress", fmtBytes(neonUsage.dataTransferBytes ?? NaN), `plan ${neonUsage.plan ?? "—"}`)}
            </div>
            <div className="text-xs text-muted-foreground" style={{ padding: "0 4px" }}>
              {neonUsage.period?.from ? `Billing period ${neonUsage.period.from}${neonUsage.period.to ? ` → ${neonUsage.period.to}` : ""} · ` : ""}
              Autoscaling {neonUsage.autoscaling?.min_compute_units ?? "—"}–{neonUsage.autoscaling?.max_compute_units ?? "—"} CU
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>Activity feed</h3>
        {feed.length ? (
          <div className="flex flex-col gap-1.5">
            {feed.map((f) => (
              <button
                type="button" key={f.id} onClick={() => navigate(f.to)}
                className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
              >
                <div>
                  <div className="font-medium text-sm">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.sub}</div>
                </div>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">{f.kind}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No recent activity.</div>
        )}
      </section>
    </div>
  );
}
