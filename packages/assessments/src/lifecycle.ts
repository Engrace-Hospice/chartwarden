// @wardenx/assessments — entity lifecycle machines (§2.2, D9). Pure, IO-free (the M8 lifecycle
// convention): legal-graph check + enumerated guards (each raises the §4.4 code), facts injected as
// data. The recording/correction services (M9-T05) compose these over the Drizzle write transaction; the
// significant-change escalation cron (M9-T06) composes the ack machine. No cross-module schema import.
import type {
  AdmissionId,
  AssessmentStatus,
  ClinicalAssessmentId,
  PatientId,
  ScaleLicenseStatus,
  ScaleType,
  SignificantChangeRuleId,
  SignificantChangeStatus,
} from "@wardenx/types";
import { isCriticalRule } from "@wardenx/types";
import { AssessmentStateError, require_ } from "./errors";

// ── §2.2.1 `clinical_assessment.status` — append-only correction-of-record (active → superseded) ──────

/** The minimal projection of an existing assessment the correction path validates against (D9). */
export interface CorrectionTarget {
  readonly id: ClinicalAssessmentId;
  readonly scaleType: ScaleType;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly status: AssessmentStatus;
  readonly version: number;
}

/** The candidate correction row's identifying context (must agree with its target, §2.3). */
export interface CorrectionCandidate {
  readonly scaleType: ScaleType;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  /** The parent `version` the caller read (optimistic concurrency, §2.3 → 412 `STALE_VERSION`). */
  readonly expectedTargetVersion: number;
}

/** The in-transaction effect a validated correction produces: supersede the target, stamp the new row's
 * `version`. The service applies this as DB writes; this machine only decides it (no IO). */
export interface CorrectionPlan {
  readonly supersedeTargetId: ClinicalAssessmentId;
  /** The new correction row's `version` (target.version + 1 — the amendment chain monotonically advances). */
  readonly newVersion: number;
}

/**
 * §2.2.1 / §2.3 — validate a correction against its target and produce the supersede plan. Guards, in
 * the §4.4 order the route surfaces them:
 *   - target must be `active`            → 409 `CORRECTION_TARGET_NOT_ACTIVE` (cannot correct a superseded row)
 *   - same scale_type / patient / admission → 422 `CORRECTION_MISMATCH`
 *   - caller's read of the parent `version` is current → 412 `STALE_VERSION`
 * Pure: the DB `correction-supersede` trigger repeats the supersede at the schema layer (defense in depth).
 */
export function planCorrection(
  target: CorrectionTarget,
  candidate: CorrectionCandidate,
): CorrectionPlan {
  require_(
    target.status === "active",
    "CORRECTION_TARGET_NOT_ACTIVE",
    `Assessment ${target.id} is already superseded; correct the current active row.`,
  );
  require_(
    target.scaleType === candidate.scaleType &&
      target.patientId === candidate.patientId &&
      target.admissionId === candidate.admissionId,
    "CORRECTION_MISMATCH",
    "Correction target scale_type / patient / admission disagrees with the correcting row.",
  );
  require_(
    target.version === candidate.expectedTargetVersion,
    "STALE_VERSION",
    `Optimistic-concurrency conflict: target is at version ${target.version}, caller expected ${candidate.expectedTargetVersion}.`,
  );
  return { supersedeTargetId: target.id, newVersion: target.version + 1 };
}

// ── §2.2.2 `significant_change_event.acknowledged_status` — open → acknowledged | escalated ────────────

/** The §2.2.2 ack-lifecycle events the detector + escalation cron drive. */
export type SignificantChangeEvent =
  /** A clinician acks (optionally with a note); valid from `open` or `escalated` (§2.2.2). */
  | { readonly type: "acknowledge" }
  /** 24h elapsed without ack on a CRITICAL rule → `escalated` (only PPS-drop / Braden-low / NYHA-IV). */
  | { readonly type: "escalate"; readonly ruleId: SignificantChangeRuleId };

