import type { ColumnDef, Row } from "./types";

export interface DownloadOpt {
  key: string;
  label: string;
  className: string;
  count: number;
  filter?: (row: Row) => boolean;
  suffix: string;
}

/** Shared download-format list + live row counts (used by the normal and the
 * custom download overlays). */
export function buildDownloadOpts(rows: Row[], columns: ColumnDef[]): DownloadOpt[] {
  const dlCols = columns.filter((c) => c.key !== "uid");
  let total = 0;
  let active = 0;
  let wa = 0;
  let activeNoWa = 0;
  let combo = 0;
  let onlyCookie = 0;
  let only2fa = 0;
  let dead = 0;
  rows.forEach((row) => {
    const empty = dlCols.every((c) => !row[c.key]);
    if (!empty) total++;
    if (row.status === "good") active++;
    if (row.wa_status === "eligible") wa++;
    if (row.status === "good" && row.wa_status !== "eligible") activeNoWa++;
    if (row.status === "good" && row.cookies && row.twofakey) combo++;
    if (row.status === "good" && row.cookies && !row.twofakey) onlyCookie++;
    if (row.status === "good" && row.twofakey && !row.cookies) only2fa++;
    if (row.status === "bad") dead++;
  });
  const defs: DownloadOpt[] = [
    { key: "all", label: "All", className: "primary", count: total, suffix: "" },
    {
      key: "valid",
      label: "Alive",
      className: "btn-green",
      count: active,
      filter: (r) => r.status === "good",
      suffix: " (Alive)",
    },
    {
      key: "combo",
      label: "Cookie + 2FA",
      className: "btn-violet",
      count: combo,
      filter: (r) => !!(r.status === "good" && r.cookies && r.twofakey),
      suffix: " (Cookie + 2FA)",
    },
    {
      key: "onlycookie",
      label: "Only Cookie",
      className: "btn-slate",
      count: onlyCookie,
      filter: (r) => !!(r.status === "good" && r.cookies && !r.twofakey),
      suffix: " (Only Cookie)",
    },
    {
      key: "only2fa",
      label: "Only 2FA",
      className: "btn-cyan",
      count: only2fa,
      filter: (r) => !!(r.status === "good" && !r.cookies && r.twofakey),
      suffix: " (Only 2FA)",
    },
    {
      key: "wa",
      label: "FB Page",
      className: "btn-blue",
      count: wa,
      filter: (r) => r.wa_status === "eligible",
      suffix: " (FB Page)",
    },
    {
      key: "valid-nwa",
      label: "No Page",
      className: "btn-amber",
      count: activeNoWa,
      filter: (r) => r.status === "good" && r.wa_status !== "eligible",
      suffix: " (No Page)",
    },
    {
      key: "dead",
      label: "Dead",
      className: "btn-red",
      count: dead,
      filter: (r) => r.status === "bad",
      suffix: " (Dead)",
    },
  ];
  return defs.filter((d) => d.count > 0);
}