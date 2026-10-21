// @chartwarden/db — `extraction_decision` (M22 §3.3). The reviewer's per-candidate attestation
// (approve|approve_with_edit|reject) — the surveyor-defensible "every approved field is the
// reviewer's attestation" record (§1.4). Org-scoped; partial-UNIQUE per (candidate, review) gives
// one decision per candidate. `edited_value` / `reason` are DENYLISTED (§3.6 — PHI / free-form
// rationale). `extraction_review_id` carries a SQL FK; `extraction_candidate_id` is plain uuid
// (candidates are partitioned). The D4 high-risk-not-bulk rule is enforced service-side + by an
// INSERT trigger against the joined candidate row (cannot be a CHECK — it needs a cross-row read).
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { extractionDecisionKind } from "../../enums";
import { extractionReviews } from "./extraction-review";

export const extractionDecisions = pgTable(
  "extraction_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    extractionCandidateId: uuid("extraction_candidate_id").notNull(), // candidates partitioned → no FK
    extractionReviewId: uuid("extraction_review_id")
      .notNull()
      .references(() => extractionReviews.id),
    decision: extractionDecisionKind("decision").notNull(),
    editedValue: text("edited_value"), // DENYLISTED (§3.6)
    editedCode: text("edited_code"),
    sourceViewConfirmed: boolean("source_view_confirmed").notNull(),
    chartOverwriteConfirmed: boolean("chart_overwrite_confirmed"),
    reason: text("reason"), // DENYLISTED (§3.6)
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
