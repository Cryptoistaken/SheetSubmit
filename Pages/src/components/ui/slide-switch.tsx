import { useEffect, useRef } from "react";

// Two-or-more option segmented control with the ViewSwitch sliding thumb.
export default function SlideSwitch<T extends string>({ options, value, onChange, ariaLabel }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
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
  return (
    <div className="view-switch" role="group" aria-label={ariaLabel} style={{ alignSelf: "flex-start" }}>
      <span className="view-switch-thumb" ref={thumbRef} aria-hidden="true" />
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { btnRefs.current[i] = el; }} type="button" className={value === o.value ? "on" : ""} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
