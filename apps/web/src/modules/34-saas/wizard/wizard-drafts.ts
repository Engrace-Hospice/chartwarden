// apps/web/src/modules/34-saas/wizard — what a form keeps through the step-up round trip (Re-verify), and how it is kept. A draft here can
// hold free text a person typed (an evidence note, a skip reason, a go-live note), so it lives in the shell's scoped store: process
// memory only (never Web Storage), filed under org|user|action|name so only the same person in the same organization can read it back,
// forgotten by sign-out and the idle screen lock (`clearAllDrafts`), dropped after 15 minutes, and restored only on the return from
// the step-up page (the history state the kit's StepUpCard returns with). Never put a secret or a consent tick in one.
import { isStepUpReturn } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSession } from "../../../shell/session";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";

/** The action every wizard draft is filed under. */
export const WIZARD_DRAFT_ACTION = "onboarding-wizard";

/** The scoped key of the draft called `name` for `owner` (null when there is no session: nothing is kept then). */
export const wizardDraftKey = (owner: StepUpDraftOwner, name: string): string | null =>
  stepUpDraftKey(owner, WIZARD_DRAFT_ACTION, name);

/**
 * The draft called `name`: `restored` is what was stashed before the Re-verify (once per mount, only on the return from the step-up
 * page), and `stash` keeps a value for it. The stored draft is dropped on mount, so it never reopens a form on a later visit.
 */
export function useWizardDraft<T>(name: string): {
  readonly restored: T | undefined;
  readonly stash: (value: T) => void;
} {
  const session = useSession();
  const owner = session ? { userId: session.userId, organizationId: session.organizationId } : null;
  const key = wizardDraftKey(owner, name);
  const returned = isStepUpReturn(useLocation().state);
  const [restored] = useState<T | undefined>(() =>
    returned ? (peekStepUpDraft<T>(key) ?? undefined) : undefined,
  );
  useEffect(() => {
    clearStepUpDraft(key);
  }, [key]);
  const stash = useCallback((value: T): void => stashStepUpDraft(key, value), [key]);
  return { restored, stash };
}
