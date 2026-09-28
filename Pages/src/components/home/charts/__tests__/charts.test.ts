import { describe, expect, test } from "bun:test";
import { buildBins, splitTail } from "../HistogramChart";
import { formatBytes, formatCount, niceTicks, percentile } from "../ChartKit";
import { saleTrend, sumRows } from "../sales";

const DAY = 86_400_000;

describe("buildBins", () => {
  test("loses no samples and covers the range", () => {
    const samples = [3, 7, 7, 12, 40, 41, 99, 100];
    const bins = buildBins(samples, 6);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(samples.length);
    expect(bins[0].from).toBeLessThanOrEqual(Math.min(...samples));
    expect(bins[bins.length - 1].to).toBeGreaterThanOrEqual(Math.max(...samples));
  });

  test("bins touch, with no gap and no overlap", () => {
    const bins = buildBins([1, 2, 3, 17, 44], 5);
    for (let i = 1; i < bins.length; i += 1) {
      expect(bins[i].from).toBeCloseTo(bins[i - 1].to, 10);
    }
  });

  test("a single sample still yields one populated bin", () => {
    const bins = buildBins([42], 10);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  test("no samples means no bins", () => {
    expect(buildBins([], 10)).toEqual([]);
  });
});

describe("splitTail", () => {
  test("folds everything past the cutoff into the overflow", () => {
    // 100 samples plus one straggler a hundred times the median.
    const samples = [...Array(100).keys()].map((i) => i + 1).concat([10_000]);
    const { body, tail, cutoff } = splitTail(samples, 99);
    expect(tail).toEqual([10_000]);
    expect(body.length).toBe(100);
    expect(cutoff).toBeLessThan(10_000);
  });

  test("cutoff 100 keeps the full range in the body", () => {
    const samples = [1, 2, 3, 900];
    const { body, tail, cutoff } = splitTail(samples, 100);
    expect(tail).toEqual([]);
    expect(body).toEqual(samples);
    expect(cutoff).toBe(Infinity);
  });

  test("a sample set with no tail is left whole", () => {
    expect(splitTail([1, 2, 3, 4, 5], 99).tail).toEqual([]);
  });

  test("empty input is safe", () => {
    expect(splitTail([], 99)).toEqual({ body: [], tail: [], cutoff: Infinity });
  });
});

describe("percentile", () => {
  test("p50 and p95 read off the ordered sample", () => {
    const samples = [...Array(100).keys()].map((i) => i + 1);
    // Nearest-rank: index = round(k/100 × (n − 1)).
    expect(percentile(samples, 50)).toBe(51);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 100)).toBe(100);
  });

  test("empty is zero, not NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("niceTicks", () => {
  test("ticks stay inside the range and land on round steps", () => {
    const ticks = niceTicks(0, 100, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(100);
    expect(ticks[1] - ticks[0]).toBe(25);
  });

  test("an empty range does not loop forever", () => {
    expect(niceTicks(5, 5, 4)).toEqual([5]);
  });
});

describe("formatters", () => {
  test("formatBytes steps units and rejects nonsense", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });

  test("formatCount rounds and survives NaN", () => {
    expect(formatCount(1234.6)).toBe("1,235");
    expect(formatCount(NaN)).toBe("—");
  });
});

describe("saleTrend", () => {
  const now = Date.now();
  const sale = (daysAgo: number, poolId: string, claimed: number, revenue = 0) => ({
    ts: now - daysAgo * DAY,
    poolId,
    claimed,
    revenue,
  });

  test("buckets run from the cutoff forward, so quiet days read as zero", () => {
    const { rows } = saleTrend([sale(1, "page", 5, 12)], "7d");
    expect(rows.length).toBeGreaterThan(1);
    const total = rows.reduce((sum, r) => sum + Number(r.page || 0), 0);
    expect(total).toBe(5);
    // The empty days stay on the axis instead of vanishing.
    expect(rows.some((r) => Number(r.page || 0) === 0)).toBe(true);
  });

  test("splits volume per pool and keeps revenue apart from rows", () => {
    const { rows } = saleTrend(
      [sale(0, "page", 3, 30), sale(0, "cookies_only", 7), sale(0, "cookies_2fa", 2, 4)],
      "7d",
    );
    expect(sumRows(rows, "page")).toBe(3);
    expect(sumRows(rows, "cookies_only")).toBe(7);
    expect(sumRows(rows, "cookies_2fa")).toBe(2);
    // Revenue rides its own key, never folded into the account counts.
    expect(sumRows(rows, "revenue")).toBe(34);
  });

  test("drops sales older than the range", () => {
    const { rows } = saleTrend([sale(40, "page", 9)], "7d");
    expect(rows.reduce((s, r) => s + (Number(r.page) || 0), 0)).toBe(0);
  });

  test("a long range goes weekly rather than daily", () => {
    expect(saleTrend([], "7d").weekly).toBe(false);
    expect(saleTrend([], "30d").weekly).toBe(false);
    expect(saleTrend([], "90d").weekly).toBe(true);
  });

  test("an empty series still produces a drawable axis", () => {
    const { rows, weekly } = saleTrend([], "7d");
    expect(rows.length).toBeGreaterThan(1);
    expect(weekly).toBe(false);
  });
});
