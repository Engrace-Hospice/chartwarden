// apps/backend/src/modules/16-bereavement/abac-resolver-drizzle.ts — M16-T06 (§4.8).
//
// The Drizzle-backed {@link BereavementAbacResolver} the four §4.8 predicates load their subject facts
// through. Every read opens `withOrgContext` so RLS scopes it to the acting org — an ABAC predicate must
// never see across a tenant boundary, so a cross-tenant subject resolves to `null`, which the predicates
// turn into a fail-CLOSED deny. Every method swallows its own error INTO that `null`: an ABAC guard that
// 500s on a database blip is a worse outcome than one that denies, and denying is the honest answer to
// "we could not find out".
//
// `disciplineOf` is the one method that reaches outside M16's own tables, and it does so through two
// M16-legal surfaces rather than an M3 schema import:
//   • the M3-owned `EffectivePermissionStore` PORT (`loadGrants(orgId, userId) → RoleGrant[]`), whose
//     `roleKey` field M3 itself documents as the discipline-derivation input; and
//   • M1's `membership` table, to translate a membership id into the user id that port is keyed on.
// The second hop exists because M16's `assigned_counselor_user_id` column is a MEMBERSHIP id under a
// spec-mandated `user_id` NAME (see the §3.3.1 schema header) — looking it up as a user id alone would
// silently return zero grants and deny every counselor assignment.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MembershipId } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import {
  type BereavedContactAbacFacts,
  type BereavementAbacResolver,
  type BereavementPlanAbacFacts,
  disciplineForRoleKeys,
} from "./abac-predicates";

/** The M3 role-grant read `disciplineOf` derives from — structurally typed (no M3 schema import). */
export interface RoleGrantReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<readonly { readonly roleKey: string; readonly enabled: boolean }[]>
    | readonly { readonly roleKey: string; readonly enabled: boolean }[];
}

/** Options for {@link buildDrizzleBereavementAbacResolver}. */
export interface BereavementAbacResolverDeps {
  /**
   * The M3 effective-permission store (the composition root binds `createDbEffectivePermissionStore`).
   * UNBOUND ⇒ `disciplineOf` answers `null` ⇒ `discipline_can_provide_bereavement` denies for any subject
   * other than the caller themselves (whose role keys ride the request context) — fail-CLOSED, and
   * loudly: a counselor assignment is refused rather than granted to an unverifiable discipline.
   */
  readonly roleGrants?: RoleGrantReader;
}

type PlanRow = typeof schema.bereavementPlan.$inferSelect;

const planFactsOf = (row: PlanRow): BereavementPlanAbacFacts => ({
  organizationId: row.organizationId,
  planId: row.id,
  status: row.status,
  assignedCounselorUserId: (row.assignedCounselorUserId ?? null) as MembershipId | null,
  assignedVolunteerUserId: (row.assignedVolunteerUserId ?? null) as MembershipId | null,
});

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (a predicate is evaluated for a request
 * whose actor is already known to M3; the org is the only scoping fact RLS needs), so the org context is
 * opened with the caller's org and a blank user — the same posture M15's ABAC resolver uses.
 */
export function buildDrizzleBereavementAbacResolver(
  db: DbClient,
  deps: BereavementAbacResolverDeps = {},
): BereavementAbacResolver {
  const PLAN = schema.bereavementPlan;
  const CONTACT = schema.bereavedContact;
  const OUTREACH = schema.bereavementOutreach;
  const MEMBERSHIP = schema.memberships;

  return {
    async loadPlan(orgId, planId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const [row] = await tx.select().from(PLAN).where(eq(PLAN.id, planId)).limit(1);
          return row ? planFactsOf(row) : null;
        });
      } catch {
        return null;
      }
    },

    async loadPlanForContact(orgId, contactId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const [row] = await tx
            .select({ plan: PLAN })
            .from(CONTACT)
            .innerJoin(PLAN, eq(PLAN.id, CONTACT.planId))
            .where(eq(CONTACT.id, contactId))
            .limit(1);
          return row ? planFactsOf(row.plan) : null;
        });
      } catch {
        return null;
      }
    },

    async loadPlanForOutreach(orgId, outreachId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const [row] = await tx
            .select({ plan: PLAN })
            .from(OUTREACH)
            .innerJoin(PLAN, eq(PLAN.id, OUTREACH.planId))
            .where(eq(OUTREACH.id, outreachId))
            .limit(1);
          return row ? planFactsOf(row.plan) : null;
        });
      } catch {
        return null;
      }
    },

    async loadContact(orgId, contactId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const [row] = await tx.select().from(CONTACT).where(eq(CONTACT.id, contactId)).limit(1);
          if (!row) return null;
          const facts: BereavedContactAbacFacts = {
            organizationId: row.organizationId,
            contactId: row.id,
            planId: row.planId,
            portalAccountId: row.portalAccountId ?? null,
          };
          return facts;
        });
      } catch {
        return null;
      }
    },

    async disciplineOf(orgId, subjectId) {
      const reader = deps.roleGrants;
      if (reader === undefined) return null; // unbound ⇒ deny (never "no grants means anyone")
      const disciplineFor = async (userId: string): Promise<string | null> => {
        const grants = await reader.loadGrants(orgId, userId);
        return disciplineForRoleKeys(grants.filter((g) => g.enabled).map((g) => g.roleKey));
      };
      try {
        const direct = await disciplineFor(subjectId);
        if (direct !== null) return direct;
        // The id was a MEMBERSHIP id (the §3.3.1 `*_user_id` columns hold membership ids); translate and
        // retry once. A membership that does not exist in this org resolves to null, which denies.
        const userId = await withOrgContext(
          db,
          { organizationId: orgId, userId: "" },
          async (tx) => {
            const [row] = await tx
              .select({ userId: MEMBERSHIP.userId })
              .from(MEMBERSHIP)
              .where(eq(MEMBERSHIP.id, subjectId))
              .limit(1);
            return row?.userId ?? null;
          },
        );
        return userId === null ? null : await disciplineFor(userId);
      } catch {
        return null; // §8.7 — an unreadable grant set denies
      }
    },
  };
}
