// apps/web/src/modules/34-saas/wizard — the panel's persistent status line. A card that reports a result (the connection test passed, the
// BAA was recorded, the clearinghouse is active) often unmounts or swaps its button as the result lands, taking its own message and the
// keyboard focus with it. This line outlives the cards: it is mounted, empty, before any message (so a screen reader hears the change),
// and after a success focus can move to it (tabIndex -1) when the control that had focus is gone.
import { InlineAlert } from "@chartwarden/ui";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

export interface PanelStatus {
  readonly tone: "success" | "error" | "info";
  readonly text: string;
}

export interface PanelStatusControl {
  readonly status: PanelStatus | null;
  readonly regionRef: RefObject<HTMLDivElement>;
  /** Show `next` (null clears it). `focus`: move focus to the line once it has rendered, for when the focused control is going away. */
  readonly announce: (next: PanelStatus | null, focus?: boolean) => void;
}

export function usePanelStatus(): PanelStatusControl {
  const regionRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const announce = useCallback((next: PanelStatus | null, focus = false): void => {
    setStatus(next);
    if (focus) setFocusTick((n) => n + 1);
  }, []);
  useEffect(() => {
    if (focusTick > 0) regionRef.current?.focus();
  }, [focusTick]);
  return { status, regionRef, announce };
}

export function StatusLine({ control }: { control: PanelStatusControl }): JSX.Element {
  const { status, regionRef } = control;
  return (
    <div
      ref={regionRef}
      // biome-ignore lint/a11y/useSemanticElements: an <output> holds phrasing content only, and the message inside is a block <p>
      role="status"
      aria-label="Step status"
      aria-live="polite"
      tabIndex={-1}
      className="wx-row-sub"
    >
      {status ? (
        <InlineAlert tone={status.tone} live={false}>
          {status.text}
        </InlineAlert>
      ) : null}
    </div>
  );
}
