// @wardenx/db — `classified_page` (M22 §3.3 / §2.1). The per-page classifier output for an intake batch: a page
// range, a document-type label + confidence, and the human-confirmation overlay. Org-scoped; carries no
// `patient_id` column (joinable to PHI only via the batch). No denylisted columns. Two CHECK invariants
// (page-range ordering; human-confirm shape). RLS + grants + the M4 write-audit trigger land in 0049.
import { boolean, check, decimal, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { classifiedPageDocType } from "../../enums";
import { organizations } from "../organizations";
import { intakeUploadBatches } from "./intake-upload-batches";

export const classifiedPages = pgTable(
  "classified_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id, { onDelete: "restrict" }),
    sourceDocumentId: uuid("source_document_id").notNull(),
    pageRangeStart: integer("page_range_start").notNull(),
    pageRangeEnd: integer("page_range_end").notNull(),
    documentType: classifiedPageDocType("document_type").notNull(),
    confidence: decimal("confidence", { precision: 4, scale: 3 }).notNull(),
    humanConfirmed: boolean("human_confirmed").notNull().default(false),
    humanConfirmedByMembershipId: uuid("human_confirmed_by_membership_id"),
    humanConfirmedAt: timestamp("human_confirmed_at", { withTimezone: true }),
    classifierModelVersionRef: text("classifier_model_version_ref").notNull(),
    // per-page processing-failure class, e.g. 'docling_parse_failed' (W1 AC); null on success
    errorClass: text("error_class"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBatch: index("classified_page_batch_idx").on(t.intakeUploadBatchId, t.pageRangeStart),
    pageRangeShape: check(
      "classified_page_range_shape",
      sql`page_range_end >= page_range_start`,
    ),
    humanConfirmShape: check(
      "classified_page_human_confirm_shape",
      sql`(human_confirmed = true) = (human_confirmed_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type ClassifiedPage = typeof classifiedPages.$inferSelect;
export type NewClassifiedPage = typeof classifiedPages.$inferInsert;
