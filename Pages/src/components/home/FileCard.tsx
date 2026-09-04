import { Download, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { CookieIcon, PageIcon, PasswordIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import { useEffect, useRef } from "react";

import { FacebookIcon } from "@/components/icons/FacebookIcon";
import { fileTypeDef } from "@/lib/types";
import type { SheetFile } from "@/lib/types";

interface FileCardProps {
  file: SheetFile;
  crossDupCount?: number;
  selected?: boolean;
  selectionMode?: boolean;
  onOpen?: () => void;
  onDownload?: () => void;
  onRename?: () => void;
  onDelete: () => void;
  onRestore?: () => void;
  onToggleSelect: () => void;
  onHoldSelect: () => void;
  disableOpen?: boolean;
  daysLeft?: number;
  recent?: boolean;
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
  onRestore,
  onToggleSelect,
  onHoldSelect,
  disableOpen = false,
  daysLeft,
  recent = false,
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

  const doOpen = () => {
    if (disableOpen) onToggleSelect();
    else if (onOpen) onOpen();
    else onToggleSelect();
  };

  const onPointerUp = () => {
    const held = heldRef.current;
    clearHold();
    if (held || movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else doOpen();
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 300);
  };

  const onClick = () => {
    if (suppressClickRef.current) return;
    if (heldRef.current || movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else doOpen();
  };

  const count = file.dataCount ?? file.rowCount ?? 0;
  const badge = fileTypeDef(file.type).badge;
  const pw = file.password ?? "dgddigital";
  const isCustom = pw !== "dgddigital" && pw !== "L0VE@12345";
  const pwLabel = pw === "dgddigital" ? "dgd" : pw === "L0VE@12345" ? "L0VE" : pw.slice(0, 8);
  const pwTitle = pw;
  const _presetKind = (file.preset ?? file.poolKind) as string | undefined;
  const FileIcon = _presetKind
    ? _presetKind === "page"
      ? PageIcon
      : _presetKind === "combo"
        ? TwoFaIcon
        : CookieIcon
      : file.name.toLowerCase().startsWith("cookie")
      ? CookieIcon
      : file.name.toLowerCase().startsWith("2fa")
        ? TwoFaIcon
        : file.name.toLowerCase().startsWith("page")
          ? PageIcon
          : CookieIcon;
  const pwStyle: React.CSSProperties = isCustom
    ? { background: "var(--fb-bg)", color: "var(--fb)" }
    : pw === "dgddigital"
      ? { background: "transparent", color: "#2563eb", border: "1px solid transparent" }
      : { background: "var(--bg3)", color: "var(--text2)" };
  const sq = (bg: string, title: string) => (
    <span title={title} style={{ width: 10, height: 10, borderRadius: 3, background: bg, border: "1px solid var(--border)", flexShrink: 0 }} />
  );

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
          else doOpen();
        }
      }}
    >
      <div className="file-card-icon">
        <FileIcon size={16} />
      </div>
      {recent ? (
        <span title="Most recently modified file" style={{ position: "absolute", top: 0, left: 0, fontSize: 9, fontWeight: 600, color: "var(--text2)", background: "var(--bg3)", padding: "2px 6px", borderBottomRightRadius: 6, letterSpacing: "-0.01em" }}>
          Last Modified
        </span>
      ) : null}
      <div className="file-card-name">{file.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
        <span className="file-type-badge" title={badge} aria-label={badge} style={{ display: "inline-flex", alignItems: "center" }}><FacebookIcon size={12} /></span>
        <span className="file-type-badge" style={{ ...pwStyle, fontSize: 10, padding: "2px 6px", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={pwTitle}>{isCustom ? pwLabel : <PasswordIcon password={pw} size={14} />}</span>
        <span className="file-card-meta" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{sq("var(--text)", "rows")}{count}</span>
          {(file.liveCount ?? 0) + (file.deadCount ?? 0) > 0 ? (
            <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{sq("var(--green)", "live")}{file.liveCount}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{sq("var(--red)", "dead")}{file.deadCount}</span>
            </>
          ) : null}
          {crossDupCount ? (
            <>
              {" · "}
              <span className="cd-badge">{crossDupCount} dup</span>
            </>
          ) : null}
          {daysLeft !== undefined ? (
            <>
              {" · "}
              {daysLeft} days left
            </>
          ) : null}
        </span>
      </div>
      <div className="file-card-actions">
        {onRestore ? (
          <button
            className="file-card-btn archive-restore"
            title="Restore"
            aria-label="Restore"
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <RotateCcw size={14} />
          </button>
        ) : null}
        {onDownload ? (
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
        ) : null}
        {onRename ? (
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
        ) : null}
        <button
          className="file-card-btn file-card-del"
          title={onRestore ? "Delete permanently" : "Delete"}
          aria-label={onRestore ? "Delete permanently" : "Delete"}
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
