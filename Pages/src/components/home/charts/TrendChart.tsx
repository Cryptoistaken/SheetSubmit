import * as React from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  ChartDataTable,
  ChartLegend,
  ChartReadout,
  ChartState,
  type ChartStatus,
  axisTick,
  formatCount,
  ink,
  useChartId,
  useChartMotion,
} from "./ChartKit";

export type TrendRow = { label: string; [key: string]: string | number };

export type TrendSeries = { key: string; label: string; weight: number };

export interface TrendChartProps {
  label: string;
  caption?: React.ReactNode;
  /** The headline number — the range total the reader came for. */
  value: React.ReactNode;
  delta?: { value: number; suffix?: string };
  aside?: React.ReactNode;
  data: TrendRow[];
  series: TrendSeries[];
  status?: ChartStatus;
  height?: number;
  /**
   * Stacked bands answer "what is this made of" — the top edge is the whole
   * and each thickness is a share, so the fills sit nearly opaque and touch.
   * Unstacked bands are alternatives being compared, so they overlay and the
   * fills go translucent.
   */
  stacked?: boolean;
  /** A second reading on its own axis, drawn as a line over the bands. */
  overlay?: { key: string; label: string; color?: string };
  format?: (value: number) => string;
  formatTotal?: (value: number) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
}

export function TrendChart({
  label,
  caption,
  value,
  delta,
  aside,
  data,
  series,
  status = "ready",
  height = 260,
  stacked = true,
  overlay,
  format = formatCount,
  formatTotal = formatCount,
  emptyTitle = "No activity in this range",
  emptyDescription,
  onRetry,
}: TrendChartProps) {
  const id = useChartId("trend");
  const { isAnimationActive, animationDuration } = useChartMotion();

  const [active, setActive] = React.useState<number>(-1);
  const activeRow = active >= 0 ? data[active] : null;

  // One ramp, one tooltip: the key is the series key so ChartContainer can
  // label the readout without a second source of truth.
  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    for (const s of series) out[s.key] = { label: s.label, color: ink(s.weight) };
    if (overlay) out[overlay.key] = { label: overlay.label, color: overlay.color ?? ink(45) };
    return out;
  }, [series, overlay]);

  const total = React.useMemo(
    () => data.reduce((sum, row) => sum + series.reduce((s, k) => s + (Number(row[k.key]) || 0), 0), 0),
    [data, series],
  );

  const overlayTotal = overlay
    ? data.reduce((sum, row) => sum + (Number(row[overlay.key]) || 0), 0)
    : 0;

  const readout = activeRow
    ? `${activeRow.label} · ${series.map((s) => `${s.label} ${format(Number(activeRow[s.key]) || 0)}`).join(" · ")}${
        overlay ? ` · ${overlay.label} ${format(Number(activeRow[overlay.key]) || 0)}` : ""
      }`
    : `${data.length} ${data.length === 1 ? "bucket" : "buckets"} · ${formatTotal(total)} total${
        overlay ? ` · ${formatTotal(overlayTotal)} ${overlay.label.toLowerCase()}` : ""
      }`;

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 font-mono text-2xl font-medium tabular-nums text-foreground">{value}</p>
          {caption ? <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {delta ? (
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {Number.isFinite(delta.value)
                ? `${delta.value > 0 ? "↑" : delta.value < 0 ? "↓" : "→"} ${Math.abs(delta.value).toFixed(1)}%${delta.suffix ?? ""}`
                : "—"}
            </span>
          ) : null}
          {aside}
        </div>
      </div>

      <ChartState
        status={status}
        height={height}
        empty={{ title: emptyTitle, description: emptyDescription }}
        error={{ title: "Could not load this series", description: "The numbers behind this chart did not come back." }}
        onRetry={onRetry}
      >
        <ChartContainer config={config} className="h-full w-full" style={{ height }}>
          <ComposedChart
            data={data}
            margin={{ top: 6, right: 6, left: -12, bottom: 0 }}
            // recharts 3 reports the hovered bucket through the chart's pointer
            // state rather than the old onActiveIndexChange callback.
            onMouseMove={(state) =>
              setActive(typeof state?.activeTooltipIndex === "number" ? state.activeTooltipIndex : -1)
            }
            onMouseLeave={() => setActive(-1)}
          >
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ink(s.weight)} stopOpacity={stacked ? 0.95 : 0.4} />
                  <stop offset="100%" stopColor={ink(s.weight)} stopOpacity={stacked ? 0.7 : 0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.1} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} minTickGap={18} />
            <YAxis tickLine={false} axisLine={false} tick={axisTick} width={48} tickFormatter={format} />
            <ChartTooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.25, strokeDasharray: "4 4" }}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stackId={stacked ? "a" : undefined}
                stroke={ink(s.weight)}
                strokeWidth={stacked ? 1 : 1.75}
                fill={`url(#${id}-${s.key})`}
                isAnimationActive={isAnimationActive}
                animationDuration={animationDuration}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            ))}
            {overlay ? (
              <Line
                type="monotone"
                dataKey={overlay.key}
                name={overlay.label}
                stroke={overlay.color ?? ink(45)}
                strokeWidth={1.75}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={isAnimationActive}
                animationDuration={animationDuration}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            ) : null}
          </ComposedChart>
        </ChartContainer>
      </ChartState>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <ChartLegend
          items={[
            ...series.map((s) => ({ label: s.label, color: ink(s.weight) })),
            ...(overlay ? [{ label: overlay.label, color: overlay.color ?? ink(45) }] : []),
          ]}
        />
      </div>
      <ChartReadout>{readout}</ChartReadout>

      <ChartDataTable
        caption={label}
        columns={["Period", ...series.map((s) => s.label), ...(overlay ? [overlay.label] : [])]}
        rows={data.map((row) => [
          row.label,
          ...series.map((s) => format(Number(row[s.key]) || 0)),
          ...(overlay ? [format(Number(row[overlay.key]) || 0)] : []),
        ])}
      />
    </div>
  );
}

export default TrendChart;
