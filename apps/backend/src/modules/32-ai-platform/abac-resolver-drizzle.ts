// apps/backend/src/modules/32-ai-platform/abac-resolver-drizzle.ts — M32-T07 (§4.7).
//
// The Drizzle-backed {@link AiPlatformAbacResolver} the six §4.7 predicates load their subject facts
// through. Every ORG-SCOPED read opens `withOrgContext` so RLS scopes it to the ACTING org — an ABAC
// predicate must never see across a tenant boundary, so a cross-tenant subject resolves to `null`, which
// the predicates turn into a fail-CLOSED deny (§8.2's isolation shape). Every read swallows its own error
// into `null`: a guard that 500s on a database blip is a worse outcome than one that denies.
//
// ── TWO READS HERE ARE PLATFORM-SHARED AND TAKE NO ORG, AND THAT IS CORRECT ─────────────────────────
//
// `resolveCapabilityId` reads `ai_capability` and `killSwitchActive` reads `ai_kill_switch_state`. Both
// tables are platform-shared (0116 grants `wardenx_app` SELECT), and the kill switch is DELIBERATELY read
// across the tenant boundary: §3.2.12's platform row carries `organization_id IS NULL` and stops every
// agency, so a lookup scoped to the caller's org would answer "no switch" for exactly the switch that
// matters most. The disjunction — this org's row OR the platform row — IS the rule (M32-T05), and running
// it through `withOrgContext` would filter half of it away.
//
// ── `killSwitchActive` IS THE ONE METHOD THAT RETURNS THREE VALUES ──────────────────────────────────
//
// `true` / `false` / `null`, where `null` is "unreadable". The predicate's fail-closed direction is "a
// switch MAY be active", so a boolean cannot carry it: collapsing an error to `false` would let an outage
// of the safety table resume a capability somebody paused during a SEV-1. Every other method collapses to
// `null` because absent and unreadable deny identically there.
//
// `roleKeysOf` reaches outside M32's tables through a structurally-typed role-grant PORT, so no M2/M3
// import edge exists at all (the M19/M20/M21 precedent). The membership→user translation matters for the
// same reason it did there: M32's `*_membership_id` columns hold MEMBERSHIP ids and M3's grant store is
// keyed on USER id, so a direct lookup would return zero grants — denying every legitimate operator for
// the wrong reason.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";

import type {
  AiInvocationAbacFacts,
  AiPlatformAbacResolver,
  AiTenantOptInAbacFacts,
} from "./abac-predicates";

/** The M3 role-grant read `roleKeysOf` derives from — structurally typed (no M3 schema import). */
export interface AiRoleGrantReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<readonly { readonly roleKey: string; readonly enabled: boolean }[]>
    | readonly { readonly roleKey: string; readonly enabled: boolean }[];
}

/** The D18 prefix query `ai_prohibited_zone_respected` runs — the §4.5 registry, structurally typed. */
export interface AiPromptZoneReader {
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly unknown[]>;
}

export interface AiPlatformAbacDrizzleDeps {
  readonly db: DbClient;
  /**
   * The M3 effective-permission store (the composition root binds `createDbEffectivePermissionStore`).
   * UNBOUND ⇒ `roleKeysOf` answers `null`, which only bites when the request context carries no roles
   * either (a system-principal path); a normal session's role set rides `context.roles`, which
   * `isAiSafetyOwner` checks FIRST precisely because the safety owner is cross-tenant and may hold no
   * membership in the org whose row they are acting on.
   */
  readonly roleGrants?: AiRoleGrantReader;
  /**
   * The live §4.5 `AIPromptRegistry`. UNBOUND ⇒ `activePromptsTargeting` answers `null` and
   * `ai_prohibited_zone_respected` DENIES. That is the M32-T06 asymmetry carried into the predicate: `[]`
   * from a working registry is "no contraband found", and `[]` minted from an absent registry is a clean
   * bill of health nobody issued.
   */
  readonly promptRegistry?: AiPromptZoneReader;
}

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (the actor is already known to M3; the
 * org is the only scoping fact RLS needs), matching the M15/M16/M19/M20/M21 ABAC-resolver posture.
 */
