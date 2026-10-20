// M36 WP 5.6 - what the Legal holds tab stashes across the /step-up round trip. Keys are scoped to org + user + action +
// record by the shared helper, so a draft is never visible to another user or organization.
import {
  type StepUpDraftOwner,
  findStepUpDraftResourceId,
  peekStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";

export const APPLY_ACTION = "messaging.legal_hold.apply";
export const RELEASE_ACTION = "messaging.legal_hold.release";
export const HOLD_ACTIONS: readonly string[] = [APPLY_ACTION, RELEASE_ACTION];
const NEW_HOLD = "new";

export interface CreateDraft {
  readonly name: string;
  readonly reason: string;
  readonly orgWide: boolean;
  readonly channels: string;
  readonly users: string;
  readonly patients: string;
}
export interface ReleaseDraft {
  readonly holdId: string;
  readonly reason: string;
}
export interface HoldResume {
  readonly create: CreateDraft | null;
  readonly release: ReleaseDraft | null;
}
export const NO_RESUME: HoldResume = { create: null, release: null };

export const createDraftKey = (owner: StepUpDraftOwner): string | null =>
  stepUpDraftKey(owner, APPLY_ACTION, NEW_HOLD);
export const releaseDraftKey = (owner: StepUpDraftOwner, holdId: string): string | null =>
  stepUpDraftKey(owner, RELEASE_ACTION, holdId);

const isCreateDraft = (v: unknown): v is CreateDraft => {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.name === "string" &&
    typeof d.reason === "string" &&
    typeof d.orgWide === "boolean" &&
    typeof d.channels === "string" &&
    typeof d.users === "string" &&
    typeof d.patients === "string"
  );
};

/** Read (never clear) this owner's pending drafts. Call once, from a state initialiser. */
export function readResume(owner: StepUpDraftOwner): HoldResume {
  const peeked = peekStepUpDraft<unknown>(createDraftKey(owner));
  const create = isCreateDraft(peeked) ? peeked : null;
  const holdId = findStepUpDraftResourceId(owner, RELEASE_ACTION);
  const stored = holdId
    ? peekStepUpDraft<{ reason?: unknown }>(releaseDraftKey(owner, holdId))
    : null;
  const release =
    holdId && typeof stored?.reason === "string" ? { holdId, reason: stored.reason } : null;
  return { create, release };
}
