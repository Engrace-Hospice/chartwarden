// apps/backend/src/modules/34-saas-tenant-platform/alert-resolver-ports.ts — GAP-057.
//
// Binds {@link M34AlertResolverPorts} for the composition root, so `registerM34AlertResolvers` can put
// `compliance_officer_for_tenant` / `platform_security_owner` onto M36's resolver registry.
//
//  - `complianceOfficersForOrg` is the SAME org-scoped membership_role join M36's built-in `role_set`
//    resolver uses (injected by the composition root: M34 does not import M36).
//  - `platformSecurityOwners` is PLATFORM-scoped: users bound to a platform-OWNED role row in whichever
//    org they hold a membership in. Tenant RLS hides that set from the app pool, so it goes through the
//    migration-0740 SECURITY DEFINER `m34_platform_role_holders` function (user ids only, platform-owned
//    roles only). Delivery caveat: the notification rows live in the emit-org, so the in-app inbox is not
//    visible from the owner's own org; out-of-band channels (push/email) reach them.
import type { DbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import type { RecipientResolverFn } from "@wardenx/messaging";
import { type M34AlertResolverPorts, registerM34AlertResolvers } from "./alert-rules";

export interface M34AlertResolverBindings {
  readonly roleSetMembers: (
    orgId: string,
    roleKeys: readonly string[],
  ) => Promise<readonly string[]>;
}

/** Build the production {@link M34AlertResolverPorts} over `db`. */
export function createDrizzleM34AlertResolverPorts(
  db: DbClient,
  bindings: M34AlertResolverBindings,
): M34AlertResolverPorts {
  return {
    complianceOfficersForOrg: (orgId, roleKeys) => bindings.roleSetMembers(orgId, roleKeys),
    async platformSecurityOwners(roleKeys) {
      if (roleKeys.length === 0) return [];
      const result = await db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM m34_platform_role_holders(${roleKeys as string[]}::text[])`,
      );
      return result.rows.map((r) => r.user_id);
    },
  };
}

/** The `AlertEmitterPorts.extendResolvers` hook that registers M34's two resolvers. */
export function m34ResolverExtension(
  ports: M34AlertResolverPorts,
): (registry: Map<string, RecipientResolverFn>) => void {
  return (registry) => {
    registerM34AlertResolvers(registry, ports);
  };
}
