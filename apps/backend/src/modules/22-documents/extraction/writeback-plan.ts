// apps/backend/src/modules/22-documents/extraction/writeback-plan.ts — the PURE §7.1 W1 step 11 commit
// planner for the DocLens → M5 demographics writeback (F-235, #248). No IO: the caller loads the review's
// server-side decisions + candidates (values already DEK-decrypted) and executes the plan in one transaction.
//
// Every approved decision either becomes a commit field or is EXCLUDED with a named reason; nothing is
// dropped silently, and an exclusion is never an error (the candidate stays as review evidence on
// `extraction_candidate`, its decision on `extraction_decision`). The rules, in the order applied:
//
//   rejected                 the reviewer rejected it — no intent (W1 AC), not reported as an exclusion
//   not_a_writeback_target   the field path is not on DOCLENS_M5_WRITEBACK_FIELDS. This is where A1
//                            lands: medication / allergy / diagnosis paths are never on it.
//   risk_not_low             an allowlisted path whose candidate is not LOW risk — §7.3.2 lets only
//                            low-risk demographics/contacts flow; a mis-tiered extraction does not.
//   sud_detected             the candidate was flagged as potential SUD content (W4 / D8). 42 CFR Part 2:
//                            a value lifted from a Part 2 record does not leave review evidence without a
//                            consent decision nobody has made here. Fail closed.
//   patient_unresolved       the batch has no resolved patient. B: never a headless create (the M29
//                            `create_patient` arm dead-letters for the same reason).
//   edited_value_missing     `approve_with_edit` with no stored edited value — refusing beats committing
//                            the unedited extraction the reviewer explicitly did not accept as-is.
//   value_missing            no stored extracted value to commit.
//   conflicting_values       two approved candidates for the same field path with different values —
//                            the reviewer attested both, so neither is chosen.
import { DOCLENS_M5_WRITEBACK_FIELDS, type DocLensCommitField } from "@chartwarden/types";

export type WritebackExclusionReason =
  | "not_a_writeback_target"
  | "risk_not_low"
  | "sud_detected"
  | "patient_unresolved"
  | "edited_value_missing"
  | "value_missing"
  | "conflicting_values";

/** One decided candidate in the review, as loaded server-side. */
export interface WritebackCandidateFact {
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
}

/** A decision that will be committed: the provenance row's inputs + the attested value. */
export interface PlannedCommitField {
  readonly candidateId: string;
  readonly decisionId: string;
  readonly fieldPath: string;
  readonly value: string;
  readonly sourceDocumentId: string;
}

export interface WritebackExclusion {
  readonly candidateId: string;
  readonly fieldPath: string;
  readonly reason: WritebackExclusionReason;
}

export interface WritebackPlan {
  /** The resolved patient, when there is anything to commit. */
  readonly targetPatientId: string | null;
  /** One entry per committed DECISION (each gets its own `extraction_provenance` row). */
  readonly committed: readonly PlannedCommitField[];
  /** The deduplicated field list the `commit_requested` payload carries (one value per field path). */
  readonly fields: readonly DocLensCommitField[];
  readonly excluded: readonly WritebackExclusion[];
}

export function planDocLensWriteback(input: {
  readonly batchPatientId: string | null;
  readonly facts: readonly WritebackCandidateFact[];
  /**
   * F-237 — the batch's §7.4 W4 SUD state. A `sud_detected` candidate is committable ONLY after a reviewer
   * rejected the detection as a false positive; `detected` (unresolved) and `confirmed` keep it out.
   */
  readonly batchSudStatus?: "not_detected" | "detected" | "confirmed" | "rejected";
}): WritebackPlan {
  const excluded: WritebackExclusion[] = [];
  const eligible: PlannedCommitField[] = [];
  const exclude = (f: WritebackCandidateFact, reason: WritebackExclusionReason): void => {
    excluded.push({ candidateId: f.candidateId, fieldPath: f.fieldPath, reason });
  };

  for (const f of input.facts) {
    if (f.decision === "reject") continue;
    if (!Object.hasOwn(DOCLENS_M5_WRITEBACK_FIELDS, f.fieldPath)) {
      exclude(f, "not_a_writeback_target");
      continue;
    }
    if (f.riskLevel !== "low") {
      exclude(f, "risk_not_low");
      continue;
    }
    if (f.sudDetected && input.batchSudStatus !== "rejected") {
      exclude(f, "sud_detected");
      continue;
    }
    if (input.batchPatientId === null) {
      exclude(f, "patient_unresolved");
      continue;
    }
    let value: string | null;
    if (f.decision === "approve_with_edit") {
      value = f.editedValue;
      if (value === null || value.trim() === "") {
        exclude(f, "edited_value_missing");
        continue;
      }
    } else {
      value = f.extractedValue;
      if (value === null || value.trim() === "") {
        exclude(f, "value_missing");
        continue;
      }
    }
    eligible.push({
      candidateId: f.candidateId,
      decisionId: f.decisionId,
      fieldPath: f.fieldPath,
      value: value.trim(),
      sourceDocumentId: f.sourceDocumentId,
    });
  }

  // Conflicts: one field path, two different attested values → commit neither.
  const valuesByPath = new Map<string, Set<string>>();
  for (const e of eligible) {
    const set = valuesByPath.get(e.fieldPath) ?? new Set<string>();
    set.add(e.value);
    valuesByPath.set(e.fieldPath, set);
  }
  const committed: PlannedCommitField[] = [];
  for (const e of eligible) {
    if ((valuesByPath.get(e.fieldPath)?.size ?? 0) > 1) {
      excluded.push({
        candidateId: e.candidateId,
        fieldPath: e.fieldPath,
        reason: "conflicting_values",
      });
    } else {
      committed.push(e);
    }
  }

  const fields: DocLensCommitField[] = [];
  const seen = new Set<string>();
  for (const c of committed) {
    if (seen.has(c.fieldPath)) continue;
    seen.add(c.fieldPath);
    fields.push({ fieldPath: c.fieldPath, value: c.value });
  }

  return {
    targetPatientId: committed.length > 0 ? input.batchPatientId : null,
    committed,
    fields,
    excluded,
  };
}
