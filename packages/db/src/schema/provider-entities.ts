// @wardenx/db — `provider_entity` (M1 Foundation §3.4). Second level of the tenancy
// spine (the Medicare-certified provider under an organization). NON_ORG_SCOPED in
// check-tenancy.ts: it carries organization_id but defines provider scope.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { providerEntityStatus } from "../enums";
import { organizations } from "./organizations";

export const providerEntities = pgTable(
  "provider_entity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ccn: text("ccn").notNull(),
    legalName: text("legal_name").notNull(),
    doingBusinessAs: text("doing_business_as"),
    fiscalIntermediary: text("fiscal_intermediary"),
    npi: text("npi").notNull(),
    taxIdEncrypted: text("tax_id_encrypted").notNull(),
    fiscalYearEnd: text("fiscal_year_end").notNull(), // 'MMDD'
    addresses: jsonb("addresses").notNull().default([]),
    // CMS iQIES facility ID (HOPE control item FAC_ID); assigned at iQIES registration (migration 0235).
    iqiesFacilityId: text("iqies_facility_id"),
    status: providerEntityStatus("status").notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ccnUniqueIdx: uniqueIndex("provider_entity_ccn_idx").on(t.ccn),
    npiUniqueIdx: uniqueIndex("provider_entity_npi_idx").on(t.npi),
    orgIdx: index("provider_entity_org_idx").on(t.organizationId),
  }),
);

export type ProviderEntity = typeof providerEntities.$inferSelect;
export type NewProviderEntity = typeof providerEntities.$inferInsert;
