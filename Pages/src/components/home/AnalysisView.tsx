import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { DbHealth, DownloadMeta, HoldRecord, NeonUsage, Withdrawal } from "@/lib/api";
import { fmtMoney, useCurrency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import PageSkeleton from "@/components/ui/page-skeleton";
import SlideSwitch from "@/components/ui/slide-switch";
import TrendChart from "./charts/TrendChart";
import DonutChart from "./charts/DonutChart";
import MatrixChart from "./charts/MatrixChart";
import HistogramChart from "./charts/HistogramChart";
import RankBars, { type RankRow } from "./charts/RankBars";
import { Delta, formatBytes, formatCount, type ChartStatus } from "./charts/ChartKit";
import {
  POOL_SERIES,
  type Range,
  rangeLabel,
  type Sale,
  saleTrend,
  sumRows,
  windowDelta,
} from "./charts/sales";

/* ------------------------------------------------------------- constants */

const PASSWORDS = ["dgddigital", "Love@12345"] as const;
const POOLS = POOL_SERIES.map((p) => ({ id: p.id, label: p.label }));
const POOL_LABEL: Record<string, string> = { cookies_only: "Cookies", cookies_2fa: "2FA", page: "Page" };

const shortPwd = (p: string) => (p === "dgddigital" ? "dgd" : p.length > 8 ? `${p.slice(0, 8)}…` : p);
const isRejected = (s?: string | null) => String(s || "").toUpperCase() === "REJECTED";
const isApproved = (s?: string | null) => String(s || "").toUpperCase() === "APPROVED";

const DOWNLOAD_CAP = 500; // GET /pools/downloads caps at 500 rows
const HOLD_CAP = 200; // GET /pools/holds caps at 200 rows

interface PoolStock { password: string; poolId: string; available: number; claimed: number; invalid: number }

type FeedItem = { kind: "hold" | "take" | "withdrawal"; ts: number; id: string; label: string; sub: string; to: string };

/* ------------------------------------------------------------ small bits */

function StatTile({
  label,
  value,
  caption,
  delta,
}: {
  label: string;
  value: string;
  caption: string;
  delta?: number;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-end justify-between gap-2">
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
        {delta === undefined ? null : <Delta value={delta} />}
      </div>
      <p className="mt-1 font-mono text-xl font-medium tabular-nums text-foreground">{value}</p>
      <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="font-mono text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card p-4 ${className}`}>{children}</div>;
}

/* ------------------------------------------------------------------ page */

export default function AnalysisView() {
  const navigate = useNavigate();
  const showToast = useToast();
  const [currency] = useCurrency();

  const [range, setRange] = useState<Range>("30d");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
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
      setUpdatedAt(Date.now());
    } catch {
      setFailed(true);
      showToast("Unable to load analysis. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  /* ------------------------------------------------------------ derived */

  const holdStatus = (h: HoldRecord) =>
    String(h.status || "").toUpperCase() === "HOLD" ? "PENDING" : String(h.status || "").toUpperCase();
  const countBy = useCallback((s: string) => holds.filter((h) => holdStatus(h) === s).length, [holds]);

  const moneyInFlight = holds
    .filter((h) => holdStatus(h) === "PENDING")
    .reduce((sum, h) => sum + (Number(h.claimed) || 0) * (prices[`${h.password}:${h.poolId}`] ?? 0), 0);
  const paid = useMemo(() => downloads.filter((d) => isApproved(d.status)), [downloads]);
  const paidTotal = useMemo(() => paid.reduce((sum, d) => sum + (Number(d.total) || 0), 0), [paid]);
  const openWd = useMemo(() => withdrawals.filter((w) => w.status === "PENDING"), [withdrawals]);
  const openWdTotal = useMemo(() => openWd.reduce((sum, w) => sum + (Number(w.amount) || 0), 0), [openWd]);

  // A rejected hold is not a sale, so it stays out of the volume series; only
  // approved downloads count as money in.
  const sales = useMemo<Sale[]>(
    () =>
      downloads
        .filter((d) => !isRejected(d.status))
        .map((d) => ({
          ts: Number(d.at) || 0,
          poolId: d.poolId,
          claimed: Number(d.claimed) || 0,
          revenue: isApproved(d.status) ? Number(d.total) || 0 : 0,
        })),
    [downloads],
  );

  const trend = useMemo(() => saleTrend(sales, range), [sales, range]);
  const trendSeries = useMemo(() => POOL_SERIES.map((p) => ({ key: p.id, label: p.label, weight: p.weight })), []);

  const accountsInRange = useMemo(
    () => POOL_SERIES.reduce((sum, p) => sum + sumRows(trend.rows, p.id), 0),
    [trend],
  );
  const revenueInRange = useMemo(() => sumRows(trend.rows, "revenue"), [trend]);
  const accountsDelta = useMemo(
    () => windowDelta(sales.map((s) => ({ ts: s.ts, value: s.claimed })), trend.cutoff, trend.span),
    [sales, trend],
  );

  // Pool stock as a matrix — six combinations, four measures.
  const stockRows = useMemo(
    () =>
      stock.map((s) => ({
        key: `${s.password}/${s.poolId}`,
        label: `${shortPwd(s.password)}·${POOL_LABEL[s.poolId] ?? s.poolId}`,
        // No per-row total column: it is always the row's own max, so under a
        // share-within-row ramp it renders as a flat stripe carrying no extra
        // information. The totals row underneath already carries the scale.
        values: [s.available, s.claimed, s.invalid],
      })),
    [stock],
  );
  const stockTotalAvailable = useMemo(() => stock.reduce((a, s) => a + s.available, 0), [stock]);

  // Query latency: pg_stat_statements already aggregates by query shape, so the
  // byTime set is one statement per distinct query.
  const latencySamples = useMemo(() => {
    if (!dbHealth?.statements.statsAvailable) return [];
    const seen = new Map<string, number>();
    for (const q of dbHealth.statements.byTime) {
      const mean = Number(q.meanMs);
      if (Number.isFinite(mean) && mean > 0) seen.set(q.query, mean);
    }
    return [...seen.values()];
  }, [dbHealth]);

  const slowRows = useMemo<RankRow[]>(
    () =>
      (dbHealth?.statements.statsAvailable ? dbHealth.statements.byTime : []).slice(0, 8).map((q, i) => {
        const full = q.query.replace(/\s+/g, " ").trim();
        return {
          key: `${i}-${full.slice(0, 24)}`,
          name: full.length > 26 ? `${full.slice(0, 26)}…` : full,
          detail: full,
          value: Math.round(q.totalMs),
          extra: [formatCount(q.calls), `${q.meanMs.toFixed(1)} ms`],
        };
      }),
    [dbHealth],
  );

  const tableRows = useMemo<RankRow[]>(
    () =>
      (dbHealth?.tables ?? []).slice(0, 10).map((t) => ({
        key: t.table,
        name: t.table,
        detail: t.table,
        value: t.bytes,
        extra: [formatCount(t.rows)],
      })),
    [dbHealth],
  );

  const scanRows = useMemo<RankRow[]>(
    () =>
      (dbHealth?.seqScans ?? []).slice(0, 8).map((t) => ({
        key: t.table,
        name: t.table,
        detail: t.table,
        value: t.seqScans,
        extra: [formatCount(t.seqTuples), formatCount(t.idxScans)],
      })),
    [dbHealth],
  );

  const feed = useMemo<FeedItem[]>(() => {
    const stamp = (ts: number) => (ts ? new Date(ts).toLocaleString() : "—");
    const rows: FeedItem[] = [
      ...holds.map((h) => {
        const ts = Number(h.at ?? h.ts ?? 0) || 0;
        return {
          kind: "hold" as const, ts, id: `hold:${h.id}`,
          label: `${holdStatus(h)} hold · ${Number(h.claimed) || 0} rows · ${h.password}/${h.poolId}`,
          sub: stamp(ts),
          to: `/approvals?hold=${encodeURIComponent(h.id)}`,
        };
      }),
      ...downloads.filter((d) => String(d.status || "").toUpperCase() === "CLAIMED").map((d) => {
        const ts = Number(d.at) || 0;
        return {
          kind: "take" as const, ts, id: `take:${d.id}`,
          label: `Take · ${Number(d.claimed) || 0} rows · ${d.password}/${d.poolId}`,
          sub: stamp(ts),
          to: `/pools/${encodeURIComponent(d.password)}/${encodeURIComponent(d.poolId)}`,
        };
      }),
      ...withdrawals.map((w) => {
        const ts = Number(w.created_at) || 0;
        return {
          kind: "withdrawal" as const, ts, id: `wd:${w.id}`,
          label: `${w.status} withdrawal · ${fmtMoney(Number(w.amount), currency)} · ${w.name || w.user_id}`,
          sub: stamp(ts),
          to: "/withdrawals",
        };
      }),
    ];
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 50);
  }, [holds, downloads, withdrawals, currency]);

  /* ------------------------------------------------------------- states */

  if (loading) return <PageSkeleton variant="admin" />;
  if (failed) {
    return (
      <div className="mx-auto flex w-full max-w-[960px] flex-col px-6 py-8">
        <p className="text-sm text-muted-foreground">Unable to load analysis.</p>
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  const hasQueries = !!dbHealth?.statements.statsAvailable;
  const trendStatus: ChartStatus = trend.rows.length > 1 && accountsInRange > 0 ? "ready" : "empty";
  const truncated = downloads.length >= DOWNLOAD_CAP;
  const label = rangeLabel(range);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold tracking-tight">Analysis</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Business overview, pool composition and database health
            {updatedAt ? (
              <span className="ml-1.5 font-mono text-[11px]">· updated {new Date(updatedAt).toLocaleTimeString()}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SlideSwitch
            ariaLabel="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
              { value: "90d", label: "90d" },
              { value: "all", label: "All" },
            ]}
          />
          <button type="button" className="btn btn-ghost" aria-label="Refresh analysis" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile
          label="Money in flight"
          value={fmtMoney(moneyInFlight, currency)}
          caption={`${countBy("PENDING")} pending holds`}
        />
        <StatTile
          label="Payouts paid"
          value={fmtMoney(paidTotal, currency)}
          caption={`${formatCount(paid.length)} settled downloads`}
        />
        <StatTile
          label="Open withdrawals"
          value={fmtMoney(openWdTotal, currency)}
          caption={`${openWd.length} awaiting review`}
        />
        <StatTile
          label={`Accounts sold · ${label}`}
          value={formatCount(accountsInRange)}
          caption={`${fmtMoney(revenueInRange, currency)} approved`}
          delta={accountsDelta}
        />
      </div>

      <Section title="Volume" hint={`${stats?.totalUsers ?? "—"} users · ${stats?.totalFiles ?? "—"} files`}>
        <Panel>
          <TrendChart
            label={`Accounts taken · ${label}`}
            caption={`${trend.weekly ? "weekly" : "daily"} buckets${
              truncated ? ` · newest ${formatCount(downloads.length)} takes only` : ""
            }`}
            value={formatCount(accountsInRange)}
            delta={{ value: accountsDelta }}
            data={trend.rows}
            series={trendSeries}
            overlay={{ key: "revenue", label: "Approved revenue" }}
            status={trendStatus}
            height={280}
            formatTotal={(v) => fmtMoney(v, currency)}
            emptyTitle="No takes in this range"
            emptyDescription="Widen the range, or take a hold from a pool to start the series."
            onRetry={() => void load()}
          />
        </Panel>
      </Section>

      <Section title="Pools">
        <div className="grid gap-2 lg:grid-cols-5">
          <Panel className="lg:col-span-3">
            <MatrixChart
              label="Pool stock"
              caption={`${formatCount(stockTotalAvailable)} available across ${stock.length} pool combinations`}
              rowHeader="Pool"
              columns={["Avail", "Claimed", "Invalid"]}
              rows={stockRows}
              totalLabel="All pools"
              emptyTitle="No pool stock"
              emptyDescription="Feed a file to a pool and its rows land here."
            />
          </Panel>
          <Panel className="lg:col-span-2">
            <DonutChart
              label="Holds"
              caption={`${formatCount(holds.length)} total${holds.length >= HOLD_CAP ? " · newest 200" : ""}`}
              centerValue={formatCount(countBy("PENDING"))}
              centerLabel="PENDING"
              slices={[
                { key: "PENDING", label: "Pending", value: countBy("PENDING") },
                { key: "APPROVED", label: "Approved", value: countBy("APPROVED") },
                { key: "REJECTED", label: "Rejected", value: countBy("REJECTED") },
              ]}
              emptyTitle="No holds yet"
              emptyDescription="A hold appears here the moment a taker reserves rows."
            />
          </Panel>
        </div>
      </Section>

      <Section title="Database" hint={hasQueries ? "pg_stat_statements" : "statements unavailable"}>
        {!dbHealth ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            DB health unavailable.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Panel>
              <HistogramChart
                label="Query latency"
                caption={`Mean ms per distinct statement · ${formatCount(latencySamples.length)} samples`}
                data={latencySamples}
                format={(v) => (v >= 10 ? `${v.toFixed(0)}ms` : `${v.toFixed(1)}ms`)}
                percentiles={[50, 95]}
                height={240}
                emptyTitle="Not enough spread"
                emptyDescription="Every tracked statement is taking about the same time, so there is no distribution to draw."
              />
            </Panel>

            {hasQueries ? (
              <Panel>
                <RankBars
                  label="Slowest queries"
                  caption="Total time accumulated since the last stats reset"
                  rows={slowRows}
                  seriesKey="ms"
                  seriesLabel="Total ms"
                  format={(v) => `${formatCount(v)} ms`}
                  extraColumns={["Calls", "Mean"]}
                  emptyTitle="No query stats"
                  emptyDescription="The pg_stat_statements extension is not installed, so there is nothing to rank."
                />
              </Panel>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                Query stats unavailable — the pg_stat_statements extension is not installed.
              </div>
            )}

            <div className="grid gap-2 lg:grid-cols-2">
              <Panel>
                <RankBars
                  label="Largest tables"
                  caption={`${formatBytes(dbHealth.tables.reduce((a, t) => a + t.bytes, 0))} total`}
                  rows={tableRows}
                  seriesKey="bytes"
                  seriesLabel="Size"
                  format={formatBytes}
                  extraColumns={["Rows"]}
                  emptyTitle="No table sizes"
                />
              </Panel>
              <Panel>
                <RankBars
                  label="Sequential scans"
                  caption="Full-table reads — the first thing to index"
                  rows={scanRows}
                  seriesKey="scans"
                  seriesLabel="Seq scans"
                  format={formatCount}
                  extraColumns={["Tuples read", "Index scans"]}
                  emptyTitle="No scan stats"
                />
              </Panel>
            </div>
          </div>
        )}
      </Section>

      <Section title="Cost" hint="Neon">
        {!neonUsage ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Usage data unavailable.
          </div>
        ) : neonUsage.configured === false ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
            Neon usage is not configured — set NEON_API_KEY + NEON_PROJECT_ID on the backend, then wait for Railway to
            redeploy.
          </div>
        ) : "error" in neonUsage ? (
          <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
            Neon API unavailable — please try again later.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              <StatTile
                label="Compute used"
                value={`${formatCount((neonUsage.computeTimeSeconds ?? 0) / 3600)} CU-h`}
                caption={`active ${formatCount((neonUsage.activeTimeSeconds ?? 0) / 3600)} h`}
              />
              <StatTile
                label="Storage"
                value={formatBytes(neonUsage.syntheticStorageSize ?? NaN)}
                caption={`written ${formatBytes(neonUsage.writtenDataBytes ?? NaN)}`}
              />
              <StatTile
                label="Egress"
                value={formatBytes(neonUsage.dataTransferBytes ?? NaN)}
                caption={neonUsage.plan ?? "—"}
              />
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              {neonUsage.period?.from
                ? `Billing period ${neonUsage.period.from}${neonUsage.period.to ? ` → ${neonUsage.period.to}` : ""} · `
                : ""}
              Autoscaling {neonUsage.autoscaling?.min_compute_units ?? "—"}–
              {neonUsage.autoscaling?.max_compute_units ?? "—"} CU
            </p>
          </div>
        )}
      </Section>

      <Section title="Activity" hint={`${formatCount(feed.length)} most recent`}>
        {feed.length ? (
          <div className="flex flex-col gap-1.5">
            {feed.map((f) => (
              <button
                type="button"
                key={f.id}
                onClick={() => navigate(f.to)}
                className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.sub}</div>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none font-semibold">
                  {f.kind}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No recent activity.
          </div>
        )}
      </Section>
    </div>
  );
}
