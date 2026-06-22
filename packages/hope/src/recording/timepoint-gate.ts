// @wardenx/hope — the recording-boundary guards (M10-T03; §2.3, D2, D9, D12). PURE, IO-free: the
// cross-field/temporal checks the recording service (M10-T06) runs AFTER route-boundary TypeBox and the
// discipline gate, BEFORE the `hope_assessment` insert. Each guard raises the precise §4.4 code. Facts
// (admission-active, schedule window, schedule rfa_kind) are injected from M6 readers / the schedule row;
// M10 never imports M6 schema. The CMS pre-submission rules (value-set membership, required-items matrix)
// are NOT here — they land in the validation engine (M10-T04).
import type { HopeDischargeReason, HopeRfaKind, IsoInstant } from "@wardenx/types";
import { require_ } from "../errors";
import { classifyCapture, type TimepointWindow } from "../scheduling/window-calculator";

/** §2.3 — the admission must be `active` at the visit's `target_date` (for a Discharge RFA, it was active
 * immediately before discharge — the discharge listener resolves that fact). Raises 409. */
export function assertAdmissionActiveAtTarget(activeAtTarget: boolean): void {
  require_(
    activeAtTarget,
    "M10_ADMISSION_NOT_ACTIVE",
    "Admission is not active at the assessment target_date; HOPE capture requires an active admission.",
  );
}

/**
 * §2.3 — the payload `rfa_kind` must match the schedule's `rfa_kind`. The one allowed divergence: a
 * `04_sfv` payload recorded against a schedule created by the SFV trigger (`generated_by='sfv_trigger'`).
 * Raises `M10_RFA_KIND_MISMATCH` (409).
 */
export function assertRfaMatchesSchedule(
  payloadRfaKind: HopeRfaKind,
  schedule: { readonly rfaKind: HopeRfaKind; readonly generatedBy: string },
): void {
  const ok =
    payloadRfaKind === schedule.rfaKind ||
    (payloadRfaKind === "04_sfv" && schedule.generatedBy === "sfv_trigger");
  require_(
    ok,
    "M10_RFA_KIND_MISMATCH",
    `Payload rfa_kind '${payloadRfaKind}' does not match the schedule's '${schedule.rfaKind}'.`,
  );
}

/** §4.4 / D12 — the closed CMS-aligned late-completion reason codelist. A capture in the late-grace span
 * (window close → late deadline) requires one of these; each late completion increments the HQRP
 * non-compliance counter (D12, exposed via `HopeSubmissionProvider` in later tasks). */
export const LATE_COMPLETION_REASON_CODES = [
  "pto",
  "hospitalization",
  "family_meeting_deferral",
  "refused",
  "missed",
  "pandemic_cohort",
  "admin_override",
  "other",
] as const;

/** A late-completion reason code (D12). */
export type LateCompletionReasonCode = (typeof LATE_COMPLETION_REASON_CODES)[number];

/** The capture verdict the service applies after {@link assertCaptureAllowed} (drives `was_late`). */
export interface CaptureDecision {
  readonly wasLate: boolean;
  readonly lateReasonCode: LateCompletionReasonCode | null;
}

/**
 * §2.3 / D2 / D12 — gate a `target_date` capture against the stored schedule window and return the
 * `was_late` decision. Guards (in §4.4 order):
 *   - `before_open` → 409 `M10_TIMEPOINT_NOT_OPEN`
 *   - `expired`     → 409 `M10_TIMEPOINT_EXPIRED` (unless `adminOverride` extends the deadline)
 *   - `late`        → requires a typed `late_reason_code`:
 *       absent  → 400 `M10_LATE_REASON_REQUIRED`
 *       invalid → 400 `M10_LATE_REASON_INVALID`
 *   - `in_window`   → normal capture (`was_late=false`; a late reason, if sent, is ignored/dropped).
 * Pure: returns the decision; the service writes `was_late` / `late_completion_reason_code`.
 */
export function assertCaptureAllowed(
  targetDate: IsoInstant,
  window: TimepointWindow,
  options: {
    readonly lateReasonCode?: string | null;
    readonly adminOverride?: boolean;
  } = {},
): CaptureDecision {
  const verdict = classifyCapture(targetDate, window);
  require_(
    verdict !== "before_open",
    "M10_TIMEPOINT_NOT_OPEN",
    `target_date ${targetDate} is before the timepoint window opens (${window.windowOpensAt}).`,
  );
  require_(
    verdict !== "expired" || options.adminOverride === true,
    "M10_TIMEPOINT_EXPIRED",
    `target_date ${targetDate} is past the late deadline (${window.lateDeadlineAt}); an admin override is required.`,
  );
  if (verdict === "in_window") return { wasLate: false, lateReasonCode: null };
  // `late` (or an admin-overridden `expired`): a typed late reason is mandatory (D12).
  require_(
    options.lateReasonCode != null && options.lateReasonCode !== "",
    "M10_LATE_REASON_REQUIRED",
    "Capture between window close and the late deadline requires a typed late_completion_reason_code.",
  );
  require_(
    (LATE_COMPLETION_REASON_CODES as readonly string[]).includes(options.lateReasonCode),
    "M10_LATE_REASON_INVALID",
    `late_completion_reason_code '${options.lateReasonCode}' is not in the CMS-aligned codelist.`,
  );
  return { wasLate: true, lateReasonCode: options.lateReasonCode as LateCompletionReasonCode };
}

/**
 * D9 — the Discharge RFA Section-Q branch, enforced at the recording boundary. Section Q (Participation)
 * is the live-discharge section: a `death` discharge REJECTS Section Q (`M10_FORBIDDEN_SECTION_PRESENT`,
 * 400); every other reason (`revocation` / `transfer_to_hospice` / `live_discharge`) REQUIRES it
 * (`M10_REQUIRED_SECTION_MISSING`, 400). (Resolved decision D9 is authoritative over the §4.3 TypeBox
 * comment which only enumerates the live-discharge case.)
 */
export function assertSectionQForDischarge(
  dischargeReason: HopeDischargeReason,
  sectionQPresent: boolean,
): void {
  if (dischargeReason === "death") {
    require_(
      !sectionQPresent,
      "M10_FORBIDDEN_SECTION_PRESENT",
      "Section Q (Participation) is forbidden on a death-discharge HOPE assessment (D9).",
    );
    return;
  }
  require_(
    sectionQPresent,
    "M10_REQUIRED_SECTION_MISSING",
    `Section Q (Participation) is required on a '${dischargeReason}' discharge HOPE assessment (D9).`,
  );
}
