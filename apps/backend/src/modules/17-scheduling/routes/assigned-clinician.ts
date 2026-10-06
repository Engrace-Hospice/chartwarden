// GAP-050 — the assigned-clinician check on the visit start / arrive self-attest routes. `actorMembershipId`
// is the server-derived acting membership (never a body or header value). Shared by the route predicate
// and both service implementations so the rule is enforced at every layer and cannot drift.
import { ForbiddenError } from "@wardenx/types";

export const ASSIGNED_CLINICIAN_REQUIRED = "ASSIGNED_CLINICIAN_REQUIRED";

/** Fail-closed: only the clinician the visit is assigned to may self-attest its start / arrival. */
export function assertAssignedClinician(
  assignedMembershipId: string | null | undefined,
  actorMembershipId: string,
): void {
  if (!assignedMembershipId || !actorMembershipId || assignedMembershipId !== actorMembershipId) {
    throw new ForbiddenError(ASSIGNED_CLINICIAN_REQUIRED);
  }
}
