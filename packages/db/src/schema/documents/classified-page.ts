import { sql } from "drizzle-orm";
// @wardenx/db — `classified_page` (M22 §3.3 / §2.2.6). The per-page classifier output: a page range
// of an intake source labeled with a document type + confidence. Org-scoped (joins to PHI via the
// batch). Two CHECK shape guards (page-range ordering; human-confirm pairing). `intake_upload_batch_id`
// carries a SQL FK to `intake_upload_batch`; `source_document_id` is plain uuid app-validated.
import {
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { classifiedPageDocType } from "../../enums";
import { intakeUploadBatches } from "./intake-upload-batch";

export const classifiedPages = pgTable(
  "classified_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id),
    sourceDocumentId: uuid("source_document_id").notNull(),
    pageRangeStart: integer("page_range_start").notNull(),
    pageRangeEnd: integer("page_range_end").notNull(),
    documentType: classifiedPageDocType("document_type").notNull(),
    confidence: decimal("confidence", { precision: 4, scale: 3 }).notNull(),
    humanConfirmed: boolean("human_confirmed").notNull().default(false),
    humanConfirmedByMembershipId: uuid("human_confirmed_by_membership_id"),
    humanConfirmedAt: timestamp("human_confirmed_at", { withTimezone: true }),
    classifierModelVersionRef: text("classifier_model_version_ref").notNull(),
    // per-page processing-failure class, e.g. 'docling_parse_failed' (W1 AC); null on success.
    errorClass: text("error_class"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
    // F-238 (0309) — the fax splitter's document segment. `document_title` is audit-denylisted (a header
    // can name a Part 2 program); `document_date` is the date codes written in this document are judged by.
    documentTitle: text("document_title"),
    documentDate: date("document_date"),
    duplicateOfPage: integer("duplicate_of_page"),
    segmentBoundary: text("segment_boundary"),
    // F-238 (0312) — does this document belong to the patient the fax is filed under (two identifiers)?
    // `identity_disagreeing` lists FIELD names only; the resolution reason is audit-denylisted.
    identityStatus: text("identity_status"),
    identityDisagreeing: jsonb("identity_disagreeing").$type<string[]>(),
    identityResolution: text("identity_resolution"),
    identityResolvedByMembershipId: uuid("identity_resolved_by_membership_id"),
    identityResolvedAt: timestamp("identity_resolved_at", { withTimezone: true }),
    identityResolutionReason: text("identity_resolution_reason"),
  },
  (t) => ({
    byBatch: index("classified_page_batch_idx").on(t.intakeUploadBatchId, t.pageRangeStart),
    pageRangeShape: check("classified_page_range_shape", sql`page_range_end >= page_range_start`),
    humanConfirmShape: check(
      "classified_page_human_confirm_shape",
      sql`(human_confirmed = true) = (human_confirmed_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type ClassifiedPage = typeof classifiedPages.$inferSelect;
export type NewClassifiedPage = typeof classifiedPages.$inferInsert;
