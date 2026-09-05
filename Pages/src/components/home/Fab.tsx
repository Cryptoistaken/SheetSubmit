import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { FacebookIcon } from "@/components/icons/FacebookIcon";
import { CookieIcon, Doc2xIcon, PageIcon, TwoFaIcon } from "@/components/icons/FileTypeIcons";
import type { FilePreset } from "@/lib/types";

interface FabProps {
  onCreate: (preset: FilePreset) => void;
  onUpload: (file: File) => void;
}

export default function Fab({ onCreate, onUpload }: FabProps) {
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuId = "fab-menu";

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(t) &&
        fabRef.current &&
        !fabRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!open) return;
      setOpen(false);
      fabRef.current?.focus();
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const handleUploadClick = () => {
    setOpen(false);
    fileRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) onUpload(file);
  };

  return (
    <>
      <button
        ref={fabRef}
        className="home-fab"
        aria-label="Create file"
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}
      >
        <span aria-hidden="true"><Doc2xIcon size={24} /></span>
      </button>
      <div ref={menuRef} id={menuId} role="menu" aria-label="Create file options" aria-hidden={!open} className={`home-fab-menu${open ? " open" : ""}`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); fabRef.current?.focus(); } }}>
        <div className="home-fab-platform" style={{ display: "flex", alignItems: "center", gap: 6 }} aria-hidden="true"><FacebookIcon size={13} aria-hidden="true" />Facebook</div>
        {([
          ["cookie", "Cookie", "cookies and uid", CookieIcon],
          ["combo", "2fa", "cookies and 2fa and uid", TwoFaIcon],
          ["page", "Page", "full columns", PageIcon],
        ] as const).map(([preset, name, desc, Icon]) => (
          <button role="menuitem" className="home-fab-item home-fab-subitem" key={preset} onClick={() => { setOpen(false); onCreate(preset); }}>
            <span className="home-fab-ic" aria-hidden="true" style={{ background: "var(--bg3)", color: "var(--text)" }}><Icon size={15} aria-hidden="true" /></span>
            <span>
              <span className="home-fab-name">{name}</span>
              <span className="home-fab-desc">{desc}</span>
            </span>
          </button>
        ))}
        <div className="home-fab-sep" role="separator" aria-hidden="true"></div>
        <button role="menuitem" className="home-fab-item" onClick={handleUploadClick}>
          <span className="home-fab-ic" aria-hidden="true" style={{ background: "var(--bg3)", color: "var(--text2)" }}>
            <Upload size={15} aria-hidden="true" />
          </span>
          <span>
            <span className="home-fab-name">Upload xlsx</span>
            <span className="home-fab-desc">Import data from file</span>
          </span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </>
  );
}
