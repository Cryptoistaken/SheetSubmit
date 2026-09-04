import { Download, MoreHorizontal, Pencil, RotateCcw, Square, Trash2 } from "lucide-react";
import { CookieIcon, PageIcon, PasswordIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import { useEffect, useRef, useState } from "react";

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
  disableOpen = false,
  daysLeft,
  recent = false,
}: FileCardProps) {
  const movedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !dotsRef.current?.contains(t)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [menuOpen]);

  const onPointerDown = (e: React.PointerEvent) => {
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    suppressClickRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) {
      movedRef.current = true;
      return;
    }
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
      movedRef.current = true;
    }
  };

  const doOpen = () => {
    if (disableOpen) onToggleSelect();
    else if (onOpen) onOpen();
    else onToggleSelect();
  };

  const onPointerUp = () => {
    if (movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else doOpen();
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 300);
  };

  const onClick = () => {
    if (suppressClickRef.current) return;
    if (movedRef.current) return;
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
  const isPage = _presetKind === "page" || (!_presetKind && file.name.toLowerCase().startsWith("page"));
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
        <span title={"Last action: " + (file.lastAction ?? "modified")} style={{ position: "absolute", top: 0, left: 0, fontSize: 9, fontWeight: 600, color: "var(--text2)", background: "var(--bg3)", padding: "2px 6px", borderBottomRightRadius: 6, letterSpacing: "-0.01em" }}>
          {({ created: "Newly Created", renamed: "Renamed", modified: "Last Modified", restored: "Last Restored", archived: "Last Archived" } as Record<string, string>)[file.lastAction ?? (file.deletedAt ? "archived" : "modified")] ?? "Last Modified"}
        </span>
      ) : null}
      <div className="file-card-name">{file.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 2 }}>
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
          {isPage && (file.pageCount ?? 0) > 0 ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{sq("var(--cyan)", "page eligible")}{file.pageCount}</span>
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
        <button
          ref={dotsRef}
          className="file-card-btn file-card-more"
          title="More"
          aria-label="More actions"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen ? (
          <div ref={menuRef} role="menu" style={{ position: "absolute", top: 26, right: 3, minWidth: 140, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow-lg)", padding: 4, display: "flex", flexDirection: "column", zIndex: 50 }}>
            <button role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onToggleSelect(); }}>
              <span className="home-fab-ic" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Square size={13} /></span>
              Select
            </button>
            {onRestore ? (
              <button role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRestore(); }}>
                <span className="home-fab-ic" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><RotateCcw size={13} /></span>
                Restore
              </button>
            ) : null}
            {onDownload ? (
              <button role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDownload(); }}>
                <span className="home-fab-ic" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Download size={13} /></span>
                Download
              </button>
            ) : null}
            {onRename ? (
              <button role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRename(); }}>
                <span className="home-fab-ic" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Pencil size={13} /></span>
                Rename
              </button>
            ) : null}
            <button role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500, color: "var(--red)" }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}>
              <span className="home-fab-ic" style={{ width: 24, height: 24, background: "var(--red-bg)", color: "var(--red)" }}><Trash2 size={13} /></span>
              {onRestore ? "Delete Permanently" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
