import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";

/** The role the M30 spec (D9) assigns every mortality review to on creation. */
export const MEDICAL_DIRECTOR_ROLE_KEY = "medical_director";

/**
 * M30 D9 — resolve the Medical Director to assign a new mortality review to. M3 answers which memberships hold the
 * `medical_director` role (its own tables); this Foundation half reads only `membership`: the ACTIVE ones sited at the
 * review's provider entity (`default_provider_entity_id`), else an ACTIVE holder with no default entity (an org-wide
 * director). Deterministic (lowest id) so a redelivery resolves the same person. `null` when nobody qualifies — the
 * caller leaves the review unassigned. RLS-scoped by the org context.
 */
export function buildMortalityReviewerResolver(
  db: DbClient,
  holdersOfRole: (organizationId: string, roleKey: string) => Promise<readonly string[]>,
) {
  return async (organizationId: string, providerEntityId: string): Promise<string | null> => {
    const holders = await holdersOfRole(organizationId, MEDICAL_DIRECTOR_ROLE_KEY);
    if (holders.length === 0) return null;
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const res = await tx.execute(sql`
        SELECT m.id AS id
          FROM membership m
         WHERE m.organization_id = ${organizationId}
           AND m.status = 'active'
           AND m.id IN (${sql.join(
             holders.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           AND (m.default_provider_entity_id = ${providerEntityId}::uuid
                OR m.default_provider_entity_id IS NULL)
         ORDER BY (m.default_provider_entity_id IS NULL), m.id
         LIMIT 1`);
      const row = (res as unknown as { rows?: Array<{ id?: string }> }).rows?.[0];
      return row?.id ?? null;
    });
  };
}
