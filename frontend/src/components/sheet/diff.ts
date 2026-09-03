import { dedupKeyForRow } from "@/stores/sheetStore";
import type { ColumnDef, Row } from "@/lib/types";

export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  add: number;
  del: number;
  oldLen: number;
  newLen: number;
}

export function vRowLine(r: Row | null | undefined, cols: ColumnDef[]): string {
  const vals: string[] = [];
  cols.forEach((c) => {
    const v = r ? r[c.key] : null;
    vals.push(v === null || v === undefined ? "" : String(v));
  });
  return vals.join(" | ");
}

export function vComputeDiff(
  parentRows: Row[],
  childRows: Row[],
  cols: ColumnDef[],
): { lines: DiffLine[]; add: number; del: number } {
  const vRowMap = (rows: Row[]) => {
    const m = new Map<string, Row>();
    rows.forEach((r) => {
      const k = dedupKeyForRow(r);
      if (k) m.set(String(k), r);
    });
    return m;
  };
  const om = vRowMap(parentRows);
  const cm = vRowMap(childRows);
  const keys = new Set<string>([...om.keys(), ...cm.keys()]);
  const lines: DiffLine[] = [];
  let add = 0;
  let del = 0;
  keys.forEach((k) => {
    const o = om.get(k);
    const n = cm.get(k);
    if (o && n) {
      if (vRowLine(o, cols) === vRowLine(n, cols)) {
        lines.push({ type: "ctx", text: vRowLine(n, cols) });
      } else {
        lines.push({ type: "del", text: vRowLine(o, cols) });
        lines.push({ type: "add", text: vRowLine(n, cols) });
        del++;
        add++;
      }
    } else if (n) {
      lines.push({ type: "add", text: vRowLine(n, cols) });
      add++;
    } else {
      lines.push({ type: "del", text: vRowLine(o, cols) });
      del++;
    }
  });
  return { lines, add, del };
}
