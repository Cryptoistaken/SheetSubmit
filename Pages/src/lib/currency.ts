import { useCallback, useEffect, useState } from "react";

// Single source of truth for display currency. Prices are stored in USD;
// BDT is a display-only conversion (same rate everywhere). One localStorage
// key + one event so the Topbar pill, pool prices and wallet amounts all
// switch together no matter where the user toggles.
export const BDT_RATE = 120; // ৳ per $1
export type Currency = "USD" | "BDT";

const KEY = "ss_currency";
const EVENT = "ss:currency";

export function loadCurrency(): Currency {
  try {
    if (localStorage.getItem(KEY) === "BDT") return "BDT";
    if (localStorage.getItem(KEY) === "USDC") return "USD"; // legacy Topbar value
    if (localStorage.getItem("ss_price_currency") === "BDT") return "BDT"; // legacy PoolsView key
    return "USD";
  } catch {
    return "USD";
  }
}

export function saveCurrency(c: Currency) {
  try {
    localStorage.setItem(KEY, c);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: c }));
  } catch {}
}

export function useCurrency(): [Currency, (c: Currency) => void] {
  const [currency, setCurrencyState] = useState<Currency>(loadCurrency);
  useEffect(() => {
    const sync = (e: Event) => {
      const next = (e as CustomEvent).detail as Currency | undefined;
      setCurrencyState(next === "BDT" || next === "USD" ? next : loadCurrency());
    };
    const onStorage = () => setCurrencyState(loadCurrency());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    saveCurrency(c);
  }, []);
  return [currency, setCurrency];
}

// 0 → "0.00", whole → grouped ("1,500"), fraction → 2 decimals ("1,500.50")
const num2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "0.00";
  if (Number.isInteger(r)) return r.toLocaleString("en-US");
  return r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Format a stored USD amount in the selected display currency. */
export const fmtMoney = (usd: number, cur: Currency) =>
  cur === "USD" ? `$${num2(usd)}` : `৳${num2(usd * BDT_RATE)}`;

/** Stored USD → price-dialog input text (BDT keeps paisa so 7.3 round-trips). */
export const usdToInput = (usd: number, cur: Currency) =>
  cur === "USD" ? String(usd) : String(Math.round(usd * BDT_RATE * 100) / 100);

/** Price-dialog input text → stored USD. */
export const inputToUsd = (raw: string, cur: Currency) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return NaN;
  return cur === "USD" ? v : Math.round((v / BDT_RATE) * 10000) / 10000;
};
