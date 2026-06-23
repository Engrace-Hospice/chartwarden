// @wardenx/intake-extraction — §3.1 the 11 v1 DocLens document types as pure data.
//
// T01 ships the per-type DESCRIPTOR (document type, whether it carries high-risk fields, the writeback
// target module). The full per-field TypeBox schemas + LangExtract prompt templates + post-processing
// rules land per-type in later M22 tasks; T01 declares the type set + the chart-writeback dividing line
// (D5) so later tasks fill each type's field list against a stable contract.

import type { ExtractionSchemaDescriptor, IntakeDocumentType } from "./interface";

/** The 11 v1 DocLens document types (§1.1 / §3.1). */
export const INTAKE_DOCUMENT_TYPES = [
  "discharge_summary",
  "med_recon",
  "hp",
  "lab",
  "imaging",
  "consult",
  "insurance_card",
  "photo_id",
  "advance_directive",
  "dpoa",
  "transfer_record",
] as const satisfies readonly IntakeDocumentType[];

/** §3.1 — the per-type extraction-schema registry. `fields` are populated per-type in later M22 tasks;
 * T01 fixes the writeback-target dividing line (D5): which module each type's approved candidates draft
 * into and whether the type carries high-risk fields (→ vision verifier + per-field-only review). */
export const EXTRACTION_SCHEMA_REGISTRY: readonly ExtractionSchemaDescriptor[] = [
  { documentType: "discharge_summary", hasHighRiskFields: true, fields: [] },
  { documentType: "med_recon", hasHighRiskFields: true, fields: [] },
  { documentType: "hp", hasHighRiskFields: true, fields: [] },
  { documentType: "lab", hasHighRiskFields: false, fields: [] },
  { documentType: "imaging", hasHighRiskFields: false, fields: [] },
  { documentType: "consult", hasHighRiskFields: false, fields: [] },
  { documentType: "insurance_card", hasHighRiskFields: false, fields: [] },
  { documentType: "photo_id", hasHighRiskFields: false, fields: [] },
  { documentType: "advance_directive", hasHighRiskFields: true, fields: [] },
  { documentType: "dpoa", hasHighRiskFields: true, fields: [] },
  { documentType: "transfer_record", hasHighRiskFields: false, fields: [] },
] as const;

/** Resolve a per-type extraction schema by document type (`undefined` when unknown). */
export function findExtractionSchema(
  documentType: IntakeDocumentType,
): ExtractionSchemaDescriptor | undefined {
  return EXTRACTION_SCHEMA_REGISTRY.find((s) => s.documentType === documentType);
}
