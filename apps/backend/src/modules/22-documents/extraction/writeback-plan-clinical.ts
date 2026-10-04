// apps/backend/src/modules/22-documents/extraction/writeback-plan-clinical.ts — the PURE planner for the
// DocLens → M12 medication-history and → M5 allergy writeback (F-238). The sibling of `writeback-plan.ts`
// (F-235's M5 demographics planner), which it does not touch: that planner still reports medication and
// allergy paths as `not_a_writeback_target` FOR M5 DEMOGRAPHICS, which stays true; this one decides whether
// the same approved candidates become a reconciliation-only `medication_history_record` (M12 D10) or an
// unverified `patient_allergy` (M5, architecture §10.6.6).
//
// WHAT CAN NEVER COME OUT OF THIS PLANNER: a `medication_order`, draft or otherwise (M12 D12 / AI Governance
// §2.1.1). The plan's two outputs are lines of text the reviewer attested, bound for two stores that change
// no order, no MAR and no signature.
//
// Every approved candidate on the two paths either becomes a planned line or is EXCLUDED with a named
// reason, in this order:
//
//   rejected                 the reviewer rejected it — no intent, not reported
//   risk_not_high            the registry tiers both paths HIGH (per-field approval + vision re-read);
//                            a candidate stored at another tier did not go through that path — fail closed
//   sud_detected             the candidate sits on a 42 CFR Part 2-flagged page and the batch's detection
//                            was not rejected as a false positive by a reviewer
//   sud_treatment_medication the line names a MAT drug (methadone, buprenorphine, naltrexone, …: the W4
//                            flagger's `medication` rules) and the batch's detection was not rejected —
//                            applies to allergy lines too ("naltrexone — rash" discloses the same thing)
//   patient_unresolved       the batch has no resolved patient (never a headless create)
//   edited_value_missing     `approve_with_edit` with no stored edit
//   value_missing            no stored extracted value
//   value_too_long           longer than DOCLENS_CLINICAL_LINE_MAX_LENGTH — excluded, never truncated
//   duplicate_in_batch       a second approved candidate with the same dedupe key in this review — the
//                            first is planned, the repeat is not (one fax page listing a drug twice is
//                            one line on the chart)
import { lineNamesSudTreatmentMedication } from "@wardenx/intake-extraction";
import {
  DOCLENS_ALLERGY_FIELD_PATH,
  DOCLENS_CLINICAL_LINE_MAX_LENGTH,
  DOCLENS_MEDICATION_FIELD_PATH,
  type DocLensBatchSudStatus,
  type DocLensClinicalLine,
  doclensClinicalLineKey,
  doclensFieldPathIndex,
  doclensGenericFieldPath,
} from "@wardenx/types";

export type ClinicalWritebackExclusionReason =
  | "risk_not_high"
  | "sud_detected"
  | "sud_treatment_medication"
  | "patient_unresolved"
  | "edited_value_missing"
  | "value_missing"
  | "value_too_long"
  | "duplicate_in_batch";

export type ClinicalWritebackTarget = "medication_history" | "allergy";

/** One decided candidate on a medication/allergy path, as loaded server-side. */
export interface ClinicalCandidateFact {
  readonly candidateId: string;
  readonly decisionId: string;
  readonly fieldPath: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly sudDetected: boolean;
  /** The decrypted extracted value, or null when the row carries none. */
  readonly extractedValue: string | null;
  readonly decision: "approve" | "approve_with_edit" | "reject";
  readonly editedValue: string | null;
  readonly sourceDocumentId: string;
  readonly sourcePage: number;
}

export interface ClinicalWritebackExclusion {
  readonly candidateId: string;
  readonly fieldPath: string;
  readonly reason: ClinicalWritebackExclusionReason;
}

export interface ClinicalWritebackPlan {
  /** The resolved patient, when anything is planned. */
  readonly targetPatientId: string | null;
  readonly medicationLines: readonly DocLensClinicalLine[];
  readonly allergyLines: readonly DocLensClinicalLine[];
  readonly excluded: readonly ClinicalWritebackExclusion[];
}

/** Which clinical target an extractor field path writes to, or null when it is neither. */
export function clinicalWritebackTargetOf(fieldPath: string): ClinicalWritebackTarget | null {
  const generic = doclensGenericFieldPath(fieldPath);
  if (generic === DOCLENS_MEDICATION_FIELD_PATH) return "medication_history";
  if (generic === DOCLENS_ALLERGY_FIELD_PATH) return "allergy";
  return null;
}

export function planDocLensClinicalWriteback(input: {
  readonly batchPatientId: string | null;
  readonly batchSudStatus: DocLensBatchSudStatus;
  readonly facts: readonly ClinicalCandidateFact[];
}): ClinicalWritebackPlan {
  const excluded: ClinicalWritebackExclusion[] = [];
  const exclude = (f: ClinicalCandidateFact, reason: ClinicalWritebackExclusionReason): void => {
    excluded.push({ candidateId: f.candidateId, fieldPath: f.fieldPath, reason });
  };
  // A reviewer-rejected detection (a documented false positive) is the ONLY state that lets SUD-adjacent
  // content out — `not_detected` included is deliberate for MAT lines: a MAT drug on a line the detector
  // somehow did not flag is still a MAT drug.
  const sudCleared = input.batchSudStatus === "rejected";

  const planned: Array<{
    target: ClinicalWritebackTarget;
    key: string;
    line: DocLensClinicalLine;
  }> = [];
  for (const f of input.facts) {
    const target = clinicalWritebackTargetOf(f.fieldPath);
    if (target === null || f.decision === "reject") continue;
    if (f.riskLevel !== "high") {
      exclude(f, "risk_not_high");
      continue;
    }
    if (f.sudDetected && !sudCleared) {
      exclude(f, "sud_detected");
      continue;
    }
    if (input.batchPatientId === null) {
      exclude(f, "patient_unresolved");
      continue;
    }
    const raw = f.decision === "approve_with_edit" ? f.editedValue : f.extractedValue;
    const text = raw?.trim() ?? "";
    if (text === "") {
      exclude(f, f.decision === "approve_with_edit" ? "edited_value_missing" : "value_missing");
      continue;
    }
    if (!sudCleared && lineNamesSudTreatmentMedication(text)) {
      exclude(f, "sud_treatment_medication");
      continue;
    }
    if (text.length > DOCLENS_CLINICAL_LINE_MAX_LENGTH) {
      exclude(f, "value_too_long");
      continue;
    }
    planned.push({
      target,
      key: doclensClinicalLineKey(text),
      line: {
        candidateId: f.candidateId,
        decisionId: f.decisionId,
        fieldPath: f.fieldPath,
        lineIndex: doclensFieldPathIndex(f.fieldPath),
        text,
        sourceDocumentId: f.sourceDocumentId,
        sourcePage: f.sourcePage,
      },
    });
  }

  const seen = new Set<string>();
  const medicationLines: DocLensClinicalLine[] = [];
  const allergyLines: DocLensClinicalLine[] = [];
  for (const p of planned) {
    const dedupe = `${p.target}\u0000${p.key}`;
    if (seen.has(dedupe)) {
      excluded.push({
        candidateId: p.line.candidateId,
        fieldPath: p.line.fieldPath,
        reason: "duplicate_in_batch",
      });
      continue;
    }
    seen.add(dedupe);
    (p.target === "medication_history" ? medicationLines : allergyLines).push(p.line);
  }

  return {
    targetPatientId: medicationLines.length + allergyLines.length > 0 ? input.batchPatientId : null,
    medicationLines,
    allergyLines,
    excluded,
  };
}
