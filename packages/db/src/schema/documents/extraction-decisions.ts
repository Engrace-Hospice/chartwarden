// @wardenx/db — `extraction_decision` (M22 §3.3 / §2.2.6 D4). One reviewer decision per (candidate, review):
// approve / approve_with_edit / reject, with the source-view + chart-overwrite confirmations. Org-scoped;
// carries no `patient_id` column. `edited_value` + `reason` are DENYLISTED in the §3.6 write-audit trigger. The
// candidate reference carries NO SQL FK (extraction_candidate is partitioned) — plain uuid app-validated; the
// review reference is FK'd. The D4 "high-risk candidate cannot be part of a bulk approve" rule cannot be a CHECK
// (it depends on the joined candidate row) — enforced at the service layer + an INSERT trigger (M22-T07/T08).
// RLS + grants + the M4 write-audit trigger land in 0049.
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { extractionDecisionKind } from "../../enums";
import { organizations } from "../organizations";
import { extractionReviews } from "./extraction-reviews";

export const extractionDecisions = pgTable(
  "extraction_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractionCandidateId: uuid("extraction_candidate_id").notNull(), // app-validated (candidate partitioned)
    extractionReviewId: uuid("extraction_review_id")
      .notNull()
      .references(() => extractionReviews.id, { onDelete: "restrict" }),
    decision: extractionDecisionKind("decision").notNull(),
    editedValue: text("edited_value"), // → DENYLISTED (§3.6)
    editedCode: text("edited_code"),
    sourceViewConfirmed: boolean("source_view_confirmed").notNull(),
    chartOverwriteConfirmed: boolean("chart_overwrite_confirmed"),
    reason: text("reason"), // → DENYLISTED (§3.6)
    partOfBulkApprove: boolean("part_of_bulk_approve").notNull().default(false),
    bulkApproveBatchId: uuid("bulk_approve_batch_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneDecisionPerCandidate: uniqueIndex("extraction_decision_per_candidate_uk").on(
      t.extractionCandidateId,
      t.extractionReviewId,
    ),
  }),
);

export type ExtractionDecision = typeof extractionDecisions.$inferSelect;
export type NewExtractionDecision = typeof extractionDecisions.$inferInsert;
