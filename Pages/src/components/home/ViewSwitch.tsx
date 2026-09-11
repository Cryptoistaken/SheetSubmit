import { useEffect, useRef } from "react";

import type { FileViewMode } from "@/stores/viewStore";

export default function ViewSwitch({ view, setViewMode, floating = false }: { view: FileViewMode; setViewMode: (v: FileViewMode) => void; floating?: boolean }) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const thumb = thumbRef.current;
    const btn = btnRefs.current[view === "grid" ? 0 : 1];
    if (thumb && btn) {
      thumb.style.width = btn.offsetWidth + "px";
      thumb.style.left = btn.offsetLeft + "px";
    }
  }, [view]);
  return (
    <div className={floating ? "view-switch view-switch-fab" : "view-switch"} role="group" aria-label="View mode">
      <div className="view-switch-thumb" ref={thumbRef} aria-hidden="true" />
      <button ref={el => { btnRefs.current[0] = el; }} className={view === "grid" ? "on" : ""} aria-label="Grid view" title="Grid view" aria-pressed={view === "grid"} onClick={() => setViewMode("grid")}>
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48Zm-96,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48v48Z"></path></svg>
      </button>
      <button ref={el => { btnRefs.current[1] = el; }} className={view === "list" ? "on" : ""} aria-label="List view" title="List view" aria-pressed={view === "list"} onClick={() => setViewMode("list")}>
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z"></path></svg>
      </button>
    </div>
  );
}
