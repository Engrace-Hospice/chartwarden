// @wardenx/intake-extraction — the §3.1 per-doc-type ExtractionSchema library (M22-T08).
//
// The eleven v1 DocLens extraction schemas, one per non-`unknown` `classified_page_doc_type`. Each declares its
// per-field descriptors: the dotted `fieldPath` the candidate writes back to, the typed `fieldKind`, the optional
// terminology `codeSystem` (M38 resolves the human string → canonical code; M22 stores only the resolved code),
// the `riskLevel` (HIGH fields can NEVER be bulk-approved — §2.3 DB CHECK — and route through the vision verifier,
// §2.2.6), and the `targetModule` the committed candidate drafts into (the `m22.extraction.commit_requested`
// discriminator, D5). This is the field-risk + writeback-target source of truth the §7.1 W1 orchestrator drives.
//
// PURE/typed — no AI, no IO. The TypeBox candidate-shape validation schema is opaque at this boundary
// (`candidateSchema: unknown`); the LangExtract prompt templates + post-processing live in the docling/M32 layer
// per §25.14. High-risk fields (medications, allergies, doses, code status, advance-directive content) are tagged
// `high` here — that single fact gates the never-bulk-approve rule end-to-end.

import type { ClassifiedPageDocType } from "@wardenx/types";
import type { ExtractionFieldSchema, ExtractionSchema } from "./interface";

/** Terse field-descriptor constructor (keeps the per-type tables readable). */
const f = (
  fieldPath: ExtractionFieldSchema["fieldPath"],
  fieldKind: ExtractionFieldSchema["fieldKind"],
  riskLevel: ExtractionFieldSchema["riskLevel"],
  targetModule: ExtractionFieldSchema["targetModule"],
  codeSystem: ExtractionFieldSchema["codeSystem"] = "none",
): ExtractionFieldSchema => ({ fieldPath, fieldKind, codeSystem, riskLevel, targetModule });

const dischargeSummary: ExtractionSchema = {
  docType: "discharge_summary",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("patient.demographics.name", "text", "medium", "m5"),
    f("patient.demographics.dob", "date", "medium", "m5"),
    f("encounter.dischargeDate", "date", "low", "m22"),
    f("problems[].icd10", "code", "high", "m7", "icd10"),
    f("medications[].rxnorm", "code", "high", "m12", "rxnorm"),
    f("medications[].dose", "measurement", "high", "m12"),
    f("allergies[].substance", "text", "high", "m5"),
    f("codeStatus", "enum", "high", "m7"),
  ],
};

const medRecon: ExtractionSchema = {
  docType: "med_recon",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("medications[].rxnorm", "code", "high", "m12", "rxnorm"),
    f("medications[].ndc", "code", "high", "m12", "ndc"),
    f("medications[].dose", "measurement", "high", "m12"),
    f("medications[].route", "enum", "high", "m12"),
    f("medications[].frequency", "text", "high", "m12"),
  ],
};

const hp: ExtractionSchema = {
  docType: "hp",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("problems[].icd10", "code", "high", "m7", "icd10"),
    f("allergies[].substance", "text", "high", "m5"),
    f("medications[].rxnorm", "code", "high", "m12", "rxnorm"),
    f("socialHistory.substanceUse", "text", "high", "m7"),
    f("functionalStatus.pps", "measurement", "medium", "m9"),
  ],
};

const lab: ExtractionSchema = {
  docType: "lab",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("observations[].loinc", "code", "high", "m11", "loinc"),
    f("observations[].value", "measurement", "high", "m11"),
    f("observations[].unit", "text", "low", "m11"),
    f("observations[].collectedAt", "date", "low", "m11"),
  ],
};

const imaging: ExtractionSchema = {
  docType: "imaging",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("study.modality", "enum", "low", "m11"),
    f("study.snomed", "code", "medium", "m11", "snomed"),
    f("study.impression", "text", "medium", "m11"),
    f("study.performedAt", "date", "low", "m11"),
  ],
};

