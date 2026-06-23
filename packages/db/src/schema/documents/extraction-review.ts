// @wardenx/db — `extraction_review` (M22 §3.3 / §2.2.7). The per-batch reviewer session (in_progress
// →complete|abandoned) tracking decided-vs-total candidate counts. Org-scoped; partial-UNIQUE
// `(intake_upload_batch_id) WHERE status='in_progress'` enforces at-most-one open review per batch.
// `intake_upload_batch_id` carries a SQL FK.
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { extractionReviewStatus } from "../../enums";
import { intakeUploadBatches } from "./intake-upload-batch";

export const extractionReviews = pgTable(
  "extraction_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id),
    reviewerMembershipId: uuid("reviewer_membership_id").notNull(),
    status: extractionReviewStatus("status").notNull().default("in_progress"),
    candidatesTotal: integer("candidates_total").notNull().default(0),
    candidatesDecided: integer("candidates_decided").notNull().default(0),
    correlationId: text("correlation_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    oneInProgressPerBatch: uniqueIndex("extraction_review_in_progress_uk")
      .on(t.intakeUploadBatchId)
      .where(sql`status = 'in_progress'`),
  }),
);

export type ExtractionReview = typeof extractionReviews.$inferSelect;
export type NewExtractionReview = typeof extractionReviews.$inferInsert;