/** The legal §2.2.2 transition graph (from → events accepted). `acknowledged` is terminal. */
const CHANGE_GRAPH: {
  readonly [S in SignificantChangeStatus]: ReadonlySet<SignificantChangeEvent["type"]>;
} = {
  open: new Set(["acknowledge", "escalate"]),
  escalated: new Set(["acknowledge"]),
  acknowledged: new Set(),
};

/**
 * §2.2.2 — advance a `significant_change_event`. `acknowledge` resolves `open`/`escalated` → `acknowledged`;
 * `escalate` moves `open` → `escalated` only for a CRITICAL rule (§4.9 — the 24h-no-ack cron, M9-T06).
 * Raises `ILLEGAL_CHANGE_TRANSITION` (409) off-graph, `CHANGE_NOT_ESCALATABLE` (422) for a non-critical
 * escalation attempt.
 */
export function transitionSignificantChange(
  current: SignificantChangeStatus,
  event: SignificantChangeEvent,
): SignificantChangeStatus {
  require_(
    CHANGE_GRAPH[current].has(event.type),
    "ILLEGAL_CHANGE_TRANSITION",
    `Cannot '${event.type}' a significant-change event in '${current}'.`,
  );
  if (event.type === "acknowledge") return "acknowledged";
  // escalate
  require_(
    isCriticalRule(event.ruleId),
    "CHANGE_NOT_ESCALATABLE",
    `Rule '${event.ruleId}' is not CRITICAL; only PPS-drop / Braden-low / NYHA-IV escalate (§4.9).`,
  );
  return "escalated";
}

// ── §2.2.3 `scale_license.status` — date-derived per-tenant licensure state (D3) ───────────────────────

/** Days, by the proprietary-scale renewal convention, before `expires_at` that a license flips to
 * `pending_renewal` (the daily license-status worker emits `m9.scale.license_pending_renewal`). */
export const LICENSE_RENEWAL_WINDOW_DAYS = 30;

/** Parse a `YYYY-MM-DD` calendar date to a UTC-midnight epoch-day ordinal (TZ-stable; pure). */
function epochDay(localDate: string): number {
  const [y, m, d] = localDate.split("-").map((p) => Number.parseInt(p, 10));
  return Math.floor(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * §2.2.3 — recompute a proprietary scale's licensure status from its effective/expiry dates as of
 * `today` (the daily worker's job, D3). `active` while in force and > {@link LICENSE_RENEWAL_WINDOW_DAYS}
 * from expiry; `pending_renewal` inside the 30-day window; `expired` on/after expiry. A not-yet-effective
 * license (today < effective) is treated as `pending_renewal` — it is not yet in force for recording, and
 * the recording gate keys off `status === 'active'`. All inputs are `YYYY-MM-DD` calendar dates.
 */
export function computeScaleLicenseStatus(
  license: { readonly effectiveDate: string; readonly expiresAt: string },
  today: string,
): ScaleLicenseStatus {
  const now = epochDay(today);
  const effective = epochDay(license.effectiveDate);
  const expires = epochDay(license.expiresAt);
  if (now >= expires) return "expired";
  if (now < effective) return "pending_renewal";
  if (expires - now <= LICENSE_RENEWAL_WINDOW_DAYS) return "pending_renewal";
  return "active";
}

/** D3 form-gating: only an `active` license permits recording a license-required scale; reads of
 * historical rows recorded under a prior active license are always preserved (enforced on the read path). */
export function canRecordUnderLicense(status: ScaleLicenseStatus): boolean {
  return status === "active";
}

/** Guard the recording path on an active license (raises `SCALE_LICENSE_MISSING` 403, §2.3 / §7.7). */
export function assertLicenseAllowsRecording(
  scaleType: ScaleType,
  status: ScaleLicenseStatus,
): void {
  require_(
    canRecordUnderLicense(status),
    "SCALE_LICENSE_MISSING",
    `Scale '${scaleType}' requires an active license to record (current status: ${status}).`,
  );
}
