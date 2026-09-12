import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function vibrate(ms = 15): void {
  if (typeof navigator !== "undefined") navigator.vibrate?.(ms);
}

// Click sweep: restarts the .sweeping light-bar animation on the tapped element.
export function sweepClick(e: { currentTarget: HTMLElement }): void {
  const el = e.currentTarget;
  el.classList.remove("sweeping");
  void el.offsetWidth;
  el.classList.add("sweeping");
}
