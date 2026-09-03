import { useEffect, useRef, useState } from "react";
import { parseStyles, useSheetStore } from "@/stores/sheetStore";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import CellEditor from "./CellEditor";

const PALETTE = ["#000000","#434343","#666666","#999999","#B7B7B7","#CCCCCC","#D9D9D9","#ee0000","#ff6d00","#fbbc04","#16a34a","#00acc1","#0070f3","#6366f1","#795548"];

function trigger(el: HTMLElement | null, cls: string) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

export default function QuickEditBar() {
  const qebOpen = useSheetStore((s) => s.qebOpen);
  const selectedCell = useSheetStore((s) => s.selectedCell);
  const rows = useSheetStore((s) => s.rows);
  const confirm = useConfirm();
  const showToast = useToast();
  const [picker, setPicker] = useState<"text"|"cell"|null>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const pasteRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const compactRef = useRef<HTMLButtonElement>(null);
  const deadRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicker(null); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".qeb-bar")) setPicker(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, []);

  if (!qebOpen || !selectedCell) return null;

  const { rowIdx, colIdx } = selectedCell;
  const styles = parseStyles(rows[rowIdx] ?? ({} as never))[colIdx] ?? {};
  const bold = !!styles.bold;
  const textColor = styles.color ?? "#000000";
  const cellBg = styles.bg ?? "transparent";

  const setStyle = (patch: { bg?: string | null; color?: string | null; bold?: boolean | null }) =>
    (useSheetStore.getState().setCellStyle as (r:number,c:string,p: typeof patch)=>void)(rowIdx, colIdx, patch);

  return (
    <div className="qeb-bar open">
      <div className="qeb-formula-bar"><CellEditor /></div>

      <div className="qeb-toolbar">
        <button className={`qeb-icon-btn${bold ? " active" : ""}`} title="Bold" onClick={() => setStyle({ bold: !bold })}><span style={{ fontWeight: 800, fontSize: 18, lineHeight: 1 }}>B</span></button>
        <div className="qeb-divider" />
        <button className="qeb-icon-btn" title="Text color" onClick={() => setPicker(p => p === "text" ? null : "text")}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 16l4-12h4l4 12" /><path d="M8 12h8" /></svg>
          <span className="qeb-color-bar" style={{ background: textColor }} />
        </button>
        <button className="qeb-icon-btn" title="Cell fill" onClick={() => setPicker(p => p === "cell" ? null : "cell")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3l7 7-8 8-7-7 8-8Z" /><path d="M5 19l3-3" /><path d="M14 14l3 3 -1 1 -3 -3" /><path d="M9.5 9.5l1.8 1.8" strokeWidth="1.2" opacity="0.6" /><path d="M10.8 7.2l1.2 1.2" strokeWidth="1" opacity="0.4" /></svg>
          <span className="qeb-color-bar" style={{ background: cellBg === "transparent" ? "transparent" : cellBg }} />
        </button>
        <div className="qeb-divider" />
        <button ref={copyRef} className="qeb-icon-btn" title="Copy" onClick={() => { trigger(copyRef.current, "anim-copy"); void useSheetStore.getState().quickEditCopy().then(() => { copyRef.current?.classList.add("copied"); setTimeout(() => copyRef.current?.classList.remove("copied"), 900); }); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V7a2 2 0 0 1 2-2h8" /></svg>
        </button>
        <button ref={pasteRef} className="qeb-icon-btn" title="Paste" onClick={() => { trigger(pasteRef.current, "anim-paste"); void useSheetStore.getState().quickEditPaste(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" /><rect x="9" y="3" width="8" height="6" rx="1.5" /></svg>
        </button>
        <button ref={clearRef} className="qeb-icon-btn" title="Clear" onClick={() => { trigger(clearRef.current, "anim-clear"); useSheetStore.getState().quickEditClear(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13.5 10.5 22 2" /><path d="M14.734 13.841a2 2 0 00-.314-2.42L12.58 9.58a2 2 0 00-2.421-.314l-7.657 4.461A1 1 0 002.3 15.3l6.403 6.403a1 1 0 001.571-.204z" /><path d="m5 18 2-2" /></svg>
        </button>
        <div className="qeb-divider" />
        <button ref={compactRef} className="qeb-icon-btn" title="Compact" onClick={() => { trigger(compactRef.current, "anim-clear"); useSheetStore.getState().removeEmptyRows(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="8 3 4 3 4 7" /><polyline points="16 3 20 3 20 7" /><polyline points="8 21 4 21 4 17" /><polyline points="16 21 20 21 20 17" /><line x1="4" y1="12" x2="20" y2="12" /></svg>
        </button>
        <button ref={deadRef} className="qeb-icon-btn" title="Delete dead" onClick={() => {
          trigger(deadRef.current, "anim-clear");
          const s = useSheetStore.getState();
          const dead = s.rows.filter((r) => r.status === "bad").length;
          if (!dead) { showToast("No dead rows to delete"); return; }
          void confirm(`Delete ${dead} dead row${dead === 1 ? "" : "s"}?`, "Delete").then((ok) => {
            if (ok) useSheetStore.getState().deleteDeadRows();
          });
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
        </button>
      </div>

      <div className="qeb-handle" />

      {picker === "text" && (
        <div className="qeb-picker open" onClick={e => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div className="qeb-picker-title" style={{ margin: 0 }}>Text color</div>
            <button className="qeb-picker-close" onClick={() => setPicker(null)} aria-label="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
          </div>
          <div className="qeb-swatch-grid">{PALETTE.map(c => <button key={c} className={`qeb-swatch${textColor === c ? " selected" : ""}`} style={{ background: c }} onClick={() => setStyle({ color: c })} aria-label={c} />)}</div>
        </div>
      )}
      {picker === "cell" && (
        <div className="qeb-picker open" onClick={e => e.stopPropagation()} style={{ transformOrigin: "38% 100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div className="qeb-picker-title" style={{ margin: 0 }}>Cell fill</div>
            <button className="qeb-picker-close" onClick={() => setPicker(null)} aria-label="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className={`qeb-swatch none${cellBg === "transparent" ? " selected" : ""}`} onClick={() => setStyle({ bg: null })} title="No fill" aria-label="No fill" style={{ flex: "none" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 2 20 20" /><path d="M8.35 2.69A10 10 0 0 1 21.3 15.65" /><path d="M19.08 19.08A10 10 0 1 1 4.92 4.92" /></svg>
            </button>
            <div className="qeb-swatch-grid" style={{ flex: 1 }}><>{PALETTE.map(c => <button key={c} className={`qeb-swatch${cellBg === c ? " selected" : ""}`} style={{ background: c }} onClick={() => setStyle({ bg: c })} aria-label={c} />)}</></div>
          </div>
        </div>
      )}
    </div>
  );
}
