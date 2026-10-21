// apps/backend/src/bootstrap/f2f-clinician-roles.ts — GAP-022. Composition-root adapter for M6's
// `F2fClinicianRolePort`: which role keys does this USER actually hold in this org? The authority is the
// SAME one `request.context.roles` derives from (enabled roles on unexpired assignments, minus a reserved
// platform key carried by a tenant-owned row). Memberships / roles are M3's tables, so M6 gets this as an
// injected port rather than importing the schema (`arch:tables`). Role KEY strings only (minimum necessary).
import { roleConfersKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, isNull, or } from "drizzle-orm";

const MB = schema.memberships;
const MR = schema.membershipRoles;
const RO = schema.roles;

/** A read with no acting human (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export function buildF2fClinicianRoleReader(db: DbClient): {
  roleKeysForUser(organizationId: string, userId: string): Promise<readonly string[] | null>;
} {
  return {
    async roleKeysForUser(organizationId, userId) {
      const now = new Date();
      const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
        tx
          .select({
            roleKey: RO.key,
            roleOrganizationId: RO.organizationId,
            roleCategory: RO.category,
          })
          .from(MB)
          .leftJoin(
            MR,
            and(
              eq(MR.membershipId, MB.id),
              eq(MR.organizationId, organizationId),
              or(isNull(MR.expiresAt), gt(MR.expiresAt, now)),
            ),
          )
          .leftJoin(RO, and(eq(RO.id, MR.roleId), eq(RO.enabled, true)))
          .where(
            and(
              eq(MB.organizationId, organizationId),
              eq(MB.userId, userId),
              // ACTIVE only — a pending / suspended / revoked membership confers no role (consistent with
              // M30's member-roles reader).
              eq(MB.status, "active"),
            ),
          ),
      );
      if (rows.length === 0) return null;
      const keys = new Set<string>();
      for (const r of rows) {
        if (
          r.roleKey !== null &&
          r.roleCategory !== null &&
          roleConfersKey({
            organizationId: r.roleOrganizationId,
            key: r.roleKey,
            category: r.roleCategory,
          })
        )
          keys.add(r.roleKey);
      }
      return [...keys].sort();
    },
  };
}
