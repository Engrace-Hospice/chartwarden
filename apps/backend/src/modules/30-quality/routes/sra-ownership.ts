// apps/backend/src/modules/30-quality/routes/sra-ownership.ts — GAP-156.
//
// §4.7 `ownsSraCycle`: the cycle owner (`opened_by_membership_id`) OR an `sra.admin`-bearing role. The route
// predicate only fires for `:cycleId` paths; finding/remediation routes key on `:findingId`/`:remediationId`,
// so the write service enforces the same rule after loading the row → cycle.
import { ForbiddenError } from "@wardenx/types";
import { type M30WriteActor, isM30SystemActor } from "./actor";

/** Roles that hold `sra.admin` in the system role templates. */
export const SRA_ADMIN_ROLES: readonly string[] = [
  "org_admin",
  "administrator",
  "compliance_officer",
  "hipaa_security_officer",
];

export function assertSraCycleAccess(
  actor: M30WriteActor,
  cycle: { readonly openedByMembershipId: string },
): void {
  if (isM30SystemActor(actor)) return;
  if (cycle.openedByMembershipId === actor.membershipId) return;
  if (actor.roles.some((role) => SRA_ADMIN_ROLES.includes(role))) return;
  throw new ForbiddenError("sra cycle is owned by another member");
}
