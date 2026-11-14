export type NoeExceptionDecision = "approved" | "denied";
export type NoeExceptionStatus = "draft" | "evidence_required" | "ready_for_external_request" | "request_recorded" | "awaiting_external_determination" | "external_approved_recorded" | "external_denied_recorded" | "withdrawn";

/** Presence of attached protected documents is a workflow prerequisite, never an eligibility/approval decision. */
export function initialNoeExceptionReviewStatus(hasActiveProtectedEvidence: boolean): NoeExceptionStatus {
  return hasActiveProtectedEvidence ? "ready_for_external_request" : "evidence_required";
}

/** Local recording keeps the external outcome explicit without claiming independent verification by WardenX. */
export function recordedExternalDecisionStatus(decision: NoeExceptionDecision): NoeExceptionStatus {
  return decision === "approved" ? "external_approved_recorded" : "external_denied_recorded";
}
