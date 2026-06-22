// @wardenx/db — `extraction_candidate` (M22 §3.3 / §2.1). One extracted field-value candidate per (job, field),
// with the typed value, the source-page bounding box, the vision-verification overlay, and the D8 SUD flag.
// Org-scoped; the PHI lives in the value columns (DENYLISTED in §3.6: `value_text`, `value_cipher`,
// `vision_disagreement`, `source_bounding_box`) but there is no `patient_id` column → only org-scope RLS
// applies. PARTITION BY RANGE (extracted_at) monthly — the Drizzle shape here is logical (composite PK incl. the
// partition key); the PARTITION BY + monthly children + DEFAULT catch-all land in the RLS migration (0049). The
// `extraction_job_id` reference carries NO SQL FK (extraction_job is partitioned) — plain uuid app-validated.
// The source-bounding-box shape invariant is a CHECK constraint. RLS + grants + the M4 write-audit trigger land
// in 0049.
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
import { sql } from "drizzle-orm";
import { extractionCandidateCodeSystem, extractionCandidateFieldKind, extractionCandidateRiskLevel } from "../../enums";
import { organizations } from "../organizations";

export const extractionCandidates = pgTable(
  "extraction_candidate",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with extracted_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    extractionJobId: uuid("extraction_job_id").notNull(), // app-validated (extraction_job is partitioned; no FK)
    fieldPath: text("field_path").notNull(),
    fieldKind: extractionCandidateFieldKind("field_kind").notNull(),
    riskLevel: extractionCandidateRiskLevel("risk_level").notNull(),
    valueText: text("value_text"), // → DENYLISTED (§3.6)
    valueCode: text("value_code"),
    valueCodeSystem: extractionCandidateCodeSystem("value_code_system").notNull().default("none"),
    valueCipher: text("value_cipher"), // DEK-encrypted PHI value if applicable → DENYLISTED (§3.6)
    confidence: decimal("confidence", { precision: 4, scale: 3 }).notNull(),
    sourcePage: integer("source_page").notNull(),
    sourceBoundingBox: jsonb("source_bounding_box").notNull(), // → DENYLISTED (§3.6)
    visionVerified: boolean("vision_verified").notNull().default(false),
    visionDisagreement: text("vision_disagreement"), // → DENYLISTED (§3.6)
    // SUD-content flag set by classifier/extractor; drives m22.intake.sud_detected (D8 / W4)
    sudDetected: boolean("sud_detected").notNull().default(false),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(), // partition key
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.extractedAt] }), // partition key must be in the PK
    byJobField: index("extraction_candidate_job_field_idx").on(t.extractionJobId, t.fieldPath),
    byRisk: index("extraction_candidate_risk_idx").on(t.riskLevel, t.confidence.desc()),
    sourceBboxShape: check(
      "extraction_candidate_source_bbox_shape",
      sql`source_bounding_box ? 'x1' AND source_bounding_box ? 'y1' AND source_bounding_box ? 'x2' AND source_bounding_box ? 'y2'`,
    ),
  }),
);

export type ExtractionCandidate = typeof extractionCandidates.$inferSelect;
export type NewExtractionCandidate = typeof extractionCandidates.$inferInsert;
