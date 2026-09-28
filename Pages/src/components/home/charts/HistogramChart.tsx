import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ChartDataTable,
  ChartReadout,
  ChartState,
  Keyframes,
  type ChartStatus,
  formatCount,
  ink,
  niceTicks,
  percentile,
  useElementWidth,
  useHoverIndexKeys,
  usePrefersReducedMotion,
} from "./ChartKit";

export type Bin = { from: number; to: number; count: number };

const PAD = { top: 34, right: 52, bottom: 26, left: 12 };
/** Top room for the percentile pins; they stack upward when they collide. */
const PIN_TOP = 26;

/** Bin edges on 1/2/2.5/5/10×10ⁿ steps, so the edges read as round numbers. */
function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 2.25 ? 2.5 : norm >= 1.5 ? 2 : 1) * mag;
}

export function buildBins(samples: number[], target = 26): Bin[] {
  if (!samples.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const step = niceStep((max - min) / target || 1);
  const lo = Math.floor(min / step) * step;
  const count = Math.max(1, Math.ceil((max - lo) / step));
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
    from: lo + i * step,
    to: lo + (i + 1) * step,
    count: 0,
  }));
  for (const v of samples) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((v - lo) / step)));
    bins[index].count += 1;
  }
  return bins;
}

/**
 * A long-tailed distribution binned to its maximum spends most of the plot on
 * air: 900 latency samples put 97% of the mass in the first fifth and one
 * straggler at the far right. So bin up to the cutoff and fold everything past
 * it into a single overflow bin, drawn detached and labelled with what it
 * holds. `tailCutoff: 100` bins the full range instead.
 */
export function splitTail(samples: number[], cutoffPercentile: number) {
  if (cutoffPercentile >= 100 || !samples.length) {
    return { body: samples, tail: [] as number[], cutoff: Infinity };
  }
  const cutoff = percentile(samples, cutoffPercentile);
  const body: number[] = [];
  const tail: number[] = [];
  for (const value of samples) (value <= cutoff ? body : tail).push(value);
  return body.length ? { body, tail, cutoff } : { body: samples, tail: [] as number[], cutoff: Infinity };
}

/** Percentiles are one ordered quantity, so they ride one hue that darkens with k. */
function pinInk(index: number, count: number) {
  const weight = 45 + (count <= 1 ? 55 : (index / (count - 1)) * 55);
  return ink(Math.round(weight));
}

export interface HistogramChartProps {
  className?: string;
  data?: number[];
  label: string;
  caption?: React.ReactNode;
  format?: (value: number) => string;
  percentiles?: number[];
  /** Percentile past which samples fold into one overflow bin. 100 disables it. */
  tailCutoff?: number;
  bins?: number;
  height?: number;
  status?: ChartStatus;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
}

/** Folding a handful of samples is noise, so the tail is only cut once there is a tail. */
const MIN_SAMPLES_TO_FOLD = 40;

