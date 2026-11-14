// apps/web/src/modules/34-saas/wizard — what a billing panel keeps through a Re-verify: the form's NON-secret fields, in the shell's
// owner-scoped step-up store (`org|user|action|resource`), so sign-out, the idle lock and a session that expires wipe it with every other
// draft (clearAllDrafts), and another user on the same tab never sees it. In process memory only, never Web Storage. A write-only
// secret (a vendor credential, a client secret) is never stashed at all.
import { useEffect, useState } from "react";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../../shell/use-step-up-return";

/** The `action` part of each draft key: one per form that survives a Re-verify. */
export const DRAFT_ACTIONS = {
  clearinghouseChoice: "tenant-clearinghouse-choice",
  clearinghouseBaa: "tenant-clearinghouse-baa",
  clearinghouseVerify: "tenant-clearinghouse-verify",
  macCredential: "tenant-mac-credential",
} as const;
const ALL_ACTIONS: readonly string[] = Object.values(DRAFT_ACTIONS);

export interface DraftScope {
  readonly owner: StepUpDraftOwner | null;
  /** True when the member just completed a step-up for THIS path: the only visit a stashed draft is restored on. */
  readonly returning: boolean;
}

/**
 * Who the drafts belong to, and whether this visit is the return from a Re-verify. Call it ONCE per panel (it consumes the one-shot
 * return marker) and hand the result to the panel's forms; a visit that is not a return drops this owner's stale drafts.
 */
export function useDraftScope(): DraftScope {
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, ALL_ACTIONS);
  return { owner, returning };
}

/** The scope key of one form's draft for `stepKey`; null when nobody is signed in (nothing is stashed then). */
export const draftKeyFor = (scope: DraftScope, action: string, stepKey: string): string | null =>
  stepUpDraftKey(scope.owner, action, stepKey);

/** The draft stashed before the Re-verify, restored once per mount and only on the return from it; dropped from the store either way. */
export function useRestoredDraft<T>(key: string | null, returning: boolean): T | undefined {
  const [restored] = useState(() =>
    returning ? (peekStepUpDraft<T>(key) ?? undefined) : undefined,
  );
  useEffect(() => {
    clearStepUpDraft(key);
  }, [key]);
  return restored;
}

/** Keep `value` for the return from Re-verify. Never a secret. */
export const stashDraft = (key: string | null, value: unknown): void =>
  stashStepUpDraft(key, value);
