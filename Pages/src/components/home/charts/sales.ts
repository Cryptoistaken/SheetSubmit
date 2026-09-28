import type { TrendRow } from "./TrendChart";

/** Pool ids the volume series is split by, in stack order (bottom first). */
export const POOL_SERIES = [
  { id: "cookies_only", label: "Cookies", weight: 100 },
  { id: "cookies_2fa", label: "2FA", weight: 58 },
  { id: "page", label: "Page", weight: 34 },
] as const;

export const DAY = 86_400_000;

export type Range = "7d" | "30d" | "90d" | "all";
export const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const rangeLabel = (range: Range) => (range === "all" ? "all time" : `last ${RANGE_DAYS[range]} days`);

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const startOfWeek = (ts: number) => {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start Monday
  return d.getTime();
};

export type Sale = { ts: number; poolId: string; claimed: number; revenue: number };

/**
 * Accounts taken and approved revenue over the range, in one pass.
 *
 * Buckets run from the cutoff forward rather than from the records present, so
 * a quiet week draws as a zero rather than vanishing and stretching the x-axis
 * across only the days that happened.
 */
export function saleTrend(sales: Sale[], range: Range, now = Date.now()) {
  const stamps = sales.map((s) => s.ts).filter((t) => t > 0);
  const from = range === "all"
    ? (stamps.length ? Math.min(...stamps) : now - 30 * DAY)
    : now - RANGE_DAYS[range] * DAY;
  const span = Math.max(DAY, now - from);
  // Past ~10 weeks the daily bars stop being readable, so the axis goes weekly.
  const weekly = range === "90d" || range === "all" || span > 70 * DAY;
  const bucketOf = weekly ? startOfWeek : startOfDay;
  const step = weekly ? 7 * DAY : DAY;

  const keys: number[] = [];
  for (let t = bucketOf(from); t <= now; t += step) keys.push(t);
  if (!keys.length) keys.push(bucketOf(now));

  const rows: TrendRow[] = keys.map((k) => {
    const row: TrendRow = {
      label: new Date(k).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      revenue: 0,
    };
    for (const p of POOL_SERIES) row[p.id] = 0;
    return row;
  });
  const index = new Map<number, TrendRow>(keys.map((k, i) => [k, rows[i]]));

  for (const s of sales) {
    if (s.ts < from || s.ts > now) continue;
    const row = index.get(bucketOf(s.ts));
    if (!row) continue;
    row[s.poolId] = (Number(row[s.poolId]) || 0) + s.claimed;
    row.revenue = (Number(row.revenue) || 0) + s.revenue;
  }

  return { rows, cutoff: from, span, weekly };
}

/** Change over the range against the equal-length window before it. */
export function windowDelta(points: { ts: number; value: number }[], cutoff: number, span: number): number {
  let cur = 0;
  let prev = 0;
  for (const p of points) {
    if (p.ts >= cutoff) cur += p.value;
    else if (p.ts >= cutoff - span) prev += p.value;
  }
  if (!prev) return NaN;
  return ((cur - prev) / prev) * 100;
}

export const sumRows = (rows: TrendRow[], key: string) =>
  rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
