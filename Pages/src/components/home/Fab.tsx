import { Plus, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { FILE_TYPE_DEFS } from "@/lib/types";
import type { FileType } from "@/lib/types";

interface FabProps {
  onCreate: (type: FileType) => void;
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

  const fb = FILE_TYPE_DEFS.fb_cookie;

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
        <button
          className="home-fab-item"
          onClick={() => {
            setOpen(false);
            onCreate("fb_cookie");
          }}
        >
          <span className="home-fab-ic t-fb">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
              <path d="M8.5 8.5v.01" />
              <path d="M16 15.5v.01" />
              <path d="M12 12v.01" />
              <path d="M11 17v.01" />
              <path d="M7 14v.01" />
            </svg>
          </span>
          <span>
            <span className="home-fab-name">{fb.label}</span>
            <span className="home-fab-desc">{fb.desc}</span>
          </span>
        </button>
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
