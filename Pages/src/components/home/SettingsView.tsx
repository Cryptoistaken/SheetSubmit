import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtMoney, inputToUsd, useBdtRate, useCurrency, usdToInput, type Currency } from "@/lib/currency";
import { useToast } from "@/lib/toast";
import { CookieIcon, PageIcon, PasswordIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import { Skeleton } from "@/components/ui/page-skeleton";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const PASSWORDS = ["dgddigital", "L0VE@12345"] as const;
const POOL_TABS = [
  { id: "cookies_only", label: "Cookies" },
  { id: "cookies_2fa", label: "2FA" },
  { id: "page", label: "Page" },
] as const;

const POOL_META: Record<string, { label: string; Icon: typeof CookieIcon }> = {
  cookies_only: { label: "Cookies", Icon: CookieIcon },
  cookies_2fa: { label: "2FA", Icon: TwoFaIcon },
  page: { label: "Page", Icon: PageIcon },
};

const cellKey = (pwd: string, pid: string) => `${pwd}:${pid}`;

export default function SettingsView() {
  const showToast = useToast();
  const [entryCurrency, setEntryCurrency] = useCurrency();
  const [rate, setRate] = useBdtRate();
  const entryRef = useRef<Currency>(entryCurrency);
  entryRef.current = entryCurrency;

  // pool prices (stored USD, keyed password:pool)
  const [prices, setPrices] = useState<Record<string, number | null> | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  // conversion rate draft (৳ per $1)
  const [rateInput, setRateInput] = useState("");

  // inputs are entered in the selected currency; stored/saved values are always USD
  const switchEntryCurrency = (c: Currency) => {
    const prev = entryRef.current;
    if (prev !== c) {
      setInputs((p) => {
        const next: Record<string, string> = {};
        Object.entries(p).forEach(([k, raw]) => {
          if (raw.trim() === "" || !Number.isFinite(Number(raw))) { next[k] = raw; return; }
          const usd = inputToUsd(raw, prev);
          next[k] = Number.isFinite(usd) ? usdToInput(usd, c) : raw;
        });
        return next;
      });
    }
    setEntryCurrency(c);
  };

  const fetchPrices = useCallback(async () => {
    const next: Record<string, number | null> = {};
    await Promise.all(PASSWORDS.flatMap((pwd) => POOL_TABS.map(async (t) => {
      try { next[cellKey(pwd, t.id)] = (await api.getPoolPrice(pwd, t.id)).price; }
      catch { next[cellKey(pwd, t.id)] = null; }
    })));
    setPrices(next);
    const cur = entryRef.current;
    setInputs((prev) => {
      const merged: Record<string, string> = { ...prev };
      PASSWORDS.forEach((pwd) => POOL_TABS.forEach((t) => {
        const k = cellKey(pwd, t.id);
        if (merged[k] === undefined) merged[k] = next[k] != null ? usdToInput(next[k]!, cur) : "";
      }));
      return merged;
    });
  }, []);

  useEffect(() => { void fetchPrices(); }, [fetchPrices]);

  const maxFor = (cur: Currency) => (cur === "USD" ? 1000 : 1000 * rate);

  const validatePrices = (): string[] => {
    const errors: string[] = [];
    const max = maxFor(entryCurrency);
    PASSWORDS.forEach((pwd) => POOL_TABS.forEach((t) => {
      const raw = inputs[cellKey(pwd, t.id)] ?? "";
      const v = Number(raw);
      if (!raw.trim() || !Number.isFinite(v) || v < 0 || v > max) {
        errors.push(`${pwd} ${POOL_META[t.id].label}: 0-${max.toLocaleString("en-US")}${entryCurrency === "BDT" ? "৳" : ""}`);
      }
    }));
    return errors;
  };

  const priceChanges = PASSWORDS.flatMap((pwd) => POOL_TABS.map((t) => {
    const k = cellKey(pwd, t.id);
    const raw = inputs[k] ?? "";
    if (!raw.trim()) return null;
    const v = inputToUsd(raw, entryCurrency);
    const old = prices?.[k];
    if (!Number.isFinite(v) || old == null || Math.abs(v - old) <= 1e-9) return null;
    return { pwd, pid: t.id, key: k, old, next: v };
  }).filter((x) => x !== null));

  const openConfirm = () => {
    const errors = validatePrices();
    if (errors.length) { showToast(`Invalid: ${errors.join(", ")}`); return; }
    if (!priceChanges.length) { showToast("No changes to save"); return; }
    setConfirm(true);
  };

  const savePrices = async () => {
    setSaving(true);
    try {
      const updated = { ...(prices ?? {}) };
      await Promise.all(priceChanges.map(async (c) => {
        try { updated[c.key] = (await api.setPoolPrice(c.pwd, c.pid, c.next)).price; }
        catch { /* keep old on failure */ }
      }));
      setPrices(updated);
      setConfirm(false);
      showToast("Prices saved");
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)); }
    finally { setSaving(false); }
  };

  const saveRate = () => {
    const v = Number(rateInput);
    if (!rateInput.trim() || !Number.isFinite(v) || v <= 0 || v > 1_000_000) { showToast("Enter a rate above 0"); return; }
    setRate(v);
    setRateInput("");
    showToast(`Rate saved — $1 = ৳${v.toLocaleString("en-US")}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Settings</h2>
        <p style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 0" }}>Prices and conversion</p>
      </div>

      {/* pool prices */}
      <section style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)", padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginRight: "auto" }}>Pool prices</h3>
          <div className="pool-switch" role="group" aria-label="Price entry currency">
            <button type="button" className={entryCurrency === "USD" ? "active" : ""} aria-pressed={entryCurrency === "USD"} onClick={() => switchEntryCurrency("USD")}>USD</button>
            <button type="button" className={entryCurrency === "BDT" ? "active" : ""} aria-pressed={entryCurrency === "BDT"} onClick={() => switchEntryCurrency("BDT")}>BDT</button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--text3)", margin: "6px 0 0" }}>
          {entryCurrency === "USD" ? "Price per row in USD — 0 to 1000." : `Enter BDT per row — auto-converts to stored USD ($1 = ৳${rate.toLocaleString("en-US")}).`}
        </p>
        {prices === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
            {PASSWORDS.map((pwd) => (
              <div key={pwd}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "var(--text2)", marginBottom: 8 }}>
                  <PasswordIcon password={pwd} size={14} />{pwd}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
                  {POOL_TABS.map((t) => {
                    const meta = POOL_META[t.id];
                    const k = cellKey(pwd, t.id);
                    const raw = inputs[k] ?? "";
                    const typed = Number(raw);
                    const other = raw.trim() !== "" && Number.isFinite(typed)
                      ? (entryCurrency === "USD" ? fmtMoney(typed, "BDT") : fmtMoney(inputToUsd(raw, "BDT"), "USD"))
                      : null;
                    return (
                      <label key={k} style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "10px 12px", background: "var(--bg3)" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                          <meta.Icon size={14} />{meta.label}
                          {prices[k] != null ? <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text3)" }}>· {fmtMoney(prices[k]!, entryCurrency)}</span> : null}
                        </span>
                        <input
                          aria-label={`${meta.label} price in ${entryCurrency} (${pwd})`}
                          type="number" min={0} max={maxFor(entryCurrency)} step={0.01}
                          value={raw}
                          onChange={(e) => setInputs((p) => ({ ...p, [k]: e.target.value }))}
                          style={{ height: 36, borderRadius: 6, border: "1px solid var(--border2)", background: "var(--bg)", padding: "6px 10px", fontSize: 13 }}
                        />
                        {other ? <span style={{ fontSize: 11, color: "var(--text3)" }}>≈ {other}</span> : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <Button disabled={prices === null} onClick={openConfirm} style={{ marginTop: 12 }}>Save all prices</Button>
      </section>

      {/* conversion rate */}
      <section style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", background: "var(--bg)", padding: "14px 16px" }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Conversion rate</h3>
        <p style={{ fontSize: 12, color: "var(--text3)", margin: "6px 0 0" }}>Display-only ৳ per $1. Stored prices stay in USD.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>$1 = ৳{rate.toLocaleString("en-US")}</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input
            aria-label="BDT per USD"
            type="number" min={0} step={0.01} placeholder="New rate"
            value={rateInput}
            onChange={(e) => setRateInput(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveRate(); } }}
            style={{ height: 36, width: 160, borderRadius: 6, border: "1px solid var(--border2)", background: "var(--bg)", padding: "6px 10px", fontSize: 13 }}
          />
          <Button variant="outline" onClick={saveRate}>Save rate</Button>
        </div>
      </section>

      {/* price confirm dialog */}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm price change</AlertDialogTitle>
            <AlertDialogDescription>Review changes before saving.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            {priceChanges.map((c) => {
              const meta = POOL_META[c.pid];
              return (
                <div key={c.key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="flex items-center gap-2 font-medium"><meta.Icon size={14} />{c.pwd} · {meta.label}</span>
                  <span className="text-muted-foreground">{fmtMoney(c.old, entryCurrency)}</span>
                  <span>→</span>
                  <span className="font-medium">{fmtMoney(c.next, entryCurrency)}</span>
                </div>
              );
            })}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={savePrices}>{saving ? "Saving…" : "OK"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
