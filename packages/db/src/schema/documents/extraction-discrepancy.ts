// @wardenx/db — `extraction_discrepancy` (M22 §3.3). A cross-source or chart-existing disagreement
// surfaced during extraction review. Org-scoped; the CHECK enforces the two legal shapes (cross-
// source needs candidate_b + no chart value; chart-existing needs a chart value + target module +
// no candidate_b). `chart_existing_value` / `resolution_value` are DENYLISTED (§3.6 — PHI).
// `intake_upload_batch_id` carries a SQL FK; candidate ids are plain uuid (candidates are partitioned).
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  chartTargetModule,
  extractionDiscrepancyKind,
  extractionDiscrepancyStatus,
} from "../../enums";
import { intakeUploadBatches } from "./intake-upload-batch";

export const extractionDiscrepancies = pgTable(
  "extraction_discrepancy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id),
    discrepancyKind: extractionDiscrepancyKind("discrepancy_kind").notNull(),
    fieldPath: text("field_path").notNull(),
    candidateAId: uuid("candidate_a_id").notNull(),
    candidateBId: uuid("candidate_b_id"), // null for chart_existing
    chartExistingValue: text("chart_existing_value"), // null for cross_source; DENYLISTED (§3.6)
    chartTargetModule: chartTargetModule("chart_target_module"),
    status: extractionDiscrepancyStatus("status").notNull().default("open"),
    resolution: text("resolution"),
    resolutionValue: text("resolution_value"), // DENYLISTED (§3.6)
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBatch: index("extraction_discrepancy_batch_idx").on(t.intakeUploadBatchId, t.status),
    shape: check(
      "extraction_discrepancy_shape",
      sql`(discrepancy_kind = 'cross_source' AND candidate_b_id IS NOT NULL AND chart_existing_value IS NULL)
        OR
        (discrepancy_kind = 'chart_existing' AND candidate_b_id IS NULL AND chart_existing_value IS NOT NULL AND chart_target_module IS NOT NULL)`,
    ),
  }),
);

export type ExtractionDiscrepancy = typeof extractionDiscrepancies.$inferSelect;
export type NewExtractionDiscrepancy = typeof extractionDiscrepancies.$inferInsert;
