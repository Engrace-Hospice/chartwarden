// packages/ui/src/web/hooks — the keyboard behaviour of the off-canvas sidebar below 768px (the `wx-sidebar` / `wx-nav-toggle`
// pair in styles/app-shell.css, used by apps/web and apps/admin).
//
// Opening moves focus to the first link inside the sidebar; Escape closes it; closing hands focus back to the toggle so a keyboard
// user is not dropped at the top of the page. The closed sidebar is `visibility: hidden` (so its links leave the tab order),
// and a hidden element cannot take focus: the first attempt after opening can land before the open class has been styled, so the
// focus call is retried for a few frames until it sticks.
import { type RefObject, useEffect, useRef, useState } from "react";

const FOCUS_ATTEMPTS = 8;
const FOCUS_RETRY_MS = 40;

export interface OffCanvasNav {
  navOpen: boolean;
  setNavOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  /** Attach to the `<aside className="wx-sidebar">`. */
  sidebarRef: RefObject<HTMLElement>;
  /** Attach to the `wx-nav-toggle` button. */
  toggleRef: RefObject<HTMLButtonElement>;
}

export function useOffCanvasNav(): OffCanvasNav {
  const [navOpen, setNavOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!navOpen) {
      if (wasOpen.current) toggleRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function focusFirstLink(): void {
      const sidebar = sidebarRef.current;
      sidebar?.querySelector<HTMLElement>("a")?.focus();
      attempts += 1;
      if (sidebar && !sidebar.contains(document.activeElement) && attempts < FOCUS_ATTEMPTS) {
        timer = setTimeout(focusFirstLink, FOCUS_RETRY_MS);
      }
    }
    timer = setTimeout(focusFirstLink, 0);
    return () => clearTimeout(timer);
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setNavOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  return { navOpen, setNavOpen, sidebarRef, toggleRef };
}
