import { Download, MoreHorizontal, Pencil, RotateCcw, Square, Trash2 } from "lucide-react";
import { FileTypeIcon, PasswordIcon } from "@/components/icons/FileTypeIcons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  list?: boolean;
  selectable?: boolean;
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
  list = false,
  selectable = true,
}: FileCardProps) {
  const movedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Touch-only long-press: first entry into multi-select (once selectionMode
  // is on, plain taps toggle). Firing also arms lpFired so the release click
  // does not toggle the card straight back off.
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const lpPos = useRef<{ x: number; y: number } | null>(null);

  const cancelLongPress = () => {
    if (lpTimer.current !== null) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
    lpPos.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    lpFired.current = false;
    if (selectionMode || e.touches.length !== 1) return;
    const t = e.touches[0];
    lpPos.current = { x: t.clientX, y: t.clientY };
    lpTimer.current = window.setTimeout(() => {
      lpTimer.current = null;
      lpPos.current = null;
      lpFired.current = true;
      try {
        navigator.vibrate?.(15);
      } catch {
        // vibrate unsupported — selection still applies
      }
      onToggleSelect();
    }, 550);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const p = lpPos.current;
    if (!p || e.touches.length !== 1) {
      if (lpTimer.current !== null) cancelLongPress();
      return;
    }
    const t = e.touches[0];
    if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > 10) cancelLongPress();
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLButtonElement>(null);

  const menuId = `file-menu-${file.id}`;

  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!menuOpen) {
      const r = dotsRef.current!.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setMenuOpen((o) => !o);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !dotsRef.current?.contains(t)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setMenuOpen(false); dotsRef.current?.focus(); }
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);

  const onPointerDown = (e: React.PointerEvent) => {
    movedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
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

  const onClick = () => {
    // A long-press release must not toggle the card back off.
    if (lpFired.current) {
      lpFired.current = false;
      return;
    }
    if (movedRef.current) return;
    if (selectionMode) onToggleSelect();
    else doOpen();
  };

  const count = file.dataCount ?? file.rowCount ?? 0;
  const cardLabel = `${file.name}, ${count} rows${selected ? ", selected" : ""}`;
  const badge = fileTypeDef(file.type).badge;
  const pw = file.password ?? "dgddigital";
  const isCustom = pw !== "dgddigital" && pw !== "Love@12345";
  const pwLabel = pw === "dgddigital" ? "dgd" : pw === "Love@12345" ? "Love" : pw.slice(0, 8);
  const pwTitle = pw;
  const _presetKind = (file.preset ?? file.poolKind) as string | undefined;
  const isPage = _presetKind === "page" || (!_presetKind && file.name.toLowerCase().startsWith("page"));

  const sq = (bg: string, title: string) => (
    <span title={title} style={{ width: 8, height: 8, borderRadius: 2, background: bg, border: "1px solid var(--border)", flexShrink: 0 }} />
  );
  const indStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11 };

  const inds = [
    <span key="rows" style={indStyle}>{sq("var(--grad-rows)", "rows")}{count}</span>,
    ...(((file.liveCount ?? 0) + (file.deadCount ?? 0) > 0
      ? [<span key="live" style={indStyle}>{sq("var(--grad-live)", "live")}{file.liveCount}</span>]
      : [])),
    ...((isPage && (file.pageCount ?? 0) > 0
      ? [<span key="page" style={indStyle}>{sq("var(--grad-page)", "page eligible")}{file.pageCount}</span>]
      : [])),
    ...(((file.liveCount ?? 0) + (file.deadCount ?? 0) > 0
      ? [<span key="dead" style={indStyle}>{sq("var(--grad-dead)", "dead")}{file.deadCount}</span>]
      : [])),
    ...(((file.dupCount ?? 0) > 0
      ? [<span key="dup" style={indStyle}>{sq("var(--grad-dup)", "duplicates in file")}{file.dupCount}</span>]
      : [])),
    ...((crossDupCount
      ? [<span key="cross" style={indStyle}>{sq("var(--grad-cross)", "cross-file duplicates")}{crossDupCount}</span>]
      : [])),
  ];

  const dt = file.updatedAt ?? file.createdAt ? new Date((file.updatedAt ?? file.createdAt) as number) : null;
  const tsStr = dt ? dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";

  const pwBadge = (
    <span className="file-type-badge" style={{ fontSize: 10, padding: "2px 6px", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pwTitle}>
      {isCustom ? pwLabel : <PasswordIcon password={pw} size={12} />}
    </span>
  );
  const fbBadge = (
    <span className="file-type-badge" title={badge} aria-label={badge} style={{ display: "inline-flex", alignItems: "center" }}><FacebookIcon size={10} /></span>
  );

  return (
    <div
      className={`file-card${selected ? " selected" : ""}${list ? " list-row" : ""}`}
      role="group"
      aria-label={cardLabel}
      tabIndex={0}
      style={{ touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelLongPress}
      onTouchCancel={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menuOpen) { e.stopPropagation(); setMenuOpen(false); dotsRef.current?.focus(); return; }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selectionMode) onToggleSelect();
          else doOpen();
        }
      }}
    >
      {/* A: Icon */}
      <div className="file-card-icon">
        <FileTypeIcon file={file} size={14} />
      </div>

      {/* B: Name + Date + Badges (grid) OR Name + Date (list) */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0, flex: list ? "none" : 1, overflow: "hidden" }}>
        <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
          <div className="file-card-name" dir="auto" style={{ unicodeBidi: "isolate" }}>{file.name}</div>
          {tsStr ? <div style={{ fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", marginTop: 1 }}>{tsStr}</div> : null}
        </div>
        {!list ? (
          <div style={{ display: "flex", gap: 4, flexShrink: 0, marginTop: 1 }}>
            {fbBadge}
            {pwBadge}
          </div>
        ) : null}
      </div>

      {/* C: Indicators + Badges (list) OR Indicators only (grid) */}
      {list ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", flex: 1, minWidth: 0, overflow: "hidden" }}>
            {inds}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {fbBadge}
            {pwBadge}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "center" }}>
          {inds}
        </div>
      )}

      {/* E: More — hidden in multi-select mode (taps toggle selection) */}
      {selectionMode ? null : (
      <div className="file-card-actions">
        <button
          ref={dotsRef}
          className="file-card-btn file-card-more"
          title="More"
          aria-label={`More actions for ${file.name}`}
          aria-haspopup="menu"
          aria-controls={menuId}
          aria-expanded={menuOpen}
          onClick={toggleMenu}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
      )}

      {daysLeft !== undefined ? (
        <span className="file-card-days" title="Days until permanent deletion">{daysLeft}d left</span>
      ) : null}

      {menuOpen ? createPortal(
        <div ref={menuRef} id={menuId} role="menu" aria-label={`Actions for ${file.name}`} style={{ position: "fixed", top: menuPos.top, right: menuPos.right, minWidth: 140, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow-lg)", padding: 4, display: "flex", flexDirection: "column", zIndex: 1000 }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMenuOpen(false); dotsRef.current?.focus(); } }}
        >
          {selectable ? (
              <button type="button" role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onToggleSelect(); }}>
              <span className="home-fab-ic" aria-hidden="true" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Square size={13} aria-hidden="true" /></span>
              {selected ? "Deselect" : "Select"}
            </button>
          ) : null}
          {onRestore ? (
              <button type="button" role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRestore(); }}>
              <span className="home-fab-ic" aria-hidden="true" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><RotateCcw size={13} aria-hidden="true" /></span>
              Restore
            </button>
          ) : null}
          {onDownload ? (
              <button type="button" role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDownload(); }}>
              <span className="home-fab-ic" aria-hidden="true" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Download size={13} aria-hidden="true" /></span>
              Download
            </button>
          ) : null}
          {onRename ? (
              <button type="button" role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRename(); }}>
              <span className="home-fab-ic" aria-hidden="true" style={{ width: 24, height: 24, background: "var(--bg3)", color: "var(--text2)" }}><Pencil size={13} aria-hidden="true" /></span>
              Rename
            </button>
          ) : null}
          <button type="button" role="menuitem" className="home-fab-item" style={{ fontSize: 12, fontWeight: 500, color: "var(--red)" }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}>
            <span className="home-fab-ic" aria-hidden="true" style={{ width: 24, height: 24, background: "var(--red-bg)", color: "var(--red)" }}><Trash2 size={13} aria-hidden="true" /></span>
            {onRestore ? "Delete forever" : "Move to archive"}
          </button>
        </div>,
        document.body
      ) : null}
    </div>
  );
}