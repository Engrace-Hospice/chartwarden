// apps/backend/src/critical-lab-wiring.ts -- #908/#910: the ONE place the critical-lab page ports and the
// no-order escalation callback are built, shared by the composition root (index.ts) and the worker-level live test, so
// the test runs the same deps-builder the boot uses and not a hand-built escalator.
import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import type { CareTeamProvider } from "@chartwarden/types";
import type { QuarantinedCritical } from "./modules/11-orders/critical-lab-result";
import { createCriticalLabLookup } from "./modules/11-orders/critical-lab-result";
import {
  createDrizzleMembershipUserLookup,
  createDrizzleRoleSetMembersReader,
} from "./modules/36-messaging/alert-emitter-drizzle";
import {
  type CriticalLabDeps,
  buildCriticalLabEscalator,
} from "./modules/36-messaging/outbox-consumers/critical-lab-alerts";

export interface CriticalLabSeams {
  readonly alerts: AlertEmitter;
  readonly careTeam: Pick<CareTeamProvider, "primaryRnUserId" | "attendingUserId">;
}

/** The ports M36's critical-lab alert reads: M11's ledger, the care-team seam, membership -> user, role holders. */
export function buildCriticalLabDeps(
  db: DbClient,
  seams: CriticalLabSeams,
  warn: (message: string, context: Record<string, string>) => void,
): CriticalLabDeps {
  return {
    alerts: seams.alerts,
    careTeam: seams.careTeam,
    lookup: createCriticalLabLookup(db),
    membershipUserId: createDrizzleMembershipUserLookup(db),
    roleHolders: createDrizzleRoleSetMembersReader(db),
    warn,
  };
}

/** The escalation callback the 5-minute worker runs for one lapsed quarantined critical. */
export function buildCriticalLabEscalate(
  deps: CriticalLabDeps,
): (organizationId: string, row: QuarantinedCritical) => Promise<void> {
  const escalator = buildCriticalLabEscalator(deps);
  return (organizationId, row) =>
    escalator(organizationId, {
      ...row,
      orderId: null,
      orderUnsigned: false,
      drafterMembershipId: null,
    });
}
