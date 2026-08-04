import { sql } from "drizzle-orm";
// @wardenx/db — `extraction_candidate` (M22 §3.3 / §2.2.6). One per extracted field: the value,
// risk level, source bounding box, vision-verification + SUD-detection flags. Org-scoped; the PHI
// value lives DEK-encrypted in `value_cipher` (or `value_text`); `value_text` / `value_cipher` /
// `vision_disagreement` / `source_bounding_box` are DENYLISTED in the audit trigger (§3.6). The CHECK
// asserts the bounding box has all four corner keys. `extraction_job_id` is plain uuid (the parent
// `extraction_job` is partitioned — no SQL FK).
//
// PARTITION BY RANGE (extracted_at) monthly: the Drizzle definition here is the LOGICAL shape
// (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all
// land in 0049, which drops the plain table 0048 emits and re-creates it partitioned (M18 precedent).
import {
  boolean,
  check,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  extractionCandidateCodeSystem,
  extractionCandidateFieldKind,
  extractionCandidateRiskLevel,
} from "../../enums";

export const extractionCandidates = pgTable(
  "extraction_candidate",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with extracted_at (the partition key)
    organizationId: uuid("organization_id").notNull(),
    extractionJobId: uuid("extraction_job_id").notNull(), // parent partitioned → plain uuid, no FK
    fieldPath: text("field_path").notNull(),
    fieldKind: extractionCandidateFieldKind("field_kind").notNull(),
    riskLevel: extractionCandidateRiskLevel("risk_level").notNull(),
    valueText: text("value_text"), // DENYLISTED (§3.6)
    valueCode: text("value_code"),
    valueCodeSystem: extractionCandidateCodeSystem("value_code_system").notNull().default("none"),
    valueCipher: text("value_cipher"), // DEK-encrypted PHI value; DENYLISTED (§3.6)
    confidence: decimal("confidence", { precision: 4, scale: 3 }).notNull(),
    sourcePage: integer("source_page").notNull(),
    sourceBoundingBox: jsonb("source_bounding_box").notNull(), // DENYLISTED (§3.6)
    visionVerified: boolean("vision_verified").notNull().default(false),
    visionDisagreement: text("vision_disagreement"), // DENYLISTED (§3.6)
    // SUD-content flag set by classifier/extractor; drives m22.intake.sud_detected (D8 / W4).
    sudDetected: boolean("sud_detected").notNull().default(false),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.extractedAt] }), // partition key must be in the PK
    byJobField: index("extraction_candidate_job_field_idx").on(t.extractionJobId, t.fieldPath),
    byRisk: index("extraction_candidate_risk_idx").on(t.riskLevel, t.confidence.desc()),
    sourceBboxShape: check(
      "extraction_candidate_bbox_shape",
      sql`source_bounding_box ? 'x1' AND source_bounding_box ? 'y1' AND source_bounding_box ? 'x2' AND source_bounding_box ? 'y2'`,
    ),
  }),
);

export type ExtractionCandidate = typeof extractionCandidates.$inferSelect;
export type NewExtractionCandidate = typeof extractionCandidates.$inferInsert;
