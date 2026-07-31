// apps/backend/src/modules/21-supplies/abac-resolver-drizzle.ts — M21-T05 (§4.4).
//
// The Drizzle-backed {@link SuppliesAbacResolver} the two §4.4 predicates load their subject facts through.
// Every read opens `withOrgContext` so RLS scopes it to the acting org — an ABAC predicate must never see
// across a tenant boundary, so a cross-tenant subject resolves to `null`, which the predicates turn into a
// fail-CLOSED deny. Every method swallows its own error INTO that `null`: an ABAC guard that 500s on a
// database blip is a worse outcome than one that denies, and denying is the honest answer to "we could not
// find out". For a controlled-substance movement it is also the only defensible one.
//
// TWO reads reach outside M21's own tables, and both go through an M21-legal surface rather than an M3/M2
// schema import that would need a manifest edge:
//   • `roleKeysOf` — the M3-owned `EffectivePermissionStore` PORT (`loadGrants(orgId, userId) →
//     RoleGrant[]`), structurally typed here so no M3 import exists at all;
//   • `locationIdsOf` — M1's `membership.default_location_ids`, which is core tenancy data (M1 is already
//     in M21's `dependsOn` for the seam registry), NOT another module's clinical schema.
//
// The membership→user translation in `roleKeysOf` matters: M21's `*_membership_id` columns hold MEMBERSHIP
// ids and M3's grant store is keyed on USER id, so looking a membership id up directly would silently
// return zero grants — which denies, but for the wrong reason, and would deny every legitimate dispatcher.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { MembershipId } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type {
  ComfortKitReturnAbacFacts,
  SuppliesAbacResolver,
  SupplyDispatchAbacFacts,
} from "./abac-predicates";

/** The M3 role-grant read `roleKeysOf` derives from — structurally typed (no M3 schema import). */
export interface SuppliesRoleGrantReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<readonly { readonly roleKey: string; readonly enabled: boolean }[]>
    | readonly { readonly roleKey: string; readonly enabled: boolean }[];
}

/** Options for {@link buildDrizzleSuppliesAbacResolver}. */
export interface SuppliesAbacResolverDeps {
  /**
   * The M3 effective-permission store (the composition root binds `createDbEffectivePermissionStore`).
   * UNBOUND ⇒ `roleKeysOf` answers `null`. That only bites when the request context carries no roles
   * either (a system-principal path); a normal session's role set rides `context.roles` and never needs
   * this read. Fail-CLOSED in both directions.
   */
  readonly roleGrants?: SuppliesRoleGrantReader;
}

/** The two kit kinds — the §4.1 row-1 conditional cell ("when kind=comfort_kit_deploy") plus replenish,
 *  which tops up the same scheduled lots and is exactly as controlled as the first fill. */
const KIT_KINDS = new Set(["comfort_kit_deploy", "comfort_kit_replenish"]);

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (a predicate is evaluated for a request
 * whose actor is already known to M3; the org is the only scoping fact RLS needs), so the org context is
 * opened with the caller's org and a blank user — the same posture M15's and M16's ABAC resolvers use.
 */
