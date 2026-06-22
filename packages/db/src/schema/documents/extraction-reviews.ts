// @wardenx/db — `extraction_review` (M22 §3.3 / §2.2.6). One reviewer session per intake batch; at most one
// in_progress review per batch (partial-UNIQUE WHERE status='in_progress'). Org-scoped; carries no `patient_id`
// column. No denylisted columns. RLS + grants + the M4 write-audit trigger land in 0049.
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { extractionReviewStatus } from "../../enums";
import { organizations } from "../organizations";
import { intakeUploadBatches } from "./intake-upload-batches";

export const extractionReviews = pgTable(
  "extraction_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id, { onDelete: "restrict" }),
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
