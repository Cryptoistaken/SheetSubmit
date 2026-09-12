import { useEffect, useState } from "react";

export function useNarrow(max = 360) {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : (window.matchMedia?.(`(max-width:${max}px)`)?.matches ?? false));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width:${max}px)`);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    if (mq.addEventListener) { mq.addEventListener("change", onChange); }
    else { mq.addListener(onChange); } // Safari <14 fallback
    return () => {
      if (mq.removeEventListener) { mq.removeEventListener("change", onChange); }
      else { mq.removeListener(onChange); }
    };
  }, [max]);
  return narrow;
}
