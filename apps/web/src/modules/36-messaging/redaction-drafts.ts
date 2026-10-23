// M36 WP 5.6 - what the Redactions tab stashes across the /step-up round trip. A decision (approve, self-approve, countersign) carries no typed
// input, so the stash only remembers WHICH redaction the officer was deciding; the dialog reopens on return and asks again (a decision is never
// replayed automatically). Keys are scoped to org + user + action + record by the shared helper.
import {
  type StepUpDraftOwner,
  findStepUpDraftResourceId,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import type { DecisionKind } from "./use-redactions";

export const DECISION_ACTION: Readonly<Record<DecisionKind, string>> = {
  approve: "messaging.redact.approve",
  self_approve: "messaging.redact.self_approve",
  countersign: "messaging.redact.countersign",
};
export const REDACTION_ACTIONS: readonly string[] = Object.values(DECISION_ACTION);

export interface RedactionResume {
  readonly kind: DecisionKind;
  readonly redactionId: string;
}

export const decisionDraftKey = (
  owner: StepUpDraftOwner,
  kind: DecisionKind,
  redactionId: string,
): string | null => stepUpDraftKey(owner, DECISION_ACTION[kind], redactionId);

/** The decision (if any) this owner was in the middle of. Call once, from a state initialiser. */
export function readRedactionResume(owner: StepUpDraftOwner): RedactionResume | null {
  for (const kind of Object.keys(DECISION_ACTION) as DecisionKind[]) {
    const redactionId = findStepUpDraftResourceId(owner, DECISION_ACTION[kind]);
    if (redactionId) return { kind, redactionId };
  }
  return null;
}
