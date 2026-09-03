export function detectTouch(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(pointer: coarse)").matches) return true;
  return (
    "ontouchstart" in window &&
    !window.matchMedia?.("(pointer: fine)").matches
  );
}
export const IS_TOUCH = detectTouch();
export const IS_DESKTOP = !IS_TOUCH;
