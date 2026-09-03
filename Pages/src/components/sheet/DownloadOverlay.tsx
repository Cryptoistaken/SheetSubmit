import { useMemo, useRef, useState } from "react";
import { useSheetStore } from "@/stores/sheetStore";
import { downloadSheetRows } from "@/lib/xlsx";
import { buildDownloadOpts } from "@/lib/downloadOpts";
import { useToast } from "@/lib/toast";

export default function DownloadOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const rows = useSheetStore((s) => s.rows);
  const columns = useSheetStore((s) => s.columns);
  const fileName = useSheetStore((s) => s.file?.name ?? "export");
  const showToast = useToast();

  const opts = useMemo(() => buildDownloadOpts(rows, columns), [rows, columns]);
  const [sel, setSel] = useState<Set<string> | null>(null);
  const timer = useRef<number | null>(null);
  const skip = useRef<string | null>(null);
  const inMulti = sel !== null;
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const start = (k: string) => {
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = null; skip.current = k;
      setSel((p) => { const s = new Set(p ?? []); s.add(k); return s; });
      try { navigator.vibrate?.(30); } catch {}
      showToast("Multi-select");
    }, 500);
  };

  if (!open) return null;
  const toggle = (k: string) => setSel((p) => { if (!p) return p; const s = new Set(p); s.has(k) ? s.delete(k) : s.add(k); return s; });
  const handleClose = () => { setSel(null); onClose(); };
  const downloadMulti = async () => {
    if (!sel?.size) return;
    let n = 0;
    for (const k of sel) {
      const o = opts.find((x) => x.key === k);
      if (!o) continue;
      try { const ok = await downloadSheetRows(rows, columns, fileName, o.filter, o.suffix); if (ok) n++; } catch {}
    }
    showToast(n ? `Downloaded ${n} files` : "No data to download");
    handleClose();
  };

  return (
    <div
      className="download-opt-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="download-opt-box">
        <div className="download-opt-title">Download</div>
        {opts.map((o) => {
          const selected = sel?.has(o.key) ?? false;
          return (
          <button
            key={o.key}
            className={"download-opt-btn " + o.className}
            aria-pressed={selected}
            style={(selected ? { borderColor: "var(--blue)", background: "var(--blue-light)", color: "var(--blue)", userSelect: "none", WebkitUserSelect: "none" } : { userSelect: "none", WebkitUserSelect: "none" }) as React.CSSProperties}
            onContextMenu={(e) => e.preventDefault()}
            onTouchStart={() => start(o.key)}
            onTouchEnd={cancel}
            onTouchMove={cancel}
            onMouseDown={() => start(o.key)}
            onMouseUp={cancel}
            onMouseLeave={cancel}
            onClick={async () => {
              if (skip.current === o.key) { skip.current = null; return; }
              if (timer.current) cancel();
              if (inMulti) { toggle(o.key); return; }
              try {
                const ok = await downloadSheetRows(rows, columns, fileName, o.filter, o.suffix);
                showToast(ok ? "Downloaded" : "No data to download");
              } catch {
                showToast("Download failed");
              }
              handleClose();
            }}
          >
            {o.label} <span className="opt-count">{o.count}</span>
          </button>
        );})}
        {inMulti ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "center", alignItems: "center" }}>
            <button className="btn btn-primary btn-sm" onClick={downloadMulti}>Download {sel!.size}</button>
            <button className="btn btn-sm" onClick={() => setSel(null)}>Cancel</button>
          </div>
        ) : (
          <button className="download-opt-cancel" onClick={handleClose}>Cancel</button>
        )}
      </div>
    </div>
  );
}
