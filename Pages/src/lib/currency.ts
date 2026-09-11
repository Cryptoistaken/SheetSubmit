import { useCallback, useEffect, useState } from "react";

// Single source of truth for display currency. Prices are stored in USD;
// BDT is a display-only conversion (same rate everywhere). One localStorage
// key + one event so the Topbar pill, pool prices and wallet amounts all
// switch together no matter where the user toggles. The ৳/$ rate itself is
// editable on the Settings page (ss_bdt_rate, default 120) and broadcasts
// ss:bdt-rate so every money view re-renders with the new rate.
export const BDT_RATE = 120; // ৳ per $1 (default; see loadBdtRate)
export type Currency = "USD" | "BDT";

const KEY = "ss_currency";
const EVENT = "ss:currency";
const RATE_KEY = "ss_bdt_rate";
const RATE_EVENT = "ss:bdt-rate";

export function loadBdtRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (raw == null) return BDT_RATE;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= 1_000_000) return v;
    return BDT_RATE;
  } catch {
    return BDT_RATE;
  }
}

export function saveBdtRate(v: number) {
  if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) return;
  try {
    localStorage.setItem(RATE_KEY, String(v));
    window.dispatchEvent(new CustomEvent(RATE_EVENT, { detail: v }));
  } catch {}
}

export function useBdtRate(): [number, (v: number) => void] {
  const [rate, setRateState] = useState<number>(loadBdtRate);
  useEffect(() => {
    const sync = (e: Event) => {
      const next = (e as CustomEvent).detail as number | undefined;
      setRateState(typeof next === "number" && Number.isFinite(next) && next > 0 ? next : loadBdtRate());
    };
    const onStorage = () => setRateState(loadBdtRate());
    window.addEventListener(RATE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RATE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const setRate = useCallback((v: number) => {
    if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) return;
    setRateState(v);
    saveBdtRate(v);
  }, []);
  return [rate, setRate];
}

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
    const onRate = () => setCurrencyState(loadCurrency()); // re-render money views when the ৳/$ rate changes
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    window.addEventListener(RATE_EVENT, onRate);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(RATE_EVENT, onRate);
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
  cur === "USD" ? `$${num2(usd)}` : `৳${num2(usd * loadBdtRate())}`;

/** Stored USD → price-dialog input text (BDT keeps paisa so 7.3 round-trips). */
export const usdToInput = (usd: number, cur: Currency) =>
  cur === "USD" ? String(usd) : String(Math.round(usd * loadBdtRate() * 100) / 100);

/** Price-dialog input text → stored USD. */
export const inputToUsd = (raw: string, cur: Currency) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return NaN;
  return cur === "USD" ? v : Math.round((v / loadBdtRate()) * 10000) / 10000;
};
