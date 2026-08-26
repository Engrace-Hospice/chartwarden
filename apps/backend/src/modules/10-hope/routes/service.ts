// apps/backend/src/modules/10-hope/routes/service.ts — M10-T06 the §4.1 route service over an in-memory
// backend (the same in-mem-slice precedent as M8-T09 / M9-T05; Drizzle in prod under `withOrgContext` so
// RLS backstops every read). The service composes the PURE M10 domain (`@wardenx/hope`): the
// server-authoritative J2051 trigger (`evaluateJ2051Trigger`, D4), the one-SFV-per-source planner
// (`planSfvCreation`), the SFV completion guard (`planSfvCompletion`), the correction-chain guards, and
// the §4.4 `HopeStateError` codes. It consumes M9's `LatestAssessmentProvider` seam (injected) to snapshot
// PPS / ESAS-r at sign (D8); when absent the snapshot is skipped and a warning is recorded (§7.13 / DR
// Tier-2 — no external dependency blocks the write path). Every state transition records the §2.4 outbox
// event the relay publishes (drainable for tests).
import {
  type CaptureDecision,
  HopeStateError,
  type J2051SymptomReading,
  assertAdmissionActiveAtTarget,
  assertCaptureAllowed,
  assertRfaMatchesSchedule,
  assertSectionQForDischarge,
  evaluateJ2051Trigger,
  planSfvCompletion,
  planSfvCreation,
  require_,
} from "@wardenx/hope";
import type {
  HopeDischargeReason,
  HopeRfaKind,
  HopeScheduleGeneratedBy,
  HopeScheduleStatus,
  HopeSfvStatus,
  HopeSubmissionStatus,
  J2051Severity,
  LatestAssessmentProvider,
  ScaleType,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import type { HopeAbacResolver, HopeAssessmentAbacFacts } from "../abac-predicates";

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
  readonly itemCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly transmittedAt: string | null;
  readonly acceptedAt: string | null;
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

export interface RecordTimepointArgs {
  readonly rfaKind: HopeRfaKind;
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly data: Record<string, unknown>;
  readonly sourceEncounterId?: string;
  readonly dischargeReason?: string;
  /**
   * #48 / D12 — the CMS-aligned reason a capture landed in the late-grace span (window close → late
   * deadline). Required there and rejected as `M10_LATE_REASON_REQUIRED` / `M10_LATE_REASON_INVALID`;
   * ignored on an in-window capture. Previously absent from the contract entirely, which is why the
   * whole late-completion branch was unreachable.
   */
  readonly lateCompletionReasonCode?: string;
  /** #48 / D2 — an admin extending the hard cutoff for a past-deadline capture. Still demands a typed
   * late reason; it moves the deadline, it does not waive the accounting. */
  readonly adminOverride?: boolean;
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
}
export interface CorrectTimepointArgs {
  readonly correctionReason: string;
  readonly targetDate: string;
  readonly authorDiscipline: string;
  readonly data: Record<string, unknown>;
}

/** The §4.1 route service contract (the routes compose over it; the in-mem slice + the prod Drizzle
 * backend both implement it). All ids/org binding come from server context, never the body. */
export interface HopeRouteService extends HopeAbacResolver {
  listSchedules(
    organizationId: string,
    filter: { patientId?: string; status?: string; rfaKind?: string },
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
  signTimepoint(organizationId: string, userId: string, id: string): Promise<HopeAssessmentView>;
  correctTimepoint(
    organizationId: string,
    userId: string,
    id: string,
    args: CorrectTimepointArgs,
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
  listSfv(organizationId: string, state?: string): Promise<{ sfvs: HopeSfvView[] }>;
  getSfv(organizationId: string, id: string): Promise<HopeSfvView>;
  getValidation(
    organizationId: string,
    id: string,
  ): Promise<{
    assessmentId: string;
    findings: ReadonlyArray<{ ruleId: string; severity: string; message: string }>;
  }>;
  listSubmissions(
    organizationId: string,
    providerEntityId?: string,
  ): Promise<{ submissions: HopeSubmissionView[] }>;
  getSubmission(organizationId: string, id: string): Promise<HopeSubmissionView>;
  retrySubmission(organizationId: string, id: string): Promise<HopeSubmissionView>;
  assembleSubmission(organizationId: string, providerEntityId: string): Promise<HopeSubmissionView>;
  complianceDashboard(
    organizationId: string,
    providerEntityId?: string,
  ): Promise<HopeComplianceView>;
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
  data: Record<string, unknown>;
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
interface SubmissionRecord extends Mutable<HopeSubmissionView> {
  organizationId: string;
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

/** Construct the in-memory M10 route backend (the slice). Returns the service (also the ABAC resolver). */
export function createInMemoryHopeBackend(seed: HopeRouteSeed = {}): HopeRouteService {
  const now = seed.now ?? (() => new Date().toISOString());
  const tz = seed.timeZone ?? "UTC";
  const assessments = new Map<string, AssessmentRecord>();
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
      submissionPeriod: now().slice(0, 7),
      status: "queued",
      itemCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      transmittedAt: null,
      acceptedAt: null,
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
  const viewSub = (r: SubmissionRecord): HopeSubmissionView => {
    const { organizationId: _o, ...v } = r;
    return v;
  };
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
        version: 1,
        data: args.data,
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
        patientId: sfv.patientId,
        admissionId,
        rfaKind: "04_sfv",
        status: "signed",
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

    async signTimepoint(organizationId, userId, id) {
      const r = findA(organizationId, id);
      require_(
        r.status === "draft",
        "M10_CORRECTION_TARGET_NOT_SIGNED",
        `Assessment ${id} is not a draft and cannot be signed.`,
      );
      const at = now();
      const verdict = evaluateJ2051Trigger({ entries: j2051EntriesOf(r.data) }); // D4 — server-authoritative
      r.status = "signed";
      r.signedAt = at;
      r.signedBy = userId;
      r.j2051MaxSeverity = verdict.maxSeverity;
      r.j2051TriggerFired = verdict.triggerFired;
      r.snapshot = await snapshotFor(r.patientId); // D8 / §7.13
      r.version += 1;
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
      return viewA(r);
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
      const at = now();
      const correctionId = nextId();
      const correction: AssessmentRecord = {
        id: correctionId,
        organizationId,
        patientId: original.patientId,
        admissionId: original.admissionId,
        rfaKind: original.rfaKind,
        status: "signed",
        targetDate: args.targetDate,
        authorDiscipline: args.authorDiscipline,
        j2051MaxSeverity: original.j2051MaxSeverity,
        j2051TriggerFired: original.j2051TriggerFired,
        wasLate: original.wasLate,
        signedAt: at,
        signedBy: userId,
        correctsAssessmentId: id,
        supersededByAssessmentId: null,
        snapshot: original.snapshot,
        version: 1,
        data: args.data,
      };
      assessments.set(correctionId, correction);
      original.status = "superseded";
      original.supersededByAssessmentId = correctionId;
      emit(
        "m10.hope.correction_submitted",
        { correctionAssessmentId: correctionId, originalAssessmentId: id },
        `${correctionId}:submitted`,
      );
      return viewA(correction);
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

    async listSfv(organizationId, state) {
      const all = [...sfvs.values()].filter(
        (r) => r.organizationId === organizationId && (!state || r.status === state),
      );
      return { sfvs: all.map(viewF) };
    },
    async getSfv(organizationId, id) {
      return viewF(findSfv(organizationId, id));
    },
    async getValidation(organizationId, id) {
      findA(organizationId, id);
      // The pre-submission validation engine (M10-T04) binds over the per-section payload at assemble time;
      // the on-demand route returns the row's stored findings (none in the in-mem slice).
      return { assessmentId: id, findings: [] };
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
      return viewSub(findSub(organizationId, id));
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
    async assembleSubmission(organizationId, providerEntityId) {
      const id = nextId();
      const rec: SubmissionRecord = {
        id,
        organizationId,
        providerEntityId,
        submissionPeriod: now().slice(0, 7),
        status: "queued",
        itemCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        transmittedAt: null,
        acceptedAt: null,
      };
      submissions.set(id, rec);
      emit(
        "m10.hope.submission_queued",
        { submissionId: id, providerEntityId, itemCount: 0 },
        `${id}:queued`,
      );
      return viewSub(rec);
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
      const accepted = subs.filter((s) => s.status === "accepted").length;
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
        submissionAcceptanceRate: rateOf(accepted, subs.length),
        submissionAcceptanceCounts: { accepted, total: subs.length },
      };
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
