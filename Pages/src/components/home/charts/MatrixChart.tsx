import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ChartDataTable,
  ChartReadout,
  ChartState,
  Keyframes,
  type ChartStatus,
  formatCount,
  intensityColor,
  onFillClass,
  useElementWidth,
  usePrefersReducedMotion,
} from "./ChartKit";

export type MatrixRow = { key: string; label: string; values: number[] };

export interface MatrixChartProps {
  label: string;
  caption?: React.ReactNode;
  rowHeader: string;
  columns: string[];
  rows: MatrixRow[];
  /** A row under the last one carrying the column totals. */
  totalLabel: string;
  status?: ChartStatus;
  height?: number;
  format?: (value: number) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
}

const HEAD_H = 26;
const ROW_H = 32;
const GAP = 2;

/** Narrow phones give the row labels less room; the cell grid takes the rest. */
const LABEL_W = (w: number) => (w < 420 ? 74 : 104);
const MIN_COL_W = (w: number) => (w < 420 ? 44 : 56);

/**
 * A grid of counts read cell by cell — the cohort-chart engine, pointed at
 * pool composition. Ink is each cell's share of its own *column* max, so a
 * column uses the whole ramp and reads down the rows. Normalising per row
 * instead would paint the largest column solid black in every row, which is
 * exactly the information the grid exists to show.
 */
