// apps/backend/src/modules/20-field-safety/abac-resolver-drizzle.ts — M20-T06 (§4.7).
//
// The Drizzle-backed {@link SafetyAbacResolver} the six §4.7 predicates load their subject facts through.
// Every read opens `withOrgContext` so RLS scopes it to the ACTING org — an ABAC predicate must never see
// across a tenant boundary, so a cross-tenant subject resolves to `null`, which the predicates turn into a
// fail-CLOSED deny (§9.4's IDOR shape). Every read swallows its own error into that `null`: a guard that
// 500s on a database blip is a worse outcome than one that denies.
//
// `subscriptionsForSupervisor` LOADS BY SUBSCRIBER **AND** BY VACATION-FORWARD TARGET, in one query. The
// pure rule (`decideSupervisesClinician`) evaluates both arms, and a resolver that only loaded rows whose
// `supervisor_membership_id` matched would make the forward-target arm dead code — the covering supervisor
// would be paged tonight and 403'd on the alert she was woken for. §3.3's `m20_sss_vacation_pair` CHECK is
// what makes the second arm safe to trust: a forwarding row always names its target.
//
// `clinicianScope` ANSWERS FROM `membership`, NOT FROM A SAFETY TABLE. The subscription scope kinds
// `location` and `provider_entity` match against where the CLINICIAN is, and M20 owns no such column —
// M2's `membership` carries `primary_location_id` and `default_provider_entity_id`, which is the same pair
// the M20-T05 coverage store reads and therefore the same answer the paging layer computes. Two different
// reads of "which location is she in" would let the board and the pager disagree.
//
// `roleKeysOf` reaches outside M20's tables through the M3-owned `EffectivePermissionStore` PORT, typed
// structurally so no M3 import edge exists at all (the M19/M21 precedent). The membership→user translation
// matters for the same reason it did there: M20's `*_membership_id` columns hold MEMBERSHIP ids and M3's
// grant store is keyed on USER id, so a direct lookup would return zero grants — denying every legitimate
// supervisor for the wrong reason.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  MembershipId,
  OrgId,
  ProviderEntityId,
  SafetySosLifecycleState,
  SafetySubscriptionScopeKind,
} from "@chartwarden/types";
import { and, eq, isNull, or } from "drizzle-orm";
import type {
  SafetyAbacResolver,
  SafetyCheckInAbacFacts,
  SafetyClinicianScopeFacts,
  SafetyIncidentAbacFacts,
  SafetySosAbacFacts,
  SafetySubscriptionAbacFacts,
} from "./abac-predicates";

/** The M3 role-grant read `roleKeysOf` derives from — structurally typed (no M3 schema import). */
export interface SafetyRoleGrantReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<readonly { readonly roleKey: string; readonly enabled: boolean }[]>
    | readonly { readonly roleKey: string; readonly enabled: boolean }[];
}

/** Options for {@link buildDrizzleSafetyAbacResolver}. */
export interface SafetyAbacResolverDeps {
  /**
   * The M3 effective-permission store (the composition root binds `createDbEffectivePermissionStore`).
   * UNBOUND ⇒ `roleKeysOf` answers `null`, which only bites when the request context carries no roles
   * either (a system-principal path); a normal session's role set rides `context.roles`.
   */
  readonly roleGrants?: SafetyRoleGrantReader;
}

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (the actor is already known to M3; the
 * org is the only scoping fact RLS needs), matching the M15/M16/M19/M21 ABAC-resolver posture.
 */
