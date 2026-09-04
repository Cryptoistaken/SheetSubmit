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
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>ollama</title>
    <path fill="currentColor" d="M17.94 125.975c-1.328-4.78-.267-14.335 2.11-18.992c1.062-2.084 1.062-2.084-.519-5.002c-4.036-7.453-4.31-18.279-.692-27.318c1.37-3.424 1.37-3.424.003-5.959c-5.619-10.41-3.848-22.86 4.502-31.66c3.62-3.815 3.62-3.815 3.176-6.515c-1.438-8.734.373-20.617 3.943-25.87c6.444-9.484 16.241-3.814 18.853 10.91c.353 1.99.704 3.704.78 3.807s1.778-.468 3.78-1.269c7.248-2.9 14.003-2.8 20.681.304c1.9.884 3.495 1.542 3.542 1.462c.048-.08.368-1.863.711-3.964C81.25 1 91.191-4.921 97.7 4.659c3.573 5.258 5.387 17.18 3.937 25.87c-.451 2.7-.451 2.7 2.894 6.21c8.381 8.793 10.265 21.377 4.73 31.595c-1.49 2.753-1.49 2.753-.197 5.694c3.853 8.763 3.673 20.372-.432 27.953c-1.581 2.918-1.581 2.918-.518 5.002c2.376 4.657 3.437 14.211 2.11 18.992c-.563 2.025-.563 2.025-4.115 2.025s-3.552 0-3.08-1.755c1.276-4.736.571-12.311-1.56-16.796c-2.466-5.184-2.465-5.131-.1-8.964c4.587-7.43 4.684-17.018.26-25.616c-2.064-4.01-2.05-4.469.254-7.891c8.675-12.891.254-30.435-14.981-31.21c-4.72-.24-4.72-.24-5.883-2.569c-6.442-12.9-25.928-13.5-33.46-1.031c-1.945 3.221-1.945 3.221-6.482 3.517C25.41 36.71 16.086 57.975 26.865 68.1c1.712 1.609 1.648 2.924-.33 6.769c-4.425 8.598-4.328 18.186.258 25.616c2.366 3.833 2.366 3.78-.098 8.964c-2.133 4.485-2.837 12.06-1.561 16.796c.472 1.755.472 1.755-3.08 1.755s-3.552 0-4.115-2.025zm20.79-97.129c4.504-.46 4.821-.985 4.378-7.23c-.634-8.923-3.835-15.995-6.251-13.808c-3.296 2.982-5.556 22.898-2.465 21.711c.447-.171 2.4-.474 4.338-.673m56.11-5.926c-.04-10.714-3.021-18.058-5.95-14.654c-2.634 3.062-5.13 16.32-3.592 19.072c.521.932 7.096 2.471 9.024 2.112c.325-.06.53-2.652.517-6.53zM56.213 83.552c-19.558-5.52-13.155-29.651 7.868-29.651c18.95 0 27.119 20.158 11.417 28.175c-4.221 2.156-14.179 2.918-19.285 1.476M73.087 78.2c11.73-5.37 5.16-19.86-9.006-19.86c-16.164 0-20.925 17.235-5.813 21.047c3.772.951 11.5.332 14.82-1.187zm-10.896-6.23c0-1.564-.343-2.395-1.35-3.27c-2.518-2.19-1.387-3.196 3.51-3.123c3.993.058 5.126 1.477 2.596 3.25c-.922.647-1.246 1.397-1.246 2.888c0 1.877-.119 2.025-1.755 2.183c-1.707.164-1.755.112-1.755-1.928m-26.214-9.017c-1.516-1.516-1.687-3.43-.51-5.706c2.28-4.409 8.364-3.014 8.364 1.918c0 4.24-4.994 6.648-7.854 3.788M85.91 62.7c-2.063-2.063-2.168-4.901-.253-6.816c2.224-2.224 5.513-1.587 7.04 1.363c2.651 5.13-2.761 9.478-6.787 5.453" />
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
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
    <title>lovable</title>
    <ellipse cx="52.738" cy="65.101" fill="#4b73ff" filter="url(#SVGisokdbCk)" mask="url(#SVGV7e6deGe)" rx="81.373" ry="81.192" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="61.673" cy="20.547" fill="#ff66f4" filter="url(#SVGaTNKjcdw)" mask="url(#SVGV7e6deGe)" rx="104.216" ry="81.192" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="78.666" cy="5.268" fill="#ff0105" filter="url(#SVGPdo8IVtS)" mask="url(#SVGV7e6deGe)" rx="81.373" ry="71.304" transform="translate(.92)scale(1.04949)" />
    <ellipse cx="63.121" cy="20.527" fill="#fe7b02" filter="url(#SVG4UcRldRB)" mask="url(#SVGV7e6deGe)" rx="48.937" ry="48.829" transform="translate(.92)scale(1.04949)" />
    <defs>
      <linearGradient id="SVGV7PGSdya" x1="40.453" x2="76.933" y1="21.433" y2="121.971" gradientTransform="translate(.92)scale(1.04949)" gradientUnits="userSpaceOnUse">
        <stop offset=".025" stopColor="#ff8e63" />
        <stop offset=".56" stopColor="#ff7eb0" />
        <stop offset=".95" stopColor="#4b73ff" />
      </linearGradient>
      <linearGradient id="SVGvgqzodPu" x1="40.453" x2="76.933" y1="21.433" y2="121.971" gradientTransform="translate(.92)scale(1.04949)" gradientUnits="userSpaceOnUse" href="#SVGV7PGSdya" />
      <filter id="SVGisokdbCk" width="235.52" height="235.159" x="-65.022" y="-52.478" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_572_319" stdDeviation="18.194" />
      </filter>
      <filter id="SVGaTNKjcdw" width="281.208" height="235.159" x="-78.93" y="-97.032" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_572_319" stdDeviation="18.194" />
      </filter>
      <filter id="SVGPdo8IVtS" width="235.52" height="215.383" x="-39.094" y="-102.423" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_572_319" stdDeviation="18.194" />
      </filter>
      <filter id="SVG4UcRldRB" width="170.649" height="170.432" x="-22.204" y="-64.688" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_572_319" stdDeviation="18.194" />
      </filter>
      <mask id="SVGV7e6deGe" maskUnits="userSpaceOnUse">
        <path fill="url(#SVGvgqzodPu)" fillRule="evenodd" strokeWidth="1.049" d="M38.774 0C59.68 0 76.628 16.955 76.628 37.87v14.392h12.598c20.905 0 37.854 16.955 37.854 37.87c0 20.913-16.949 37.868-37.854 37.868H.92V37.87C.92 16.954 17.868 0 38.774 0" clipRule="evenodd" transform="translate(-.877)scale(.95284)" />
      </mask>
    </defs>
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
