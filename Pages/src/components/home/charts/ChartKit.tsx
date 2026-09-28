import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared chart primitives for the admin Analysis charts.
 *
 * The vocabulary is deliberately monochrome: every series is a step on a
 * single ink ramp off --chart-1 (the theme accent, black/white — never blue),
 * so a chart reads as one system rather than a bag of categories. Anything
 * that needs to distinguish a *kind* of thing (state, not magnitude) is a
 * question for the palette, not for the ramp.
 *
 * Motion is CSS only. Recharts animates natively and app.css already defines
 * the --anim-* / --ease-out dialect plus a global prefers-reduced-motion kill,
 * so charts animate in-idiom without pulling in a motion runtime.
 */

export type ChartStatus = "ready" | "loading" | "empty" | "error";

/* ------------------------------------------------------------------ hooks */

/** True when the user asked for less motion. Charts draw to final shape. */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

/** Recharts animation flags, suppressed when the user asked for less motion. */
export function useChartMotion(duration = 520) {
  const reduce = usePrefersReducedMotion();
  return { reduce, isAnimationActive: !reduce, animationDuration: duration };
}

/** Measures a container so hand-rolled SVG charts can lay out before paint. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Stable, DOM-safe id for <defs> (gradients, masks) inside a chart. */
export function useChartId(prefix: string): string {
  const id = React.useId().replace(/:/g, "");
  return `${prefix}-${id}`;
}

/** Arrow-key navigation across N hover positions, for keyboard-only readers. */
export function useHoverIndexKeys({ count, setIndex }: { count: number; setIndex: (i: number | null) => void }) {
  return (e: React.KeyboardEvent) => {
    const current = (e.target as SVGElement).dataset.hoverIndex;
    const at = current == null ? -1 : Number(current);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(count - 1, at + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, at < 0 ? 0 : at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setIndex(next);
  };
}

/* --------------------------------------------------------------- ink ramp */

/** A step on the monochrome ramp. `weight` is ink %, 0 = transparent. */
export const ink = (weight: number) => `color-mix(in srgb, var(--chart-1) ${weight}%, transparent)`;

/** Fill for a 0..1 intensity cell — the light end stays off the surface. */
export function intensityColor(intensity: number, rampWeight = 92): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
  return ink(Math.round(6 + t * (rampWeight - 6)));
}

/**
 * Readable ink over an intensity cell. The cell is a mix of `--chart-1` with
 * the surface, so the text on it has to be the *opposite* of that ramp — and
 * "opposite" flips with the theme. `--color-background` is that opposite in
 * both themes, so a fixed class name stays correct when the user switches.
 */
export function onFillClass(intensity: number): string {
  return intensity > 0.55 ? "text-background" : "text-foreground";
}

/** Ordinal series colours — darkest is the biggest share. */
export const RAMP = [100, 62, 40, 26, 16] as const;
export const ramp = (index: number) => ink(RAMP[Math.min(index, RAMP.length - 1)]);
export const rampClass = (index: number) =>
  index === 0 ? "text-foreground" : index === 1 ? "text-foreground/70" : "text-muted-foreground";

/* ------------------------------------------------------------- formatting */

export const formatCount = (n: number): string =>
  Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";

export const formatPct = (n: number, digits = 1): string =>
  Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%` : "—";

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Axis ticks on 1/2/5×10ⁿ steps inside [min,max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 2.25 ? 2.5 : norm >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Nearest-rank percentile of a sample set. */
export function percentile(samples: number[], k: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((k / 100) * (sorted.length - 1))))];
}

/* ----------------------------------------------------------------- pieces */

/** Rise + fade keyframes, scoped to a class so they can't leak globally. */
export function Keyframes() {
  return (
    <style>{`
