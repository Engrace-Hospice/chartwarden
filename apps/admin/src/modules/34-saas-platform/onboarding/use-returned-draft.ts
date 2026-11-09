// apps/admin/src/modules/34-saas-platform/onboarding — a draft stashed before a Re-verify is restored ONLY on the return from it.
// Leaving for /step-up and pressing Back is an abandoned step-up, not a return: the draft it stashed is dropped by the next mount
// (these hooks still consume it) and never reopens a form, a dialog or a stale pin on a later, unrelated visit to the step. The return
// is the history state `StepUpCard` navigates back with, read once at mount (as the clearinghouse card does).
import { isStepUpReturn, useStepUpDraft, useStepUpMemoryDraft } from "@chartwarden/ui";
import { useState } from "react";
import { useLocation } from "react-router-dom";

/** Whether this screen mounted on the return from a successful step-up. */
export function useReturnedFromStepUp(): boolean {
  const location = useLocation();
  const [returned] = useState(() => isStepUpReturn(location.state));
  return returned;
}

/**
 * `useStepUpDraft` (sessionStorage), handed back only on the return from step-up. The draft is consumed either way. A screen that mounts
 * after its parent already cleared the history marker (the hub's clearinghouse card does) passes what the parent read as `returned`.
 */
export function useReturnedDraft<T>(key: string, returned?: boolean): T | undefined {
  const fromLocation = useReturnedFromStepUp();
  const draft = useStepUpDraft<T>(key);
  return (returned ?? fromLocation) ? draft : undefined;
}

/** `useStepUpMemoryDraft` (free text, memory only), handed back only on the return from step-up. The draft is consumed either way. */
export function useReturnedMemoryDraft<T>(key: string): T | undefined {
  const returned = useReturnedFromStepUp();
  const draft = useStepUpMemoryDraft<T>(key);
  return returned ? draft : undefined;
}
