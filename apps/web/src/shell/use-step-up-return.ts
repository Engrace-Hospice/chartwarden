// The two things every screen with a step-up draft needs: who the draft belongs to (org + user, so another user or
// org never sees it) and whether the user is GENUINELY back from the step-up page. An abandoned draft must not pop a
// modal open on a later ordinary visit: it is discarded unless the one-shot return marker names this very path.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSession } from "./session";
import {
  type StepUpDraftOwner,
  clearStepUpReturn,
  discardStepUpDrafts,
  peekStepUpReturn,
} from "./step-up-redirect";

/** Stable per session identity; null when signed out. */
export function useStepUpOwner(): StepUpDraftOwner | null {
  const session = useSession();
  const userId = session?.userId;
  const organizationId = session?.organizationId;
  return useMemo(
    () => (userId && organizationId ? { userId, organizationId } : null),
    [userId, organizationId],
  );
}

/** Fixed at mount: true when the user just completed step-up for this path. Consumes the marker and, when it was
 *  not a genuine return, deletes this owner's stale drafts of `actions` (pass a module-level constant array). */
export function useStepUpReturn(
  owner: StepUpDraftOwner | null,
  actions: readonly string[],
): boolean {
  const { pathname, search } = useLocation();
  const [returning] = useState(() => peekStepUpReturn(`${pathname}${search}`));
  useEffect(() => {
    clearStepUpReturn();
    if (returning) return;
    for (const action of actions) discardStepUpDrafts(owner, action);
  }, [returning, owner, actions]);
  return returning;
}
