// @chartwarden/types — the DocLens → MEDICATION HISTORY (M12) and → ALLERGY LIST (M5) writeback contract
// (F-238 "meds-allergies"). The sibling of `doclens-writeback.ts` (F-235's M5 demographics path); it does not
// change that contract.
//
// WHAT A1 STILL FORBIDS, AND WHAT THIS IS INSTEAD. F-231's A1 kept extracted medications out of every
// writeback because M12 D12 / AI Governance §2.1.1 hard-block AI-introduced changes to MEDICATIONS — and the
// operational meaning of that block (M12 D12, §1.2, §7.9) is "the LLM may not create, modify, sign or
// otherwise mutate a `medication_order`". That stays absolute: nothing in this contract can reach a
// `medication_order`, a draft or otherwise. What DocLens now writes is the reviewer-ATTESTED line, verbatim,
// into M12 D10's `medication_history_record` — the external-medication-history store that is "persisted for
// clinical reconciliation but never auto-linked to medication_order". It is the outside medication list a
// referral fax carries, labelled as such, for a clinician to reconcile; it changes no order and no MAR.
//
// ALLERGIES go to M5 — architecture §10.6.6 ("Allergies → Module 5 → Allergy (linked to Patient)") — as an
// UNVERIFIED entry a clinician verifies or marks entered-in-error. Unverified is still shown to prescribers
// (an unverified allergy is safer shown than hidden), always labelled.
//
// Both modules import this one leaf file (M22 shares no `dependsOn` edge with M5 or M12), so the field
// paths, the dedupe key and the payload shapes cannot drift between the producer and the consumers.

/** The registry field path (`@chartwarden/intake-extraction`) whose approved candidates become history lines. */
export const DOCLENS_MEDICATION_FIELD_PATH = "medications[].name" as const;
/** The registry field path whose approved candidates become unverified allergy entries. */
export const DOCLENS_ALLERGY_FIELD_PATH = "allergies[].substance" as const;

/** The longest attested line either target accepts. A longer value is excluded, never truncated. */
export const DOCLENS_CLINICAL_LINE_MAX_LENGTH = 500;

/** `medications[3].name` → `medications[].name` — the registry's own list-index collapse. */
export function doclensGenericFieldPath(fieldPath: string): string {
  return fieldPath.replace(/\[\d+\]/g, "[]");
}

/** The list index a field path carries (`medications[3].name` → 3), or 0 when it carries none. */
export function doclensFieldPathIndex(fieldPath: string): number {
  const m = /\[(\d+)\]/.exec(fieldPath);
  return m ? Number(m[1]) : 0;
}

/**
 * The deterministic DEDUPE key for an attested line: Unicode-normalized, lower-cased, whitespace collapsed,
 * surrounding punctuation dropped. "Morphine 5 mg PO q4h PRN." and "morphine 5 mg po  q4h prn" are one line;
 * "morphine 10 mg …" is a different one. It never parses, codes or reinterprets the line — it only decides
 * whether a second batch is repeating a line the chart already holds (→ `duplicate`, not a second row).
 */
export function doclensClinicalLineKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:\-–—*•]+|[\s.,;:\-–—*•]+$/g, "");
}

/** M22 → M12: a completed review's approved medication lines for ONE resolved patient. */
export const M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT =
  "m22.extraction.medication_history_requested" as const;
/** M22 → M5: a completed review's approved allergy lines for ONE resolved patient. */
export const M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT =
  "m22.extraction.allergies_requested" as const;
/** M12 → M22: per-line outcome of a medication-history writeback (`medication_history_record` ids). */
export const M12_MEDICATION_HISTORY_DRAFT_CREATED_FROM_EXTRACTION_EVENT =
  "m12.medication_history_record.draft_created_from_extraction" as const;
/** M5 → M22: per-line outcome of an allergy writeback (`patient_allergy` ids). */
export const M5_ALLERGY_DRAFT_CREATED_FROM_EXTRACTION_EVENT =
  "m5.patient_allergy.draft_created_from_extraction" as const;

/** The §7.4 W4 batch SUD state the producer applied; the consumers re-check MAT lines against it. */
export type DocLensBatchSudStatus = "not_detected" | "detected" | "confirmed" | "rejected";

/** One approved line, as the reviewer attested it (their edit when `approve_with_edit`, else the extraction). */
export interface DocLensClinicalLine {
  readonly candidateId: string;
  readonly decisionId: string;
  /** The candidate's concrete path (`medications[2].name`). */
  readonly fieldPath: string;
  readonly lineIndex: number;
  /** Verbatim, trimmed. Never parsed, coded or rewritten by anyone on this path. */
  readonly text: string;
  readonly sourceDocumentId: string;
  readonly sourcePage: number;
}

interface DocLensClinicalCommitBase {
  /** The commit's correlation id — the `extraction_review` that was completed. */
  readonly extractionCommitId: string;
  readonly organizationId: string;
  readonly intakeBatchId: string;
  /** The resolved patient (`intake_upload_batch.patient_id`). Never a headless create. */
  readonly targetAggregateId: string;
  /** The reviewer whose attestation this is (the clinician who approved each line). */
  readonly reviewerMembershipId: string;
  readonly batchSudStatus: DocLensBatchSudStatus;
  readonly lines: readonly DocLensClinicalLine[];
  readonly requestedAt: string;
}

