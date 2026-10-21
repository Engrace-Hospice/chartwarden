// @chartwarden/intake-extraction — §3.1 / Pillar 3 (DocLens) the ExtractionSchema contract.
//
// Each of the 11 v1 patient-intake document types declares a per-type schema: the structured fields the
// extractor proposes, each field's risk level (high = per-field-only, never bulk-approved, §1.4) and the
// chart module the approved field writes back to (D5). M22-T01 ships the contract + the per-type
// descriptor DATA; the per-type TypeBox schemas, the LangExtract prompt templates, and the
// post-processing rules land in later M22 tasks. Leaf-import only (`@chartwarden/types`).

import type {
  ChartTargetModule,
  ClassifiedPageDocType,
  ExtractionCandidateRiskLevel,
} from "@chartwarden/types";

/** The 11 v1 DocLens document types (the `classified_page_doc_type` set minus `unknown`). */
export type IntakeDocumentType = Exclude<ClassifiedPageDocType, "unknown">;

/** §3.1 — one extractable field within a per-type extraction schema. `riskLevel='high'` fields
 * (medications, allergies, doses, code status, advance-directive content, DPOA agents) are per-field-only
 * and can never be bulk-approved (§1.4 / §2.3 high-risk bulk-approve block). */
export interface ExtractionFieldDescriptor {
  /** The field path the extractor emits, e.g. `medications[0].dose`. */
  readonly fieldPath: string;
  /** The per-field risk tier that gates bulk-approve. */
  readonly riskLevel: ExtractionCandidateRiskLevel;
  /** The chart module the approved field drafts into on writeback (D5). */
  readonly targetModule: ChartTargetModule;
  /** F-236 — what the extractor is asked for (sent verbatim in the FIELDS section of the prompt). */
  readonly description: string;
  /**
   * F-238 — who produces the value. `model` (default): the extractor is asked for it. `page_scan`: never
   * asked of a model — DocLens reads it off the page deterministically (ICD-10 codes: AI Governance §2.1.1
   * hard-blocks AI-introduced codes), so it is left out of the prompt's FIELDS section.
   */
  readonly source?: "model" | "page_scan";
}

/** §3.1 — the per-document-type extraction schema descriptor. */
export interface ExtractionSchemaDescriptor {
  readonly documentType: IntakeDocumentType;
  /** Whether any field on this type is high-risk and therefore routed through the vision verifier. */
  readonly hasHighRiskFields: boolean;
  /** The fields the extractor proposes for this type. */
  readonly fields: readonly ExtractionFieldDescriptor[];
}
