// @chartwarden/assessments — LPN cosignature workflow (§7.4, §2.3, §6). Pure, IO-free.
//
// §2.3 sets `cosign_required=true` when the capturing discipline is LPN and the scale ∈ {PPS, KPS, FAST}.
// §7.4: a row recorded by an LPN under that rule inserts with `cosign_required=true`; consumer surfaces
// (the M6 CTI narrative draft) refuse to include it until a cosignature row exists (the `COSIGN_REQUIRED`
// read gate). A supervising RN / Clinical Supervisor reviews from the cosign queue and attests — the
// `assessment_cosignature` row inserts; `cosign_required` STAYS `true` on the row for historical accuracy,
// and consumers key off the cosignature row's PRESENCE, not the column. This module owns those pure
// decisions; the service (M9-T05) applies them and the `assessment.cosigned` event (M9-T06).
import type { ScaleType } from "@chartwarden/types";
import { AssessmentStateError, require_ } from "./errors";

/** §2.3 — the scales an LPN-captured row must have cosigned before a consumer surface may use it. */
export const LPN_COSIGN_SCALES = ["pps", "kps", "fast"] as const satisfies readonly ScaleType[];

/** The disciplines permitted to attest an assessment cosignature (§6 `assessment.cosign` — RN Case
 * Manager and Clinical Supervisor; ABAC caseload/scope is layered at the route). Lower-cased keys. */
export const COSIGN_ELIGIBLE_DISCIPLINES = ["rn", "clinical_supervisor"] as const;

/** Normalize a free-text `captured_by_discipline` to the lower-case key the rules compare. */
function disciplineKey(discipline: string): string {
  return discipline.trim().toLowerCase();
}

/**
 * §2.3 — whether a capture requires an LPN cosignature: the capturing discipline is an LPN and the scale
 * is one of {PPS, KPS, FAST}. The recording service sets `cosign_required` from this; RN/MD/NP captures
 * never require a cosignature (§7.1).
 */
export function cosignRequiredFor(discipline: string, scaleType: ScaleType): boolean {
  return (
    disciplineKey(discipline) === "lpn" &&
    (LPN_COSIGN_SCALES as readonly ScaleType[]).includes(scaleType)
  );
}

/**
 * §7.4 — whether a row is effectively usable by a consumer surface: either it never required a
 * cosignature, or a cosignature row exists. The `cosign_required` column is preserved for historical
 * accuracy; consumers consult the cosignature's PRESENCE (this function), never flip the column.
 */
export function cosignSatisfied(cosignRequired: boolean, hasCosignature: boolean): boolean {
  return !cosignRequired || hasCosignature;
}

/**
 * §7.4 / §4.4 — the read gate a cosignature-sensitive consumer (e.g. the M6 CTI narrative draft) calls
 * before surfacing a row. Raises `COSIGN_REQUIRED` (412) when the row required a cosignature that has not
 * yet been attested. The default chart read is NOT gated — only contexts that must not surface an
 * un-cosigned value (the CTI narrative) consult this.
 */
export function assertCosignSatisfied(cosignRequired: boolean, hasCosignature: boolean): void {
  require_(
    cosignSatisfied(cosignRequired, hasCosignature),
    "COSIGN_REQUIRED",
    "This assessment requires a cosignature before it can be surfaced in this context.",
  );
}

/** The decision a validated attest produces: the cosignature row to insert + the `assessment.cosigned`
 * event to emit. The service applies it; the row's `cosign_required` column is left unchanged (§7.4). */
export interface CosignPlan {
  readonly clinicalAssessmentId: string;
  readonly emitsCosigned: true;
}

/** The facts an attest is validated against (the parent row's state + the attesting caller's discipline). */
export interface CosignAttest {
  readonly clinicalAssessmentId: string;
  readonly cosignRequired: boolean;
  /** Whether a cosignature row already exists for this assessment (idempotency / double-sign guard). */
  readonly alreadyCosigned: boolean;
  readonly cosignerDiscipline: string;
  /** ABAC self-cosign guard: the attester must not be the row's original recorder (§6 / §7.4). */
  readonly cosignerIsRecorder: boolean;
}

/**
 * §7.4 / §6 — validate an LPN-cosignature attest and produce the insert/emit plan. Guards:
 *   - the row must actually require a cosignature → 422 `COSIGN_NOT_REQUIRED`
 *   - not already cosigned                        → 409 `ALREADY_COSIGNED`
 *   - attester is RN / Clinical Supervisor and not the original recorder → 403 `NOT_COSIGN_ELIGIBLE`
 * Pure: the service inserts the `assessment_cosignature` row and emits `assessment.cosigned`.
 */
export function planCosignAttest(attest: CosignAttest): CosignPlan {
  require_(
    attest.cosignRequired,
    "COSIGN_NOT_REQUIRED",
    `Assessment ${attest.clinicalAssessmentId} does not require a cosignature.`,
  );
  require_(
    !attest.alreadyCosigned,
    "ALREADY_COSIGNED",
    `Assessment ${attest.clinicalAssessmentId} is already cosigned.`,
  );
  require_(
    (COSIGN_ELIGIBLE_DISCIPLINES as readonly string[]).includes(
      attest.cosignerDiscipline.trim().toLowerCase(),
    ) && !attest.cosignerIsRecorder,
    "NOT_COSIGN_ELIGIBLE",
    "Only a supervising RN or Clinical Supervisor (other than the original recorder) may cosign.",
  );
  return { clinicalAssessmentId: attest.clinicalAssessmentId, emitsCosigned: true };
}
