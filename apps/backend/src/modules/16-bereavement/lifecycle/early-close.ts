// apps/backend/src/modules/16-bereavement/lifecycle/early-close.ts — GAP-047 (D7). The pure guards around
// the two-step early close: close-early records a PENDING request on the plan, and cosign-close — by a
// DIFFERENT supervisor — performs the transition. The requester is never recorded as the cosigner.
import { isClosedPlanStatus } from "@chartwarden/bereavement";
import { ForbiddenError } from "@chartwarden/types";
import { require_ } from "./errors";
import type { BereavementPlanLifecycleState } from "./plan";

/** A close-early request needs an open plan with no request already pending. */
export function assertEarlyCloseRequestable(
  status: BereavementPlanLifecycleState,
  pendingRequestedAt: Date | null,
): void {
  require_(!isClosedPlanStatus(status), "PLAN_CLOSED", `the bereavement plan is ${status}`);
  require_(
    pendingRequestedAt === null,
    "EARLY_CLOSE_ALREADY_REQUESTED",
    "an early close is already awaiting its clinical-supervisor cosign",
  );
}

/** §6.1 (S) — the two signatures on the survey record must be two people. An unknown requester fails closed. */
export function assertCosignerDistinct(
  requestedByUserId: string | null,
  cosignerMembershipId: string,
): void {
  if (requestedByUserId === null || requestedByUserId === cosignerMembershipId) {
    throw new ForbiddenError(
      "the clinical-supervisor cosign must come from someone other than the closing counselor (D7)",
    );
  }
}
