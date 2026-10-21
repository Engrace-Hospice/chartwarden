// @chartwarden/db — `hope_retention_review` (M10 `hope-retention-scan`, GAP-181). One row per (organization,
// patient): the retention horizon the monthly scan computed for the patient's HOPE record and whether the
// record is FLAGGED eligible for M4-certified destruction, BLOCKED (legal hold / open iQIES error / pending
// correction) or cleared again. The scan only flags; destruction stays on the M4 destruction-certificate
// pathway. RLS + grants + the M4 write-audit trigger land in migration 0482.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const hopeRetentionReviews = pgTable(
  "hope_retention_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    /** `submitted_cms_10y` (10 years from last iQIES transmission) | `standard_7y` (7 years from last effective date). */
    basis: text("basis").notNull(),
    anchorAt: timestamp("anchor_at", { withTimezone: true }).notNull(),
    retentionYears: integer("retention_years").notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    /** `eligible` (flagged for certified destruction) | `blocked` | `cleared` (not yet / no longer due). */
    status: text("status").notNull(),
    blockers: text("blockers").array().notNull().default([]),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientUq: uniqueIndex("hope_retention_review_patient_uq").on(t.organizationId, t.patientId),
    statusIdx: index("hope_retention_review_status_idx").on(
      t.organizationId,
      t.status,
      t.eligibleAt,
    ),
  }),
);

export type HopeRetentionReview = typeof hopeRetentionReviews.$inferSelect;
export type NewHopeRetentionReview = typeof hopeRetentionReviews.$inferInsert;
