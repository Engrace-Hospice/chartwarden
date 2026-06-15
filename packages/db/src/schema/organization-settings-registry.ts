// @wardenx/db — `organization_settings_registry` (M1 Foundation §3.12 / D6).
// Platform-shared, boot-populated registry of the keys modules may store under
// `organization.settings`, with the collision guard that rejects two modules
// claiming the same uniqueAcrossTenants key (W-M1-08). NON_ORG_SCOPED in
// check-tenancy.ts — platform reference data, written via the platform role.
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const organizationSettingsRegistry = pgTable("organization_settings_registry", {
  settingsKey: text("settings_key").primaryKey(),
  registeredByModule: text("registered_by_module").notNull(),
  description: text("description").notNull(),
  registryEntryJson: jsonb("registry_entry_json").notNull(),
  registeredAt: timestamp("registered_at").notNull().defaultNow(),
});

export type OrganizationSettingsRegistryEntry = typeof organizationSettingsRegistry.$inferSelect;
export type NewOrganizationSettingsRegistryEntry = typeof organizationSettingsRegistry.$inferInsert;
