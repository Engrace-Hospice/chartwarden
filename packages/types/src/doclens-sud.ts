// @wardenx/types — the DocLens SUD-detection contract (F-237; M22 §7.4 W4 / D8, 42 CFR Part 2 §2.31).
//
// M22 detects possible substance-use-disorder content in an intake batch and tells M5, which owns the
// patient's privacy-flag snapshot (M5 D10). The reviewer then confirms or rejects the detection in the
// review UI; both round-trip to M5. M5 and M22 share no `dependsOn` edge, so the event names and payloads
// live here, in the leaf both may read.
//
// No payload carries PHI beyond ids: NOT the matched term, NOT a snippet, NOT the reviewer's reason.
// A Part 2 indicator on a named patient is itself protected information, and an outbox row is read by
// every consumer of the event.

/** The §7.4 W4 state of an intake batch (mirrors `intake_batch_sud_status`, migration 0308). */
export type IntakeBatchSudStatus = "not_detected" | "detected" | "confirmed" | "rejected";

export const M22_INTAKE_SUD_DETECTED_EVENT = "m22.intake.sud_detected" as const;
export const M22_INTAKE_SUD_CONFIRMED_EVENT = "m22.intake.sud_confirmed" as const;
export const M22_INTAKE_SUD_REJECTED_EVENT = "m22.intake.sud_rejected" as const;

/** The coarse §1.1 / D8 categories (`suggestedSudKind`). */
export type DocLensSudKind = "medication" | "diagnosis" | "social_history" | "treatment_setting";

/** `m22.intake.sud_detected` — detection is independent of any reviewer decision (W4 step 3). */
export interface IntakeSudDetectedPayload {
  readonly intakeBatchId: string;
  /** The batch's already-resolved patient. `null` ⇒ M5 has no patient to flag (it records nothing). */
  readonly patientId: string | null;
  /** Candidates on the SUD-bearing pages (each tagged `sud_detected = true`). */
  readonly candidateCount: number;
  /** The most frequent indicator category. */
  readonly suggestedSudKind: DocLensSudKind;
  /** Page numbers carrying an indicator (no text). */
  readonly pages: readonly number[];
}

/** `m22.intake.sud_confirmed` / `m22.intake.sud_rejected` — the reviewer's W4 step 6 resolution. */
export interface IntakeSudResolvedPayload {
  readonly intakeBatchId: string;
  readonly patientId: string | null;
  readonly resolvedByMembershipId: string;
}
