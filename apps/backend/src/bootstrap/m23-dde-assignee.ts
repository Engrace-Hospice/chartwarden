import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { ActorEnrichmentReader } from "@wardenx/types";
import { sql } from "drizzle-orm";

/** The DDE work permission an assignee must hold (ADR-0052). */
export const DDE_WORK_PERMISSION = "billing.dde.work";

/**
 * Can this membership be assigned a DDE item of this provider entity? (ADR-0052, review M6). Three facts, none of which
 * M23 owns, answered here in the composition root:
 *   1. M3: the membership holds `billing.dde.work` through an enabled, unexpired role (`holders`);
 *   2. M2: the membership is ACTIVE in this organization (`membership.status`, a suspended or revoked membership with a
 *      lingering role row is NOT assignable);
 *   3. reach: the membership's effective provider-entity reach (default entity narrowed by its live role grants'
 *      `scope`, via the same `ActorEnrichmentReader` that stamps the request context) covers the item's provider
 *      entity, or the actor holds an org-wide billing role. This is the predicate the item's own routes enforce, so an
 *      assignee can always open what they were given.
 */
export function buildDdeAssigneeEligibility(
  db: DbClient,
  holders: (
    organizationId: string,
    permissionKeys: readonly string[],
  ) => Promise<ReadonlySet<string>>,
  enrichment: ActorEnrichmentReader,
  orgWideRoles: readonly string[],
) {
  return async (
    organizationId: string,
    membershipId: string,
    providerEntityId: string,
  ): Promise<boolean> => {
    if (!(await holders(organizationId, [DDE_WORK_PERMISSION])).has(membershipId)) return false;
    const userId = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const res = await tx.execute(sql`
        SELECT m.user_id::text AS user_id
          FROM membership m
         WHERE m.organization_id = ${organizationId}
           AND m.id = ${membershipId}::uuid
           AND m.status = 'active'`);
      const row = (res as unknown as { rows?: Array<{ user_id?: string }> }).rows?.[0];
      return row?.user_id ?? null;
    });
    if (!userId) return false;
    const actor = await enrichment.read({ orgId: organizationId }, userId);
    if (!actor || actor.membershipId !== membershipId) return false;
    return (
      actor.roles.some((r) => orgWideRoles.includes(r)) ||
      actor.providerEntityIds.includes(providerEntityId)
    );
  };
}