export function buildDrizzleSuppliesAbacResolver(
  db: DbClient,
  deps: SuppliesAbacResolverDeps = {},
): SuppliesAbacResolver {
  const REQUEST = schema.supplyRequest;
  const DISPATCH = schema.comfortKitDispatch;
  const DISPATCHED = schema.comfortKitDispatchedContent;
  const RETURN = schema.comfortKitReturn;
  const MEMBERSHIP = schema.memberships;

  /** Open the org context for an ABAC read (blank user — the actor is already known to M3). */
  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async loadDispatch(orgId, dispatchId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<SupplyDispatchAbacFacts | null> => {
          const [row] = await tx
            .select({
              organizationId: DISPATCH.organizationId,
              id: DISPATCH.id,
              locationId: DISPATCH.locationId,
            })
            .from(DISPATCH)
            .where(eq(DISPATCH.id, dispatchId))
            .limit(1);
          if (!row) return null;
          // A comfort-kit dispatch is treated as controlled unless every dispatched line says otherwise.
          // Reading the CONTENT rows rather than assuming keeps a non-scheduled kit (some agencies dispatch
          // a purely anti-emetic kit) out of the tighter gate, without ever assuming the safe direction.
          const controlled = await tx
            .select({ id: DISPATCHED.id })
            .from(DISPATCHED)
            .where(
              and(
                eq(DISPATCHED.dispatchId, dispatchId),
                eq(DISPATCHED.isControlledSubstance, true),
              ),
            )
            .limit(1);
          return {
            organizationId: row.organizationId,
            targetId: row.id,
            locationId: row.locationId,
            involvesControlledSubstance: controlled.length > 0,
          };
        });
      } catch {
        return null;
      }
    },

    async loadRequest(orgId, supplyRequestId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<SupplyDispatchAbacFacts | null> => {
          const [row] = await tx
            .select({
              organizationId: REQUEST.organizationId,
              id: REQUEST.id,
              locationId: REQUEST.locationId,
              kind: REQUEST.kind,
            })
            .from(REQUEST)
            .where(eq(REQUEST.id, supplyRequestId))
            .limit(1);
          if (!row) return null;
          return {
            organizationId: row.organizationId,
            targetId: row.id,
            locationId: row.locationId,
            involvesControlledSubstance: KIT_KINDS.has(row.kind),
          };
        });
      } catch {
        return null;
      }
    },

    async loadReturn(orgId, returnId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<ComfortKitReturnAbacFacts | null> => {
          const [row] = await tx
            .select({
              organizationId: RETURN.organizationId,
              id: RETURN.id,
              dispatchId: RETURN.dispatchId,
              assignedRetrievingMembershipId: RETURN.assignedRetrievingMembershipId,
              disposalWitnessMembershipId: RETURN.disposalWitnessMembershipId,
            })
            .from(RETURN)
            .where(eq(RETURN.id, returnId))
            .limit(1);
          if (!row) return null;
          const [dispatch] = await tx
            .select({ dispatchedByMembershipId: DISPATCH.dispatchedByMembershipId })
            .from(DISPATCH)
            .where(eq(DISPATCH.id, row.dispatchId))
            .limit(1);
          // No dispatch ⇒ no dispatcher ⇒ the separation-of-duties clause is UNDECIDABLE, so the whole
          // predicate denies. Inventing an empty dispatcher id would make every reconciler pass clause (a).
          if (!dispatch) return null;
          const controlled = await tx
            .select({ id: DISPATCHED.id })
            .from(DISPATCHED)
            .where(
              and(
                eq(DISPATCHED.dispatchId, row.dispatchId),
                eq(DISPATCHED.isControlledSubstance, true),
              ),
            )
            .limit(1);
          return {
            organizationId: row.organizationId,
            returnId: row.id,
            dispatchId: row.dispatchId,
            dispatchedByMembershipId: dispatch.dispatchedByMembershipId as MembershipId,
            assignedRetrievingMembershipId:
              (row.assignedRetrievingMembershipId ?? null) as MembershipId | null,
            disposalWitnessMembershipId:
              (row.disposalWitnessMembershipId ?? null) as MembershipId | null,
            containsControlledSubstance: controlled.length > 0,
          };
        });
      } catch {
        return null;
      }
    },

    async roleKeysOf(orgId, subjectId) {
      const reader = deps.roleGrants;
      if (reader === undefined) return null; // unbound ⇒ deny (never "no grants means anyone")
      const keysFor = async (userId: string): Promise<readonly string[]> => {
        const grants = await reader.loadGrants(orgId, userId);
        return grants.filter((g) => g.enabled).map((g) => g.roleKey);
      };
      try {
        const direct = await keysFor(subjectId);
        if (direct.length > 0) return direct;
        // The id was a MEMBERSHIP id (see the header); translate once and retry.
        const userId = await withOrgContext(db, ctx(orgId), async (tx): Promise<string | null> => {
          const [row] = await tx
            .select({ userId: MEMBERSHIP.userId })
            .from(MEMBERSHIP)
            .where(eq(MEMBERSHIP.id, subjectId))
            .limit(1);
          return row?.userId ?? null;
        });
        return userId === null ? null : await keysFor(userId);
      } catch {
        return null;
      }
    },

    async locationIdsOf(orgId, membershipId) {
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<readonly string[] | null> => {
          const [row] = await tx
            .select({ defaultLocationIds: MEMBERSHIP.defaultLocationIds })
            .from(MEMBERSHIP)
            .where(and(eq(MEMBERSHIP.id, membershipId), eq(MEMBERSHIP.organizationId, orgId)))
            .limit(1);
          if (!row) return null;
          const ids = row.defaultLocationIds;
          return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
        });
      } catch {
        return null;
      }
    },
  };
}
