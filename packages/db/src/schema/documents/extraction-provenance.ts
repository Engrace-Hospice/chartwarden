// @wardenx/db — `extraction_provenance` (M22 §3.3 / AI Governance §8.3). The committed-extraction audit trail:
// one row per committed `extraction_decision`, linking the source document/page/bbox + the model versions to the
// chart target it wrote. Itself a compliance-class record — it SURVIVES the intake_artifact eraser (the source
// document may be destroyed, but the provenance link is preserved for survey reconstruction; §3.7). Org-scoped;
// carries no `patient_id` column. `source_bounding_box` + `target_field_path` are DENYLISTED in the §3.6
// write-audit trigger. Only the decision reference is FK'd (candidate is partitioned; the source-document
// references are app-validated and may outlive the document). RLS + grants + the M4 write-audit trigger land in
// 0049.
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chartTargetModule } from "../../enums";
import { organizations } from "../organizations";
import { extractionDecisions } from "./extraction-decisions";

export const extractionProvenance = pgTable(
  "extraction_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractionDecisionId: uuid("extraction_decision_id")
      .notNull()
      .references(() => extractionDecisions.id, { onDelete: "restrict" }),
    extractionCandidateId: uuid("extraction_candidate_id").notNull(), // app-validated (candidate partitioned)
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceDocumentVersionId: uuid("source_document_version_id").notNull(),
    sourcePage: integer("source_page").notNull(),
    sourceBoundingBox: jsonb("source_bounding_box").notNull(), // → DENYLISTED (§3.6)
    classifierModelVersionRef: text("classifier_model_version_ref").notNull(),
    extractorModelVersionRef: text("extractor_model_version_ref").notNull(),
    visionVerifierModelVersionRef: text("vision_verifier_model_version_ref"),
    targetModule: chartTargetModule("target_module").notNull(),
    targetFieldPath: text("target_field_path").notNull(), // field-paths may reveal context → DENYLISTED (§3.6)
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
