// apps/web/src/modules/21-supplies — only the NEWEST read may write screen state.
//
// A filter keystroke fires a read per change and replies can land out of order: an older filter's rows would show under
// the newer filter, and the older call's `loading` / error writes would overwrite the newer call's. Each read takes a
// ticket from `startRead()`; the ticket's `isLatest()` is checked after every await, and a stale read writes nothing.
import { useCallback, useRef } from "react";

export function useLatestRead(): () => () => boolean {
  const newest = useRef(0);
  return useCallback(() => {
    newest.current += 1;
    const mine = newest.current;
    return () => mine === newest.current;
  }, []);
}
