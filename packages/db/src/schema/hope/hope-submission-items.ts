// @wardenx/db — `hope_submission_item` (M10 §3.3). A submission↔assessment join row recording one
// assessment's per-item iQIES outcome (pending→accepted/rejected) within a hope_submission batch.
// Outside the PHI three-column rule (a join row, §3.3 tenancy note) → carries organization_id only (for
// RLS) + an intra-module FK to hope_submission. The hope_assessment link is a plain uuid (the parent is
// partitioned — a composite-PK FK is impractical). An assessment may appear in only one pending
// submission at a time (idempotency, partial unique index). RLS + grants + the M4 write-audit trigger
// (iqies_validation_result denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hopeSubmissionItemStatus } from "../../enums";
import { organizations } from "../organizations";
import { hopeSubmissions } from "./hope-submissions";

export const hopeSubmissionItems = pgTable(
  "hope_submission_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    hopeSubmissionId: uuid("hope_submission_id")
      .notNull()
      .references(() => hopeSubmissions.id, { onDelete: "restrict" }),
    hopeAssessmentId: uuid("hope_assessment_id").notNull(), // M10 hope_assessment (logical; parent partitioned)
    itemStatus: hopeSubmissionItemStatus("item_status").notNull().default("pending"),
    iqiesRecordId: text("iqies_record_id"),
    iqiesValidationResult: jsonb("iqies_validation_result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySubmission: index("idx_hope_sub_item_submission").on(t.hopeSubmissionId, t.itemStatus),
    byAssessment: index("idx_hope_sub_item_assessment").on(t.hopeAssessmentId),
    // Idempotency: an assessment can appear in only one pending submission at a time.
    uniqueAssessmentActive: uniqueIndex("uniq_hope_sub_item_assessment_active")
      .on(t.hopeAssessmentId)
      .where(sql`item_status = 'pending'`),
  }),
);

export type HopeSubmissionItem = typeof hopeSubmissionItems.$inferSelect;
export type NewHopeSubmissionItem = typeof hopeSubmissionItems.$inferInsert;
