import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { FacebookIcon } from "@/components/icons/FacebookIcon";
import type { FilePreset } from "@/lib/types";

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

const Doc2xIcon = ({ size = 24, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <title>doc2x</title>
    <path fill="#7748f9" d="M21.66 7.017a3.308 3.308 0 1 0-4.677-4.678l-3.458 3.458a3.308 3.308 0 1 0 4.678 4.677l3.458-3.457zM10.475 18.203a3.308 3.308 0 1 0-4.678-4.678l-3.458 3.458a3.308 3.308 0 1 0 4.678 4.677z" />
    <path fill="#bfabfb" d="M18.203 13.525a3.308 3.308 0 1 0-4.678 4.678l3.458 3.458a3.308 3.308 0 0 0 4.678-4.678zM7.017 2.339a3.308 3.308 0 1 0-4.678 4.678l3.458 3.457a3.308 3.308 0 0 0 4.677-4.678z" />
  </svg>
);

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
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Doc2xIcon size={24} />
      </button>
      <div ref={menuRef} className={`home-fab-menu${open ? " open" : ""}`}>
        <div className="home-fab-platform" style={{ display: "flex", alignItems: "center", gap: 6 }}><FacebookIcon size={13} />Facebook</div>
        {([
          ["cookie", "Cookie", "cookies and uid", CookieIcon],
          ["combo", "2fa", "cookies and 2fa and uid", TwoFaIcon],
          ["page", "Page", "full columns", PageIcon],
        ] as const).map(([preset, name, desc, Icon]) => (
          <button className="home-fab-item home-fab-subitem" key={preset} onClick={() => { setOpen(false); onCreate(preset); }}>
            <span className="home-fab-ic" style={{ background: "var(--bg3)", color: "var(--text)" }}><Icon size={15} /></span>
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
