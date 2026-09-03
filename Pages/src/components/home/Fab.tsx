import { Cookie, FileText, KeyRound, Plus, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

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
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

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
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={24} strokeWidth={3} />
      </button>
      <div ref={menuRef} className={`home-fab-menu${open ? " open" : ""}`}>
        <div className="home-fab-platform">Facebook</div>
        {([
          ["cookie", "Cookie", "cookies and uid", Cookie],
          ["combo", "2fa", "cookies and 2fa and uid", KeyRound],
          ["page", "Page", "full columns", FileText],
        ] as const).map(([preset, name, desc, Icon]) => (
          <button className="home-fab-item home-fab-subitem" key={preset} onClick={() => { setOpen(false); onCreate(preset); }}>
            <span className="home-fab-ic t-fb"><Icon size={15} /></span>
            <span>
              <span className="home-fab-name">{name}</span>
              <span className="home-fab-desc">{desc}</span>
            </span>
          </button>
        ))}
        <div className="home-fab-sep"></div>
        <button className="home-fab-item" onClick={handleUploadClick}>
          <span className="home-fab-ic" style={{ background: "var(--bg3)", color: "var(--text2)" }}>
            <Upload size={15} />
          </span>
          <span>
            <span className="home-fab-name">Upload xlsx</span>
            <span className="home-fab-desc">Import data from a spreadsheet</span>
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
