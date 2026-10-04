// apps/backend/src/modules/32-ai-platform/seams/actor-resolver-drizzle.ts — the real `AiSeamActorResolver`
// (F-236).
//
// `ai_invocation` needs a membership, a role and (NOT NULL, ARCH-011) the certified provider entity that
// disclosed the PHI. The denying resolver refused every seam call because "nothing on the platform maps a
// user to a provider entity". Something does: `membership.default_provider_entity_id` (+
// `default_location_ids`), the same siting the M2 authenticate hook feeds into `context.providerEntityIds`.
//
// Fail-closed exactly where the denying resolver was: no ACTIVE membership for (org, user), or a
// membership with no default provider entity ⇒ `null` ⇒ the seam refuses. It never picks "some" entity of
// the org — a §164.528 accounting naming the wrong certified provider is worse than none. `actorUserId:
// null` (the ambient-context arm the M19 pair uses) is not resolved here: refuse.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq } from "drizzle-orm";
import type { AiSeamActorContext, AiSeamActorResolver } from "./published";

const M = schema.memberships;
const MR = schema.membershipRoles;
const R = schema.roles;

export function createDrizzleAiSeamActorResolver(db: DbClient): AiSeamActorResolver {
  return {
    async resolve(organizationId, actorUserId): Promise<AiSeamActorContext | null> {
      if (actorUserId === null) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [m] = await tx
          .select({
            id: M.id,
            providerEntityId: M.defaultProviderEntityId,
            locationIds: M.defaultLocationIds,
          })
          .from(M)
          .where(
            and(
              eq(M.organizationId, organizationId),
              eq(M.userId, actorUserId),
              eq(M.status, "active"),
            ),
          )
          .limit(1);
        if (!m || !m.providerEntityId) return null;
        const [role] = await tx
          .select({ key: R.key })
          .from(MR)
          .innerJoin(R, eq(R.id, MR.roleId))
          .where(eq(MR.membershipId, m.id))
          .orderBy(asc(R.key))
          .limit(1);
        if (!role) return null; // a membership with no role has no `actor_role` to record
        const locations = Array.isArray(m.locationIds) ? (m.locationIds as unknown[]) : [];
        const locationId = typeof locations[0] === "string" ? (locations[0] as string) : null;
        return {
          actorMembershipId: m.id,
          actorRole: role.key,
          providerEntityId: m.providerEntityId,
          locationId,
        };
      });
    },
  };
}
