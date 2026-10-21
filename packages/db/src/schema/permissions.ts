// @chartwarden/db — `permission` (M3 Authorization §3.3). The read-only **mirror** of the
// code-owned permission catalog (packages/auth/src/permissions/catalog.ts — the source
// of truth). The table exists for admin-UI listing and as the FK target for
// `role_permission.permission_key`; it is refreshed from the catalog on deploy via
// `permissionMirrorRows()`. Platform-global reference: no organization_id, read-all
// (opted into the NON_ORG_SCOPED allowlist in check-tenancy.ts; spec §3.6).
import { pgTable, text } from "drizzle-orm/pg-core";

export const permissions = pgTable("permission", {
  key: text("key").primaryKey(),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  category: text("category").notNull(),
  defaultAbac: text("default_abac"), // predicate name or 'none'
  description: text("description").notNull().default(""),
});

export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