export function buildDrizzleSafetyAbacResolver(
  db: DbClient,
  deps: SafetyAbacResolverDeps = {},
): SafetyAbacResolver {
  const SOS = schema.safetySosAlert;
  const CHECK_IN = schema.safetyCheckIn;
  const INCIDENT = schema.safetyIncident;
  const SUBSCRIPTION = schema.safetySupervisorSubscription;
  const MEMBERSHIP = schema.memberships;

  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async loadSosAlert(orgId, sosAlertId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<SafetySosAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: SOS.organizationId,
                id: SOS.id,
                providerEntityId: SOS.providerEntityId,
                postedByMembershipId: SOS.postedByMembershipId,
                lifecycleState: SOS.lifecycleState,
              })
              .from(SOS)
              .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return {
              organizationId: row.organizationId as OrgId,
              sosAlertId: row.id,
              providerEntityId: row.providerEntityId as ProviderEntityId,
              postedByMembershipId: row.postedByMembershipId as MembershipId,
              lifecycleState: row.lifecycleState as SafetySosLifecycleState,
            };
          },
        );
      } catch {
        return null;
      }
    },

    async loadCheckIn(orgId, checkInId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<SafetyCheckInAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: CHECK_IN.organizationId,
                id: CHECK_IN.id,
                providerEntityId: CHECK_IN.providerEntityId,
                postedByMembershipId: CHECK_IN.postedByMembershipId,
                postedAt: CHECK_IN.postedAt,
              })
              .from(CHECK_IN)
              .where(and(eq(CHECK_IN.id, checkInId), eq(CHECK_IN.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return {
              organizationId: row.organizationId as OrgId,
              checkInId: row.id,
              providerEntityId: row.providerEntityId as ProviderEntityId,
              clinicianMembershipId: row.postedByMembershipId as MembershipId,
              postedAt: row.postedAt.toISOString() as SafetyCheckInAbacFacts["postedAt"],
            };
          },
        );
      } catch {
        return null;
      }
    },

    async loadIncident(orgId, incidentId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<SafetyIncidentAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: INCIDENT.organizationId,
                id: INCIDENT.id,
                providerEntityId: INCIDENT.providerEntityId,
                affectedClinicianMembershipId: INCIDENT.affectedClinicianMembershipId,
                reportedByMembershipId: INCIDENT.reportedByMembershipId,
                lifecycleState: INCIDENT.lifecycleState,
              })
              .from(INCIDENT)
              .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return {
              organizationId: row.organizationId as OrgId,
              incidentId: row.id,
              providerEntityId: row.providerEntityId as ProviderEntityId,
              affectedClinicianMembershipId: row.affectedClinicianMembershipId as MembershipId,
              reportedByMembershipId: row.reportedByMembershipId as MembershipId,
              lifecycleState: row.lifecycleState,
            };
          },
        );
      } catch {
        return null;
      }
    },

    async subscriptionsForSupervisor(orgId, supervisorMembershipId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<readonly SafetySubscriptionAbacFacts[]> => {
            const rows = await tx
              .select({
                supervisorMembershipId: SUBSCRIPTION.supervisorMembershipId,
                clinicianMembershipId: SUBSCRIPTION.clinicianMembershipId,
                locationId: SUBSCRIPTION.locationId,
                providerEntityId: SUBSCRIPTION.providerEntityId,
                scopeKind: SUBSCRIPTION.scopeKind,
                isVacationForwarding: SUBSCRIPTION.isVacationForwarding,
                vacationForwardToMembershipId: SUBSCRIPTION.vacationForwardToMembershipId,
              })
              .from(SUBSCRIPTION)
              .where(
                and(
                  eq(SUBSCRIPTION.organizationId, orgId),
                  isNull(SUBSCRIPTION.supersededAt),
                  isNull(SUBSCRIPTION.deactivatedAt),
                  // Both arms in one query — see the module header on why the second is not optional.
                  or(
                    eq(SUBSCRIPTION.supervisorMembershipId, supervisorMembershipId),
                    eq(SUBSCRIPTION.vacationForwardToMembershipId, supervisorMembershipId),
                  ),
                ),
              );
            return rows.map((r) => ({
              supervisorMembershipId: r.supervisorMembershipId as MembershipId,
              clinicianMembershipId: (r.clinicianMembershipId ?? null) as MembershipId | null,
              locationId: r.locationId ?? null,
              providerEntityId: (r.providerEntityId ?? null) as ProviderEntityId | null,
              scopeKind: r.scopeKind as SafetySubscriptionScopeKind,
              isVacationForwarding: r.isVacationForwarding,
              vacationForwardToMembershipId: (r.vacationForwardToMembershipId ??
                null) as MembershipId | null,
            }));
          },
        );
      } catch {
        return null; // UNREADABLE, which denies — never an empty array, which reads as "nobody watches her"
      }
    },

    async clinicianScope(orgId, membershipId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<SafetyClinicianScopeFacts | null> => {
            const [row] = await tx
              .select({
                id: MEMBERSHIP.id,
                defaultLocationIds: MEMBERSHIP.defaultLocationIds,
                defaultProviderEntityId: MEMBERSHIP.defaultProviderEntityId,
              })
              .from(MEMBERSHIP)
              .where(
                and(
                  eq(MEMBERSHIP.id, membershipId),
                  eq(MEMBERSHIP.organizationId, orgId),
                  isNull(MEMBERSHIP.revokedAt),
                ),
              )
              .limit(1);
            if (!row) return null;
            return {
              membershipId: row.id as MembershipId,
              // `default_location_ids` is jsonb (M1's `membership`); a malformed value normalizes to the
              // empty list, which makes a `location`-scoped subscription MISS rather than match — the
              // fail-closed direction for an authorization read.
              locationIds: Array.isArray(row.defaultLocationIds)
                ? (row.defaultLocationIds as unknown[]).filter(
                    (v): v is string => typeof v === "string",
                  )
                : [],
              providerEntityId: (row.defaultProviderEntityId ?? null) as ProviderEntityId | null,
            };
          },
        );
      } catch {
        return null;
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
