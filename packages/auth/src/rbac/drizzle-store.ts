// @wardenx/auth · rbac — the PRODUCTION EffectivePermissionStore (M3 §2.2).
//
// The RBAC engine (resolve.ts) resolves an actor's effective permissions through an injected
// `EffectivePermissionStore` PORT; that file is deliberately db-free. THIS file is the live store the
// engine's TODO pointed at — it runs the §2.2 pipeline query (`membership ⋈ membership_role ⋈ role ⋈
// role_permission` for the actor's active organization) inside `withOrgContext`, so Postgres RLS
// scopes every row by `app.org_id` (defense in depth beneath the explicit org/user predicates). It
// mirrors the M2 db-session-store pattern: a pure seam (resolve.ts) plus a Drizzle store (here) in the
// same leaf. Until this landed, `requirePermission` had no registered resolver and failed closed in
// production; the composition root registers this when a DB client is present, turning real RBAC on.
//
// Expiry/disabled filtering is NOT done here — the store returns raw grants (each with its `expiresAt`)
// and the engine's `resolveEffectivePermissions` drops disabled roles + time-bound grants past their
// window (§7.2), capping the cache TTL by the soonest expiry. Keeping the store a thin reader keeps that
// §7.2 rule in one place.
import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { ActorEnrichment, ActorEnrichmentReader, OrgScope } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import {
  type EffectivePermissionStore,
  type RbacEngineHandle,
  registerEffectivePermissionResolver,
} from "./resolve";
import type { RoleGrant } from "./resolve";

/**
 * Build the live `EffectivePermissionStore` over the pooled Drizzle client. `loadGrants` is keyed by
 * (orgId, userId) — the request context carries the actor + active org, not a membership id — and only
 * `active` memberships contribute grants (a pending/suspended/revoked membership grants nothing).
 */
export function createDbEffectivePermissionStore(db: DbClient): EffectivePermissionStore {
  return {
    async loadGrants(orgId: string, userId: string): Promise<RoleGrant[]> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        // One grant row per membership_role: the role (key + enabled) and the grant's expiry. RLS +
        // the explicit predicates scope this to the actor's active membership in this org.
        const grantRows = await tx
          .select({
            roleId: schema.roles.id,
            roleKey: schema.roles.key,
            enabled: schema.roles.enabled,
            expiresAt: schema.membershipRoles.expiresAt,
          })
          .from(schema.memberships)
          .innerJoin(
            schema.membershipRoles,
            eq(schema.membershipRoles.membershipId, schema.memberships.id),
          )
          .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
          .where(
            and(
              eq(schema.memberships.userId, userId),
              eq(schema.memberships.organizationId, orgId),
              eq(schema.memberships.status, "active"),
            ),
          );
        if (grantRows.length === 0) return [];

        // The permission keys each granted role confers (`role_permission` → `permission.key`).
        const roleIds = [...new Set(grantRows.map((g) => g.roleId))];
        const permRows = await tx
          .select({
            roleId: schema.rolePermissions.roleId,
            permissionKey: schema.rolePermissions.permissionKey,
          })
          .from(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roleIds));
        const permsByRole = new Map<string, string[]>();
        for (const p of permRows) {
          const keys = permsByRole.get(p.roleId);
          if (keys) keys.push(p.permissionKey);
          else permsByRole.set(p.roleId, [p.permissionKey]);
        }

        return grantRows.map((g) => ({
          roleKey: g.roleKey,
          enabled: g.enabled,
          expiresAt: g.expiresAt ?? null,
          permissionKeys: permsByRole.get(g.roleId) ?? [],
        }));
      });
    },
  };
}

/**
 * Boot helper (M3 §2.2): register the cached effective-permission resolver over the production Drizzle
 * store, flipping the Authorization Contract's `requirePermission` from its fail-closed default to real
 * DB-backed resolution. The composition root calls this when a DB client is present (slice/tests keep
 * the fail-closed default + their own in-memory resolvers). Returns the handle so role grant/revoke/edit
 * can drive the §2.5 cache invalidation.
 */
export function registerDbEffectivePermissionResolver(db: DbClient): RbacEngineHandle {
  return registerEffectivePermissionResolver(createDbEffectivePermissionStore(db));
}

/**
 * Build the live `ActorEnrichmentReader` (M2 §4.7 enrichment, M3-owned path). Given an org scope +
 * user, it returns the actor's ACTIVE `membershipId` and current role keys (enabled + non-expired) —
 * the fields M2's session store can't read itself (membership_role/role are M3-owned). Runs under
 * `withOrgContext` so RLS scopes the read by `app.org_id`. Returns null when the user has no active
 * membership in the org. Role-expiry filtering matches the RBAC engine (§7.2): the actor's `roles`
 * reflect only currently-effective grants; the authoritative permission set still flows through the
 * effective-permission resolver.
 */
export function createDbActorEnrichmentReader(db: DbClient): ActorEnrichmentReader {
  return {
    async read(scope: OrgScope, userId: string): Promise<ActorEnrichment | null> {
      return withOrgContext(db, { organizationId: scope.orgId, userId }, async (tx) => {
        const memberships = await tx
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.userId, userId),
              eq(schema.memberships.organizationId, scope.orgId),
              eq(schema.memberships.status, "active"),
            ),
          )
          .limit(1);
        const membership = memberships[0];
        if (!membership) return null; // no active membership in this org → no actor context

        const roleRows = await tx
          .select({
            roleKey: schema.roles.key,
            enabled: schema.roles.enabled,
            expiresAt: schema.membershipRoles.expiresAt,
          })
          .from(schema.membershipRoles)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
          .where(eq(schema.membershipRoles.membershipId, membership.id));

        const now = Date.now();
        const roles = [
          ...new Set(
            roleRows
              .filter((r) => r.enabled && (r.expiresAt === null || r.expiresAt.getTime() > now))
              .map((r) => r.roleKey),
          ),
        ];
        return { membershipId: membership.id, roles };
      });
    },
  };
}