export function buildDrizzleAiPlatformAbacResolver(
  deps: AiPlatformAbacDrizzleDeps,
): AiPlatformAbacResolver {
  const { db } = deps;
  const CAPABILITY = schema.aiCapability;
  const OPT_IN = schema.aiTenantOptInRecord;
  const OPT_OUT = schema.aiClinicianOptOut;
  const KILL = schema.aiKillSwitchState;
  const INVOCATION = schema.aiInvocation;
  const MEMBERSHIP = schema.memberships;

  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async roleKeysOf(orgId, membershipId) {
      if (deps.roleGrants === undefined) return null;
      try {
        // Membership → user, because M3's grant store is keyed on USER id (see the header).
        const [member] = await db
          .select({ userId: MEMBERSHIP.userId })
          .from(MEMBERSHIP)
          .where(and(eq(MEMBERSHIP.id, membershipId), eq(MEMBERSHIP.organizationId, orgId)))
          .limit(1);
        if (!member) return null;
        const grants = await deps.roleGrants.loadGrants(orgId, member.userId);
        return grants.filter((g) => g.enabled).map((g) => g.roleKey);
      } catch {
        return null;
      }
    },

    async resolveCapabilityId(capabilityRef) {
      try {
        // A target may name the capability by id or by key; one query answers both, and a ref that
        // matches neither resolves to `null` — which denies. Telling "no such capability" apart from
        // "not permitted" would let a caller enumerate the registry by timing the refusals.
        const [row] = await db
          .select({ id: CAPABILITY.id })
          .from(CAPABILITY)
          .where(or(eq(CAPABILITY.id, capabilityRef), eq(CAPABILITY.capabilityKey, capabilityRef)))
          .limit(1);
        return row?.id ?? null;
      } catch {
        return null;
      }
    },

    async loadTenantOptIn(orgId, capabilityId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<AiTenantOptInAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: OPT_IN.organizationId,
                capabilityId: OPT_IN.capabilityId,
                status: OPT_IN.status,
                optedOutAt: OPT_IN.optedOutAt,
              })
              .from(OPT_IN)
              .where(
                and(eq(OPT_IN.organizationId, orgId), eq(OPT_IN.capabilityId, capabilityId)),
              )
              .limit(1);
            if (!row) return null;
            return {
              organizationId: row.organizationId,
              capabilityId: row.capabilityId,
              status: row.status,
              optedOutAt: row.optedOutAt === null ? null : row.optedOutAt.toISOString(),
            };
          },
        );
      } catch {
        return null;
      }
    },

    async clinicianOptedOut(orgId, membershipId, capabilityId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<boolean> => {
          // LIVE means `opted_out AND reverted_at IS NULL`. §5.4 keeps the reverted row forever (it is
          // the history that makes a coercion question answerable), so a query that only checked
          // `opted_out` would report a clinician who turned the capability back on as still opted out.
          const [row] = await tx
            .select({ id: OPT_OUT.id })
            .from(OPT_OUT)
            .where(
              and(
                eq(OPT_OUT.organizationId, orgId),
                eq(OPT_OUT.membershipId, membershipId),
                eq(OPT_OUT.capabilityId, capabilityId),
                eq(OPT_OUT.optedOut, true),
                isNull(OPT_OUT.revertedAt),
              ),
            )
            .limit(1);
          return row !== undefined;
        });
      } catch {
        return null;
      }
    },

    async killSwitchActive(orgId, capabilityId) {
      try {
        // PLATFORM-SHARED and deliberately un-scoped (see the header): the disjunction of this org's row
        // and the `organization_id IS NULL` platform row IS the rule.
        const rows = await db
          .select({ id: KILL.id })
          .from(KILL)
          .where(
            and(
              eq(KILL.capabilityId, capabilityId),
              eq(KILL.active, true),
              or(eq(KILL.organizationId, orgId), isNull(KILL.organizationId)),
            ),
          )
          .limit(1);
        return rows.length > 0;
      } catch {
        // `null`, not `false` — see the header on why this method is three-valued.
        return null;
      }
    },

    async loadInvocation(orgId, invocationId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<AiInvocationAbacFacts | null> => {
            const [row] = await tx
              .select({
                id: INVOCATION.id,
                organizationId: INVOCATION.organizationId,
                invokedAt: INVOCATION.invokedAt,
              })
              .from(INVOCATION)
              .where(
                and(
                  eq(INVOCATION.id, invocationId),
                  eq(INVOCATION.organizationId, orgId),
                  // The partition key cannot be derived from the id, so an id-only lookup scans every
                  // monthly partition. `IS NOT NULL` is a no-op predicate the planner drops; the real
                  // pruning happens on the READ route, which bounds by window (routes/read-service-
                  // drizzle.ts). Stated here so the absence of a time bound is a noted cost, not an
                  // oversight: an ABAC guard cannot invent a window the caller did not supply.
                  isNotNull(INVOCATION.invokedAt),
                ),
              )
              .limit(1);
            if (!row) return null;
            return {
              invocationId: row.id,
              organizationId: row.organizationId,
              invokedAt: row.invokedAt.toISOString(),
            };
          },
        );
      } catch {
        return null;
      }
    },

    async activePromptsTargeting(prefix) {
      if (deps.promptRegistry === undefined) return null;
      try {
        return await deps.promptRegistry.getActivePromptsTargeting(prefix);
      } catch {
        return null;
      }
    },
  };
}
