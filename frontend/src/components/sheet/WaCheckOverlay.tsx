import { useMemo, useState } from "react";
import { useSheetStore } from "@/stores/sheetStore";
import { useToast } from "@/lib/toast";

export default function WaCheckOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows = useSheetStore((s) => s.rows);
  const showToast = useToast();
  const [custom, setCustom] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<"idle" | "checking" | "done">("idle");
  const [targets, setTargets] = useState<number[]>([]);
  const [doneCounts, setDoneCounts] = useState<{ page: number; noPage: number } | null>(null);

  const pageCount = useMemo(() => rows.filter((r) => r.wa_status === "eligible").length, [rows]);
  const noPageCount = useMemo(() => rows.filter((r) => r.status === "good" && r.wa_status !== "eligible" && !!r.cookies && /c_user=\d+/.test(r.cookies)).length, [rows]);

  const handleClose = () => { setCustom(false); setSel(new Set()); setPhase("idle"); setTargets([]); setDoneCounts(null); setRunning(false); onClose(); };

  if (!open) return null;

  const run = async (filter: (row: Record<string, unknown>, idx: number) => boolean, emptyMsg: string) => {
    if (running) return;
    const idxs = rows.map((r, i) => (filter(r as unknown as Record<string, unknown>, i) ? i : -1)).filter((i) => i !== -1);
    if (!idxs.length) { showToast(emptyMsg); return; }
    setTargets(idxs.slice(0, 100));
    setPhase("checking");
    setRunning(true);
    setDoneCounts(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await useSheetStore.getState().runWaChecksWaFiltered(filter as any);
      const after = useSheetStore.getState().rows;
      const page = idxs.filter((i) => after[i]?.wa_status === "eligible").length;
      setDoneCounts({ page, noPage: idxs.length - page });
      setPhase("done");
      showToast(`WA Check done: ${page} page · ${idxs.length - page} no page`);
    } catch {
      showToast("WA Check failed");
      setPhase("idle");
    } finally {
      setRunning(false);
    }
  };

  const toggle = (idx: number) => setSel((p) => { const s = new Set(p); s.has(idx) ? s.delete(idx) : s.add(idx); return s; });

  const isProgress = phase === "checking" || phase === "done";
  return (
    <div className="download-opt-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="download-opt-box" style={{ width: custom || isProgress ? 300 : 220 }}>
        <div className="download-opt-title">{phase === "checking" ? "Checking…" : phase === "done" ? "Result" : "WA Check"}</div>
        {isProgress ? (
          <>
            <div style={{ fontSize: 12, color: "var(--text2)", display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              {phase === "checking" ? <><span className="spin-icon" style={{ width: 12, height: 12, border: "2px solid var(--border2)", borderTopColor: "var(--blue)", borderRadius: "50%" }} /> Checking {targets.length}…</> : <span style={{ color: "var(--text)", fontWeight: 600 }}>{doneCounts ? `${doneCounts.page} page · ${doneCounts.noPage} no page` : `${targets.length} checked`}</span>}
            </div>
            <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: "var(--r)", padding: 6 }}>
              {targets.map((idx) => {
                const r = rows[idx];
                if (!r) return null;
                const uid = (r.uid as string) || (r.cookies?.match(/c_user=(\d+)/)?.[1] ?? "") || "";
                const isChecking = phase === "checking";
                // live dot from store: eligible green, else gray; checking = blue pulse
                const dotBg = isChecking ? "var(--blue)" : r.wa_status === "eligible" ? "var(--green)" : "var(--text3)";
                const dotCls = isChecking ? "row-dot d-spin" : r.wa_status === "eligible" ? "row-dot d-green" : "row-dot";
                return (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--r)", background: "var(--bg2)", border: "1px solid var(--border)" }}>
                    <span className={dotCls} style={isChecking ? undefined : { background: dotBg, width: 8, height: 8 }} />
                    <span style={{ fontSize: 12, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{uid ? uid.slice(-8) : r.cookies?.slice(-12) ?? ""} #{idx + 1}</span>
                    <span style={{ fontSize: 11, color: isChecking ? "var(--blue)" : r.wa_status === "eligible" ? "var(--green)" : "var(--text3)", flexShrink: 0 }}>{isChecking ? "…" : r.wa_status === "eligible" ? "page" : "no page"}</span>
                  </div>
                );
              })}
            </div>
            {phase === "done" ? <button className="download-opt-btn primary" onClick={handleClose}>Close</button> : null}
            {phase === "checking" ? <button className="download-opt-cancel" disabled style={{ opacity: 0.5 }}>Checking…</button> : null}
          </>
        ) : !custom ? (
          <>
            <button className="download-opt-btn btn-blue" disabled={running} onClick={() => void run((r) => (r as Record<string,string>).wa_status === "eligible", pageCount ? "Checking Page..." : "No Page rows")}>Page <span className="opt-count">{pageCount}</span></button>
            <button className="download-opt-btn btn-amber" disabled={running} onClick={() => void run((r) => (r as Record<string,string>).status === "good" && (r as Record<string,string>).wa_status !== "eligible" && !!(r as Record<string,string>).cookies, noPageCount ? "Checking No Page..." : "No rows")}>No Page <span className="opt-count">{noPageCount}</span></button>
            <button className="download-opt-btn primary" disabled={running} onClick={() => setCustom(true)}>Custom <span className="opt-count">{rows.filter((r) => !!r.cookies && /c_user=\d+/.test(r.cookies)).length}</span></button>
            <button className="download-opt-cancel" onClick={handleClose}>Cancel</button>
          </>
        ) : (
          <>
            <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: "var(--r)", padding: 6 }}>
              {rows.slice(0, 200).map((r, idx) => {
                if (!r.cookies || !/c_user=\d+/.test(r.cookies)) return null;
                const checked = sel.has(idx);
                const uid = (r.uid as string) || (r.cookies.match(/c_user=(\d+)/)?.[1] ?? "") || "";
                const dot = r.wa_status === "eligible" ? "var(--green)" : r.wa_status === "ineligible" ? "var(--text3)" : r.status === "good" ? "var(--cyan)" : "var(--border2)";
                return (
                  <div key={idx} onClick={() => toggle(idx)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--r)", cursor: "pointer", background: checked ? "var(--blue-light)" : "transparent", border: checked ? "1px solid var(--blue)" : "1px solid transparent" }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, border: "1.5px solid " + (checked ? "var(--blue)" : "var(--border2)"), background: checked ? "var(--blue)" : "var(--bg)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>{checked ? "✓" : ""}</span>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uid ? uid.slice(-8) : r.cookies.slice(-12)} #{idx + 1}</span>
                  </div>
                );
              })}
            </div>
            <button className="download-opt-btn primary" disabled={running || sel.size === 0} onClick={() => void run((_, idx) => sel.has(idx), sel.size ? `Checking ${sel.size}...` : "No selection")}>Check Selected ({sel.size})</button>
            <button className="download-opt-cancel" onClick={() => { setCustom(false); setSel(new Set()); }}>Back</button>
          </>
        )}
      </div>
    </div>
  );
}