@keyframes mc-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes mc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mc-pop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
@keyframes mc-sweep { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
.mc-rise { transform-box: fill-box; transform-origin: bottom center; animation: mc-rise 420ms var(--ease-out) both; }
.mc-fade { animation: mc-fade 380ms var(--ease-out) both; }
.mc-pop { animation: mc-pop 160ms var(--ease-out) both; }
.mc-sweep::after { content:""; position:absolute; inset:0 auto 0 -60%; width:45%;
  background: linear-gradient(95deg, transparent, color-mix(in srgb, var(--chart-1) 22%, transparent), transparent);
  animation: mc-sweep 1.4s var(--ease-out) infinite; }
`}</style>
  );
}

/** The card every chart sits in. */
export function ChartFrame({ className, children, ...rest }: React.ComponentProps<"section">) {
  return (
    <section className={cn("rounded-lg border bg-card p-4", className)} {...rest}>
      {children}
    </section>
  );
}

/**
 * The readout above a plot: what the chart is of, the number, and one muted
 * line of context. The value is the first thing read, so it is the largest.
 */
export function ChartHeader({
  label,
  value,
  caption,
  delta,
  aside,
  className,
}: {
  label: string;
  value: React.ReactNode;
  caption?: React.ReactNode;
  delta?: { value: number; suffix?: string };
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-mono text-2xl font-medium tabular-nums text-foreground">{value}</p>
        {caption ? <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">{caption}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {delta ? <Delta value={delta.value} suffix={delta.suffix} /> : null}
        {aside}
      </div>
    </div>
  );
}

/**
 * A signed change on one hue. Direction is carried by the glyph and weight,
 * not by red/green — green means "good" only where good is defined, and here
 * the chart does not get to make that call.
 */
export function Delta({ value, suffix }: { value: number; suffix?: string }) {
  const unknown = !Number.isFinite(value);
  const up = value > 0;
  return (
    <span
      className={cn(
        "font-mono text-[12px] tabular-nums",
        unknown ? "text-muted-foreground" : up ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {unknown ? "—" : `${up ? "↑" : value < 0 ? "↓" : "→"} ${Math.abs(value).toFixed(1)}%${suffix ?? ""}`}
    </span>
  );
}

/** Legend key — a swatch and a name, one per series. */
export function ChartLegend({ items, className }: { items: { label: string; color: string }[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Content swaps for a same-size placeholder until the data lands. */
export function Stat({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  if (ready) return <>{children}</>;
  return <span className="inline-block h-3 w-20 animate-pulse rounded bg-muted align-middle" aria-hidden />;
}

/** Loading placeholder that occupies the plot's real height. */
export function ChartLoadingBars({ count = 7, height = 220, className }: { count?: number; height?: number; className?: string }) {
  return (
    <div className={cn("flex w-full items-end gap-2", className)} style={{ height }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="mc-sweep relative flex-1 overflow-hidden rounded-t bg-muted"
          style={{ height: `${30 + ((i * 37) % 65)}%`, animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * The state gate every plot goes through, so "no data" and "still loading"
 * never render as a chart of zeroes. `height` keeps the card from jumping
 * when the state resolves.
 */
export function ChartState({
  status,
  height,
  children,
  empty,
  error,
  onRetry,
}: {
  status: ChartStatus;
  height: number;
  children: React.ReactNode;
  empty?: { title: string; description?: string };
  error?: { title: string; description?: string };
  onRetry?: () => void;
}) {
  if (status === "ready") return <>{children}</>;
  if (status === "loading") return <ChartLoadingBars height={height} />;

  const copy = status === "error" ? error : empty;
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 text-center"
      style={{ height }}
    >
      <p className="text-sm font-medium text-foreground">{copy?.title ?? "Nothing to show"}</p>
      {copy?.description ? <p className="max-w-[38ch] text-xs text-muted-foreground">{copy.description}</p> : null}
      {status === "error" && onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 font-mono text-[11px] text-foreground underline underline-offset-2">
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * The same numbers as a real table. Charts carry colour and position; a
 * screen reader gets neither, so every plot ships its data as text once.
 *
 * The clip lives on a wrapping div, not on the table: `sr-only` asks for
 * `width:1px`, but a <table> is auto-laid-out and expands to its content
 * instead, which silently widened the page's scroll area on a phone.
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {/* Index keys: a chart may legitimately carry two columns with the
                same heading (a per-row "Total" beside the column totals). */}
            {columns.map((c, i) => <th key={i} scope="col">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The line under a plot that reports whatever is under the cursor. Reserving
 * its height keeps the card from reflowing as the pointer moves.
 */
export function ChartReadout({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      aria-live="polite"
      className={cn("mt-2 h-4 truncate font-mono text-[11px] tabular-nums text-muted-foreground", className)}
    >
      {children || "\u00a0"}
    </p>
  );
}

/** Axis defaults: no axis line, no ticks, quiet type. */
export const axisTick = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
