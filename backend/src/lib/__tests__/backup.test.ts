import { describe, expect, test } from "bun:test";
import { BACKUP_TABLES } from "../backup";

// DB-free: FK safety lives in table order (users + file_index are the only
// REFERENCES targets, so they must come first for parent-first inserts).
describe("backup table order", () => {
  test("parents before children, no duplicates", () => {
    expect(BACKUP_TABLES[0]).toBe("users");
    expect(BACKUP_TABLES[1]).toBe("file_index");
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
    expect(BACKUP_TABLES.length).toBeGreaterThan(10);
  });
});
