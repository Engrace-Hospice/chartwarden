// @chartwarden/intake-extraction — §3.1 the 11 v1 DocLens document types as pure data.
//
// T01 ships the per-type DESCRIPTOR (document type, whether it carries high-risk fields, the writeback
// target module). The full per-field TypeBox schemas + LangExtract prompt templates + post-processing
// rules land per-type in later M22 tasks; T01 declares the type set + the chart-writeback dividing line
// (D5) so later tasks fill each type's field list against a stable contract.

import type {
  ExtractionFieldDescriptor,
  ExtractionSchemaDescriptor,
  IntakeDocumentType,
} from "./interface";

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
// F-236 (ADR-0048) — the v1 field sets. The RISK TIER is the registry's, never the model's: a candidate is
// stored with the tier of the field it matched here. Writeback is a separate, narrower decision
// (`DOCLENS_M5_WRITEBACK_FIELDS` in @chartwarden/types — low-risk contacts only; A1: no medications).
const contact = (fieldPath: string, description: string): ExtractionFieldDescriptor => ({
  fieldPath,
  riskLevel: "low",
  targetModule: "m5",
  description,
});
const identity = (fieldPath: string, description: string): ExtractionFieldDescriptor => ({
  fieldPath,
  riskLevel: "medium",
  targetModule: "m5",
  description,
});
const clinical = (fieldPath: string, description: string): ExtractionFieldDescriptor => ({
  fieldPath,
  riskLevel: "high",
  targetModule: "m12",
  description,
});

const DEMOGRAPHICS: readonly ExtractionFieldDescriptor[] = [
  identity("patient.legalFirstName", "patient's legal first name"),
  identity("patient.legalLastName", "patient's legal last name"),
  identity("patient.dateOfBirth", "patient's date of birth, as written"),
  contact("patient.preferredName", "the name the patient prefers to be called, only if stated"),
  contact("patient.phoneHome", "patient's home phone number"),
  contact("patient.phoneMobile", "patient's mobile or cell phone number"),
  contact("patient.email", "patient's email address"),
  contact("patient.address.line1", "street address (number and street)"),
  contact("patient.address.line2", "apartment, unit or suite, only if present"),
  contact("patient.address.city", "city of the patient's address"),
  contact("patient.address.state", "state of the patient's address"),
  contact("patient.address.postalCode", "ZIP code of the patient's address"),
];

const MEDICATIONS: readonly ExtractionFieldDescriptor[] = [
  clinical("medications[].name", "one medication as written: name, strength, route and frequency"),
  clinical(
    "allergies[].substance",
    "one allergy or intolerance as written, with the reaction if stated",
  ),
];

// F-238 — diagnoses. The model reads the WORDING and how the document labels it; the ICD-10-CM code is
// `page_scan` — read off the page by the code scanner (coding/icd-scanner.ts), never produced by a model.
// Same index = same diagnosis (`diagnoses[3].description` ↔ `diagnoses[3].icd10`).
const DIAGNOSES: readonly ExtractionFieldDescriptor[] = [
  {
    fieldPath: "diagnoses[].description",
    riskLevel: "high",
    targetModule: "m7",
    description:
      "one diagnosis or medical condition exactly as written, WITHOUT any code (from a diagnosis list, problem list, past medical history or assessment); never a ruled-out, negated or 'no evidence of' finding",
  },
  {
    fieldPath: "diagnoses[].role",
    riskLevel: "medium",
    targetModule: "m7",
    description:
      "how this document labels that same diagnosis: principal (listed as principal/primary diagnosis), secondary, history (past, resolved or 'history of'), or unspecified",
  },
  {
    fieldPath: "diagnoses[].icd10",
    riskLevel: "high",
    targetModule: "m7",
    description: "the ICD-10-CM code printed next to that diagnosis",
    source: "page_scan",
  },
];

/** §3.1 — the per-type extraction-schema registry, with the writeback-target dividing line (D5). */
export const EXTRACTION_SCHEMA_REGISTRY: readonly ExtractionSchemaDescriptor[] = [
  {
    documentType: "discharge_summary",
    hasHighRiskFields: true,
    fields: [...DEMOGRAPHICS, ...MEDICATIONS, ...DIAGNOSES],
  },
  { documentType: "med_recon", hasHighRiskFields: true, fields: MEDICATIONS },
  {
    documentType: "hp",
    hasHighRiskFields: true,
    fields: [...DEMOGRAPHICS, ...MEDICATIONS, ...DIAGNOSES],
  },
  { documentType: "lab", hasHighRiskFields: false, fields: DEMOGRAPHICS },
  { documentType: "imaging", hasHighRiskFields: false, fields: DEMOGRAPHICS },
  { documentType: "consult", hasHighRiskFields: true, fields: [...DEMOGRAPHICS, ...DIAGNOSES] },
  { documentType: "insurance_card", hasHighRiskFields: false, fields: DEMOGRAPHICS },
  { documentType: "photo_id", hasHighRiskFields: false, fields: DEMOGRAPHICS },
  // Advance directives and DPOAs carry high-risk content (code status, agents) whose v1 fields are not
  // specified yet; until they are, only demographics are extracted from them.
  { documentType: "advance_directive", hasHighRiskFields: true, fields: DEMOGRAPHICS },
  { documentType: "dpoa", hasHighRiskFields: true, fields: DEMOGRAPHICS },
  {
    documentType: "transfer_record",
    hasHighRiskFields: true,
    fields: [...DEMOGRAPHICS, ...MEDICATIONS, ...DIAGNOSES],
  },
] as const;

/**
 * Resolve an extracted field path (`medications[2].name`) to its registry descriptor
 * (`medications[].name`) for a document type, or `undefined` — a path the schema does not declare is
 * never stored, whatever the model returned.
 */
export function findExtractionField(
  documentType: IntakeDocumentType,
  fieldPath: string,
): ExtractionFieldDescriptor | undefined {
  const generic = fieldPath.replace(/\[\d+\]/g, "[]");
  return findExtractionSchema(documentType)?.fields.find((f) => f.fieldPath === generic);
}

/** Resolve a per-type extraction schema by document type (`undefined` when unknown). */
export function findExtractionSchema(
  documentType: IntakeDocumentType,
): ExtractionSchemaDescriptor | undefined {
  return EXTRACTION_SCHEMA_REGISTRY.find((s) => s.documentType === documentType);
}