export function MatrixChart({
  label,
  caption,
  rowHeader,
  columns,
  rows,
  totalLabel,
  status = "ready",
  height,
  format = formatCount,
  emptyTitle = "Nothing to break down yet",
  emptyDescription,
  onRetry,
}: MatrixChartProps) {
  const reduce = usePrefersReducedMotion();
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hovered, setHovered] = React.useState<{ row: number; col: number } | null>(null);

  const totals = React.useMemo(
    () => columns.map((_, c) => rows.reduce((sum, r) => sum + (Number(r.values[c]) || 0), 0)),
    [columns, rows],
  );

  // Each column scaled to its own max, so a 1,840-row pool and a 95-row pool
  // both land somewhere legible on the ramp.
  const colMax = React.useMemo(
    () => columns.map((_, c) => Math.max(1, ...rows.map((r) => Number(r.values[c]) || 0))),
    [columns, rows],
  );

  const labelW = LABEL_W(width);
  const colW = Math.max(MIN_COL_W(width), Math.floor(Math.max(120, width - labelW) / Math.max(1, columns.length)));
  const w = labelW + columns.length * colW;
  const h = height ?? HEAD_H + (rows.length + 1) * ROW_H + 8;
  const ready = width > 0;

  const cellX = (col: number) => labelW + col * colW;
  const hoveredRowIdx = hovered?.row;
  const hoveredCol = hovered?.col;
  const hoveredRow = hoveredRowIdx != null ? rows[hoveredRowIdx] : null;
  const hoveredValue = hoveredRow && hoveredCol != null ? hoveredRow.values[hoveredCol] : 0;
  const hoveredShare =
    hoveredRowIdx != null && hoveredCol != null
      ? (hoveredValue / Math.max(1, colMax[hoveredCol])) * 100
      : 0;

  return (
    <div ref={wrapRef} className="flex w-full min-w-0 flex-col">
      <Keyframes />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {caption ?? `${rows.length} ${rowHeader.toLowerCase()} × ${columns.length} measures · ink is share of that column's largest`}
          </p>
        </div>
      </div>

      <ChartState
        status={rows.length ? status : "empty"}
        height={h}
        empty={{ title: emptyTitle, description: emptyDescription }}
        error={{ title: "Could not load the breakdown" }}
        onRetry={onRetry}
      >
        {/* min-w-0 lets this scroll instead of widening the page: a flex item
            defaults to min-width:auto, so the SVG's intrinsic width would push
            the whole card past the viewport. */}
        <div className="relative w-full min-w-0 overflow-x-auto">
          {ready ? (
            <svg
              width={w}
              height={h}
              viewBox={`0 0 ${w} ${h}`}
              className="block select-none"
              role="img"
              aria-label={`${label}. ${rows.length} ${rowHeader.toLowerCase()} across ${columns.join(", ")}.`}
              onPointerLeave={() => setHovered(null)}
            >
              <g className="font-mono uppercase tracking-wider" fontSize={9} fill="currentColor">
                <text x={0} y={HEAD_H - 10} className="text-muted-foreground">{rowHeader}</text>
                {columns.map((col, c) => (
                  <text
                    key={col}
                    x={cellX(c) + colW / 2}
                    y={HEAD_H - 10}
                    textAnchor="middle"
                    opacity={hovered && hovered.col === c ? 1 : 0.7}
                    className={cn(hovered && hovered.col === c ? "fill-foreground" : "fill-muted-foreground")}
                  >
                    {col}
                  </text>
                ))}
              </g>

              {rows.map((row, r) => {
                const y = HEAD_H + r * ROW_H;
                const rowActive = hovered?.row === r;
                return (
                  <g key={row.key}>
                    <text
                      x={0}
                      y={y + ROW_H / 2}
                      dominantBaseline="middle"
                      fontSize={11}
                      className={cn("font-mono", rowActive ? "fill-foreground" : "fill-muted-foreground")}
                    >
                      {colW >= 40 ? row.label : `${row.label.slice(0, Math.max(4, Math.floor(labelW / 6.6)))}…`}
                    </text>
                    {row.values.map((value, c) => {
                      const v = Number(value) || 0;
                      const intensity = v / colMax[c];
                      const active = hovered?.row === r && hovered?.col === c;
                      const inCross = hovered != null && (hovered.row === r || hovered.col === c);
                      return (
                        <g
                          key={c}
                          onPointerEnter={() => setHovered({ row: r, col: c })}
                          className={reduce ? undefined : "mc-fade"}
                          style={reduce ? undefined : { animationDelay: `${Math.min(c * 22 + r * 12, 520)}ms` }}
                        >
                          <rect
                            x={cellX(c) + GAP / 2}
                            y={y + GAP / 2}
                            width={colW - GAP}
                            height={ROW_H - GAP}
                            rx={4}
                            fill={intensityColor(intensity)}
                            stroke={active ? "var(--foreground)" : "transparent"}
                            strokeWidth={1.5}
                            style={{
                              opacity: hovered && !inCross ? 0.4 : 1,
                              transition: reduce ? undefined : "opacity 140ms ease-out",
                            }}
                          />
                          <text
                            x={cellX(c) + colW / 2}
                            y={y + ROW_H / 2}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fontSize={10}
                            fontWeight={500}
                            className={cn("pointer-events-none font-mono tabular-nums", onFillClass(intensity))}
                            style={{
                              opacity: hovered && !inCross ? 0.45 : 1,
                              transition: reduce ? undefined : "opacity 140ms ease-out",
                            }}
                          >
                            {format(v)}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              <g>
                <line
                  x1={0}
                  x2={w}
                  y1={HEAD_H + rows.length * ROW_H + 2}
                  y2={HEAD_H + rows.length * ROW_H + 2}
                  stroke="currentColor"
                  strokeOpacity={0.16}
                  shapeRendering="crispEdges"
                />
                <text
                  x={0}
                  y={HEAD_H + rows.length * ROW_H + ROW_H / 2 + 4}
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={600}
                  className="fill-foreground font-mono"
                >
                  {totalLabel}
                </text>
                {totals.map((total, c) => (
                  <text
                    key={c}
                    x={cellX(c) + colW / 2}
                    y={HEAD_H + rows.length * ROW_H + ROW_H / 2 + 4}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    fontWeight={600}
                    className="fill-muted-foreground font-mono tabular-nums"
                    opacity={hovered && hovered.col !== c ? 0.45 : 1}
                  >
                    {format(total)}
                  </text>
                ))}
              </g>
            </svg>
          ) : null}
        </div>
      </ChartState>

      <ChartReadout>
        {hoveredRow && hoveredCol != null
          ? `${hoveredRow.label} · ${columns[hoveredCol]} ${format(hoveredValue)} · ${hoveredShare.toFixed(0)}% of the largest ${columns[hoveredCol].toLowerCase()}`
          : `${rows.length} ${rowHeader.toLowerCase()} · ${formatCount(totals[0] ?? 0)} ${columns[0]?.toLowerCase() ?? "total"} across all pools`}
      </ChartReadout>

      <ChartDataTable
        caption={`${label} — ${columns.join(", ")} by ${rowHeader.toLowerCase()}`}
        columns={[rowHeader, ...columns, "Total"]}
        rows={[
          ...rows.map((r) => [
            r.label,
            ...r.values.map((v) => format(Number(v) || 0)),
            format(r.values.reduce((sum, v) => sum + (Number(v) || 0), 0)),
          ]),
          [totalLabel, ...totals.map((t) => format(t)), format(totals.reduce((a, b) => a + b, 0))],
        ]}
      />
    </div>
  );
}

export default MatrixChart;
