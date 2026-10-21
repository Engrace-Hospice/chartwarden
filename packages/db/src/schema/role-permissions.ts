// @chartwarden/db — `role_permission` (M3 Authorization §3.4). The join from a role to the
// permission keys it grants. M03-F05: a **denormalized** organization_id (= the parent
// role's org; NULL only for platform templates) so RLS is well-defined — without it the
// generic generator would emit a predicate against a missing column. This table gets a
// **bespoke** RLS pair in M3-T04 (read own+template, write own only), so it is exempt
// from the generic wardenx_enable_rls() generator (§3.4 note / §3.6).
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { permissions } from "./permissions";
import { roles } from "./roles";

export const rolePermissions = pgTable(
  "role_permission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // = parent role's org; NULL only for platform-template rows (read-only to tenants).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key),
    abacOverride: text("abac_override"), // optional stricter predicate than catalog default
  },
  (t) => ({
    rolePermUnique: uniqueIndex("role_permission_idx").on(t.roleId, t.permissionKey),
    orgIdx: index("role_permission_org_idx").on(t.organizationId),
  }),
);

export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
