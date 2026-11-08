// apps/admin/src/modules/34-saas-platform/onboarding — keyboard focus for the panels' inline editors. When an editor opens, focus moves
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
