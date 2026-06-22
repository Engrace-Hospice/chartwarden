// @wardenx/db — `extraction_job` (M22 §3.3 / §2.2.6 / §7.1 W1). One DocLens extraction job per classified page,
// driven through the queued→extracting→verifying→…→committed machine (`awaiting_capability`/`stalled` are the
// M32-deny-stub / circuit-open parks). Org-scoped; carries no `patient_id` column. No denylisted columns.
// PARTITION BY RANGE (queued_at) monthly — the Drizzle shape here is logical (composite PK incl. the partition
// key); the PARTITION BY + monthly children + DEFAULT catch-all land in the RLS migration (0049). Because it is
// partitioned, references TO it (extraction_candidate.extraction_job_id) carry NO SQL FK — plain uuid
// app-validated. RLS + grants + the M4 write-audit trigger land in 0049.
import { decimal, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { classifiedPageDocType, extractionJobStatus } from "../../enums";
import { organizations } from "../organizations";
import { classifiedPages } from "./classified-pages";

export const extractionJobs = pgTable(
  "extraction_job",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with queued_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    classifiedPageId: uuid("classified_page_id")
      .notNull()
      .references(() => classifiedPages.id, { onDelete: "restrict" }),
    documentType: classifiedPageDocType("document_type").notNull(),
    status: extractionJobStatus("status").notNull().default("queued"),
    extractorModelVersionRef: text("extractor_model_version_ref").notNull(),
    visionVerifierModelVersionRef: text("vision_verifier_model_version_ref"),
    aggregateConfidence: decimal("aggregate_confidence", { precision: 4, scale: 3 }),
    retryCount: integer("retry_count").notNull().default(0),
    failureReason: text("failure_reason"),
    correlationId: text("correlation_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(), // partition key
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