/** `m22.extraction.medication_history_requested` payload. */
export interface ExtractionMedicationHistoryRequestedPayload extends DocLensClinicalCommitBase {
  readonly targetModule: "m12";
}

/** `m22.extraction.allergies_requested` payload. */
export interface ExtractionAllergiesRequestedPayload extends DocLensClinicalCommitBase {
  readonly targetModule: "m5";
}

/**
 * Per-line outcome a target module reports back.
 *   created          a new row was written (`recordId`).
 *   already_present  this very candidate was written before (a redelivery) — `recordId` is that row.
 *   duplicate        another commit already put the same line on this patient's chart; nothing new was
 *                    written and `recordId` is the existing row (the second fax is FLAGGED, not duplicated).
 *   skipped          not written, with the reason.
 */
export type DocLensClinicalLineOutcome =
  | {
      readonly candidateId: string;
      readonly outcome: "created" | "already_present" | "duplicate";
      readonly recordId: string;
    }
  | { readonly candidateId: string; readonly outcome: "skipped"; readonly reason: string };

/** The reply payload both target modules emit. */
export interface ClinicalDraftCreatedFromExtractionPayload {
  readonly patientId: string;
  readonly organizationId: string;
  readonly extractionCommitId: string;
  readonly lineOutcomes: readonly DocLensClinicalLineOutcome[];
  readonly appliedAt: string;
}

/** `patient_allergy.verification_status` (M5). */
export const PATIENT_ALLERGY_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "entered_in_error",
] as const;
export type PatientAllergyVerificationStatus =
  (typeof PATIENT_ALLERGY_VERIFICATION_STATUSES)[number];

/** `patient_allergy.source` (M5). */
export const PATIENT_ALLERGY_SOURCES = ["intake_extraction", "clinician_entry"] as const;
export type PatientAllergySource = (typeof PATIENT_ALLERGY_SOURCES)[number];

/** `patient_allergy.severity` (M5), nullable — DocLens never infers it. */
export const PATIENT_ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;
export type PatientAllergySeverity = (typeof PATIENT_ALLERGY_SEVERITIES)[number];

/** `medication_history_record.reconciliation_decision` (M12 §5.5 W-MR-05). */
export const MEDICATION_HISTORY_RECONCILIATION_DECISIONS = [
  "carry_forward",
  "discontinue",
  "document_only",
] as const;
export type MedicationHistoryReconciliationDecision =
  (typeof MEDICATION_HISTORY_RECONCILIATION_DECISIONS)[number];

/**
 * Fail-closed parse of a DocLens clinical commit (shared by M12's and M5's consumers so the two cannot
 * accept different shapes). Returns the payload or a reason; never guesses. Checks the event's `organizationId`
 * matches the outbox row's, the `targetModule` is the consumer's own, every line is structurally complete,
 * no line is longer than the producer allows, and no candidate appears twice.
 */
export function parseDocLensClinicalCommit<T extends "m12" | "m5">(
  raw: unknown,
  organizationId: string,
  targetModule: T,
):
  | {
      readonly ok: true;
      readonly payload: T extends "m12"
        ? ExtractionMedicationHistoryRequestedPayload
        : ExtractionAllergiesRequestedPayload;
    }
  | { readonly ok: false; readonly reason: string } {
  const p = raw as Partial<ExtractionMedicationHistoryRequestedPayload> | null;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (
    !p ||
    !str(p.extractionCommitId) ||
    !str(p.organizationId) ||
    !str(p.intakeBatchId) ||
    !str(p.targetAggregateId) ||
    !str(p.reviewerMembershipId) ||
    !str(p.requestedAt) ||
    !Array.isArray(p.lines)
  ) {
    return { ok: false, reason: "malformed payload — refusing to guess" };
  }
  if ((p.targetModule as string) !== targetModule) {
    return { ok: false, reason: `targetModule ${String(p.targetModule)} is not ${targetModule}` };
  }
  if (p.organizationId !== organizationId) {
    return {
      ok: false,
      reason: `payload org ${p.organizationId} != outbox row org ${organizationId}`,
    };
  }
  const seen = new Set<string>();
  for (const l of p.lines as unknown[]) {
    const line = l as Partial<DocLensClinicalLine> | null;
    if (
      !line ||
      !str(line.candidateId) ||
      !str(line.decisionId) ||
      !str(line.fieldPath) ||
      !str(line.sourceDocumentId) ||
      typeof line.lineIndex !== "number" ||
      typeof line.sourcePage !== "number" ||
      typeof line.text !== "string" ||
      line.text.trim() === "" ||
      line.text.length > DOCLENS_CLINICAL_LINE_MAX_LENGTH
    ) {
      return { ok: false, reason: "malformed line" };
    }
    if (seen.has(line.candidateId)) return { ok: false, reason: "duplicate candidate in lines" };
    seen.add(line.candidateId);
  }
  return {
    ok: true,
    payload: p as T extends "m12"
      ? ExtractionMedicationHistoryRequestedPayload
      : ExtractionAllergiesRequestedPayload,
  };
}
