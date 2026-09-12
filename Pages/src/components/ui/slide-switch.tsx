import { useEffect, useRef, type ReactNode } from "react";

// Segmented control with the ViewSwitch sliding thumb. Arrow keys move
// selection (roving focus), Home/End jump to the ends.
export default function SlideSwitch<T extends string>({ options, value, onChange, ariaLabel, stretch = false }: {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  stretch?: boolean;
}) {
  const thumbRef = useRef<HTMLSpanElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const thumb = thumbRef.current;
    const btn = btnRefs.current[i];
    if (thumb && btn) {
      thumb.style.width = btn.offsetWidth + "px";
      thumb.style.left = btn.offsetLeft + "px";
    }
  }, [value, options]);
  const focusBtn = (i: number) => btnRefs.current[i]?.focus();
  const selectAt = (i: number) => {
    const n = options[(i + options.length) % options.length];
    if (!n) return;
    onChange(n.value);
    focusBtn(options.indexOf(n));
  };
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div
      className="view-switch"
      role="group"
      aria-label={ariaLabel}
      style={stretch ? { flex: "1 1 240px", minWidth: 0 } : { alignSelf: "flex-start" }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); selectAt(current + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); selectAt(current - 1); }
        else if (e.key === "Home") { e.preventDefault(); selectAt(0); }
        else if (e.key === "End") { e.preventDefault(); selectAt(options.length - 1); }
      }}
    >
      <span className="view-switch-thumb" ref={thumbRef} aria-hidden="true" />
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { btnRefs.current[i] = el; }} type="button" className={value === o.value ? "on" : ""} aria-pressed={value === o.value} style={stretch ? { flex: 1, minWidth: 0 } : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
