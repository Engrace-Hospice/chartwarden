// apps/backend/src/modules/10-hope/routes/service.ts — M10-T06 the §4.1 route service over an in-memory
// backend (the same in-mem-slice precedent as M8-T09 / M9-T05; Drizzle in prod under `withOrgContext` so
// RLS backstops every read). The service composes the PURE M10 domain (`@chartwarden/hope`): the
// server-authoritative J2051 trigger (`evaluateJ2051Trigger`, D4), the one-SFV-per-source planner
// (`planSfvCreation`), the SFV completion guard (`planSfvCompletion`), the correction-chain guards, and
// the §4.4 `HopeStateError` codes. It consumes M9's `LatestAssessmentProvider` seam (injected) to snapshot
// PPS / ESAS-r at sign (D8); when absent the snapshot is skipped and a warning is recorded (§7.13 / DR
// Tier-2 — no external dependency blocks the write path). Every state transition records the §2.4 outbox
// event the relay publishes (drainable for tests).
import { createHash } from "node:crypto";
import {
  type CaptureDecision,
  type HopeAttention,
  HopeStateError,
  type HopeValidationFindingDescriptor,
  type J2051SymptomReading,
  assertAdmissionActiveAtTarget,
  assertCaptureAllowed,
  assertRfaMatchesSchedule,
  assertSectionQForDischarge,
  evaluateFixedHopeAttention,
  evaluateJ2051Trigger,
  evaluateSfvAttention,
  planSfvCompletion,
  planSfvCreation,
  require_,
} from "@chartwarden/hope";
import type {
  HopeDischargeReason,
  HopeRfaKind,
  HopeScheduleGeneratedBy,
  HopeScheduleStatus,
  HopeSfvStatus,
  HopeSubmissionItemStatus,
  HopeSubmissionStatus,
  J2051Severity,
  LatestAssessmentProvider,
  ScaleType,
} from "@chartwarden/types";
import { ConflictError, NotFoundError } from "@chartwarden/types";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "../abac-predicates";
import type {
  HopeAnswerPatchChange,
  HopeAnswerPatchResult,
  HopeAssessmentWorkspace,
} from "../hope-answer-service";
import type { HopeReviewReadModel } from "../hope-readiness-service";
import {
  type RejectedItemResolution,
  classifyCmsResult,
  deriveBatchOutcome,
  findingSeverity,
  isResultImportable,
  manualUploadTransmittedPayload,
  resolveRejectedItem,
  settledBatchEvent,
  terminalCorrection,
  worstOutcome,
} from "../hope-submission-result";
import type { HopeValidationRunView } from "../hope-validation-service";
import { submissionPeriodFor } from "../jobs/submission";

export type { HopeReviewReadModel } from "../hope-readiness-service";
export type { HopeAnswerPatchResult, HopeAssessmentWorkspace } from "../hope-answer-service";
export type { HopeValidationFindingView, HopeValidationRunView } from "../hope-validation-service";

// ── §2.4 outbox events the service records (the relay wraps them in the M1 envelope) ───────────────────
export interface RecordedHopeEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
}

// ── view DTOs (read projections; never the raw Drizzle row) ────────────────────────────────────────────
export interface HopeAssessmentView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly rfaKind: HopeRfaKind;
  readonly status: "draft" | "signed" | "superseded";
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly j2051MaxSeverity: J2051Severity | null;
  readonly j2051TriggerFired: boolean;
  readonly wasLate: boolean;
  readonly signedAt: string | null;
  readonly signedBy: string | null;
  readonly correctsAssessmentId: string | null;
  readonly supersededByAssessmentId: string | null;
  readonly snapshot: Readonly<Record<string, number | null>> | null;
  readonly regulatory: {
    readonly specVersionId: string | null;
    readonly isc: "HA" | "HUV" | "HD" | "XX" | null;
  };
  readonly version: number;
}
export interface HopeScheduleView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly rfaKind: HopeRfaKind;
  readonly status: HopeScheduleStatus;
  readonly windowOpensAt: string;
  readonly windowClosesAt: string;
  readonly lateDeadlineAt: string;
  readonly generatedBy: HopeScheduleGeneratedBy;
  readonly completedByAssessmentId: string | null;
}
export interface HopeSfvView {
  readonly id: string;
  readonly patientId: string;
  /** The admission the follow-up belongs to — the key `POST …/hope/sfv` is addressed by (#91). */
  readonly admissionId: string;
  readonly triggeringAssessmentId: string;
  readonly status: HopeSfvStatus;
  readonly triggeredAt: string;
  readonly dueAt: string;
  readonly completingAssessmentId: string | null;
}
export interface HopeSubmissionView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly submissionPeriod: string;
  readonly status: HopeSubmissionStatus;
  readonly transportMode?: string;
  readonly validationProfile?: string | null;
  readonly packageFilename?: string | null;
  readonly packageSha256?: string | null;
  readonly packageSizeBytes?: number | null;
  readonly itemCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly transmittedAt: string | null;
  readonly exportedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly acceptedAt: string | null;
  readonly iqiesSubmissionReference?: string | null;
  /** Rejected items still awaiting a correction assessment (corrections supersede; originals untouched). */
  readonly needsCorrectionCount: number;
  /** Rejected items whose correction exists but is not yet in a batch (draft/signed, unpackaged). */
  readonly correctionInProgressCount: number;
  /** Rejected items whose correction is in a newer batch awaiting the CMS result. */
  readonly resubmittedCount: number;
}

/** One assessment inside a batch, with its CMS outcome. Patient NAME is not resolved here (M10 holds only
 * the id); the web resolves it from the patient API. */
export interface HopeSubmissionItemView {
  readonly id: string;
  readonly assessmentId: string;
  readonly patientId: string | null;
  readonly rfaKind: HopeRfaKind | null;
  readonly assessmentStatus: "draft" | "signed" | "superseded" | null;
  readonly status: HopeSubmissionItemStatus;
  readonly iqiesRecordId: string | null;
  readonly processedAt: string | null;
  /** Only for a rejected item: where the correction stands. */
  readonly resolution: RejectedItemResolution | null;
  readonly correctionAssessmentId: string | null;
}

/** One CMS finding recorded from the Final Validation Report. */
export interface HopeSubmissionFindingView {
  readonly id: string;
  readonly assessmentId: string | null;
  readonly severity: "error" | "warning";
  readonly code: string | null;
  readonly itemCode: string | null;
  readonly message: string | null;
}

export interface HopeSubmissionDetailView extends HopeSubmissionView {
  readonly resultImportedAt: string | null;
  readonly resultReportReference: string | null;
  readonly items: readonly HopeSubmissionItemView[];
  readonly findings: readonly HopeSubmissionFindingView[];
}

/** Reverse lookup: a batch holding one assessment. */
export interface HopeAssessmentSubmissionView {
  readonly submissionId: string;
  readonly status: HopeSubmissionStatus;
  readonly itemStatus: HopeSubmissionItemStatus;
  readonly packageFilename: string | null;
  readonly submittedAt: string | null;
  readonly resultImportedAt: string | null;
}

/**
 * What one force-assemble pass did (F-058 / #150).
 *
 * The route used to return a single `HopeSubmissionView` because it always created exactly one batch —
 * an EMPTY one, whose `itemCount` was the literal `0` and whose `hope_submission_item` rows were never
 * written at all. A real pass groups the provider entity's eligible signed assessments by CMS submission
 * period, so it produces one batch PER period and may legitimately produce none.
 *
 * The three counts are not telemetry. `skippedAlreadyBatched` is what makes the §4.10 idempotency
 * OBSERVABLE — a second press returns zero submissions and a non-zero skip count, rather than looking
 * like a failure — and `skippedUnsited` is the one outcome that must never be silent: an assessment
 * whose `provider_entity_id` is NULL has no CCN to be batched under and is excluded by arithmetic, not
 * by a rule anyone wrote down.
 */
export interface HopeAssembleResultView {
  readonly submissions: readonly HopeSubmissionView[];
  /** Signed, unsuperseded, not-yet-iQIES-accepted assessments the pass looked at. */
  readonly assessmentsConsidered: number;
  /** Already carried by a `pending` submission item — the idempotency skip. */
  readonly skippedAlreadyBatched: number;
  /** No `provider_entity_id`, so no batch key. See {@link HopeAssembleResultView}. */
  readonly skippedUnsited: number;
}
/**
 * The §7 HQRP compliance posture.
 *
 * #48 — every rate is NULLABLE and ships beside the count pair it was computed from. They used to be
 * plain numbers that fell back to `1` on an empty denominator, so an agency with no closed timepoint
 * windows at all — which was EVERY agency, because nothing ever wrote a `hope_timepoint_schedule` row —
 * was shown a perfect on-time rate on the screen it would use to decide it did not need to act. "No
 * data" is not "100%", and it is the compliance officer's call which one they are looking at. Exposing
 * the counts beside the rate follows the M15 `supervisoryOnTimeCounts` precedent (a pre-divided rate
 * cannot be suppressed for small N, because the denominator is gone by the time anyone sees it).
 */
export interface HopeComplianceView {
  readonly providerEntityId: string | null;
  readonly hopeOnTimeRate: number | null;
  readonly hopeOnTimeCounts: { readonly onTime: number; readonly total: number };
  readonly sfvOnTimeRate: number | null;
  readonly sfvOnTimeCounts: { readonly onTime: number; readonly total: number };
  readonly submissionAcceptanceRate: number | null;
  readonly submissionAcceptanceCounts: { readonly accepted: number; readonly total: number };
}
export type HopeWorkflowItemStatus =
  | "upcoming"
  | "open"
  | "late"
  | "completed"
  | "expired"
  | "skipped"
  | "not_applicable"
  | "workflow_not_initialized";