export function HistogramChart({
  className,
  data = [],
  label,
  caption,
  format = (v) => `${Math.round(v)}ms`,
  percentiles = [50, 95, 99],
  tailCutoff = 99,
  bins: binTarget = 26,
  height = 280,
  status = "ready",
  emptyTitle = "No samples yet",
  emptyDescription,
  onRetry,
}: HistogramChartProps) {
  const reduce = usePrefersReducedMotion();
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);

  const cutoffPercentile = data.length >= MIN_SAMPLES_TO_FOLD ? tailCutoff : 100;
  const { body, tail, cutoff } = React.useMemo(
    () => splitTail(data, cutoffPercentile),
    [data, cutoffPercentile],
  );
  const binsData = React.useMemo(() => buildBins(body, binTarget), [body, binTarget]);

  const n = binsData.length;
  const total = data.length;
  const maxCount = Math.max(1, ...binsData.map((b) => b.count), tail.length);
  const pins = React.useMemo(
    () => percentiles.map((k) => ({ k, value: percentile(data, k) })),
    [data, percentiles],
  );

  const w = Math.max(width, 300);
  const h = height;
  const x0 = PAD.left;
  const x1 = w - PAD.right;
  const y0 = PAD.top + PIN_TOP;
  const y1 = h - PAD.bottom;
  const plotW = Math.max(1, x1 - x0);

  // The overflow bin sits past a gap, so the break in the axis is visible
  // rather than implied.
  const hasTail = tail.length > 0;
  const tailGap = 16;
  const tailW = hasTail ? Math.max(12, plotW * 0.04) : 0;
  const bodyW = Math.max(1, plotW - (hasTail ? tailW + tailGap : 0));
  const tailX = x0 + bodyW + tailGap;

  const domainLo = binsData[0]?.from ?? 0;
  const domainHi = binsData[n - 1]?.to ?? 1;
  const xOf = React.useCallback(
    (v: number) => x0 + ((v - domainLo) / (domainHi - domainLo || 1)) * bodyW,
    [x0, bodyW, domainLo, domainHi],
  );
  const yOf = React.useCallback(
    (count: number) => y1 - (count / maxCount) * (y1 - y0),
    [y1, y0, maxCount],
  );

  const countTicks = React.useMemo(() => niceTicks(0, maxCount, 3), [maxCount]);
  const edgeTicks = React.useMemo(() => niceTicks(domainLo, domainHi, 5), [domainLo, domainHi]);

  const onMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || !n) return;
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const x = ((clientX - box.left) / box.width) * w;
    if (hasTail && x >= tailX - tailGap / 2) {
      setHover(n);
      return;
    }
    setHover(Math.max(0, Math.min(n - 1, Math.floor(((x - x0) / bodyW) * n))));
  };
  const onKeyDown = useHoverIndexKeys({ count: hasTail ? n + 1 : n, setIndex: setHover });

  const active = hover != null && hover < n ? binsData[hover] : null;
  const tailActive = hasTail && hover === n;
  const ready = width > 0 && n > 0;
  const binW = bodyW / Math.max(n, 1);
  // Bins are a continuous range: they touch, separated by a hairline of
  // surface rather than by a gap that would read as categories.
  const barW = Math.max(1, binW - 1);

  // A handful of identical samples is not a distribution — drawing bins for it
  // would put a shape on the plot that the data does not have.
  const spread = total ? Math.max(...data) - Math.min(...data) : 0;
  const resolution = status === "ready" && (total < 4 || spread <= 0) ? "empty" : status;

  return (
    <div ref={wrapRef} className={cn("flex w-full flex-col", className)}>
      <Keyframes />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {caption ?? (
              <>
                {formatCount(total)} samples · {n} bins
                {hasTail ? ` · ${formatCount(tail.length)} past ${format(cutoff)}` : ""}
              </>
            )}
          </p>
        </div>
        <p className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
          {pins.map((pin, i) => (
            <span key={pin.k} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: pinInk(i, pins.length) }} />
              p{pin.k}{" "}
              <span className="font-medium text-foreground">{format(pin.value)}</span>
            </span>
          ))}
        </p>
      </div>

      <ChartState
        status={resolution}
        height={height}
        empty={{
          title: emptyTitle,
          description: emptyDescription ?? "Too few samples, or no spread between them, for a distribution to mean anything.",
        }}
        error={{ title: "Could not load the distribution" }}
        onRetry={onRetry}
      >
        <div className="relative w-full" style={{ height }}>
          {ready ? (
            <svg
              ref={svgRef}
              width={w}
              height={h}
              viewBox={`0 0 ${w} ${h}`}
              className="block w-full touch-pan-y select-none overflow-visible focus-visible:outline-hidden"
              role="img"
              tabIndex={0}
              aria-label={`${label} distribution: ${formatCount(total)} samples across ${n} bins${
                hasTail ? `, with ${formatCount(tail.length)} samples at or above ${format(cutoff)} in an overflow bin` : ""
              }. ${pins.map((p) => `p${p.k} ${format(p.value)}`).join(", ")}.`}
              onKeyDown={onKeyDown}
              onBlur={() => setHover(null)}
              onPointerMove={(e) => onMove(e.clientX)}
              onPointerDown={(e) => onMove(e.clientX)}
              onPointerLeave={() => setHover(null)}
            >
              <g shapeRendering="crispEdges">
                {countTicks.map((tick) =>
                  tick === 0 ? null : (
                    <line key={tick} x1={x0} x2={x1} y1={yOf(tick)} y2={yOf(tick)} stroke="currentColor" strokeOpacity={0.14} />
                  ),
                )}
                <line x1={x0} x2={x1} y1={y1} y2={y1} stroke="currentColor" strokeOpacity={0.28} />
              </g>
              <g className="font-mono">
                {countTicks.map((tick) =>
                  tick === 0 ? null : (
                    <text
                      key={tick}
                      x={x1 + 8}
                      y={yOf(tick)}
                      dominantBaseline="middle"
                      fontSize={10.5}
                      fill="currentColor"
                      className="tabular-nums text-muted-foreground"
                    >
                      {formatCount(tick)}
                    </text>
                  ),
                )}
                {edgeTicks.map((tick) => {
                  const x = xOf(tick);
                  if (x < x0 - 1 || x > x1 + 1) return null;
                  return (
                    <text
                      key={tick}
                      x={x}
                      y={y1 + 15}
                      textAnchor="middle"
                      fontSize={10.5}
                      fill="currentColor"
                      className="tabular-nums text-muted-foreground"
                    >
                      {format(tick)}
                    </text>
                  );
                })}
              </g>

              {binsData.map((bin, index) => {
                const barH = Math.max(bin.count > 0 ? 1.5 : 0, (bin.count / maxCount) * (y1 - y0));
                const dim = hover != null && hover !== index;
                return (
                  <g key={bin.from}>
                    <rect x={xOf(bin.from)} y={y0} width={binW} height={y1 - y0} fill="transparent" />
                    {bin.count > 0 ? (
                      <rect
                        x={xOf(bin.from) + (binW - barW) / 2}
                        y={y1 - barH}
                        width={barW}
                        height={barH}
                        fill="var(--chart-1)"
                        opacity={dim ? 0.55 : 1}
                        className={reduce ? undefined : "mc-rise"}
                        style={{ transition: reduce ? undefined : "opacity 150ms ease-out", animationDelay: `${(index / Math.max(1, n - 1)) * 300}ms` }}
                      />
                    ) : null}
                  </g>
                );
              })}

              {hasTail ? (
                <g>
                  <rect x={tailX} y={y0} width={tailW} height={y1 - y0} fill="transparent" />
                  {/* Two strokes across the baseline: the axis breaks here, and
                      a reader should see that rather than infer it from a gap. */}
                  <g stroke="currentColor" strokeOpacity={0.45} strokeWidth={1}>
                    <line x1={tailX - tailGap / 2 - 3} x2={tailX - tailGap / 2 + 1} y1={y1 + 4} y2={y1 - 4} />
                    <line x1={tailX - tailGap / 2 + 1} x2={tailX - tailGap / 2 + 5} y1={y1 + 4} y2={y1 - 4} />
                  </g>
                  <rect
                    x={tailX}
                    y={y1 - Math.max(1.5, (tail.length / maxCount) * (y1 - y0))}
                    width={tailW}
                    height={Math.max(1.5, (tail.length / maxCount) * (y1 - y0))}
                    fill="var(--chart-1)"
                    opacity={hover != null && !tailActive ? 0.4 : 0.72}
                    className={reduce ? undefined : "mc-rise"}
                    style={{ transition: reduce ? undefined : "opacity 150ms ease-out", animationDelay: "300ms" }}
                  />
                  <text
                    x={tailX + tailW / 2}
                    y={y1 + 15}
                    textAnchor="middle"
                    fontSize={10.5}
                    fill="currentColor"
                    className="font-mono tabular-nums text-muted-foreground"
                  >
                    ≥{format(cutoff)}
                  </text>
                </g>
              ) : null}

              {(() => {
                // Lay the pin labels out first: when two of them would print on
                // top of each other (narrow phone, close percentiles) the later
                // one drops to a second line rather than overprinting.
                const half = (p: { k: number; value: number }) => (`p${p.k} ${format(p.value)}`).length * 3.1;
                const labelX = pins.map((pin) => {
                  const h = half(pin);
                  const rule = Math.min(x0 + bodyW, xOf(pin.value));
                  return Math.max(x0 + h, Math.min(x0 + bodyW - h, rule));
                });
                const tiers = pins.map((_, i) => {
                  let tier = 0;
                  while (tier < i && Math.abs(labelX[i] - labelX[tier]) < half(pins[i]) + half(pins[tier])) tier += 1;
                  return tier;
                });
                return pins.map((pin, index) => {
                  const text = `p${pin.k} ${format(pin.value)}`;
                  const rule = Math.min(x0 + bodyW, xOf(pin.value));
                  const paint = pinInk(index, pins.length);
                  const labelY = y0 - 14 - tiers[index] * 12;
                  const tickY = labelY + 8;
                  return (
                    <g key={pin.k} className={reduce ? undefined : "mc-fade"} style={reduce ? undefined : { animationDelay: "380ms" }}>
                      <line x1={rule} x2={rule} y1={tickY} y2={y1} stroke={paint} strokeWidth={1.25} />
                      <circle cx={rule} cy={tickY} r={2.5} fill={paint} />
                      <text
                        x={labelX[index]}
                        y={labelY}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={500}
                        fill="currentColor"
                        className="font-mono tabular-nums text-foreground"
                      >
                        {text}
                      </text>
                    </g>
                  );
                });
              })()}
            </svg>
          ) : null}
        </div>
      </ChartState>

      <ChartReadout>
        {tailActive
          ? `${format(cutoff)} and above · ${formatCount(tail.length)} ${tail.length === 1 ? "sample" : "samples"} · ${((tail.length / Math.max(1, total)) * 100).toFixed(1)}% · the tail`
          : active
            ? `${format(active.from)} – ${format(active.to)} · ${formatCount(active.count)} ${active.count === 1 ? "sample" : "samples"} · ${((active.count / Math.max(1, total)) * 100).toFixed(1)}%`
            : `${formatCount(total)} samples · drag across the plot or use ← → to read a bin`}
      </ChartReadout>

      <ChartDataTable
        caption={`${label} — sample count by bin`}
        columns={["Range", "Count", "Share"]}
        rows={[
          ...binsData.map((bin) => [
            `${format(bin.from)} – ${format(bin.to)}`,
            bin.count,
            `${((bin.count / Math.max(1, total)) * 100).toFixed(1)}%`,
          ]),
          ...(hasTail
            ? [[`${format(cutoff)} and above`, tail.length, `${((tail.length / Math.max(1, total)) * 100).toFixed(1)}%`]]
            : []),
        ]}
      />
    </div>
  );
}

export default HistogramChart;
