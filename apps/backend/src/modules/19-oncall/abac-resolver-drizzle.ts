// apps/backend/src/modules/19-oncall/abac-resolver-drizzle.ts — M19-T07 (§4.7).
//
// The Drizzle-backed {@link OncallAbacResolver} the six §4.7 predicates load their subject facts through.
// Every read opens `withOrgContext` so RLS scopes it to the ACTING org — an ABAC predicate must never see
// across a tenant boundary, so a cross-tenant subject resolves to `null`, which the predicates turn into a
// fail-CLOSED deny (§9.4's IDOR shape). Every row read swallows its own error into that `null`: a guard
// that 500s on a database blip is a worse outcome than one that denies.
//
// `activeShiftForMembership` IS THE ONE METHOD THAT DOES NOT COLLAPSE ITS ERROR INTO A BOOLEAN, and that
// asymmetry is deliberate. Its three-valued answer (`true` / `false` / `null`) is what keeps "this nurse is
// not on call" distinct from "we could not read the roster" — the M19-T04 finding. `decideOnCallEligible`
// treats `null` as no-answer and lets the ROLE path still speak, so a supervisor is not locked out of the
// board by a slow query, while an ordinary RN is still refused (they have no other path). Collapsing the
// error to `false` would have been indistinguishable at this layer and silently wrong at 2 a.m.
//
// `roleKeysOf` reaches outside M19's tables through the M3-owned `EffectivePermissionStore` PORT, typed
// structurally so no M3 import edge exists at all (the M21 precedent). The membership→user translation
// matters for the same reason it did there: M19's `*_membership_id` columns hold MEMBERSHIP ids and M3's
// grant store is keyed on USER id, so a direct lookup would return zero grants — denying for the wrong
// reason, and denying every legitimate on-call supervisor.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type {
  OnCallShiftAbacFacts,
  OncallAbacResolver,
  TriageCallAbacFacts,
  TriageEscalationAbacFacts,
} from "./abac-predicates";

/** The M3 role-grant read `roleKeysOf` derives from — structurally typed (no M3 schema import). */
export interface OncallRoleGrantReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<readonly { readonly roleKey: string; readonly enabled: boolean }[]>
    | readonly { readonly roleKey: string; readonly enabled: boolean }[];
}

/** Options for {@link buildDrizzleOncallAbacResolver}. */
export interface OncallAbacResolverDeps {
  /**
   * The M3 effective-permission store (the composition root binds `createDbEffectivePermissionStore`).
   * UNBOUND ⇒ `roleKeysOf` answers `null`, which only bites when the request context carries no roles
   * either (a system-principal path); a normal session's role set rides `context.roles`.
   */
  readonly roleGrants?: OncallRoleGrantReader;
}

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (the actor is already known to M3; the
 * org is the only scoping fact RLS needs), matching the M15/M16/M21 ABAC-resolver posture.
 */