export interface HopeWorkflowTimepointView {
  readonly kind: Exclude<HopeRfaKind, "04_sfv">;
  readonly status: HopeWorkflowItemStatus;
  readonly scheduleId: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly lateDeadline: string | null;
  readonly completedAt: string | null;
  readonly assessmentId: string | null;
  readonly attention: HopeAttention;
}
export interface HopeWorkflowSfvView {
  readonly id: string;
  readonly status: HopeSfvStatus;
  readonly triggeringAssessmentId: string;
  readonly triggeringRfaKind: HopeRfaKind | null;
  readonly dueAt: string;
  readonly triggeredAt: string;
  readonly completedAt: string | null;
  readonly completingAssessmentId: string | null;
  readonly attention: HopeAttention;
}
export interface HopeWorkflowSummaryView {
  readonly actionableCount: number;
  readonly overdueCount: number;
  readonly completedCount: number;
  readonly nextDeadline: string | null;
  readonly highestSeverity: HopeAttention["severity"];
  readonly dueSoonCount: number;
  readonly workflowIssueCount: number;
}
export interface HopeWorkflowStateView {
  readonly admissionId: string;
  readonly patientId: string | null;
  readonly admissionStatus: string | null;
  readonly admissionAt: string | null;
  readonly activatedAt: string | null;
  readonly dischargedAt: string | null;
  readonly admissionAssessment: HopeWorkflowTimepointView;
  readonly huv1: HopeWorkflowTimepointView;
  readonly huv2: HopeWorkflowTimepointView;
  readonly sfvs: readonly HopeWorkflowSfvView[];
  readonly dischargeAssessment: HopeWorkflowTimepointView;
  readonly summary: HopeWorkflowSummaryView;
}

export interface RecordTimepointArgs {
  readonly rfaKind: HopeRfaKind;
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly data: Record<string, unknown>;
  readonly sourceEncounterId?: string;
  readonly dischargeReason?: string;
  readonly lateCompletionReasonCode?: string | null;
  readonly adminOverride?: boolean;
  /** GAP-015: the platform-admin justification recorded on the critical audit when the override is used. */
  readonly adminOverrideJustification?: string;
  /**
   * #48 — the `hope_timepoint_schedule` window this capture completes, as handed to the clinician by the
   * timepoint worklist. Naming it is what makes `M10_RFA_KIND_MISMATCH` reachable: the payload's RFA and
   * the window that was clicked can disagree. Omitted, the window is resolved by `rfa_kind` instead.
   */
  readonly scheduleId?: string;
}
export interface RecordSfvArgs {
  readonly triggeringAssessmentId: string;
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly data: Record<string, unknown>;
  readonly adminOverride?: boolean;
  readonly adminOverrideJustification?: string;
}
export interface SignTimepointArgs {
  readonly ifVersion?: number;
}
export interface SetHuvCompletionDateArgs {
  readonly ifVersion: number;
  readonly z0350: string;
}
export interface HopeSignResult {
  readonly assessmentId: string;
  readonly status: "signed";
  readonly version: number;
  readonly signedAt: string;
  readonly signedByMembershipId: string;
  readonly z0500b: string;
  readonly validation: {
    readonly errorCount: number;
    readonly warningCount: number;
    readonly hasBlockingErrors: boolean;
  };
}
export interface CorrectTimepointArgs {
  readonly correctionReason: string;
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly data: Record<string, unknown>;
  readonly ifVersion?: number;
}
export interface InactivateTimepointArgs {
  readonly reason: string;
  readonly ifVersion?: number;
}

/** The §4.1 route service contract (the routes compose over it; the in-mem slice + the prod Drizzle
 * backend both implement it). All ids/org binding come from server context, never the body. */
export interface HopeRouteService extends HopeAbacResolver {
  listSchedules(
    organizationId: string,
    filter: {
      patientId?: string;
      status?: string;
      rfaKind?: string;
      /** Caseload narrowing: only these patients' rows. `[]` matches nothing; omitted = no narrowing. */
      patientIds?: readonly string[];
    },
  ): Promise<{ schedules: HopeScheduleView[] }>;
  getSchedule(organizationId: string, id: string): Promise<HopeScheduleView>;
  skipSchedule(organizationId: string, id: string, reasonCode: string): Promise<HopeScheduleView>;
  recordTimepoint(
    organizationId: string,
    userId: string,
    admissionId: string,
    args: RecordTimepointArgs,
  ): Promise<HopeAssessmentView>;
  recordSfv(
    organizationId: string,
    userId: string,
    admissionId: string,
    args: RecordSfvArgs,
  ): Promise<HopeAssessmentView>;
  updateDraft(
    organizationId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<HopeAssessmentView>;
  getAssessmentWorkspace(organizationId: string, id: string): Promise<HopeAssessmentWorkspace>;
  getAssessmentReview(organizationId: string, id: string): Promise<HopeReviewReadModel>;
  patchAssessmentAnswers(
    organizationId: string,
    userId: string,
    id: string,
    input: { readonly ifVersion: number; readonly changes: readonly HopeAnswerPatchChange[] },
  ): Promise<HopeAnswerPatchResult>;
  setHuvCompletionDate(
    organizationId: string,
    userId: string,
    id: string,
    input: SetHuvCompletionDateArgs,
  ): Promise<HopeAnswerPatchResult>;
  signTimepoint(
    organizationId: string,
    userId: string,
    id: string,
    args?: SignTimepointArgs,
  ): Promise<HopeSignResult>;
  correctTimepoint(
    organizationId: string,
    userId: string,
    id: string,
    args: CorrectTimepointArgs,
  ): Promise<HopeAssessmentView>;
  inactivateTimepoint(
    organizationId: string,
    userId: string,
    id: string,
    args: InactivateTimepointArgs,
  ): Promise<HopeAssessmentView>;
  getAssessment(organizationId: string, id: string): Promise<HopeAssessmentView>;
  listPatientAssessments(
    organizationId: string,
    patientId: string,
  ): Promise<{ assessments: HopeAssessmentView[] }>;
  requestSummaryPdf(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<{ assessmentId: string; requested: true }>;
  listSfv(
    organizationId: string,
    state?: string,
    /** GAP-182 — caseload narrowing: ONLY these patients' SFVs (empty = none); absent = org-wide. */
    patientIds?: readonly string[],
  ): Promise<{ sfvs: HopeSfvView[] }>;
  getSfv(organizationId: string, id: string): Promise<HopeSfvView>;
  getValidation(
    organizationId: string,
    id: string,
    options?: { readonly mode?: "draft" | "final"; readonly submissionDate?: string },
  ): Promise<HopeValidationRunView>;
  listSubmissions(
    organizationId: string,
    providerEntityId?: string,
  ): Promise<{ submissions: HopeSubmissionView[] }>;
  getSubmission(organizationId: string, id: string): Promise<HopeSubmissionDetailView>;
  listAssessmentSubmissions(
    organizationId: string,
    assessmentId: string,
  ): Promise<{ submissions: HopeAssessmentSubmissionView[] }>;
  /**
   * @deprecated for the UI — iQIES has no retry. A rejected record is fixed with a correction assessment
   * (`POST /assessments/:id/correct`) and re-packaged in a NEW batch (assemble picks the correction up).
   * Kept only so the route contract is stable; nothing consumes the `queued` state it sets.
   */
  retrySubmission(organizationId: string, id: string): Promise<HopeSubmissionView>;
  assembleSubmission(organizationId: string, providerEntityId: string): Promise<HopeSubmissionView>;
  downloadSubmissionPackage(
    organizationId: string,
    id: string,
  ): Promise<{ filename: string; contentType: string; bytes: Buffer }>;
  markSubmissionUploaded(
    organizationId: string,
    userId: string,
    id: string,
    args: { submittedAt?: string; iqiesSubmissionReference?: string | null },
  ): Promise<HopeSubmissionView>;
  importSubmissionResult(
    organizationId: string,
    userId: string,
    id: string,
    args: { reportReference?: string | null; results: readonly Record<string, unknown>[] },
  ): Promise<HopeSubmissionDetailView>;
  complianceDashboard(
    organizationId: string,
    providerEntityId?: string,
  ): Promise<HopeComplianceView>;
  getWorkflowState(organizationId: string, admissionId: string): Promise<HopeWorkflowStateView>;
  regenerateSchedules(
    organizationId: string,
    admissionId: string,
  ): Promise<{ admissionId: string; scheduleCount: number }>;
  /** Drain (and clear) the §2.4 outbox events recorded since the last call (test/relay seam). */
  drainEvents(): RecordedHopeEvent[];
}

// ── in-memory records (the slice mutates these; the view DTOs are the read-only projections) ────────────
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface AssessmentRecord extends Mutable<HopeAssessmentView> {
  organizationId: string;
  /** F-058 — the CCN batch key. Not on the view (the wire shape is unchanged); the DB backend stamps
   *  the real column from the M6 admission summary at insert. */
  providerEntityId: string | null;
  data: Record<string, unknown>;
  /** F-057 — kept because the D9 Section-Q rules read it at validation time. Not on the view: the wire
   * shape is unchanged, and `recordTimepoint` already takes it. */
  dischargeReason: string | null;
  /** F-057 — the CMS pre-submission findings persisted at sign, mirroring `hope_validation_finding`. */
  findings: HopeValidationFindingDescriptor[];
}
interface ScheduleRecord extends Mutable<HopeScheduleView> {
  organizationId: string;
  timeZone: string;
}
interface SfvRecord extends Mutable<HopeSfvView> {
  organizationId: string;
  timeZone: string;
  triggeringSymptoms: ReadonlyArray<{ symptomCode: string; severity: string }>;
}
interface SubmissionItemRecord {
  id: string;
  assessmentId: string;
  status: HopeSubmissionItemStatus;
  iqiesRecordId: string | null;
  processedAt: string | null;
}
interface SubmissionRecord
  extends Mutable<
    Omit<
      HopeSubmissionView,
      "needsCorrectionCount" | "correctionInProgressCount" | "resubmittedCount"
    >
  > {
  organizationId: string;
  packageContentBase64?: string;
  items: SubmissionItemRecord[];
  findings: HopeSubmissionFindingView[];
  resultImportedAt: string | null;
  resultReportReference: string | null;
  resultReportHash: string | null;
}

export interface HopeRouteSeed {
  readonly assessments?: ReadonlyArray<
    Partial<AssessmentRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      rfaKind: HopeRfaKind;
    }
  >;
  readonly schedules?: ReadonlyArray<
    Partial<ScheduleRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      rfaKind: HopeRfaKind;
      windowOpensAt: string;
      windowClosesAt: string;
      lateDeadlineAt: string;
    }
  >;
  readonly sfvs?: ReadonlyArray<
    Partial<SfvRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      triggeringAssessmentId: string;
      dueAt: string;
    }
  >;
  readonly submissions?: ReadonlyArray<
    Partial<SubmissionRecord> & { id: string; organizationId: string; providerEntityId: string }
  >;
  /** Org IANA TZ for the org-local SFV due-date math (defaults to UTC). */
  readonly timeZone?: string;
  /** Injected clock (defaults to wall-clock ISO). */
  readonly now?: () => string;
  /** Injected M9 `LatestAssessmentProvider` seam for the D8 PPS/ESAS-r snapshot (absent ⇒ snapshot skipped). */
  readonly latestAssessments?: LatestAssessmentProvider;
  /**
   * #45 — admissionId → patientId, the M6 `AdmissionStatusReader` seam the DB backend resolves the
   * subject of a recorded timepoint through. The slice takes a plain map because it stands in for the
   * whole seam. An admission absent from it is a projection gap: `recordTimepoint` REFUSES rather than
   * inventing a subject (which is what this backend used to do — it wrote the `admissionId`).
   */
  readonly admissionPatients?: Readonly<Record<string, string>>;
  /**
   * #48 — admissionId → M6 admission status, the fact the §2.3 active-admission guard turns on.
   * Defaults to `active` for any admission in {@link admissionPatients}, so a seed that does not care
   * about the guard is unaffected and one that does states the closed status explicitly.
   */
  readonly admissionStatuses?: Readonly<Record<string, string>>;
}

