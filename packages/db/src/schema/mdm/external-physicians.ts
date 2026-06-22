// @wardenx/db — `external_physician` (M40 MDM §3.3). The CANONICAL physician record:
// one org-less row per real-world NPI, registry-sourced (NPPES), the same answer for every
// tenant (§2.3). Carries NO organization_id by design — it is platform-shared master data on
// the check-tenancy NON_ORG_SCOPED allowlist; this-tenant opinions (preferred contact,
// do-not-refer, relationship notes) live in the org-scoped overlay (external-physicians-overlay.ts).
// `npi` is UNIQUE where non-null (nullable for provisional rows); a `merged` row carries a
// non-null `merged_into_id` and redirects transparently to its survivor (§2.4.1, §7.2). The
// canonical/overlay two-table RLS pattern + the `mdm_canonical_writer` role land in M40-T03
// (§3.6); this task is schema only. Not PHI (provider master data, no patient field).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mdmEntityStatus } from "../../enums";

export const externalPhysicians = pgTable(
  "external_physician",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    npi: text("npi"), // UNIQUE where non-null; nullable for provisional
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    credentials: text("credentials"), // 'MD' | 'DO' | 'NP' | 'PA-C' | ...
    isNp: boolean("is_np").notNull().default(false),
    specialtyTaxonomy: text("specialty_taxonomy"), // NUCC taxonomy
    licenseStates: text("license_states").array(), // ['OR','WA']
    primaryAddress: jsonb("primary_address"),
    contactMethods: jsonb("contact_methods").notNull().default({}),
    status: mdmEntityStatus("status").notNull().default("active"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => externalPhysicians.id, {
      onDelete: "restrict",
    }),
    mergedFrom: uuid("merged_from").array().notNull().default(sql`'{}'::uuid[]`),
    nppesLastSyncedAt: timestamp("nppes_last_synced_at", { withTimezone: true }),
    nppesProvenance: jsonb("nppes_provenance").$type<{
      lastSyncedAt: string;
      lastSyncSource: "m29_platform_sync" | "m40_legacy_nightly" | "m40_on_demand_lookup";
      lastSyncRunId?: string;
      lastChangedFields: readonly string[];
      deactivationSource?: "m29_platform_sync_nppes" | "m40_legacy_nightly" | "admin";
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    npiUniqueIdx: uniqueIndex("external_physician_npi_idx").on(t.npi).where(sql`npi IS NOT NULL`),
    nameTrgmIdx: index("external_physician_name_trgm_idx").using(
      "gin",
      sql`(first_name || ' ' || last_name) gin_trgm_ops`,
    ),
    statusIdx: index("external_physician_status_idx").on(t.status),
    mergedIdx: index("external_physician_merged_idx")
      .on(t.mergedIntoId)
      .where(sql`merged_into_id IS NOT NULL`),
    provenanceSourceIdx: index("idx_external_physician_nppes_provenance_source")
      .on(sql`(nppes_provenance->>'lastSyncSource')`)
      .where(sql`nppes_provenance IS NOT NULL`),
    npiFormat: check("external_physician_npi_format", sql`npi IS NULL OR npi ~ '^[0-9]{10}$'`),
    mergedConsistency: check(
      "external_physician_merged_consistency",
      sql`(status = 'merged') = (merged_into_id IS NOT NULL)`,
    ),
  }),
);

export type ExternalPhysician = typeof externalPhysicians.$inferSelect;
export type NewExternalPhysician = typeof externalPhysicians.$inferInsert;
