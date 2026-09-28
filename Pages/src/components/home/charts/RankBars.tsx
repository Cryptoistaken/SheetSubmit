import * as React from "react";
import { Bar, BarChart, Cell, CartesianGrid, XAxis, YAxis } from "recharts";
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
  formatCount,
  ramp,
  useChartMotion,
  useElementWidth,
} from "./ChartKit";

/** ~monospace 11px fits the axis width minus padding; longer names are cut, never wrapped. */
const axisFor = (w: number) => (w > 0 && w < 480 ? { width: 118, chars: 17 } : { width: 168, chars: 24 });

/** A single-line category tick. Recharts' default tick wraps on spaces, which
 *  turns one long query into three lines and drags the axis through it. */
function RowTick({ x, y, payload, chars }: { x?: number; y?: number; payload?: { value?: unknown }; chars: number }) {
  const text = String(payload?.value ?? "");
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fontSize={11}
      fill="var(--muted-foreground)"
      className="font-mono"
    >
      {text.length > chars ? `${text.slice(0, chars)}…` : text}
    </text>
  );
}

export interface RankRow {
  key: string;
  name: string;
  value: number;
  /** Second line in the tooltip — the full text the short name truncated. */
  detail?: string;
  /** Extra cells for the data table. */
  extra?: (string | number)[];
}

export interface RankBarsProps {
  label: string;
  caption?: React.ReactNode;
  rows: RankRow[];
  seriesKey: string;
  seriesLabel: string;
  status?: ChartStatus;
  height?: number;
  format?: (value: number) => string;
  /** Column headings for the data table, beyond the name and the value. */
  extraColumns?: string[];
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
}

/**
 * A ranked horizontal bar list. One measure, so one ink — the ramp darkens
 * with rank, which is the only ordering on screen that means something.
 */
export function RankBars({
  label,
  caption,
  rows,
  seriesKey,
  seriesLabel,
  status = "ready",
  height = 280,
  format = formatCount,
  extraColumns = [],
  emptyTitle = "Nothing recorded yet",
  emptyDescription,
  onRetry,
}: RankBarsProps) {
  const { isAnimationActive, animationDuration } = useChartMotion();
  const [wrapRef, wrapWidth] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = React.useState<RankRow | null>(null);
  // A phone cannot spare 168px for labels and still show a readable bar, so
  // the axis gives ground first — the full query is still in the tooltip,
  // the data table and the readout.
  const axis = axisFor(wrapWidth);

  const config = React.useMemo<ChartConfig>(() => ({ [seriesKey]: { label: seriesLabel, color: ramp(0) } }), [seriesKey, seriesLabel]);
  const chartHeight = Math.max(height, rows.length * 30 + 12);
  // Recharts reads the bar's magnitude off the series key, so the key has to
  // exist on the row — `value` alone would draw every bar at zero height.
  const data = React.useMemo(
    () => rows.map((r) => ({ ...r, [seriesKey]: r.value })),
    [rows, seriesKey],
  );

  return (
    <div ref={wrapRef} className="flex w-full min-w-0 flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
          {caption ? <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p> : null}
        </div>
      </div>

      <ChartState
        status={rows.length ? status : "empty"}
        height={chartHeight}
        empty={{ title: emptyTitle, description: emptyDescription }}
        error={{ title: "Could not load this breakdown" }}
        onRetry={onRetry}
      >
        <ChartContainer config={config} className="w-full" style={{ height: chartHeight }}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 16, left: 4, bottom: 0 }}
            onMouseLeave={() => setActive(null)}
          >
            <CartesianGrid horizontal={false} stroke="currentColor" strokeOpacity={0.1} />
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={axis.width}
              interval={0}
              tick={<RowTick chars={axis.chars} />}
            />
            <ChartTooltip
              cursor={{ fill: "currentColor", opacity: 0.06 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => String((payload?.[0]?.payload as RankRow | undefined)?.detail ?? "")}
                />
              }
            />
            <Bar
              dataKey={seriesKey}
              name={seriesLabel}
              radius={[0, 4, 4, 0]}
              isAnimationActive={isAnimationActive}
              animationDuration={animationDuration}
              onMouseEnter={(_, index) => setActive(rows[index] ?? null)}
            >
              {rows.map((row) => (
                <Cell
                  key={row.key}
                  fill={ramp(0)}
                  style={{ opacity: active && active.key !== row.key ? 0.45 : 1, transition: "opacity var(--anim-fast) var(--ease-out)" }}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartState>

      <ChartLegend className="mt-1" items={[{ label: seriesLabel, color: ramp(0) }]} />
      <ChartReadout>
        {active
          ? `${active.name} · ${seriesLabel} ${format(active.value)}`
          : `${rows.length} ${rows.length === 1 ? "row" : "rows"} · ${seriesLabel} ${format(rows[0]?.value ?? 0)} at the top`}
      </ChartReadout>

      <ChartDataTable
        caption={`${label} — ${seriesLabel.toLowerCase()}`}
        columns={["Name", seriesLabel, ...extraColumns]}
        rows={rows.map((r) => [r.detail ?? r.name, format(r.value), ...(r.extra ?? [])])}
      />
    </div>
  );
}

export default RankBars;
