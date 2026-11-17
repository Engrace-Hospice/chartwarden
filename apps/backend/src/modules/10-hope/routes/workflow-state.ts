// apps/backend/src/modules/10-hope/routes/workflow-state.ts — the per-admission HOPE workflow state: the pure builder
// that folds an admission's schedules, assessments and SFVs into the timepoint / SFV / summary views the workflow
// screen reads, with the view types it needs. Shared by the in-memory backend (`./service.ts`) and the Drizzle one
// (`../hope-route-service-db.ts`), and re-exported from `./service.ts` so existing importers are unchanged.
import {
  type HopeAttention,
  evaluateFixedHopeAttention,
  evaluateSfvAttention,
} from "@chartwarden/hope";
import type {
  HopeRfaKind,
  HopeScheduleGeneratedBy,
  HopeScheduleStatus,
  HopeSfvStatus,
  J2051Severity,
} from "@chartwarden/types";

// ── the base views the builder reads (never the raw Drizzle row) ───────────────────────────────────────
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
