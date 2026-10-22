import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

// One persistent polite live region. Re-mounting it (a changing `key`) is not a reliable way to re-announce: screen
// readers watch an existing region for text changes. So the text is cleared, then set on a later tick, which makes an
// identical consecutive message ("1 new message" twice) a fresh change that is announced again.
const SET_DELAY_MS = 50;

export interface LiveAnnouncement {
  /** Render this once, always mounted. */
  readonly region: ReactElement;
  readonly announce: (message: string) => void;
  readonly clear: () => void;
}

export function useLiveAnnouncement(): LiveAnnouncement {
  const [text, setText] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setText("");
  }, []);
  const announce = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setText("");
    timer.current = window.setTimeout(() => setText(message), SET_DELAY_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const region = (
    <output className="wx-sr-only" aria-live="polite">
      {text}
    </output>
  );
  return { region, announce, clear };
}