const consult: ExtractionSchema = {
  docType: "consult",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("consult.specialty", "text", "low", "m22"),
    f("consult.recommendations", "text", "medium", "m7"),
    f("consult.prescriberNpi", "text", "medium", "m40"),
    f("problems[].icd10", "code", "high", "m7", "icd10"),
  ],
};

const insuranceCard: ExtractionSchema = {
  docType: "insurance_card",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("payer.name", "text", "low", "m5"),
    f("payer.memberId", "text", "medium", "m5"),
    f("payer.groupNumber", "text", "low", "m5"),
    f("payer.planType", "enum", "low", "m5"),
  ],
};

const photoId: ExtractionSchema = {
  docType: "photo_id",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("identity.fullName", "text", "medium", "m5"),
    f("identity.dob", "date", "medium", "m5"),
    f("identity.documentNumber", "text", "high", "m5"),
  ],
};

const advanceDirective: ExtractionSchema = {
  docType: "advance_directive",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("directive.type", "enum", "high", "m22", "snomed"),
    f("directive.codeStatus", "enum", "high", "m7"),
    f("directive.effectiveDate", "date", "medium", "m22"),
    f("directive.snomed", "code", "high", "m7", "snomed"),
  ],
};

const dpoa: ExtractionSchema = {
  docType: "dpoa",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("agent.name", "text", "high", "m5"),
    f("agent.relationship", "text", "medium", "m5"),
    f("agent.phone", "text", "medium", "m5"),
    f("dpoa.effectiveDate", "date", "medium", "m22"),
  ],
};

const transferRecord: ExtractionSchema = {
  docType: "transfer_record",
  version: "v1",
  candidateSchema: undefined,
  fields: [
    f("transfer.fromFacilityNpi", "text", "medium", "m40"),
    f("transfer.priorLevelOfCare", "enum", "low", "m22"),
    f("medications[].rxnorm", "code", "high", "m12", "rxnorm"),
    f("problems[].icd10", "code", "high", "m7", "icd10"),
  ],
};

/** The §3.1 extraction-schema library keyed by `classified_page_doc_type` (the `unknown` page type has none). */
export const EXTRACTION_SCHEMAS: {
  readonly [K in Exclude<ClassifiedPageDocType, "unknown">]: ExtractionSchema;
} = {
  discharge_summary: dischargeSummary,
  med_recon: medRecon,
  hp,
  lab,
  imaging,
  consult,
  insurance_card: insuranceCard,
  photo_id: photoId,
  advance_directive: advanceDirective,
  dpoa,
  transfer_record: transferRecord,
};

/** Resolve the §3.1 ExtractionSchema for a classified doc type (`unknown` → null; no extraction job is created). */
export function resolveExtractionSchema(docType: ClassifiedPageDocType): ExtractionSchema | null {
  if (docType === "unknown") return null;
  return EXTRACTION_SCHEMAS[docType];
}

/** The risk level the schema declares for a given `fieldPath` of a doc type (defaults `medium` if undeclared —
 * fail toward the more-restrictive per-field-only review path rather than letting an unknown field bulk-approve). */
export function fieldRiskLevel(
  docType: ClassifiedPageDocType,
  fieldPath: string,
): ExtractionFieldSchema["riskLevel"] {
  const schema = resolveExtractionSchema(docType);
  return schema?.fields.find((field) => field.fieldPath === fieldPath)?.riskLevel ?? "medium";
}

/** The writeback target module for a given `fieldPath` (defaults `m22` — store-only — when undeclared). */
export function fieldTargetModule(
  docType: ClassifiedPageDocType,
  fieldPath: string,
): ExtractionFieldSchema["targetModule"] {
  const schema = resolveExtractionSchema(docType);
  return schema?.fields.find((field) => field.fieldPath === fieldPath)?.targetModule ?? "m22";
}
