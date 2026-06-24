// @wardenx/db — `extraction_provenance` (M22 §3.3 / §3.4). The "what extraction produced this chart
// row?" surveyor record: one per committed decision, binding source document/page/bbox + model
// versions to the target module field path + draft aggregate. Org-scoped; `source_bounding_box` /
// `target_field_path` are DENYLISTED (§3.6 — structural; field-paths may reveal clinical context).
// `extraction_decision_id` carries a SQL FK; source/candidate/target ids are plain uuid app-validated.
import { index, jsonb, pgTable, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chartTargetModule } from "../../enums";
import { extractionDecisions } from "./extraction-decision";

export const extractionProvenance = pgTable(
  "extraction_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    extractionDecisionId: uuid("extraction_decision_id")
      .notNull()
      .references(() => extractionDecisions.id),
    extractionCandidateId: uuid("extraction_candidate_id").notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceDocumentVersionId: uuid("source_document_version_id").notNull(),
    sourcePage: integer("source_page").notNull(),
    sourceBoundingBox: jsonb("source_bounding_box").notNull(), // DENYLISTED (§3.6)
    classifierModelVersionRef: text("classifier_model_version_ref").notNull(),
    extractorModelVersionRef: text("extractor_model_version_ref").notNull(),
    visionVerifierModelVersionRef: text("vision_verifier_model_version_ref"),
    targetModule: chartTargetModule("target_module").notNull(),
    targetFieldPath: text("target_field_path").notNull(), // DENYLISTED (§3.6)
    targetAggregateId: uuid("target_aggregate_id"), // populated after target module creates draft
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDecision: uniqueIndex("extraction_provenance_decision_uk").on(t.extractionDecisionId),
    byTargetAggregate: index("extraction_provenance_target_idx").on(
      t.targetModule,
      t.targetAggregateId,
    ),
    bySourceDocument: index("extraction_provenance_source_idx").on(t.sourceDocumentId),
  }),
);

export type ExtractionProvenance = typeof extractionProvenance.$inferSelect;
export type NewExtractionProvenance = typeof extractionProvenance.$inferInsert;
