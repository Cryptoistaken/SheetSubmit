import { describe, expect, it } from "bun:test";

// Shared display currency (Pages/src/lib/currency.ts): USD stored, BDT shown
// at a fixed display rate. Covers the admin's headline case: typing 7.3 BDT
// stores ≈$0.0608 and renders back as ৳7.30.
import { BDT_RATE, fmtMoney, inputToUsd, loadBdtRate, saveBdtRate, usdToInput } from "../currency";

// bun test has no DOM localStorage — rate persistence tests only run where it exists.
const hasLS = typeof localStorage !== "undefined";

describe("fmtMoney", () => {
  it("formats USD like the balance pill (whole grouped, fraction 2dp)", () => {
    expect(fmtMoney(0.05, "USD")).toBe("$0.05");
    expect(fmtMoney(1500, "USD")).toBe("$1,500");
    expect(fmtMoney(0, "USD")).toBe("$0.00");
  });

  it("formats BDT converted at the fixed rate", () => {
    expect(fmtMoney(1, "BDT")).toBe(`৳${(1 * BDT_RATE).toLocaleString()}`);
    expect(fmtMoney(0, "BDT")).toBe("৳0.00");
  });

  it("keeps paisa so a 7.3 BDT price round-trips visibly", () => {
    expect(fmtMoney(7.3 / BDT_RATE, "BDT")).toBe("৳7.30");
    expect(fmtMoney(0.0608, "BDT")).toBe("৳7.30");
  });
});

describe("usdToInput / inputToUsd", () => {
  it("passes USD through", () => {
    expect(usdToInput(0.05, "USD")).toBe("0.05");
    expect(inputToUsd("0.05", "USD")).toBe(0.05);
  });

  it("converts a 7.3 BDT price to stored USD and back", () => {
    const stored = inputToUsd("7.3", "BDT");
    expect(stored).toBeCloseTo(7.3 / BDT_RATE, 4);
    expect(usdToInput(stored, "BDT")).toBe("7.3");
  });

  it("rejects non-numeric input (empty is 0 — callers guard blank fields)", () => {
    expect(inputToUsd("abc", "USD")).toBeNaN();
    expect(inputToUsd("", "BDT")).toBe(0);
  });
});

describe.skipIf(!hasLS)("loadBdtRate / saveBdtRate", () => {
  it("defaults to BDT_RATE and round-trips a custom rate", () => {
    localStorage.removeItem("ss_bdt_rate");
    expect(loadBdtRate()).toBe(BDT_RATE);
    saveBdtRate(150);
    expect(loadBdtRate()).toBe(150);
    expect(fmtMoney(1, "BDT")).toBe("৳150");
    expect(inputToUsd("150", "BDT")).toBeCloseTo(1, 4);
    localStorage.removeItem("ss_bdt_rate");
    expect(loadBdtRate()).toBe(BDT_RATE);
  });

  it("ignores invalid rates", () => {
    saveBdtRate(NaN);
    saveBdtRate(0);
    saveBdtRate(-5);
    expect(loadBdtRate()).toBe(BDT_RATE);
    localStorage.setItem("ss_bdt_rate", "junk");
    expect(loadBdtRate()).toBe(BDT_RATE);
    localStorage.removeItem("ss_bdt_rate");
  });
});
