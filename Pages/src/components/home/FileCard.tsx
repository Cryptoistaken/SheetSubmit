import { Download, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

const TwoFaIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 -11 960 876" width={size} height={size} aria-hidden="true" {...props}>
    <path d="M960 427c0 44.7-36.2 80.9-80.9 80.9H600L480 265.2 609.5 40.9C631.9 2.2 681.3-11 720 11.3c38.7 22.4 51.9 71.8 29.6 110.5L620.1 346.1h259c44.7 0 80.9 36.2 80.9 80.9z" fill="currentColor" />
    <path d="M720 842.7c-38.7 22.3-88.1 9.1-110.5-29.6L480 588.8 350.5 813.1c-22.4 38.7-71.8 51.9-110.5 29.6-38.7-22.4-51.9-71.8-29.6-110.5l129.5-224.3 140.1-5.3 140.1 5.3 129.5 224.3c22.3 38.7 9.1 88.1-29.6 110.5z" fill="currentColor" />
    <path d="M480 265.2l-36.5 99.2-103.6-18.3-129.5-224.3c-22.3-38.7-9.1-88.1 29.6-110.5 38.7-22.3 88.1-9.1 110.5 29.6z" fill="currentColor" />
    <path d="M459.1 346.1l-93.9 161.8H80.9C36.2 507.9 0 471.7 0 427s36.2-80.9 80.9-80.9z" fill="currentColor" />
    <path d="M620.1 507.9H339.9L480 265.2z" fill="currentColor" />
  </svg>
);

const PageIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...props}>
    <path fill="currentColor" d="M1.16 16.466c.049 0 .09-.039.098-.093l.27-2.022l-.27-2.069a.103.103 0 0 0-.099-.093c-.05 0-.094.04-.1.093l-.236 2.069l.236 2.021c.006.055.05.094.1.094m-.887-.769c.048 0 .088-.036.095-.09l.209-1.256l-.209-1.28c-.007-.053-.047-.09-.095-.09c-.051 0-.09.037-.098.09L0 14.351l.174 1.256c.008.053.047.09.098.09m1.948-3.8a.12.12 0 0 0-.12-.114a.12.12 0 0 0-.119.114l-.224 2.454l.224 2.364a.12.12 0 0 0 .12.112a.12.12 0 0 0 .12-.113l.254-2.363zm.832 5.026a.143.143 0 0 0 .14-.133l.241-2.439l-.24-2.522a.143.143 0 0 0-.141-.132a.14.14 0 0 0-.14.133l-.213 2.521l.212 2.439a.14.14 0 0 0 .141.133m.958.039a.16.16 0 0 0 .162-.152l.226-2.459l-.226-2.34a.16.16 0 0 0-.162-.151a.16.16 0 0 0-.16.152l-.2 2.34l.2 2.458a.16.16 0 0 0 .16.152m1.36-2.61l-.212-3.805a.184.184 0 0 0-.182-.173a.183.183 0 0 0-.182.173l-.188 3.805l.188 2.458a.183.183 0 0 0 .364 0zm.581 2.635a.2.2 0 0 0 .201-.192v.002l.199-2.444l-.199-4.676a.203.203 0 0 0-.405 0l-.174 4.676l.175 2.443a.2.2 0 0 0 .203.19m.98-7.91a.22.22 0 0 0-.223.212l-.162 5.065l.162 2.418a.22.22 0 0 0 .223.211a.22.22 0 0 0 .223-.211l.185-2.418l-.185-5.065a.22.22 0 0 0-.223-.212m.989 7.911a.24.24 0 0 0 .244-.232v.002l.17-2.404l-.17-5.235a.24.24 0 0 0-.243-.232a.24.24 0 0 0-.243.232l-.153 5.235l.153 2.404c.002.129.11.23.243.23m.997-.002a.26.26 0 0 0 .263-.252v.002l.157-2.381l-.157-5.103a.26.26 0 0 0-.263-.25a.26.26 0 0 0-.264.25l-.138 5.103l.139 2.38c.003.14.119.25.263.25m1.431-2.63l-.142-4.917a.28.28 0 0 0-.284-.27a.28.28 0 0 0-.285.271l-.127 4.916l.127 2.366a.28.28 0 0 0 .285.27a.28.28 0 0 0 .284-.273v.003zm.586 2.64c.165 0 .301-.13.304-.29l.129-2.349l-.129-5.85a.3.3 0 0 0-.304-.291a.303.303 0 0 0-.305.291l-.115 5.848l.115 2.352c.003.158.14.289.305.289m1.009-9.33a.32.32 0 0 0-.327.31l-.133 6.382l.134 2.315a.32.32 0 0 0 .325.308a.32.32 0 0 0 .324-.311v.003l.146-2.315l-.146-6.381a.32.32 0 0 0-.323-.311m.922 9.332l8.182.004C22.678 17 24 15.732 24 14.167c0-1.564-1.322-2.832-2.953-2.832c-.404 0-.79.079-1.142.22C19.673 9.003 17.44 7 14.718 7c-.665 0-1.314.126-1.887.339c-.223.083-.283.168-.285.333v8.989a.35.35 0 0 0 .32.335" />
  </svg>
);

const CookieIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...props}>
    <mask id="cookie-chips"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" fill="#fff" /><g fill="#000"><circle cx="8.5" cy="8.5" r="1.5" /><circle cx="16" cy="15.5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="11" cy="17" r="1.5" /><circle cx="7" cy="14" r="1.5" /></g></mask>
    <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" fill="currentColor" mask="url(#cookie-chips)" />
  </svg>
);

const PasswordIcon = ({ password, size = 16 }: { password: string; size?: number }) => password === "dgddigital" ? (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 12a1 1 0 0 1-10 0 1 1 0 0 0-10 0" />
    <path d="M7 20.7a1 1 0 1 1 5-8.7 1 1 0 1 0 5-8.6" />
    <path d="M7 3.3a1 1 0 1 1 5 8.6 1 1 0 1 0 5 8.6" />
    <circle cx="12" cy="12" r="10" />
  </svg>
) : password === "L0VE@12345" ? (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
  </svg>
) : null;

import { FacebookIcon } from "@/components/icons/FacebookIcon";
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
        <FileIcon size={16} />
      </div>
      <div className="file-card-name">{file.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
        <span className="file-type-badge" title={badge} aria-label={badge} style={{ display: "inline-flex", alignItems: "center" }}><FacebookIcon size={12} /></span>
        <span className="file-type-badge" style={{ ...pwStyle, fontSize: 10, padding: "2px 6px", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={pwTitle}>{isCustom ? pwLabel : <PasswordIcon password={pw} size={14} />}</span>
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
