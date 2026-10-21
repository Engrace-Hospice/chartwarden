// @chartwarden/db — `cahps_vendor_binding` (M30 §3.3; non-partitioned; retention class `compliance`).
// The per-org binding to an approved CAHPS Hospice survey vendor (or `manual`), carrying the
// envelope-encrypted vendor credentials and the size-exemption determination. At most one active
// binding per org (V-7 partial-unique). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id
// RLS). `configuration_cipher` is ciphertext → audit-denylisted (§3.6).
import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const cahpsVendorBinding = pgTable(
  "cahps_vendor_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vendorAdapterId: text("vendor_adapter_id").notNull(), // V-6 — 'shp'|'press_ganey'|'deyta'|'healthcarefirst'|'manual'
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    configurationCipher: text("configuration_cipher").notNull(), // envelope-encrypted; DENYLISTED (§3.6)
    configurationKeyVersion: integer("configuration_key_version").notNull(),
    sizeExemptionFlag: boolean("size_exemption_flag").notNull().default(false),
    sizeExemptionLastDeterminedAt: timestamp("size_exemption_last_determined_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqActive: uniqueIndex("uq_cahps_binding_active_per_org")
      .on(t.organizationId)
      .where(sql`active = true`), // V-7
  }),
);

export type CahpsVendorBinding = typeof cahpsVendorBinding.$inferSelect;
export type NewCahpsVendorBinding = typeof cahpsVendorBinding.$inferInsert;