/** The §D8 scales snapshotted at HOPE sign (PPS + ESAS-r) — read from M9's `LatestAssessmentProvider`. */
const SNAPSHOT_SCALES = ["pps", "esas_r"] as const;

/**
 * #48 — a rate over an empty denominator is NOT 1. `null` means "no data"; the caller renders that
 * distinctly from a perfect score. Shared by both M10 backends so the slice and Drizzle paths cannot
 * drift on the one behaviour a compliance officer reads off the screen.
 */
export const rateOf = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

let idCounter = 0x10a00000;
function nextId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const j2051EntriesOf = (data: Record<string, unknown>): J2051SymptomReading[] => {
  const j = (data as { J?: { J2051?: { entries?: unknown } } }).J?.J2051?.entries;
  if (!Array.isArray(j)) return [];
  return j.flatMap((e) =>
    e && typeof e === "object" && typeof (e as { severity?: unknown }).severity === "string"
      ? [
          {
            symptomCode: String((e as { symptomCode?: unknown }).symptomCode ?? "other"),
            severity: (e as { severity: J2051Severity }).severity,
          },
        ]
      : [],
  );
};

const FIXED_RFA_KINDS = ["01_admission", "02_huv1", "03_huv2", "05_discharge"] as const;

function statusForSchedule(
  schedule: HopeScheduleView | null,
  kind: (typeof FIXED_RFA_KINDS)[number],
  nowIso: string,
): HopeWorkflowItemStatus {
  if (!schedule) return kind === "05_discharge" ? "not_applicable" : "workflow_not_initialized";
  if (
    schedule.status === "completed" ||
    schedule.status === "expired" ||
    schedule.status === "skipped"
  )
    return schedule.status;
  if (nowIso < schedule.windowOpensAt) return "upcoming";
  if (nowIso > schedule.lateDeadlineAt) return "expired";
  if (nowIso > schedule.windowClosesAt) return "late";
  return "open";
}

export function buildWorkflowState(input: {
  readonly admissionId: string;
  readonly nowIso: string;
  readonly schedules: readonly HopeScheduleView[];
  readonly assessments: readonly HopeAssessmentView[];
  readonly sfvs: readonly HopeSfvView[];
  readonly admission?: {
    readonly patientId?: string | null;
    readonly status?: string | null;
    readonly admissionAt?: string | null;
    readonly activatedAt?: string | null;
    readonly dischargedAt?: string | null;
  } | null;
}): HopeWorkflowStateView {
  const assessmentsById = new Map(input.assessments.map((a) => [a.id, a]));
  const signedByRfa = new Map<HopeRfaKind, HopeAssessmentView>();
  for (const a of [...input.assessments].sort((a, b) => b.targetDate.localeCompare(a.targetDate))) {
    if (a.status === "signed" && !signedByRfa.has(a.rfaKind)) signedByRfa.set(a.rfaKind, a);
  }
  const draftByRfa = new Map<HopeRfaKind, HopeAssessmentView>();
  for (const a of [...input.assessments].sort((a, b) => b.targetDate.localeCompare(a.targetDate))) {
    if (a.status === "draft" && !draftByRfa.has(a.rfaKind)) draftByRfa.set(a.rfaKind, a);
  }
  const schedulesByKind = new Map<HopeRfaKind, HopeScheduleView>();
  for (const s of [...input.schedules].sort((a, b) =>
    a.windowOpensAt.localeCompare(b.windowOpensAt),
  ))
    if (!schedulesByKind.has(s.rfaKind)) schedulesByKind.set(s.rfaKind, s);

  const timepoint = (kind: (typeof FIXED_RFA_KINDS)[number]): HopeWorkflowTimepointView => {
    const schedule = schedulesByKind.get(kind) ?? null;
    const completed =
      (schedule?.completedByAssessmentId
        ? assessmentsById.get(schedule.completedByAssessmentId)
        : undefined) ??
      signedByRfa.get(kind) ??
      null;
    const draft = draftByRfa.get(kind) ?? null;
    const status = completed ? "completed" : statusForSchedule(schedule, kind, input.nowIso);
    return {
      kind,
      status,
      scheduleId: schedule?.id ?? null,
      windowStart: schedule?.windowOpensAt ?? null,
      windowEnd: schedule?.windowClosesAt ?? null,
      lateDeadline: schedule?.lateDeadlineAt ?? null,
      completedAt: completed?.signedAt ?? null,
      assessmentId: completed?.id ?? draft?.id ?? null,
      attention: evaluateFixedHopeAttention({
        kind,
        workflowStatus: status,
        windowOpensAt: schedule?.windowOpensAt ?? null,
        windowClosesAt: schedule?.windowClosesAt ?? null,
        lateDeadlineAt: schedule?.lateDeadlineAt ?? null,
        completedAt: completed?.signedAt ?? null,
        nowIso: input.nowIso,
      }),
    };
  };

  const fixed = {
    admissionAssessment: timepoint("01_admission"),
    huv1: timepoint("02_huv1"),
    huv2: timepoint("03_huv2"),
    dischargeAssessment: timepoint("05_discharge"),
  };
  const sfvs = input.sfvs
    .map((s) => {
      const source = assessmentsById.get(s.triggeringAssessmentId);
      const completion = s.completingAssessmentId
        ? assessmentsById.get(s.completingAssessmentId)
        : null;
      return {
        id: s.id,
        status: s.status,
        triggeringAssessmentId: s.triggeringAssessmentId,
        triggeringRfaKind: source?.rfaKind ?? null,
        dueAt: s.dueAt,
        triggeredAt: s.triggeredAt,
        completedAt: completion?.signedAt ?? null,
        completingAssessmentId: s.completingAssessmentId,
        attention: evaluateSfvAttention({
          status: s.status,
          dueAt: s.dueAt,
          completedAt: completion?.signedAt ?? null,
          nowIso: input.nowIso,
        }),
      };
    })
    .sort(
      (a, b) =>
        attentionPriority(a.attention.state) - attentionPriority(b.attention.state) ||
        a.dueAt.localeCompare(b.dueAt),
    );
  const fixedItems = Object.values(fixed);
  const actionableCount =
    fixedItems.filter((i) => i.status === "open" || i.status === "late").length +
    sfvs.filter((s) => s.status === "open" || s.status === "overdue").length;
  const overdueCount =
    fixedItems.filter(
      (i) => i.attention.state === "overdue" || i.attention.state === "window_expired",
    ).length + sfvs.filter((s) => s.status === "overdue" || s.status === "missed").length;
  const completedCount =
    fixedItems.filter((i) => i.status === "completed").length +
    sfvs.filter((s) => s.status === "completed").length;
  const allAttention = [...fixedItems.map((i) => i.attention), ...sfvs.map((s) => s.attention)];
  const dueSoonCount = allAttention.filter((a) => a.state === "due_soon").length;
  const workflowIssueCount = allAttention.filter((a) => a.state === "workflow_issue").length;
  const candidateDeadlines = [
    ...fixedItems
      .filter((i) => i.status === "upcoming" || i.status === "open" || i.status === "late")
      .map((i) => (i.status === "upcoming" ? i.windowStart : i.windowEnd))
      .filter((v): v is string => !!v),
    ...sfvs.filter((s) => s.status === "open" || s.status === "overdue").map((s) => s.dueAt),
  ].sort();
  const patientId =
    input.admission?.patientId ??
    input.schedules[0]?.patientId ??
    input.assessments[0]?.patientId ??
    input.sfvs[0]?.patientId ??
    null;
  return {
    admissionId: input.admissionId,
    patientId,
    admissionStatus: input.admission?.status ?? null,
    admissionAt: input.admission?.admissionAt ?? null,
    activatedAt: input.admission?.activatedAt ?? null,
    dischargedAt: input.admission?.dischargedAt ?? null,
    ...fixed,
    sfvs,
    summary: {
      actionableCount,
      overdueCount,
      completedCount,
      nextDeadline: candidateDeadlines[0] ?? null,
      highestSeverity: highestSeverity(allAttention.map((a) => a.severity)),
      dueSoonCount,
      workflowIssueCount,
    },
  };
}

