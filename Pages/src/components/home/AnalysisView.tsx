import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import type { DbHealth, DownloadMeta, HoldRecord, NeonUsage, Withdrawal } from "@/lib/api";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import PageSkeleton from "@/components/ui/page-skeleton";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const PASSWORDS = ["dgddigital", "Love@12345"] as const;
const POOLS = [
  { id: "cookies_only", label: "Cookies" },
  { id: "cookies_2fa", label: "2FA" },
  { id: "page", label: "Page" },
] as const;
const shortPwd = (p: string) => (p === "dgddigital" ? "dgd" : p.length > 8 ? `${p.slice(0, 8)}…` : p);

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
// monochrome ramps off --chart-1 (theme accent is black/white, never blue)
const ink = (pct: number) => `color-mix(in srgb, var(--chart-1) ${pct}%, transparent)`;

function CardHead({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="mb-1 flex items-end justify-between gap-3 px-0.5">
      <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
      {caption ? <p className="mb-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p> : null}
      <p className="font-mono text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}

const stockConfig = {
  available: { label: "Available", color: "var(--chart-1)" },
  claimed: { label: "Claimed", color: ink(45) },
  invalid: { label: "Invalid", color: ink(22) },
} satisfies ChartConfig;

const holdsConfig = {
  PENDING: { label: "Pending", color: "var(--chart-1)" },
  APPROVED: { label: "Approved", color: ink(45) },
  REJECTED: { label: "Rejected", color: ink(22) },
} satisfies ChartConfig;

export default function AnalysisView() {
  const navigate = useNavigate();
  const showToast = useToast();
  const [currency] = useCurrency();
  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

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

  const stockRows = stock.map((s) => ({
    name: `${shortPwd(s.password)}·${POOLS.find((p) => p.id === s.poolId)?.label ?? s.poolId}`,
    available: s.available, claimed: s.claimed, invalid: s.invalid,
  }));
  const holdsRows = (["PENDING", "APPROVED", "REJECTED"] as const).map((s) => ({ name: s, value: byStatus(s).length, fill: holdsConfig[s].color }));
  const slowRows = (dbHealth?.statements.statsAvailable ? dbHealth.statements.byTime : []).slice(0, 5).map((q) => ({
    name: q.query.replace(/\s+/g, " ").trim().slice(0, 34) + "…",
    full: q.query, ms: Math.round(q.totalMs),
    label: `${fmtInt(q.calls)} calls · ${fmtInt(q.totalMs)} ms`,
  }));
  const scanRows = (dbHealth?.seqScans ?? []).slice(0, 8).map((t) => ({ name: t.table, scans: t.seqScans }));

  const axisTick = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

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
          <div className="rounded-lg border bg-card px-4 py-3">
            <CardHead label="Money in flight" value={fmtMoney(moneyInFlight, currency)} caption={`${byStatus("PENDING").length} pending`} />
          </div>
          <div className="rounded-lg border bg-card px-4 py-3">
            <CardHead label="Payouts paid" value={fmtMoney(paidTotal, currency)} caption={`${paid.length} settled`} />
          </div>
          <div className="rounded-lg border bg-card px-4 py-3">
            <CardHead label="Open withdrawals" value={fmtMoney(openWdTotal, currency)} caption={`${openWd.length} open`} />
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-5" style={{ marginTop: 8 }}>
          <div className="rounded-lg border bg-card px-4 py-3 lg:col-span-3">
            <CardHead label="Pool stock" value={fmtInt(stockRows.reduce((a, r) => a + r.available, 0))} caption="available" />
            <ChartContainer config={stockConfig} className="h-56 w-full">
              <BarChart data={stockRows} margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={axisTick} interval={0} />
                <YAxis tickLine={false} axisLine={false} tick={axisTick} width={44} />
                <ChartTooltip content={<ChartTooltipContent />} cursor={{ fill: "currentColor", opacity: 0.06 }} />
                <Bar dataKey="available" stackId="s" fill="var(--color-available)" radius={[0, 0, 0, 0]} isAnimationActive={!reduceMotion} />
                <Bar dataKey="claimed" stackId="s" fill="var(--color-claimed)" isAnimationActive={!reduceMotion} />
                <Bar dataKey="invalid" stackId="s" fill="var(--color-invalid)" radius={[4, 4, 0, 0]} isAnimationActive={!reduceMotion} />
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          </div>
          <div className="rounded-lg border bg-card px-4 py-3 lg:col-span-2">
            <CardHead label="Holds" value={String(holds.length)} caption="total" />
            <ChartContainer config={holdsConfig} className="relative h-56 w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={holdsRows} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="85%" paddingAngle={3} cornerRadius={6} strokeWidth={0} isAnimationActive={!reduceMotion}>
                  {holdsRows.map((r) => <Cell key={r.name} fill={r.fill} />)}
                </Pie>
                <ChartLegend content={<ChartLegendContent />} />
              </PieChart>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: 28 }}>
                <span className="font-mono text-xl font-medium tabular-nums">{byStatus("PENDING").length}</span>
                <span className="font-mono text-[10px] tracking-wide text-muted-foreground">PENDING</span>
              </div>
            </ChartContainer>
          </div>
        </div>
        <p className="text-xs text-muted-foreground" style={{ padding: "8px 4px 0" }}>
          {stats?.totalUsers ?? "—"} users · {stats?.totalFiles ?? "—"} files
        </p>
      </section>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>DB health</h3>
        {!dbHealth ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">DB health unavailable.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="rounded-lg border bg-card px-4 py-3">
              <CardHead label="Tables" value={fmtBytes(dbHealth.tables.reduce((a, t) => a + t.bytes, 0))} caption="total size" />
              <div className="flex flex-col" style={{ marginTop: 4 }}>
                {dbHealth.tables.slice(0, 8).map((t) => (
                  <div key={t.table} className="flex items-center justify-between gap-3 text-sm" style={{ padding: "2px 0" }}>
                    <span className="font-mono text-xs">{t.table}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmtBytes(t.bytes)} · {fmtInt(t.rows)}</span>
                  </div>
                ))}
              </div>
            </div>
            {dbHealth.statements.statsAvailable ? (
              <div className="rounded-lg border bg-card px-4 py-3">
                <CardHead label="Slowest queries" value={`${fmtInt(dbHealth.statements.byTime.slice(0, 5).reduce((a, q) => a + q.totalMs, 0))} ms`} caption="top 5 total" />
                <ChartContainer config={{ ms: { label: "Total ms", color: "var(--chart-1)" } }} className="h-56 w-full">
                  <BarChart data={slowRows} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid horizontal={false} stroke="currentColor" strokeOpacity={0.12} />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} tick={{ ...axisTick, fontSize: 10 }} width={150} />
                    <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => String((p?.[0]?.payload as { full?: string } | undefined)?.full ?? "").slice(0, 120)} />} cursor={{ fill: "currentColor", opacity: 0.06 }} />
                    <Bar dataKey="ms" fill="var(--color-ms)" radius={[0, 4, 4, 0]} isAnimationActive={!reduceMotion} />
                  </BarChart>
                </ChartContainer>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Query stats unavailable — pg_stat_statements extension is not installed.</div>
            )}
            <div className="rounded-lg border bg-card px-4 py-3">
              <CardHead label="Seq scans" value={fmtInt(scanRows.reduce((a, r) => a + r.scans, 0))} caption="top 8 tables" />
              <ChartContainer config={{ scans: { label: "Scans", color: "var(--chart-1)" } }} className="h-52 w-full">
                <BarChart data={scanRows} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ ...axisTick, fontSize: 10 }} interval={0} angle={-18} height={44} />
                  <YAxis tickLine={false} axisLine={false} tick={axisTick} width={48} />
                  <ChartTooltip content={<ChartTooltipContent />} cursor={{ fill: "currentColor", opacity: 0.06 }} />
                  <Bar dataKey="scans" fill="var(--color-scans)" radius={[4, 4, 0, 0]} isAnimationActive={!reduceMotion} />
                </BarChart>
              </ChartContainer>
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold" style={{ marginBottom: 8 }}>Cost tracker</h3>
        {!neonUsage ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Usage data unavailable.</div>
        ) : neonUsage.configured === false ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Neon usage is not configured — set NEON_API_KEY + NEON_PROJECT_ID on the backend, then wait for Railway to redeploy.</div>
        ) : "error" in neonUsage ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">Neon API unavailable — please try again later.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-lg border bg-card px-4 py-3">
                <CardHead label="Compute used" value={`${fmtInt((neonUsage.computeTimeSeconds ?? 0) / 3600)} CU-h`} caption={`active ${fmtInt((neonUsage.activeTimeSeconds ?? 0) / 3600)} h`} />
              </div>
              <div className="rounded-lg border bg-card px-4 py-3">
                <CardHead label="Storage" value={fmtBytes(neonUsage.syntheticStorageSize ?? NaN)} caption={`written ${fmtBytes(neonUsage.writtenDataBytes ?? NaN)}`} />
              </div>
              <div className="rounded-lg border bg-card px-4 py-3">
                <CardHead label="Egress" value={fmtBytes(neonUsage.dataTransferBytes ?? NaN)} caption={neonUsage.plan ?? "—"} />
              </div>
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
