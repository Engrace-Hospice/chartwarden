// M3 (Authorization) — "who could act?" for a set of permissions.
//
// F-204 (#248): a two-person control (M11's lab-transmission recovery) needs a SECOND person, and M11 owns neither the
// membership nor the role tables, so "does anyone else in this organization hold one of these keys?" is answered in two
// halves that each read only their own tables (the same split `createDbAdminMembershipReader` uses): THIS half returns
// the ids of the memberships that hold ANY of `permissionKeys` through an ENABLED, UNEXPIRED role assignment; the
// composition root's Foundation half (`bootstrap/m11-cosigner-counter.ts`) resolves those to distinct ACTIVE users other
// than the requester. Read under the caller's org context, so RLS scopes it and another tenant's holders are never
// visible. The result is a hint for a friendlier refusal, not an authorization decision: the co-sign itself re-checks
// the caller's permission.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";

export type MembershipsHoldingPermissionReader = (
  organizationId: string,
  permissionKeys: readonly string[],
) => Promise<ReadonlySet<string>>;

export function createMembershipsHoldingPermissionReader(
  db: DbClient,
): MembershipsHoldingPermissionReader {
  return (organizationId, permissionKeys) => {
    if (permissionKeys.length === 0) return Promise.resolve(new Set<string>());
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const res = await tx.execute(sql`
        SELECT DISTINCT mr.membership_id AS membership_id
          FROM membership_role mr
          JOIN role ro ON ro.id = mr.role_id AND ro.enabled
          JOIN role_permission rp ON rp.role_id = ro.id
         WHERE mr.organization_id = ${organizationId}
           AND (mr.expires_at IS NULL OR mr.expires_at > now())
           AND rp.permission_key IN (${sql.join(
             permissionKeys.map((k) => sql`${k}`),
             sql`, `,
           )})`);
      const rows = (res as unknown as { rows?: Array<{ membership_id?: string }> }).rows ?? [];
      return new Set(rows.flatMap((r) => (r.membership_id ? [r.membership_id] : [])));
    });
  };
}

/** M3's half of "who holds role X?": the membership ids granted an ENABLED, UNEXPIRED role with this key (M30 mortality
 *  review assignment). The Foundation half narrows to ACTIVE memberships of a provider entity
 *  (`bootstrap/m30-mortality-reviewer-resolver.ts`) because `membership` is M2's table, not M3's. */
export type MembershipsHoldingRoleKeyReader = (
  organizationId: string,
  roleKey: string,
) => Promise<readonly string[]>;

export function createMembershipsHoldingRoleKeyReader(
  db: DbClient,
): MembershipsHoldingRoleKeyReader {
  return (organizationId, roleKey) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const res = await tx.execute(sql`
        SELECT DISTINCT mr.membership_id AS membership_id
          FROM membership_role mr
          JOIN role ro ON ro.id = mr.role_id AND ro.enabled
         WHERE mr.organization_id = ${organizationId}
           AND ro.key = ${roleKey}
           AND (mr.expires_at IS NULL OR mr.expires_at > now())`);
      const rows = (res as unknown as { rows?: Array<{ membership_id?: string }> }).rows ?? [];
      return rows.flatMap((r) => (r.membership_id ? [r.membership_id] : []));
    });
}
