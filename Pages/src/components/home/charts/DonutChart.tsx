import * as React from "react";
import { Cell, Pie, PieChart as RechartsPie } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  ChartLegend,
  ChartReadout,
  ChartState,
  type ChartStatus,
  formatCount,
  ramp,
  useChartMotion,
} from "./ChartKit";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
}

export interface DonutChartProps {
  label: string;
  caption?: React.ReactNode;
  /** The number that sits in the hole — the slice the reader is really after. */
  centerValue: React.ReactNode;
  centerLabel: string;
  slices: DonutSlice[];
  status?: ChartStatus;
  height?: number;
  format?: (value: number) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
}

/**
 * A donut reads a part-to-whole where the parts are steps on one scale, so
 * the slices are drawn on the monochrome ramp and ordered from the largest —
 * the hover dim is what tells them apart, not hue.
 */
export function DonutChart({
  label,
  caption,
  centerValue,
  centerLabel,
  slices,
  status = "ready",
  height = 240,
  format = formatCount,
  emptyTitle = "Nothing in this breakdown",
  emptyDescription,
  onRetry,
}: DonutChartProps) {
  const { isAnimationActive, animationDuration } = useChartMotion();
  const [active, setActive] = React.useState<string | null>(null);

  const rows = React.useMemo(() => {
    const ordered = [...slices].filter((s) => Number(s.value) > 0).sort((a, b) => b.value - a.value);
    return ordered.map((slice, i) => ({ ...slice, color: ramp(i) }));
  }, [slices]);

  const total = rows.reduce((sum, s) => sum + s.value, 0);

  const config = React.useMemo<ChartConfig>(() => {
    const out: ChartConfig = {};
    for (const s of rows) out[s.key] = { label: s.label, color: s.color };
    return out;
  }, [rows]);

  const activeSlice = rows.find((s) => s.key === active) ?? null;

  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
          {caption ? <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p> : null}
        </div>
      </div>

      <ChartState
        status={status}
        height={height}
        empty={{ title: emptyTitle, description: emptyDescription }}
        error={{ title: "Could not load this breakdown" }}
        onRetry={onRetry}
      >
        <div className="relative">
          <ChartContainer config={config} className="w-full" style={{ height }}>
            <RechartsPie>
              <ChartTooltip content={<ChartTooltipContent hideLabel indicator="dot" />} />
              <Pie
                data={rows}
                dataKey="value"
                nameKey="label"
                innerRadius="66%"
                outerRadius="92%"
                paddingAngle={2}
                cornerRadius={5}
                stroke="var(--card)"
                strokeWidth={1.5}
                isAnimationActive={isAnimationActive}
                animationDuration={animationDuration}
                onMouseLeave={() => setActive(null)}
              >
                {rows.map((slice) => (
                  <Cell
                    key={slice.key}
                    fill={slice.color}
                    style={{
                      opacity: active && active !== slice.key ? 0.4 : 1,
                      transition: "opacity var(--anim-fast) var(--ease-out)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={() => setActive(slice.key)}
                  />
                ))}
              </Pie>
            </RechartsPie>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-xl font-medium tabular-nums text-foreground">{centerValue}</span>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground">{centerLabel}</span>
          </div>
        </div>
      </ChartState>

      <ChartLegend className="mt-2" items={rows.map((s) => ({ label: s.label, color: s.color }))} />
      <ChartReadout>
        {activeSlice
          ? `${activeSlice.label} · ${format(activeSlice.value)} · ${((activeSlice.value / Math.max(1, total)) * 100).toFixed(1)}% of ${format(total)}`
          : `${format(total)} total across ${rows.length} ${rows.length === 1 ? "state" : "states"}`}
      </ChartReadout>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr><th scope="col">State</th><th scope="col">Count</th><th scope="col">Share</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td>{format(s.value)}</td>
              <td>{((s.value / Math.max(1, total)) * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DonutChart;