export function buildDrizzleOncallAbacResolver(
  db: DbClient,
  deps: OncallAbacResolverDeps = {},
): OncallAbacResolver {
  const CALL = schema.triageCall;
  const SHIFT = schema.onCallShift;
  const ESCALATION = schema.triageEscalation;
  const MEMBERSHIP = schema.memberships;

  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async loadCall(orgId, triageCallId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<TriageCallAbacFacts | null> => {
          const [row] = await tx
            .select({
              organizationId: CALL.organizationId,
              id: CALL.id,
              providerEntityId: CALL.providerEntityId,
              patientId: CALL.patientId,
              onCallShiftId: CALL.onCallShiftId,
            })
            .from(CALL)
            .where(and(eq(CALL.id, triageCallId), eq(CALL.organizationId, orgId)))
            .limit(1);
          if (!row) return null;
          return {
            organizationId: row.organizationId,
            triageCallId: row.id,
            providerEntityId: row.providerEntityId,
            patientId: row.patientId,
            onCallShiftId: row.onCallShiftId,
          };
        });
      } catch {
        return null;
      }
    },

    async loadShift(orgId, shiftId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<OnCallShiftAbacFacts | null> => {
          const [row] = await tx
            .select({
              organizationId: SHIFT.organizationId,
              id: SHIFT.id,
              providerEntityId: SHIFT.providerEntityId,
              discipline: SHIFT.discipline,
              primaryOnCallMembershipId: SHIFT.primaryOnCallMembershipId,
              backupMembershipId: SHIFT.backupMembershipId,
              externalActorId: SHIFT.externalActorId,
            })
            .from(SHIFT)
            .where(and(eq(SHIFT.id, shiftId), eq(SHIFT.organizationId, orgId)))
            .limit(1);
          if (!row) return null;
          return {
            organizationId: row.organizationId,
            shiftId: row.id,
            providerEntityId: row.providerEntityId,
            discipline: row.discipline,
            primaryOnCallMembershipId: row.primaryOnCallMembershipId,
            backupMembershipId: row.backupMembershipId,
            externalActorId: row.externalActorId,
          };
        });
      } catch {
        return null;
      }
    },

    async loadEscalation(orgId, escalationId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<TriageEscalationAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: ESCALATION.organizationId,
                id: ESCALATION.id,
                tier: ESCALATION.tier,
                escalatedToMembershipId: ESCALATION.escalatedToMembershipId,
                escalatedToExternalActorId: ESCALATION.escalatedToExternalActorId,
              })
              .from(ESCALATION)
              .where(and(eq(ESCALATION.id, escalationId), eq(ESCALATION.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return {
              organizationId: row.organizationId,
              escalationId: row.id,
              tier: row.tier,
              escalatedToMembershipId: row.escalatedToMembershipId,
              escalatedToExternalActorId: row.escalatedToExternalActorId,
            };
          },
        );
      } catch {
        return null;
      }
    },

    /**
     * §4.7(a) — the membership is the PRIMARY or the BACKUP on an `active` shift covering `asOfIso`.
     *
     * The backup is included because §3.3 gives the shift a `backup_membership_id` and a backup who cannot
     * open a call is not a backup — the whole point of the column is that someone else can pick up when
     * the primary does not. The status filter is `active` only (not `scheduled`): a scheduled shift that
     * has not opened yet names a nurse who is not on duty, and §2.2.2's cron is what opens it. That is the
     * OPPOSITE of `OnCallProvider.currentOnCallActors` (M19-T06), which deliberately includes a scheduled
     * shift already inside its window — because that read answers "who covers this night" for ALERTING,
     * while this one answers "may this session act right now", and acting early is a different question
     * from being reachable.
     */
    async activeShiftForMembership({ orgId, membershipId, asOfIso, providerEntityId }) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<boolean> => {
          const at = new Date(asOfIso);
          const rows = await tx
            .select({ id: SHIFT.id })
            .from(SHIFT)
            .where(
              and(
                eq(SHIFT.organizationId, orgId),
                eq(SHIFT.status, "active"),
                sql`${SHIFT.shiftStartsAt} <= ${at}`,
                sql`${SHIFT.shiftEndsAt} > ${at}`,
                or(
                  eq(SHIFT.primaryOnCallMembershipId, membershipId),
                  eq(SHIFT.backupMembershipId, membershipId),
                ),
                ...(providerEntityId ? [eq(SHIFT.providerEntityId, providerEntityId)] : []),
              ),
            )
            .limit(1);
          return rows.length > 0;
        });
      } catch {
        return null; // UNREADABLE, not "not on call" — see the module header
      }
    },

    async roleKeysOf(orgId, membershipId) {
      const store = deps.roleGrants;
      if (!store) return null;
      try {
        const userId = await withOrgContext(db, ctx(orgId), async (tx): Promise<string | null> => {
          const [row] = await tx
            .select({ userId: MEMBERSHIP.userId })
            .from(MEMBERSHIP)
            .where(
              and(
                eq(MEMBERSHIP.id, membershipId),
                eq(MEMBERSHIP.organizationId, orgId),
                // A REVOKED membership holds no grants. §4.4(b)'s "not suspended" clause has no column of
                // its own on `membership`; `revoked_at IS NULL` plus the enabled-grant filter below is the
                // only suspension signal the platform actually publishes (the M21 finding).
                isNull(MEMBERSHIP.revokedAt),
              ),
            )
            .limit(1);
          return row?.userId ?? null;
        });
        if (userId === null) return null;
        const grants = await store.loadGrants(orgId, userId);
        return grants.filter((g) => g.enabled).map((g) => g.roleKey);
      } catch {
        return null;
      }
    },
  };
}
