import { Download, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { fileTypeDef } from "@/lib/types";
import type { SheetFile } from "@/lib/types";

interface FileCardProps {
  file: SheetFile;
  crossDupCount?: number;
  selected?: boolean;
  selectionMode?: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  onHoldSelect: () => void;
}

export default function FileCard({
  file,
  crossDupCount,
  selected = false,
  selectionMode = false,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onToggleSelect,
  onHoldSelect,
}: FileCardProps) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const movedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const clearHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => {
    return () => clearHold();
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    heldRef.current = false;
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    suppressClickRef.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      heldRef.current = true;
      onHoldSelect();
    }, 500);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) {
      movedRef.current = true;
      clearHold();
      return;
    }
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
      movedRef.current = true;
      clearHold();
    }
  };

  const onPointerUp = () => {
    const held = heldRef.current;
    clearHold();
    if (held || movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else onOpen();
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 300);
  };

  const onClick = () => {
    if (suppressClickRef.current) return;
    if (heldRef.current || movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else onOpen();
  };

  const count = file.dataCount ?? file.rowCount ?? 0;
  const badge = fileTypeDef(file.type).badge;
  const pw = file.password ?? "dgddigital";
  const isCustom = pw !== "dgddigital" && pw !== "L0VE@12345";
  const pwLabel = pw === "dgddigital" ? "dgd" : pw === "L0VE@12345" ? "L0VE" : pw.slice(0, 8);
  const pwTitle = pw;
  const pwStyle: React.CSSProperties = isCustom
    ? { background: "var(--fb-bg)", color: "var(--fb)" }
    : pw === "L0VE@12345"
      ? { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" }
      : { background: "var(--bg3)", color: "var(--text2)" };

  return (
    <div
      className={`file-card${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      style={{ touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none" } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selectionMode) onToggleSelect();
          else onOpen();
        }
      }}
    >
      <div className="file-card-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
          <path d="M8.5 8.5v.01" />
          <path d="M16 15.5v.01" />
          <path d="M12 12v.01" />
          <path d="M11 17v.01" />
          <path d="M7 14v.01" />
        </svg>
      </div>
      <div className="file-card-name">{file.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
        <span className="file-type-badge t-fb">{badge}</span>
        <span className="file-type-badge" style={{ ...pwStyle, fontSize: 10, padding: "2px 6px", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pwTitle}>{pwLabel}</span>
        <span className="file-card-meta">
          {count} row{count !== 1 ? "s" : ""}
          {crossDupCount ? (
            <>
              {" · "}
              <span className="cd-badge">{crossDupCount} dup</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="file-card-actions">
        <button
          className="file-card-btn file-card-dl"
          title="Download"
          aria-label="Download"
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <Download size={14} />
        </button>
        <button
          className="file-card-btn file-card-rename"
          title="Rename"
          aria-label="Rename"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <Pencil size={14} />
        </button>
        <button
          className="file-card-btn file-card-del"
          title="Delete"
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
