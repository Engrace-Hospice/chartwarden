// apps/web/src/modules/08-encounters/review — move focus to a workspace anchor once the screen has committed what it names. A screen that
// replaces itself by a spinner while it reads the note again (the composer, after a finalize) loses focus with the nodes it removed; asking
// from an event handler would land on the old panel, so the request waits for `ready` and the commit after it.
import { useCallback, useEffect, useState } from "react";
import { jumpToAnchor } from "../workspace/jump-to-anchor";

/** `request()` takes focus to the element with `anchorId` as soon as `ready` is true (at once when it already is, after the next commit). */
export function useAnchorFocus(anchorId: string, ready: boolean): () => void {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending || !ready) return;
    setPending(false);
    jumpToAnchor(anchorId);
  }, [pending, ready, anchorId]);
  return useCallback(() => setPending(true), []);
}
