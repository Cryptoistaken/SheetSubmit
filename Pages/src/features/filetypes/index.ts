import type { Row, SheetFile } from "@/lib/types";
import { createFbCookieBehavior } from "./fbcookie";

export function isPageFile(file: SheetFile | null | undefined): boolean {
  if (!file) return false;
  const hasTwoFaCol = file.columns?.some((c) => c.key === "twofakey") ?? false;
  const hasPreset = file.preset != null || file.poolKind != null;
  const isPagePreset = hasPreset
    ? file.preset === "page" || file.poolKind === "page"
    : (file.name?.toLowerCase().startsWith("page") ?? false);
  return hasTwoFaCol && isPagePreset;
}

export interface BehaviorCtx {
  rows: Row[];
  rowIdx: number;
  colKey: string;
  value: string;
  invalidCells: Set<string>;
  showToast: (msg: string) => void;
}

export interface FileBehavior {
  onCellChange?(ctx: BehaviorCtx): void;
  onDotDoubleTap?(
    row: Row,
  ): Promise<{ action: string; code: string } | null>;
  onDotHold?(
    row: Row,
    logs: unknown[],
  ): { action: string; logs: unknown[]; label: string } | null;
  checkAccounts?(
    rows: Row[],
  ): Promise<{ total: number; valid: number; dead: number; uncertain: number }>;
}

const behaviors: Record<string, FileBehavior> = {
  fb_cookie: createFbCookieBehavior(),
};

export function getFileBehavior(type: string): FileBehavior | undefined {
  return behaviors[type];
}
