// @wardenx/db — `facility` (M40 MDM §3.3). The CANONICAL facility record: one org-less row
// per real-world facility, keyed by CCN and/or NPI (each UNIQUE where non-null). `kind` is the
// §3.3 facility subtype. `sending_facility_codes` carries the HL7 MSH-4 sending-facility codes
// that anchor inbound-message routing + the §7.9/§7.10 BAA gate (gin-indexed for containment
// lookups). A `merged` row redirects to its survivor via `merged_into_id` (§2.4.1, §7.2).
// Canonical → no organization_id (NON_ORG_SCOPED allowlist); facility has no Phase-1 overlay
// table (manifest owns 11 tables). RLS/grants/audit triggers land in M40-T03 (§3.6). Not PHI.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { facilityKind, mdmEntityStatus } from "../../enums";

export const facilities = pgTable(
  "facility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ccn: text("ccn"), // UNIQUE where non-null
    npi: text("npi"), // UNIQUE where non-null
    kind: facilityKind("kind").notNull(),
    name: text("name").notNull(),
    primaryAddress: jsonb("primary_address"),
    sendingFacilityCodes: jsonb("sending_facility_codes")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    status: mdmEntityStatus("status").notNull().default("active"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => facilities.id, {
      onDelete: "restrict",
    }),
    mergedFrom: uuid("merged_from").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ccnUniqueIdx: uniqueIndex("facility_ccn_idx").on(t.ccn).where(sql`ccn IS NOT NULL`),
    npiUniqueIdx: uniqueIndex("facility_npi_idx").on(t.npi).where(sql`npi IS NOT NULL`),
    nameTrgmIdx: index("facility_name_trgm_idx").using("gin", sql`name gin_trgm_ops`),
    addrTrgmIdx: index("facility_addr_trgm_idx").using(
      "gin",
      sql`(primary_address->>'line1') gin_trgm_ops`,
    ),
    sendingCodesGinIdx: index("idx_facility_sending_facility_codes_gin").using(
      "gin",
      t.sendingFacilityCodes,
    ),
    ccnFormat: check("facility_ccn_format", sql`ccn IS NULL OR ccn ~ '^[0-9A-Z]{6,10}$'`),
    mergedConsistency: check(
      "facility_merged_consistency",
      sql`(status = 'merged') = (merged_into_id IS NOT NULL)`,
    ),
  }),
);

export type Facility = typeof facilities.$inferSelect;
export type NewFacility = typeof facilities.$inferInsert;
