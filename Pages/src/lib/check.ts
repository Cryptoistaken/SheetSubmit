import type { Row } from "./types";

/** Canonical check-state fields written by page-simple + page-advanced. */
export const CHECK_FIELDS = [
  "check_status",
  "check_ban_reason",
  "check_page_name",
  "check_linked_number",
] as const;

/** Legacy wa-check-era field names — read-fallback only here, never written. */
const LEGACY_FIELDS = [
  "wa_status",
  "wa_ban_reason",
  "wa_page_name",
  "wa_linked_number",
  "waStatus",
] as const;

/** Eligibility verdict, with legacy fallback for rows stored before the rename. */
export function checkStatusOf(row: Row | null | undefined): string {
  const r = (row ?? {}) as Record<string, unknown>;
  return String(r.check_status ?? r.wa_status ?? r.waStatus ?? "");
}

/** Write check fields onto a row, wiping legacy keys so stored rows converge. */
export function applyCheckFields(
  row: Row,
  patch: { status?: unknown; banReason?: unknown; pageName?: unknown; linkedNumber?: unknown },
): Row {
  const r = row as Record<string, unknown>;
  if (patch.status !== undefined) r.check_status = patch.status;
  if (patch.banReason !== undefined) r.check_ban_reason = patch.banReason;
  if (patch.pageName !== undefined) r.check_page_name = patch.pageName;
  if (patch.linkedNumber !== undefined) r.check_linked_number = patch.linkedNumber;
  for (const k of LEGACY_FIELDS) delete r[k];
  return row;
}
