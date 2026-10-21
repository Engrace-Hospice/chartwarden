// @chartwarden/db — `role` (M3 Authorization §3.4). A named set of permissions. Rows with
// organization_id NULL are **platform templates** (the ≈60 default roles, readable by
// all, writable only in platform context); a tenant clones/extends them into org-owned
// rows. `system_locked` roles are CoP-required and cannot be deleted or stripped below
// their permission floor (§3.4.1 / M03-F06). org_id is nullable here BY DESIGN (template
// rows) — RLS is the bespoke role policy in M3-T04, not the generic generator.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { roleCategory, scopeLevel } from "../enums";
import { organizations } from "./organizations";

export const roles = pgTable(
  "role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null = platform template (global, read-only to tenants); set = an org's own role.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    category: roleCategory("category").notNull(),
    scopeLevel: scopeLevel("scope_level").notNull().default("location"),
    systemDefault: boolean("system_default").notNull().default(false),
    systemLocked: boolean("system_locked").notNull().default(false), // CoP-required
    enabled: boolean("enabled").notNull().default(true),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKeyUnique: uniqueIndex("role_org_key_idx").on(t.organizationId, t.key),
    // 0320 — NULLs are distinct above, so platform-owned keys need their own uniqueness.
    platformKeyUnique: uniqueIndex("role_platform_key_idx")
      .on(t.key)
      .where(sql`${t.organizationId} IS NULL`),
    orgIdx: index("role_org_idx").on(t.organizationId),
    // GAP-003 (0318, widened by 0321; NOT VALID): platform authority lives only on platform-owned rows.
    platformAuthorityPlatformOwned: check(
      "role_platform_authority_platform_owned",
      sql`${t.organizationId} IS NULL OR (${t.key} NOT LIKE 'platform\\_%' AND ${t.key} <> 'ai_safety_owner' AND ${t.category} <> 'platform_staff')`,
    ),
  }),
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
