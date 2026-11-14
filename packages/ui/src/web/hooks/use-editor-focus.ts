// packages/ui/src/web/hooks — keyboard focus for a wizard panel's inline editor. When an editor opens, focus moves
// to its heading (give it tabIndex={-1}); when it closes (Save or Cancel), focus goes back to the control that opened it. A trigger
// that unmounted while the editor was open (an "Add" button the panel hides) is found again by its `data-editor-return` name.
import { type RefObject, useEffect, useRef } from "react";

export function useEditorFocus(open: boolean, returnName: string): RefObject<HTMLHeadingElement> {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
      headingRef.current?.focus();
    } else if (!open && wasOpen.current) {
      const previous = trigger.current;
      trigger.current = null;
      const target = previous?.isConnected
        ? previous
        : document.querySelector<HTMLElement>(`[data-editor-return="${returnName}"]`);
      target?.focus();
    }
    wasOpen.current = open;
  }, [open, returnName]);
  return headingRef;
}

/**
 * After a reload removed the control the editor opened from (the first credential is saved: the "Add" button goes), puts focus on the
 * control now carrying that name (its "Replace"). It never takes focus from a control the operator has since moved to.
 */
export function refocusEditorReturn(returnName: string): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
  document.querySelector<HTMLElement>(`[data-editor-return="${returnName}"]`)?.focus();
}
