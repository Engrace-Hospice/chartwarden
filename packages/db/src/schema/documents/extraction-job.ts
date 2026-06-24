// @wardenx/db — `extraction_job` (M22 §3.3 / §2.2.6). The per-classified-page DocLens extraction
// job (queued→extracting→verifying→discrepancy_check→ready_for_review→…). Org-scoped; built-not-
// active until M32 lands (the DocLens seams ship as deny-stubs, §4.4). `classified_page_id` carries
// a SQL FK to `classified_page`.
//
// PARTITION BY RANGE (queued_at) monthly: the Drizzle definition here is the LOGICAL shape (composite
// PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land in 0049,
// which drops the plain table 0048 emits and re-creates it partitioned (M18 precedent). Because it is
// partitioned, references TO it (extraction_candidate.extraction_job_id) carry NO SQL FK — plain uuid.
import {
  decimal,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { classifiedPageDocType, extractionJobStatus } from "../../enums";
import { classifiedPages } from "./classified-page";

export const extractionJobs = pgTable(
  "extraction_job",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with queued_at (the partition key)
    organizationId: uuid("organization_id").notNull(),
    classifiedPageId: uuid("classified_page_id")
      .notNull()
      .references(() => classifiedPages.id),
    documentType: classifiedPageDocType("document_type").notNull(),
    status: extractionJobStatus("status").notNull().default("queued"),
    extractorModelVersionRef: text("extractor_model_version_ref").notNull(),
    visionVerifierModelVersionRef: text("vision_verifier_model_version_ref"),
    aggregateConfidence: decimal("aggregate_confidence", { precision: 4, scale: 3 }),
    retryCount: integer("retry_count").notNull().default(0),
    failureReason: text("failure_reason"),
    correlationId: text("correlation_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.queuedAt] }), // partition key must be in the PK
    byStatus: index("extraction_job_status_idx").on(t.status, t.queuedAt),
    byClassifiedPage: index("extraction_job_classified_page_idx").on(t.classifiedPageId),
  }),
);

export type ExtractionJob = typeof extractionJobs.$inferSelect;
export type NewExtractionJob = typeof extractionJobs.$inferInsert;
