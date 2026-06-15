// @wardenx/db — `audit_action_catalog` (M4 Audit §3.5, §4.6). Platform-shared registry of every
// auditable action keyed by action name: which module owns it, its default retention class, the
// denylist categories it implies, and whether it is Part 2–eligible. M4 boot-validates owner-module
// actions against this catalog (§4.6.7). NON_ORG_SCOPED platform reference, read-all (writes via M4
// boot/migration under the platform role; check-tenancy allowlist).
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { auditRetentionClass, phiDenylistCategory } from "../enums";

export const auditActionCatalog = pgTable("audit_action_catalog", {
  action: text("action").primaryKey(),
  moduleOwner: text("module_owner").notNull(),
  defaultRetentionClass: auditRetentionClass("default_retention_class").notNull(),
  description: text("description").notNull(),
  denylistCategories: phiDenylistCategory("denylist_categories").array().notNull().default([]),
  isPartTwoEligible: boolean("is_part_two_eligible").notNull().default(false),
  registeredAt: timestamp("registered_at").notNull().defaultNow(),
});

export type AuditActionCatalogEntry = typeof auditActionCatalog.$inferSelect;
export type NewAuditActionCatalogEntry = typeof auditActionCatalog.$inferInsert;
