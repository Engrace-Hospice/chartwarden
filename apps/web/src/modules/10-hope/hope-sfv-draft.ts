// apps/web/src/modules/10-hope — what an SFV completion keeps across a step-up round trip.
//
// The step-up window is 300 s but is only checked at submit, so a slow SFV would otherwise lose its answers: the
// dialog stashes what the clinician typed (the shell's in-memory step-up draft, `step-up-redirect.ts`; the same
// stash/restore M13 and M22 use) just before redirecting, and restores it on a genuine return.
import { type StepUpDraftOwner, stepUpDraftKey } from "../../shell/step-up-redirect";
import type { SfvAuthorDiscipline } from "./hope-api";

/** The step-up draft action for an SFV completion; scoped per triggering assessment by `sfvDraftKey`. */
const SFV_DRAFT_ACTION = "hope.sfv.record";
/** Module-level so `useStepUpReturn` sees a stable array. */
export const SFV_DRAFT_ACTIONS: readonly string[] = [SFV_DRAFT_ACTION];

/** What a clinician has typed into the SFV completion dialog. Never the attestation: they re-attest on return. */
export interface SfvDraft {
  readonly date: string;
  readonly discipline: SfvAuthorDiscipline;
  readonly answers: Readonly<Record<string, string>>;
}

/** `org|user|hope.sfv.record|<triggering assessment id>`; null (nothing stashed) when signed out. */
export function sfvDraftKey(owner: StepUpDraftOwner, assessmentId: string): string | null {
  return stepUpDraftKey(owner, SFV_DRAFT_ACTION, assessmentId);
}
