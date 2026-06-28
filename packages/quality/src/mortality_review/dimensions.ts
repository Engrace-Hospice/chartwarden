// @wardenx/quality — M30 §2.2 / D9 mortality-review three-dimension form structure (P2a). PURE types.
//
// The structured post-death review form (§2.2 / D9 / S-14) has three dimensions — clinical, satisfaction,
// compliance — each persisted to the matching `mortality_review` jsonb column. The frozen schema types
// (`schema.ClinicalDimensionData` / `SatisfactionDimensionData` / `ComplianceDimensionData`) are open
// (`{ [key]: unknown }`) so the column accepts any well-formed payload; THIS file is the DOMAIN structure
// those open payloads conform to, plus the completeness predicates the lifecycle `complete` guard reads
// (all three dimensions must be populated before a review may be completed — §2.2). The free-text members
// (`freeTextNotes` / `caregiverQualitativeSummary` / `notes`) are §3.6 audit-denylisted. No Fastify, no IO.
import type { schema } from "@wardenx/db";

/** A four-point clinical-adequacy rating used across the clinical dimension (D9). */
export type AdequacyRating = "inadequate" | "partial" | "adequate" | "exemplary";

/** The compliance posture of a timeliness/process check on the compliance dimension. */
export type ComplianceCheck = "met" | "not_met" | "not_applicable";

/**
 * Clinical dimension (D9): symptom-management quality, pain-control adequacy, end-of-life care-plan
 * execution, plus the final-days visit cadence and comfort-pack readiness surfaced on S-14. Structurally
 * assignable to the open `schema.ClinicalDimensionData` (which carries the denylisted `freeTextNotes`).
 */
export interface ClinicalReviewDimension {
  readonly symptomManagementAdequacy: AdequacyRating;
  readonly painControlAdequacy: AdequacyRating;
  readonly endOfLifeCarePlanExecution: AdequacyRating;
  /** Whether the last-7-days visit cadence met the patient's plan-of-care expectation. */
  readonly last7DayVisitCadenceMet: boolean;
  /** Whether the comfort kit / comfort pack was confirmed present and accessible in the final days. */
  readonly comfortPackReady: boolean;
  /** Reviewer free-text clinical narrative (§3.6 audit-denylisted). */
  readonly freeTextNotes?: string;
}

/**
 * Satisfaction dimension (D9): the caregiver-experience qualitative summary (fed from CAHPS when available
 * for the decedent) plus any flagged caregiver concerns and the follow-up plan. Structurally assignable to
 * the open `schema.SatisfactionDimensionData` (denylisted `caregiverQualitativeSummary`).
 */
export interface SatisfactionReviewDimension {
  /** Whether any caregiver concern was flagged during or after care. */
  readonly caregiverConcernsFlagged: boolean;
  /** The bereavement / follow-up plan recorded for the family. */
  readonly followUpPlanRecorded: boolean;
  /** Whether a CAHPS decedent result is linked to this review (informational provenance). */
  readonly cahpsResultLinked: boolean;
  /** Caregiver-experience qualitative summary (§3.6 audit-denylisted). */
  readonly caregiverQualitativeSummary?: string;
}

/**
 * Compliance dimension (D9): the cross-module timeliness/process checks — F2F window (M6), CTI timeliness
 * (M6), HOPE submission status (M10), eMAR completeness in the final 7 days (M13), IDG decisions captured
 * (M14). Structurally assignable to the open `schema.ComplianceDimensionData` (denylisted `notes`).
 */
export interface ComplianceReviewDimension {
  readonly faceToFaceWindowCompliance: ComplianceCheck;
  readonly ctiTimeliness: ComplianceCheck;
  readonly hopeSubmissionStatus: ComplianceCheck;
  readonly emarCompletenessFinal7Days: ComplianceCheck;
  readonly idgDecisionsCaptured: ComplianceCheck;
  /** Reviewer free-text compliance notes (§3.6 audit-denylisted). */
  readonly notes?: string;
}

/** The full three-dimension mortality-review form (D9 / S-14). */
export interface MortalityReviewForm {
  readonly clinical: ClinicalReviewDimension;
  readonly satisfaction: SatisfactionReviewDimension;
  readonly compliance: ComplianceReviewDimension;
}

/** The structural keys each dimension must carry to count as "populated" (the §2.2 completion fact). */
const REQUIRED_CLINICAL_KEYS = [
  "symptomManagementAdequacy",
  "painControlAdequacy",
  "endOfLifeCarePlanExecution",
] as const;
const REQUIRED_SATISFACTION_KEYS = ["caregiverConcernsFlagged", "followUpPlanRecorded"] as const;
const REQUIRED_COMPLIANCE_KEYS = [
  "faceToFaceWindowCompliance",
  "ctiTimeliness",
  "hopeSubmissionStatus",
  "emarCompletenessFinal7Days",
  "idgDecisionsCaptured",
] as const;

/** Presence check over the open jsonb payload — a member is populated iff present and not null/empty-string. */
function hasAll(data: Record<string, unknown> | null | undefined, keys: ReadonlyArray<string>): boolean {
  if (data === null || data === undefined) return false;
  return keys.every((k) => {
    const v = data[k];
    if (v === undefined || v === null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  });
}

/** True iff the clinical dimension carries its required structural members (D9). */
export function isClinicalDimensionComplete(data: schema.ClinicalDimensionData | null | undefined): boolean {
  return hasAll(data, REQUIRED_CLINICAL_KEYS);
}

/** True iff the satisfaction dimension carries its required structural members (D9). */
export function isSatisfactionDimensionComplete(
  data: schema.SatisfactionDimensionData | null | undefined,
): boolean {
  return hasAll(data, REQUIRED_SATISFACTION_KEYS);
}

/** True iff the compliance dimension carries its required structural members (D9). */
export function isComplianceDimensionComplete(
  data: schema.ComplianceDimensionData | null | undefined,
): boolean {
  return hasAll(data, REQUIRED_COMPLIANCE_KEYS);
}

/**
 * True iff ALL THREE dimensions are populated — the §2.2 `completed` precondition the lifecycle machine's
 * `complete` guard consumes (alongside the Medical Director signature). PURE.
 */
export function areAllDimensionsComplete(input: {
  readonly clinical: schema.ClinicalDimensionData | null | undefined;
  readonly satisfaction: schema.SatisfactionDimensionData | null | undefined;
  readonly compliance: schema.ComplianceDimensionData | null | undefined;
}): boolean {
  return (
    isClinicalDimensionComplete(input.clinical) &&
    isSatisfactionDimensionComplete(input.satisfaction) &&
    isComplianceDimensionComplete(input.compliance)
  );
}
