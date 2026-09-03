import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Accessibility behavior for modals: remembers the previously-focused element,
 * focuses the first focusable control on open, traps Tab within the modal,
 * closes on Escape (with stopPropagation so global handlers stay quiet), and
 * restores focus on close. Attach the returned ref to the modal container.
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  containerRef?: RefObject<T | null>,
): RefObject<T | null> {
  const ownRef = useRef<T | null>(null);
  const ref = containerRef ?? ownRef;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    const prevActive = document.activeElement as HTMLElement | null;

    const getFocusable = () => {
      if (!container) return [] as HTMLElement[];
      return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    };

    getFocusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = getFocusable();
      if (!list.length) return;
      const active = document.activeElement as HTMLElement | null;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey) {
        if (active === firstEl || !container?.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (active === lastEl || !container?.contains(active)) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (prevActive && typeof prevActive.focus === "function") prevActive.focus();
    };
  }, [open, ref]);

  return ref;
}