// @chartwarden/ui web — the horizontally scrolling frame of a list table (`.wx-list-table-wrap`).
// A scroll container with nothing focusable inside cannot be scrolled from the keyboard (WCAG 2.1.1), and not every browser makes
// one focusable by itself. When the frame actually overflows AND holds no focusable content, it becomes a focusable, named
// region (the table's caption is its name); a table with focusable rows or controls already has a tab stop and gets no extra one.
import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const FOCUSABLE =
  "a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function TableScroll({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [needsStop, setNeedsStop] = useState(false);
  const [name, setName] = useState<string | undefined>();

  const measure = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    setNeedsStop(el.scrollWidth > el.clientWidth && el.querySelector(FOCUSABLE) === null);
    setName(el.querySelector("caption")?.textContent?.trim() || undefined);
  }, []);

  // Every render (the rows may have changed), and whenever the frame is resized.
  useEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={ref}
      className="wx-list-table-wrap"
      tabIndex={needsStop ? 0 : undefined}
      role={needsStop && name ? "region" : undefined}
      aria-label={needsStop ? name : undefined}
    >
      {children}
    </div>
  );
}
