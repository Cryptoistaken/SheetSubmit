import { NO_2FA_MARK } from "@/lib/types";

export function validateCell(
  colKey: string,
  value: string,
): { valid: boolean; msg?: string } {
  if (!value) return { valid: true };
  if (colKey === "cookies") {
    if (!value.match(/c_user=\d+/)) {
      return { valid: false, msg: "Cookies must contain c_user=ID" };
    }
    return { valid: true };
  }
  if (colKey === "twofakey") {
    if (value === NO_2FA_MARK) return { valid: true };
    const cleaned = value.replace(/[\s\-]/g, "").toUpperCase();
    if (cleaned.length < 10) return { valid: false, msg: "2FA key too short" };
    if (!cleaned.match(/^[A-Z2-7]+$/)) {
      return { valid: false, msg: "2FA key must be base32 (A-Z, 2-7)" };
    }
    return { valid: true };
  }
  if (colKey === "uid") {
    if (!value.match(/^\d+$/)) return { valid: false, msg: "UID must be digits only" };
    return { valid: true };
  }
  return { valid: true };
}