function attentionPriority(state: HopeAttention["state"]): number {
  const order: Record<HopeAttention["state"], number> = {
    workflow_issue: 0,
    missed: 1,
    window_expired: 2,
    overdue: 3,
    due: 4,
    due_soon: 5,
    upcoming: 6,
    none: 7,
  };
  return order[state];
}

function highestSeverity(
  severities: readonly HopeAttention["severity"][],
): HopeAttention["severity"] {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warn")) return "warn";
  if (severities.includes("info")) return "info";
  return "none";
}

/** Construct the in-memory M10 route backend (the slice). Returns the service (also the ABAC resolver). */
export function createInMemoryHopeBackend(seed: HopeRouteSeed = {}): HopeRouteService {
  const now = seed.now ?? (() => new Date().toISOString());
  const tz = seed.timeZone ?? "UTC";
  const assessments = new Map<string, AssessmentRecord>();
  const canonicalAnswers = new Map<
    string,
    Map<
      string,
      {
        state: "answered" | "skipped";
        value: unknown | null;
        source:
          | "user"
          | "patient_prefill"
          | "admission_prefill"
          | "derived"
          | "imported"
          | "correction_copy";
        answeredAt: string | null;
        answeredByMembershipId: string | null;
      }
    >
  >();
  const schedules = new Map<string, ScheduleRecord>();
  const sfvs = new Map<string, SfvRecord>();
  const submissions = new Map<string, SubmissionRecord>();
  const events: RecordedHopeEvent[] = [];
  const latest = seed.latestAssessments;
  const admissionPatients = seed.admissionPatients ?? {};
  const admissionStatuses = seed.admissionStatuses ?? {};
  const statusOfAdmission = (admissionId: string): string =>
    admissionStatuses[admissionId] ?? "active";
  /** #45 — the subject of a HOPE record, never guessed. Mirrors the DB backend's `admissionPatient`. */
  const patientOfAdmission = (admissionId: string): string => {
    const patientId = admissionPatients[admissionId];
    if (!patientId)
      throw new HopeStateError(
        "M10_ADMISSION_PROJECTION_GAP",
        `Admission ${admissionId} could not be projected by the M6 status seam, so the subject of this HOPE record is unknown`,
      );
    return patientId;
  };

  for (const s of seed.assessments ?? [])
    assessments.set(s.id, {
      status: "draft",
      // F-058 — explicit, so an unseeded row is UNSITED (null) rather than `undefined`. The assembler
      // distinguishes the two, and a cast-away `undefined` would read as neither.
      providerEntityId: null,
      targetDate: now(),
      authorDiscipline: "RN",
      j2051MaxSeverity: null,
      j2051TriggerFired: false,
      wasLate: false,
      signedAt: null,
      signedBy: null,
      correctsAssessmentId: null,
      supersededByAssessmentId: null,
      snapshot: null,
      regulatory: { specVersionId: null, isc: null },
      version: 1,
      data: {},
      ...s,
    } as AssessmentRecord);
  for (const s of seed.schedules ?? [])
    schedules.set(s.id, {
      status: "open",
      generatedBy: "auto_admission",
      completedByAssessmentId: null,
      timeZone: tz,
      ...s,
    } as ScheduleRecord);
  for (const s of seed.sfvs ?? [])
    sfvs.set(s.id, {
      status: "open",
      triggeredAt: now(),
      completingAssessmentId: null,
      timeZone: tz,
      triggeringSymptoms: [],
      ...s,
    } as SfvRecord);
  for (const s of seed.submissions ?? [])
    submissions.set(s.id, {
      submissionPeriod: submissionPeriodFor(now()),
      status: "queued",
      itemCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      transmittedAt: null,
      exportedAt: null,
      submittedAt: null,
      acceptedAt: null,
      transportMode: "manual_iqies_upload",
      validationProfile: null,
      packageFilename: null,
      packageSha256: null,
      packageSizeBytes: null,
      iqiesSubmissionReference: null,
      items: [],
      findings: [],
      resultImportedAt: null,
      resultReportReference: null,
      resultReportHash: null,
      ...s,
    } as SubmissionRecord);

  const emit = (
    eventName: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): void => {
    events.push({ eventName, payload, idempotencyKey });
  };
  const viewA = (r: AssessmentRecord): HopeAssessmentView => {
    const { organizationId: _o, data: _d, ...v } = r;
    return v;
  };
  const viewS = (r: ScheduleRecord): HopeScheduleView => {
    const { organizationId: _o, timeZone: _t, ...v } = r;
    return v;
  };
  const viewF = (r: SfvRecord): HopeSfvView => {
    const { organizationId: _o, timeZone: _t, triggeringSymptoms: _s, ...v } = r;
    return v;
  };
  /** Where a rejected assessment's correction stands (the correction is a NEW row; the original is never
   * edited). The correction's latest batch item decides it. */
  const correctionStanding = (assessmentId: string) => {
    const childOf = new Map<string, string>();
    for (const a of assessments.values())
      if (a.correctsAssessmentId && !childOf.has(a.correctsAssessmentId))
        childOf.set(a.correctsAssessmentId, a.id);
    const correctionId = terminalCorrection(assessmentId, childOf);
    if (!correctionId)
      return { correctionAssessmentId: null, resolution: resolveRejectedItem(null) };
    const placed = [...submissions.values()]
      .flatMap((s) => s.items)
      .filter((i) => i.assessmentId === correctionId)
      .at(-1);
    return {
      correctionAssessmentId: correctionId,
      resolution: resolveRejectedItem({ itemStatus: placed?.status ?? null }),
    };
  };
  const itemViews = (r: SubmissionRecord): HopeSubmissionItemView[] =>
    r.items.map((i) => {
      const a = assessments.get(i.assessmentId);
      const standing =
        i.status === "rejected"
          ? correctionStanding(i.assessmentId)
          : { correctionAssessmentId: null, resolution: null };
      return {
        id: i.id,
        assessmentId: i.assessmentId,
        patientId: a?.patientId ?? null,
        rfaKind: a?.rfaKind ?? null,
        assessmentStatus: a?.status ?? null,
        status: i.status,
        iqiesRecordId: i.iqiesRecordId,
        processedAt: i.processedAt,
        ...standing,
      };
    });
  const viewSub = (r: SubmissionRecord): HopeSubmissionView => {
    const resolutions = itemViews(r).map((i) => i.resolution);
    const n = (x: RejectedItemResolution) => resolutions.filter((v) => v === x).length;
    return {
      id: r.id,
      providerEntityId: r.providerEntityId,
      submissionPeriod: r.submissionPeriod,
      status: r.status,
      transportMode: r.transportMode,
      validationProfile: r.validationProfile,
      packageFilename: r.packageFilename,
      packageSha256: r.packageSha256,
      packageSizeBytes: r.packageSizeBytes,
      itemCount: r.itemCount,
      acceptedCount: r.acceptedCount,
      rejectedCount: r.rejectedCount,
      transmittedAt: r.transmittedAt,
      exportedAt: r.exportedAt,
      submittedAt: r.submittedAt,
      acceptedAt: r.acceptedAt,
      iqiesSubmissionReference: r.iqiesSubmissionReference,
      needsCorrectionCount: n("needs_correction"),
      correctionInProgressCount: n("correction_in_progress"),
      resubmittedCount: n("resubmitted"),
    };
  };
  const viewSubDetail = (r: SubmissionRecord): HopeSubmissionDetailView => ({
    ...viewSub(r),
    resultImportedAt: r.resultImportedAt,
    resultReportReference: r.resultReportReference,
    items: itemViews(r),
    findings: r.findings,
  });
  const findA = (organizationId: string, id: string): AssessmentRecord => {
    const r = assessments.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`HOPE assessment ${id} not found`);
    return r;
  };
  const findSchedule = (organizationId: string, id: string): ScheduleRecord => {
    const r = schedules.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`HOPE schedule ${id} not found`);
    return r;
  };
  const findSfv = (organizationId: string, id: string): SfvRecord => {
    const r = sfvs.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError(`SFV ${id} not found`);
    return r;
  };
  const findSub = (organizationId: string, id: string): SubmissionRecord => {
    const r = submissions.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`HOPE submission ${id} not found`);
    return r;
  };

  async function snapshotFor(patientId: string): Promise<Record<string, number | null> | null> {
    if (!latest) return null; // §7.13 — snapshot skipped when M9 is unavailable (no inline external block).
    const rows = await latest.latestBatch(
      patientId,
      SNAPSHOT_SCALES as unknown as ReadonlyArray<ScaleType>,
    );
    const byScale = new Map(
      rows.map((r) => [
        String((r as { scaleType?: unknown }).scaleType),
        (r as { score?: number | null }).score ?? null,
      ]),
    );
    const snap: Record<string, number | null> = {};
    for (const s of SNAPSHOT_SCALES) snap[s] = byScale.get(s) ?? null;
    return snap;
  }

  return {
    async listSchedules(organizationId, filter) {
      const all = [...schedules.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!filter.patientId || r.patientId === filter.patientId) &&
          (!filter.patientIds || filter.patientIds.includes(r.patientId)) &&
          (!filter.status || r.status === filter.status) &&
          (!filter.rfaKind || r.rfaKind === filter.rfaKind),
      );
      return { schedules: all.map(viewS) };
    },
    async getSchedule(organizationId, id) {
      return viewS(findSchedule(organizationId, id));
    },
    async skipSchedule(organizationId, id, _reasonCode) {
      const r = findSchedule(organizationId, id);
      r.status = "skipped";
      return viewS(r);
    },

    async recordTimepoint(organizationId, userId, admissionId, args) {
      const patientId = patientOfAdmission(admissionId);
      // #48 — the §4.4 recording gate, mirroring the Drizzle backend exactly (see its `recordTimepoint`
      // for why each of these guards had zero callers until now).
      if (args.rfaKind !== "05_discharge") {
        assertAdmissionActiveAtTarget(statusOfAdmission(admissionId) === "active");
      } else {
        require_(
          args.dischargeReason != null && args.dischargeReason !== "",
          "M10_REQUIRED_SECTION_MISSING",
          "rfa_kind '05_discharge' requires a discharge_reason (D9 decides Section Q from it).",
        );
        assertSectionQForDischarge(
          args.dischargeReason as HopeDischargeReason,
          Object.hasOwn(args.data, "Q") && args.data.Q != null,
        );
      }
      // ANY status, `open` first — an EXPIRED window must not read as an unscheduled one. A named
      // `scheduleId` selects the row directly, which is the branch that makes the RFA-mismatch guard real.
      const candidates = [...schedules.values()].filter(
        (s) =>
          s.organizationId === organizationId &&
          s.admissionId === admissionId &&
          (args.scheduleId ? s.id === args.scheduleId : s.rfaKind === args.rfaKind),
      );
      const sched = candidates.find((s) => s.status === "open") ?? candidates[0];
      if (args.scheduleId && !sched) {
        throw new NotFoundError(
          `HOPE schedule ${args.scheduleId} not found on admission ${admissionId}`,
        );
      }
      let capture: CaptureDecision = { wasLate: false, lateReasonCode: null };
      if (sched) {
        assertRfaMatchesSchedule(args.rfaKind, {
          rfaKind: sched.rfaKind,
          generatedBy: sched.generatedBy,
        });
        capture = assertCaptureAllowed(
          args.targetDate,
          {
            windowOpensAt: sched.windowOpensAt,
            windowClosesAt: sched.windowClosesAt,
            lateDeadlineAt: sched.lateDeadlineAt,
          },
          {
            lateReasonCode: args.lateCompletionReasonCode ?? null,
            adminOverride: args.adminOverride === true,
          },
        );
      }
      const id = nextId();
      const rec: AssessmentRecord = {
        id,
        organizationId,
        // F-058 — the slice has no M6 admission seam to site from, so a slice-recorded assessment is
        // UNSITED unless the seed supplies it. That is the same state the DB backend reports as
        // `skippedUnsited`, which is what makes the count testable without a database.
        providerEntityId: null,
        patientId,
        admissionId,
        rfaKind: args.rfaKind,
        status: "draft",
        targetDate: args.targetDate,
        authorDiscipline: args.authorDiscipline,
        j2051MaxSeverity: null,
        j2051TriggerFired: false,
        wasLate: capture.wasLate,
        signedAt: null,
        signedBy: null,
        correctsAssessmentId: null,
        supersededByAssessmentId: null,
        snapshot: null,
        regulatory: { specVersionId: null, isc: null },
        version: 1,
        data: args.data,
        dischargeReason: args.dischargeReason ?? null,
        findings: [],
      };
      assessments.set(id, rec);
      return viewA(rec);
    },

    async recordSfv(organizationId, userId, admissionId, args) {
      const sfv = [...sfvs.values()].find(
        (s) =>
          s.organizationId === organizationId &&
          s.triggeringAssessmentId === args.triggeringAssessmentId,
      );
      require_(
        sfv != null,
        "M10_SFV_NO_TRIGGER",
        `No SFV obligation for triggering assessment ${args.triggeringAssessmentId}.`,
      );
      const at = now();
      // Insert the signed RFA-04 row, then complete the open SFV (the §4.4 guards live in planSfvCompletion).
      const id = nextId();
      const rec: AssessmentRecord = {
        id,
        organizationId,
        // F-058 — the slice has no M6 admission seam to site from, so a slice-recorded assessment is
        // UNSITED unless the seed supplies it. That is the same state the DB backend reports as
        // `skippedUnsited`, which is what makes the count testable without a database.
        providerEntityId: null,
        patientId: sfv.patientId,
        admissionId,
        rfaKind: "04_sfv",
        status: "signed",
        dischargeReason: null,
        findings: [],
        targetDate: args.targetDate,
        authorDiscipline: args.authorDiscipline,
        j2051MaxSeverity: null,
        j2051TriggerFired: false,
        wasLate: false,
        signedAt: at,
        signedBy: userId,
        correctsAssessmentId: null,
        supersededByAssessmentId: null,
        snapshot: null,
        regulatory: { specVersionId: null, isc: null },
        version: 1,
        data: args.data,
      };
      assessments.set(id, rec);
      const plan = planSfvCompletion(
        { id: sfv.id, status: sfv.status, dueAt: sfv.dueAt },
        id,
        args.targetDate,
        { adminOverride: args.adminOverride },
      );
      sfv.status = "completed";
      sfv.completingAssessmentId = plan.completingAssessmentId;
      emit(
        "m10.hope.sfv_completed",
        { sfvId: sfv.id, completingAssessmentId: id, completedAt: at },
        `${sfv.id}:completed`,
      );
      return viewA(rec);
    },

    async updateDraft(organizationId, id, data) {
      const r = findA(organizationId, id);
      require_(
        r.status === "draft",
        "M10_CORRECTION_TARGET_NOT_SIGNED",
        `Assessment ${id} is not a draft.`,
      );
      r.data = { ...r.data, ...data };
      r.version += 1;
      return viewA(r);
    },

    async getAssessmentWorkspace(organizationId, id) {
      const r = findA(organizationId, id);
      return {
        assessment: {
          id: r.id,
          status: r.status,
          rfaKind: r.rfaKind,
          targetDate: r.targetDate,
          isc: (r.regulatory.isc ?? "HA") as never,
          specVersionId: r.regulatory.specVersionId ?? "in-memory-spec",
          specVersion: "in-memory",
          version: r.version,
        },
        sections: [],
        progress: {
          active: 0,
          applicable: 0,
          notApplicable: 0,
          pending: 0,
          answered: 0,
          skipped: 0,
          unanswered: 0,
        },
        huv:
          r.regulatory.isc === "HUV"
            ? {
                scheduleId:
                  [...schedules.values()].find(
                    (s) =>
                      s.organizationId === organizationId &&
                      s.admissionId === r.admissionId &&
                      s.rfaKind === r.rfaKind,
                  )?.id ?? null,
                scheduleStatus:
                  [...schedules.values()].find(
                    (s) =>
                      s.organizationId === organizationId &&
                      s.admissionId === r.admissionId &&
                      s.rfaKind === r.rfaKind,
                  )?.status ?? null,
                windowStart:
                  [...schedules.values()].find(
                    (s) =>
                      s.organizationId === organizationId &&
                      s.admissionId === r.admissionId &&
                      s.rfaKind === r.rfaKind,
                  )?.windowOpensAt ?? null,
                windowEnd:
                  [...schedules.values()].find(
                    (s) =>
                      s.organizationId === organizationId &&
                      s.admissionId === r.admissionId &&
                      s.rfaKind === r.rfaKind,
                  )?.windowClosesAt ?? null,
                lateDeadline:
                  [...schedules.values()].find(
                    (s) =>
                      s.organizationId === organizationId &&
                      s.admissionId === r.admissionId &&
                      s.rfaKind === r.rfaKind,
                  )?.lateDeadlineAt ?? null,
                timingState: r.status === "signed" ? "completed" : "unknown",
                z0350:
                  (canonicalAnswers.get(id)?.get("Z0350")?.value as string | undefined) ?? null,
              }
            : null,
      };
    },

    async getAssessmentReview(organizationId, id) {
      const r = findA(organizationId, id);
      const answers = canonicalAnswers.get(id) ?? new Map();
      return {
        assessmentId: id,
        version: r.version,
        specVersion: r.regulatory.specVersionId ?? "in-memory",
        isc: (r.regulatory.isc ?? "HA") as never,
        status: r.status,
        signedAt: r.signedAt,
        signedByMembershipId: r.signedBy,
        z0350: (answers.get("Z0350")?.value as string | undefined) ?? null,
        z0500b: (answers.get("Z0500B")?.value as string | undefined) ?? null,
        sections: [],
        progress: {
          active: 0,
          applicable: 0,
          answered: answers.size,
          skipped: 0,
          pending: 0,
          unanswered: 0,
        },
        validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
        sfv: { required: r.j2051TriggerFired },
        readiness: { readyToSign: r.status === "draft", blockers: [] },
      };
    },

    async patchAssessmentAnswers(organizationId, userId, id, input) {
      const r = findA(organizationId, id);
      require_(
        r.status === "draft",
        "M10_ASSESSMENT_IMMUTABLE",
        `Assessment ${id} is not a draft.`,
      );
      require_(
        r.version === input.ifVersion,
        "M10_VERSION_CONFLICT",
        `Assessment ${id} version is stale.`,
      );
      const seen = new Set<string>();
      const byItem = canonicalAnswers.get(id) ?? new Map();
      const answers = input.changes.map((change) => {
        require_(
          !seen.has(change.itemCode),
          "M10_DUPLICATE_ANSWER",
          `${change.itemCode} appears more than once.`,
        );
        seen.add(change.itemCode);
        require_(
          ![
            "A0050",
            "A0250",
            "J2052A",
            "J2052B",
            "J2052C",
            "J2053A",
            "J2053B",
            "J2053C",
            "J2053D",
            "J2053E",
            "J2053F",
            "J2053G",
            "J2053H",
            "Z0350",
            "Z0500B",
          ].includes(change.itemCode),
          "M10_PROTECTED_ANSWER",
          `${change.itemCode} is workflow-controlled.`,
        );
        if (change.action === "clear") {
          byItem.delete(change.itemCode);
          return {
            itemCode: change.itemCode,
            active: true,
            state: "unanswered" as const,
            value: null,
            source: null,
            answeredAt: null,
            answeredByMembershipId: null,
            applicability: "applicable" as const,
            skipReason: null,
          };
        }
        require_(
          change.value != null,
          "M10_INVALID_ANSWER",
          `${change.itemCode} answered values cannot be null.`,
        );
        const answeredAt = now();
        byItem.set(change.itemCode, {
          state: "answered",
          value: change.value,
          source: "user",
          answeredAt,
          answeredByMembershipId: userId,
        });
        return {
          itemCode: change.itemCode,
          active: true,
          state: "answered" as const,
          value: change.value,
          source: "user" as const,
          answeredAt,
          answeredByMembershipId: userId,
          applicability: "applicable" as const,
          skipReason: null,
        };
      });
      canonicalAnswers.set(id, byItem);
      r.version += 1;
      return { assessmentId: id, version: r.version, answers };
    },

    async setHuvCompletionDate(organizationId, userId, id, input) {
      const r = findA(organizationId, id);
      require_(
        r.status === "draft",
        "M10_ASSESSMENT_IMMUTABLE",
        `Assessment ${id} is not a draft.`,
      );
      require_(
        r.rfaKind === "02_huv1" || r.rfaKind === "03_huv2",
        "M10_TIMEPOINT_NOT_OPEN",
        `Assessment ${id} is not a HUV record.`,
      );
      require_(
        r.version === input.ifVersion,
        "M10_VERSION_CONFLICT",
        `Assessment ${id} version is stale.`,
      );
      const answeredAt = now();
      const byItem = canonicalAnswers.get(id) ?? new Map();
      byItem.set("Z0350", {
        state: "answered",
        value: input.z0350,
        source: "derived",
        answeredAt,
        answeredByMembershipId: userId,
      });
      canonicalAnswers.set(id, byItem);
      r.targetDate = input.z0350;
      r.version += 1;
      return {
        assessmentId: id,
        version: r.version,
        answers: [
          {
            itemCode: "Z0350",
            active: true,
            state: "answered",
            value: input.z0350,
            source: "derived",
            answeredAt,
            answeredByMembershipId: userId,
            applicability: "applicable",
            skipReason: null,
          },
        ],
      };
    },

    async signTimepoint(organizationId, userId, id, args) {
      const r = findA(organizationId, id);
      require_(
        r.status === "draft",
        "M10_CORRECTION_TARGET_NOT_SIGNED",
        `Assessment ${id} is not a draft and cannot be signed.`,
      );
      require_(
        args?.ifVersion == null || r.version === args.ifVersion,
        "M10_VERSION_CONFLICT",
        `Assessment ${id} version is stale.`,
      );
      const at = now();
      const z0500b = at.slice(0, 10);
      const verdict = evaluateJ2051Trigger({ entries: j2051EntriesOf(r.data) }); // D4 — server-authoritative
      const byItem = canonicalAnswers.get(id) ?? new Map();
      byItem.set("Z0500B", {
        state: "answered",
        value: z0500b,
        source: "derived",
        answeredAt: at,
        answeredByMembershipId: null,
      });
      canonicalAnswers.set(id, byItem);
      r.status = "signed";
      r.signedAt = at;
      r.signedBy = userId;
      r.j2051MaxSeverity = verdict.maxSeverity;
      r.j2051TriggerFired = verdict.triggerFired;
      r.snapshot = await snapshotFor(r.patientId); // D8 / §7.13
      // (Recovery merge: the lost F-057 legacy `runHopeAssessmentValidation` pass is not mirrored here —
      // the Drizzle backend validates through the spec-registry readiness/validation services instead.)
      r.version += 1;
      if (r.correctsAssessmentId) {
        const original = assessments.get(r.correctsAssessmentId);
        if (original?.organizationId === organizationId && original.status === "signed") {
          original.status = "superseded";
          original.supersededByAssessmentId = id;
        }
      }
      // Complete the matching schedule (idempotent — only an open schedule transitions).
      const sched = [...schedules.values()].find(
        (s) =>
          s.organizationId === organizationId &&
          s.admissionId === r.admissionId &&
          s.rfaKind === r.rfaKind &&
          s.status === "open",
      );
      if (sched) {
        sched.status = "completed";
        sched.completedByAssessmentId = id;
      }
      emit(
        "m10.hope.timepoint_signed",
        {
          assessmentId: id,
          rfaKind: r.rfaKind,
          signedAt: at,
          signedBy: userId,
          j2051TriggerFired: verdict.triggerFired,
          wasLate: r.wasLate,
        },
        `${id}:signed`,
      );
      if (verdict.triggerFired) {
        // D4 — exactly one SFV per source timepoint; due_at anchored to the ASSESSMENT date, never
        // the signature (ADR-0018 D1).
        const descriptor = planSfvCreation({
          triggeringAssessmentId: id,
          assessmentDate: r.targetDate,
          signedAt: at,
          timeZone: tz,
        });
        const sfvId = nextId();
        sfvs.set(sfvId, {
          id: sfvId,
          organizationId,
          patientId: r.patientId,
          admissionId: r.admissionId,
          triggeringAssessmentId: id,
          status: "open",
          triggeredAt: descriptor.triggeredAt,
          dueAt: descriptor.dueAt,
          completingAssessmentId: null,
          timeZone: tz,
          triggeringSymptoms: verdict.contributingSymptoms.map((c) => ({
            symptomCode: c.symptomCode,
            severity: c.severity,
          })),
        });
        emit(
          "m10.hope.j2051_trigger_fired",
          {
            assessmentId: id,
            sfvId,
            maxSeverity: verdict.maxSeverity,
            triggeredAt: descriptor.triggeredAt,
            dueAt: descriptor.dueAt,
          },
          `${id}:j2051_triggered`,
        );
        emit(
          "m10.hope.sfv_created",
          { sfvId, triggeringAssessmentId: id, dueAt: descriptor.dueAt },
          `${sfvId}:created`,
        );
      }
      return {
        assessmentId: id,
        status: "signed",
        version: r.version,
        signedAt: at,
        signedByMembershipId: userId,
        z0500b,
        validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false },
      };
    },

    async correctTimepoint(organizationId, userId, id, args) {
      const original = findA(organizationId, id);
      require_(
        original.status === "signed",
        "M10_CORRECTION_TARGET_NOT_SIGNED",
        `Assessment ${id} must be signed to correct (edit the draft instead).`,
      );
      require_(
        original.supersededByAssessmentId == null,
        "M10_CORRECTION_TARGET_SUPERSEDED",
        `Assessment ${id} is already superseded; correct the latest instead.`,
      );
      require_(
        args.ifVersion == null || original.version === args.ifVersion,
        "M10_VERSION_CONFLICT",
        `Assessment ${id} version is stale.`,
      );
      require_(
        ![...assessments.values()].some(
          (a) => a.correctsAssessmentId === id && a.status === "draft",
        ),
        "M10_VERSION_CONFLICT",
        `Assessment ${id} already has a pending regulatory operation.`,
      );
      const at = now();
      const correctionId = nextId();
      const correction: AssessmentRecord = {
        id: correctionId,
        organizationId,
        // F-058 — copied, never re-resolved (the DB backend's rule): a correction is submitted under the
        // CCN the ORIGINAL was captured under.
        providerEntityId: original.providerEntityId,
        patientId: original.patientId,
        admissionId: original.admissionId,
        rfaKind: original.rfaKind,
        status: "draft",
        dischargeReason: original.dischargeReason,
        findings: [],
        targetDate: original.targetDate,
        authorDiscipline: args.authorDiscipline,
        j2051MaxSeverity: original.j2051MaxSeverity,
        j2051TriggerFired: original.j2051TriggerFired,
        wasLate: original.wasLate,
        signedAt: null,
        signedBy: null,
        correctsAssessmentId: id,
        supersededByAssessmentId: null,
        snapshot: original.snapshot,
        regulatory: original.regulatory,
        version: 1,
        data: args.data,
      };
      assessments.set(correctionId, correction);
      const originalAnswers = canonicalAnswers.get(id);
      if (originalAnswers) {
        const correctionAnswers = new Map<
          string,
          {
            state: "answered" | "skipped";
            value: unknown | null;
            source:
              | "user"
              | "patient_prefill"
              | "admission_prefill"
              | "derived"
              | "imported"
              | "correction_copy";
            answeredAt: string | null;
            answeredByMembershipId: string | null;
          }
        >();
        for (const [itemCode, answer] of originalAnswers) {
          if (itemCode === "A0050" || itemCode === "A0250" || itemCode === "Z0500B") continue;
          correctionAnswers.set(itemCode, {
            ...answer,
            source: "correction_copy",
            answeredAt: at,
            answeredByMembershipId: null,
          });
        }
        canonicalAnswers.set(correctionId, correctionAnswers);
      }
      const correctionAnswers = canonicalAnswers.get(correctionId) ?? new Map();
      correctionAnswers.set("A0050", {
        state: "answered",
        value: "2",
        source: "derived",
        answeredAt: at,
        answeredByMembershipId: null,
      });
      correctionAnswers.set("A0250", {
        state: "answered",
        value:
          original.rfaKind === "02_huv1"
            ? "2"
            : original.rfaKind === "03_huv2"
              ? "3"
              : original.rfaKind === "05_discharge"
                ? "9"
                : "1",
        source: "derived",
        answeredAt: at,
        answeredByMembershipId: null,
      });
      canonicalAnswers.set(correctionId, correctionAnswers);
      emit(
        "m10.hope.correction_submitted",
        { correctionAssessmentId: correctionId, originalAssessmentId: id },
        `${correctionId}:submitted`,
      );
      return viewA(correction);
    },

    async inactivateTimepoint(organizationId, userId, id, args) {
      const original = findA(organizationId, id);
      require_(
        original.status === "signed",
        "M10_CORRECTION_TARGET_NOT_SIGNED",
        `Assessment ${id} must be signed to inactivate.`,
      );
      require_(
        original.supersededByAssessmentId == null,
        "M10_CORRECTION_TARGET_SUPERSEDED",
        `Assessment ${id} is already superseded; target the current record instead.`,
      );
      require_(
        args.ifVersion == null || original.version === args.ifVersion,
        "M10_VERSION_CONFLICT",
        `Assessment ${id} version is stale.`,
      );
      require_(
        ![...assessments.values()].some(
          (a) => a.correctsAssessmentId === id && a.status === "draft",
        ),
        "M10_VERSION_CONFLICT",
        `Assessment ${id} already has a pending regulatory operation.`,
      );
      const at = now();
      const inactivationId = nextId();
      const inactivation: AssessmentRecord = {
        ...original,
        id: inactivationId,
        status: "draft",
        signedAt: null,
        signedBy: null,
        correctsAssessmentId: id,
        supersededByAssessmentId: null,
        regulatory: { specVersionId: original.regulatory.specVersionId, isc: "XX" },
        version: 1,
        data: { inactivationReason: args.reason },
      };
      assessments.set(inactivationId, inactivation);
      const byItem = new Map<
        string,
        {
          state: "answered" | "skipped";
          value: unknown | null;
          source:
            | "user"
            | "patient_prefill"
            | "admission_prefill"
            | "derived"
            | "imported"
            | "correction_copy";
          answeredAt: string | null;
          answeredByMembershipId: string | null;
        }
      >();
      byItem.set("A0050", {
        state: "answered",
        value: "3",
        source: "derived",
        answeredAt: at,
        answeredByMembershipId: null,
      });
      byItem.set("A0250", {
        state: "answered",
        value:
          original.rfaKind === "02_huv1"
            ? "2"
            : original.rfaKind === "03_huv2"
              ? "3"
              : original.rfaKind === "05_discharge"
                ? "9"
                : "1",
        source: "derived",
        answeredAt: at,
        answeredByMembershipId: null,
      });
      canonicalAnswers.set(inactivationId, byItem);
      emit(
        "m10.hope.inactivation_created",
        { inactivationAssessmentId: inactivationId, targetAssessmentId: id, createdBy: userId },
        `${inactivationId}:inactivation_created`,
      );
      return viewA(inactivation);
    },

    async getAssessment(organizationId, id) {
      return viewA(findA(organizationId, id));
    },
    async listPatientAssessments(organizationId, patientId) {
      const all = [...assessments.values()].filter(
        (r) => r.organizationId === organizationId && r.patientId === patientId,
      );
      return { assessments: all.map(viewA) };
    },
    async requestSummaryPdf(organizationId, userId, id) {
      findA(organizationId, id);
      emit(
        "m10.hope.summary_requested",
        { assessmentId: id, requestedBy: userId },
        `${id}:${now()}`,
      );
      return { assessmentId: id, requested: true };
    },

    async listSfv(organizationId, state, patientIds) {
      const all = [...sfvs.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!state || r.status === state) &&
          (!patientIds || patientIds.includes(r.patientId)),
      );
      return { sfvs: all.map(viewF) };
    },
    async getSfv(organizationId, id) {
      return viewF(findSfv(organizationId, id));
    },
    async getValidation(organizationId, id, options) {
      findA(organizationId, id);
      // The pre-submission validation engine (M10-T04) binds over the per-section payload at assemble time;
      // the on-demand route returns the row's stored findings (none in the in-mem slice).
      return { assessmentId: id, mode: options?.mode ?? "final", evaluatedAt: now(), findings: [] };
    },

    async listSubmissions(organizationId, providerEntityId) {
      const all = [...submissions.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!providerEntityId || r.providerEntityId === providerEntityId),
      );
      return { submissions: all.map(viewSub) };
    },
    async getSubmission(organizationId, id) {
      return viewSubDetail(findSub(organizationId, id));
    },
    async listAssessmentSubmissions(organizationId, assessmentId) {
      findA(organizationId, assessmentId);
      const submissionsOut = [...submissions.values()]
        .filter((s) => s.organizationId === organizationId)
        .flatMap((s) =>
          s.items
            .filter((i) => i.assessmentId === assessmentId)
            .map((i) => ({
              submissionId: s.id,
              status: s.status,
              itemStatus: i.status,
              packageFilename: s.packageFilename ?? null,
              submittedAt: s.submittedAt ?? null,
              resultImportedAt: s.resultImportedAt,
            })),
        );
      return { submissions: submissionsOut };
    },
    async retrySubmission(organizationId, id) {
      const r = findSub(organizationId, id);
      require_(
        r.status === "rejected",
        "M10_SUBMISSION_RETRY_NOT_REJECTED",
        `Submission ${id} is ${r.status}; only a rejected submission can be retried.`,
      );
      r.status = "queued";
      emit(
        "m10.hope.submission_queued",
        { submissionId: id, providerEntityId: r.providerEntityId, itemCount: r.itemCount },
        `${id}:queued`,
      );
      return viewSub(r);
    },
    /**
     * F-058 — the slice mirrors the DB backend's real assembler: group this provider entity's signed,
     * unsuperseded, not-yet-accepted assessments by CMS submission period and create one batch per
     * period, each carrying its items. It used to mint one EMPTY batch per call, keyed on the wall
     * clock, which is what the route published as work done.
     *
     * The slice has no `hope_submission_item` table, so the items live on the record — enough for the
     * route contract and the idempotency skip to be exercised without a database.
     */
    async assembleSubmission(organizationId, providerEntityId) {
      // A correction of a rejected assessment is a new signed row and is picked up here; the rejected
      // original is superseded when the correction signs, and never re-sent unchanged before that.
      const batched = new Set(
        [...submissions.values()].flatMap((sub) =>
          sub.items.filter((i) => i.status !== "rejected").map((i) => i.assessmentId),
        ),
      );
      const rejectedBefore = new Set(
        [...submissions.values()].flatMap((sub) =>
          sub.items.filter((i) => i.status === "rejected").map((i) => i.assessmentId),
        ),
      );
      const ready = [...assessments.values()].filter(
        (a) =>
          a.organizationId === organizationId &&
          a.status === "signed" &&
          a.regulatory.specVersionId &&
          !a.supersededByAssessmentId &&
          !batched.has(a.id) &&
          !rejectedBefore.has(a.id),
      );
      if (ready.length === 0) {
        throw new ConflictError(
          "No signed HOPE assessments are eligible for iQIES package generation.",
        );
      }
      const id = nextId();
      const content = Buffer.from(
        `HOPE manual_iqies_upload package ${id}\n${ready.map((a) => a.id).join("\n")}\n`,
        "utf8",
      );
      const rec: SubmissionRecord = {
        id,
        organizationId,
        providerEntityId,
        submissionPeriod: now().slice(0, 7),
        status: "packaged",
        transportMode: "manual_iqies_upload",
        validationProfile: "HOPE-1.00.1-ERRATA-1.00.3",
        packageFilename: `HOPE_${providerEntityId}_${id}.zip`,
        packageSha256: "in-memory",
        packageSizeBytes: content.length,
        packageContentBase64: content.toString("base64"),
        itemCount: ready.length,
        acceptedCount: 0,
        rejectedCount: 0,
        transmittedAt: null,
        exportedAt: null,
        submittedAt: null,
        acceptedAt: null,
        iqiesSubmissionReference: null,
        items: ready.map((a) => ({
          id: nextId(),
          assessmentId: a.id,
          status: "pending" as const,
          iqiesRecordId: null,
          processedAt: null,
        })),
        findings: [],
        resultImportedAt: null,
        resultReportReference: null,
        resultReportHash: null,
      };
      submissions.set(id, rec);
      emit(
        "m10.hope.submission_queued",
        {
          submissionId: id,
          providerEntityId,
          itemCount: ready.length,
          transportMode: "manual_iqies_upload",
        },
        `${id}:queued`,
      );
      return viewSub(rec);
    },
    async downloadSubmissionPackage(organizationId, id) {
      const r = findSub(organizationId, id);
      const bytes = Buffer.from(r.packageContentBase64 ?? "", "base64");
      if (bytes.length === 0) throw new ConflictError(`Submission ${id} has no package.`);
      if (r.status === "packaged") {
        r.status = "exported";
        r.exportedAt = now();
      }
      return {
        filename: r.packageFilename ?? `${id}.zip`,
        contentType: "application/zip",
        bytes,
      };
    },
    async markSubmissionUploaded(organizationId, userId, id, args) {
      const r = findSub(organizationId, id);
      if (r.status !== "packaged" && r.status !== "exported") {
        throw new ConflictError(
          `Submission ${id} must be packaged/exported before it can be marked uploaded.`,
        );
      }
      const at = args.submittedAt ?? now();
      r.status = "submitted_pending_result";
      r.transmittedAt = at;
      r.submittedAt = at;
      r.iqiesSubmissionReference = args.iqiesSubmissionReference ?? null;
      emit(
        "m10.hope.submission_transmitted",
        {
          ...manualUploadTransmittedPayload(id, r.packageSha256, new Date(at)),
          submittedBy: userId,
        },
        `${id}:manual-uploaded`,
      );
      return viewSub(r);
    },
    async importSubmissionResult(organizationId, userId, id, args) {
      const r = findSub(organizationId, id);
      const reportHash = createHash("sha256").update(JSON.stringify(args.results)).digest("hex");
      if (r.resultReportHash === reportHash) return viewSubDetail(r); // idempotent replay
      require_(
        isResultImportable(r.status),
        r.status === "packaged" || r.status === "queued" || r.status === "ready"
          ? "M10_SUBMISSION_RESULT_NOT_UPLOADED"
          : "M10_SUBMISSION_RESULT_ALREADY_RECORDED",
        `Submission ${id} is ${r.status}; a result can only be recorded for a batch that was downloaded/uploaded and is still awaiting its CMS result.`,
      );
      const matched = args.results.filter((raw) =>
        r.items.some((i) => i.assessmentId === raw.assessmentId),
      );
      require_(
        matched.length > 0,
        "M10_SUBMISSION_RESULT_NO_MATCH",
        `None of the ${args.results.length} report rows names an assessment in submission ${id}.`,
      );
      const at = now();
      const findings: HopeSubmissionFindingView[] = [];
      // One report row per finding: the worst outcome per assessment wins, independent of row order.
      const worst = new Map<string, ReturnType<typeof classifyCmsResult>>();
      for (const raw of args.results) {
        const id_ = typeof raw.assessmentId === "string" ? raw.assessmentId : null;
        const status = classifyCmsResult(raw);
        if (id_ && status !== "pending")
          worst.set(id_, worstOutcome(worst.get(id_) ?? status, status));
      }
      for (const raw of args.results) {
        const item = r.items.find((i) => i.assessmentId === raw.assessmentId);
        const resultStatus = classifyCmsResult(raw);
        const merged = item ? worst.get(item.assessmentId) : undefined;
        if (item && merged && merged !== "pending") {
          item.status = merged;
          item.processedAt = at;
          if (typeof raw.iqiesRecordId === "string") item.iqiesRecordId = raw.iqiesRecordId;
        }
        const code = typeof raw.code === "string" ? raw.code : null;
        const itemCode = typeof raw.itemCode === "string" ? raw.itemCode : null;
        const message = typeof raw.message === "string" ? raw.message : null;
        if (code || itemCode || message)
          findings.push({
            id: nextId(),
            assessmentId: typeof raw.assessmentId === "string" ? raw.assessmentId : null,
            severity: findingSeverity({
              resultStatus,
              cmsSeverity: typeof raw.severity === "string" ? raw.severity : null,
            }),
            code,
            itemCode,
            message,
          });
      }
      const outcome = deriveBatchOutcome(r.items.map((i) => i.status));
      r.findings = [...r.findings, ...findings];
      r.status = outcome.status;
      r.acceptedCount = outcome.acceptedCount;
      r.rejectedCount = outcome.rejectedCount;
      r.resultReportHash = reportHash;
      r.resultReportReference = args.reportReference ?? null;
      r.resultImportedAt = at;
      if (outcome.pendingCount === 0) {
        r.acceptedAt = outcome.rejectedCount === 0 ? at : null;
        const event = settledBatchEvent(id, r.providerEntityId, outcome, args.results);
        emit(event.eventName, event.payload, `${id}:result-imported`);
      }
      return viewSubDetail(r);
    },
    async complianceDashboard(organizationId, providerEntityId) {
      const scoped = [...schedules.values()].filter((s) => s.organizationId === organizationId);
      const completed = scoped.filter((s) => s.status === "completed").length;
      const expired = scoped.filter((s) => s.status === "expired").length;
      const denom = completed + expired;
      const subs = [...submissions.values()].filter(
        (s) =>
          s.organizationId === organizationId &&
          (!providerEntityId || s.providerEntityId === providerEntityId),
      );
      // F-058 (#150) — terminal batches only; a `queued` batch has no acceptance outcome and counting
      // it as a failed one reads as 0% acceptance (the §1.3 APU-penalty band) for work merely awaiting
      // transmit. Mirrors the DB backend.
      const terminal = subs.filter((s) =>
        ["accepted", "rejected", "partially_accepted"].includes(s.status),
      );
      const accepted = terminal.filter((s) => s.status === "accepted").length;
      const sfvAll = [...sfvs.values()].filter((s) => s.organizationId === organizationId);
      const sfvOnTime = sfvAll.filter((s) => s.status === "completed").length;
      const sfvDenom = sfvAll.filter(
        (s) => s.status === "completed" || s.status === "missed",
      ).length;
      return {
        providerEntityId: providerEntityId ?? null,
        hopeOnTimeRate: rateOf(completed, denom),
        hopeOnTimeCounts: { onTime: completed, total: denom },
        sfvOnTimeRate: rateOf(sfvOnTime, sfvDenom),
        sfvOnTimeCounts: { onTime: sfvOnTime, total: sfvDenom },
        submissionAcceptanceRate: rateOf(accepted, terminal.length),
        submissionAcceptanceCounts: { accepted, total: terminal.length },
      };
    },
    async getWorkflowState(organizationId, admissionId) {
      const scopedSchedules = [...schedules.values()]
        .filter((s) => s.organizationId === organizationId && s.admissionId === admissionId)
        .map(viewS);
      const scopedAssessments = [...assessments.values()]
        .filter((a) => a.organizationId === organizationId && a.admissionId === admissionId)
        .map(viewA);
      const patientIds = new Set([
        ...scopedSchedules.map((s) => s.patientId),
        ...scopedAssessments.map((a) => a.patientId),
      ]);
      const scopedSfvs = [...sfvs.values()]
        .filter((s) => s.organizationId === organizationId && patientIds.has(s.patientId))
        .map(viewF);
      return buildWorkflowState({
        admissionId,
        nowIso: now(),
        schedules: scopedSchedules,
        assessments: scopedAssessments,
        sfvs: scopedSfvs,
        admission: {
          patientId: scopedSchedules[0]?.patientId ?? scopedAssessments[0]?.patientId ?? null,
        },
      });
    },
    async regenerateSchedules(organizationId, admissionId) {
      const count = [...schedules.values()].filter(
        (s) => s.organizationId === organizationId && s.admissionId === admissionId,
      ).length;
      return { admissionId, scheduleCount: count };
    },

    // ── §4.7 / GAP-018 ABAC resolver (correction + scope predicates) ───────────────────────────────────
    async loadAssessment(organizationId, assessmentId): Promise<HopeAssessmentAbacFacts | null> {
      const r = assessments.get(assessmentId);
      if (!r || r.organizationId !== organizationId) return null;
      // The signer of the corrected-of-record chain is the most-recent signed row's signer.
      return { patientId: r.patientId, originalSignedBy: r.signedBy };
    },
    async loadSchedule(organizationId, scheduleId) {
      const r = schedules.get(scheduleId);
      if (!r || r.organizationId !== organizationId) return null;
      return { patientId: r.patientId };
    },
    async loadSfv(organizationId, sfvId) {
      const r = sfvs.get(sfvId);
      if (!r || r.organizationId !== organizationId) return null;
      return { patientId: r.patientId };
    },
    async loadSubmission(organizationId, submissionId) {
      const r = submissions.get(submissionId);
      if (!r || r.organizationId !== organizationId) return null;
      return { providerEntityId: r.providerEntityId };
    },

    drainEvents() {
      const drained = [...events];
      events.length = 0;
      return drained;
    },
  };
}
