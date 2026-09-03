import type { Row } from "@/lib/types";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import { getCachedTOTP } from "./totp";
import { validateCell } from "./validation";

function _extractCUser(cookies: string | null | undefined): string | null {
  if (!cookies) return null;
  const m = cookies.match(/c_user=(\d+)/);
  return m ? m[1] : null;
}

interface FbCookieCtx {
  rows: Row[];
  rowIdx: number;
  colKey: string;
  value: string;
  invalidCells: Set<string>;
  showToast: (msg: string) => void;
}

export function createFbCookieBehavior() {
  return {
    onCellChange(ctx: FbCookieCtx): void {
      const validation = validateCell(ctx.colKey, ctx.value);
      const cellKey = ctx.rowIdx + ":" + ctx.colKey;
      if (!validation.valid) {
        ctx.invalidCells.add(cellKey);
        toast("Invalid: " + validation.msg);
      } else {
        ctx.invalidCells.delete(cellKey);
      }

      const row = ctx.rows[ctx.rowIdx];

      if (ctx.colKey === "cookies") {
        const uid = _extractCUser(ctx.value);
        if (uid) {
          if (!row.uid) row.uid = uid;
        } else {
          row.wa_status = "";
          row.wa_ban_reason = null;
          row.wa_page_name = null;
          row.wa_linked_number = null;
        }
      }

      if (ctx.colKey === "uid" && ctx.value && row.cookies) {
        const extracted = _extractCUser(row.cookies);
        if (extracted && extracted !== ctx.value.trim()) {
          toast("UID doesn't match c_user in cookies");
        }
      }
    },

    async onDotDoubleTap(row: Row) {
      if (!row.twofakey) return null;
      const result = await getCachedTOTP(row.twofakey);
      if (!result) return null;
      return { action: "totp_copied" as const, code: result.code };
    },

    onDotHold(row: Row, logs: unknown[]) {
      const logMap: Record<string, unknown> = {};
      const key = (row.uid || row.cookies) ?? "";
      logs.forEach((l) => {
        const entry = l as { username?: string };
        if (entry.username) logMap[entry.username] = l;
      });
      const rowLogs = logMap[key] ? [logMap[key]] : [];
      return { action: "show_logs" as const, logs: rowLogs, label: key };
    },

    async checkAccounts(rows: Row[]) {
      const uidRows: { uid: string; row: Row }[] = [];
      rows.forEach((row) => {
        const uid = _extractCUser(row.cookies) || row.uid;
        if (uid) {
          if (!row.uid) row.uid = uid;
          uidRows.push({ uid, row });
        }
      });
      if (!uidRows.length) throw new Error("No UIDs found");

      const uids = uidRows.map((r) => r.uid);
      const data = await api.fbCheck(uids);

      uidRows.forEach((r) => {
        if (data.valid.indexOf(r.uid) !== -1) {
          r.row.status = "good";
        } else if (data.dead.indexOf(r.uid) !== -1) {
          r.row.status = "bad";
          r.row.wa_status = "";
          r.row.wa_ban_reason = null;
          r.row.wa_page_name = null;
          r.row.wa_linked_number = null;
        } else {
          r.row.status = "pending";
        }
      });

      return {
        total: uidRows.length,
        valid: data.valid.length,
        dead: data.dead.length,
        uncertain: data.uncertain.length,
      };
    },
  };
}
