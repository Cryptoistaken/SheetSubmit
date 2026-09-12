import { describe, expect, it } from "bun:test";
import { checkStatusOf, applyCheckFields, CHECK_FIELDS } from "../check";

describe("check state helpers", () => {
  it("prefers check_status over legacy wa_status/waStatus", () => {
    expect(checkStatusOf({ check_status: "eligible", wa_status: "ineligible" })).toBe("eligible");
    expect(checkStatusOf({ wa_status: "eligible" })).toBe("eligible");
    expect(checkStatusOf({ waStatus: "eligible" })).toBe("eligible");
    expect(checkStatusOf({})).toBe("");
    expect(checkStatusOf(null)).toBe("");
  });

  it("applyCheckFields writes check_* and wipes legacy keys", () => {
    const row: Record<string, unknown> = { wa_status: "ineligible", wa_ban_reason: "b", waStatus: "x" };
    applyCheckFields(row as never, { status: "eligible", banReason: null });
    expect(row.check_status).toBe("eligible");
    expect(row.check_ban_reason).toBe(null);
    expect("wa_status" in row).toBe(false);
    expect("wa_ban_reason" in row).toBe(false);
    expect("waStatus" in row).toBe(false);
  });

  it("CHECK_FIELDS covers the four canonical fields", () => {
    expect([...CHECK_FIELDS]).toEqual(["check_status", "check_ban_reason", "check_page_name", "check_linked_number"]);
  });
});
