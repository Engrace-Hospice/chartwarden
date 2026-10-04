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
/** F-238 — a batch with an UNREVIEWED detection was discarded: its detection no longer holds a flag. */
export const M22_INTAKE_SUD_WITHDRAWN_EVENT = "m22.intake.sud_withdrawn" as const;

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
  /**
   * `m22.intake.sud_rejected` only: another batch of this patient still carries a live (pending or
   * confirmed) detection, so M5 must keep the DocLens flag. Absent on older events (treated as false).
   */
  readonly patientRetainsFlag?: boolean;
}

/**
 * `m22.intake.sud_relinked` — F-238: a fax carrying a pending or confirmed Part 2 detection was moved to
 * another patient (Move document), or a referral-filed fax adopted the patient its referral resolved to.
 * M5 moves the DocLens-origin flag with it: the new patient gains it (as `detected` / `confirmed`), and the
 * previous patient loses it ONLY when no other DocLens detection still holds it (`fromPatientRetainsFlag`,
 * computed by M22, which owns the batches) and only when DocLens — not M39 consent state — put it there.
 */
export const M22_INTAKE_SUD_RELINKED_EVENT = "m22.intake.sud_relinked" as const;

export interface IntakeSudRelinkedPayload {
  readonly intakeBatchId: string;
  /** Who the fax was filed under. `null` ⇒ no patient held the flag (a referral not yet resolved). */
  readonly fromPatientId: string | null;
  /** Who it is filed under now. `null` ⇒ moved to a referral with no patient yet: nobody gains the flag. */
  readonly toPatientId: string | null;
  readonly sudStatus: "detected" | "confirmed";
  /** Another unresolved/confirmed DocLens detection on `fromPatientId` still needs the flag. */
  readonly fromPatientRetainsFlag: boolean;
  /** Null when the move was the referral's resolution (adoption), not a person. */
  readonly movedByMembershipId: string | null;
}

/**
 * `m22.intake.sud_withdrawn` — F-238: a batch whose detection nobody had reviewed was discarded, so the
 * detection no longer restricts the patient. M5 retires the DocLens-origin flag as a rejection would —
 * only if DocLens put it there, and not while another live detection holds it (`patientRetainsFlag`,
 * computed by M22). A CONFIRMED detection is a licensed reviewer's finding and is never withdrawn.
 */
export interface IntakeSudWithdrawnPayload {
  readonly intakeBatchId: string;
  readonly patientId: string;
  readonly patientRetainsFlag: boolean;
  readonly withdrawnByMembershipId: string | null;
}
