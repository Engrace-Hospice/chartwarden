// @wardenx/hope — central HOPE attention evaluator (Phase 3).
//
// Workflow status remains M10's persisted/read lifecycle. This module layers operational attention on top
// of those statuses so routes, watchdogs, and React do not each invent their own due-soon/late rules.

export type HopeAttentionState =
  | "none"
  | "upcoming"
  | "due_soon"
  | "due"
  | "overdue"
  | "window_expired"
  | "missed"
  | "workflow_issue";

export type HopeAttentionSeverity = "none" | "info" | "warn" | "critical";

export type HopeAttentionAction =
  | "COMPLETE_ADMISSION_RFA"
  | "COMPLETE_HUV1"
  | "COMPLETE_HUV2"
  | "COMPLETE_DISCHARGE_RFA"
  | "OPEN_SFV"
  | "REPAIR_WORKFLOW"
  | "NONE";

export interface HopeAttention {
  readonly state: HopeAttentionState;
  readonly severity: HopeAttentionSeverity;
  readonly action: HopeAttentionAction;
  readonly message: string | null;
  readonly deadline: string | null;
}

export interface HopeAttentionPolicy {
  /** A normal-window item becomes due soon this many hours before `windowClosesAt` / `dueAt`. */
  readonly dueSoonHours: number;
  /** A normal-window item becomes due this many hours before `windowClosesAt` / at/past `dueAt`. */
  readonly dueHours: number;
}

export const DEFAULT_HOPE_ATTENTION_POLICY: HopeAttentionPolicy = {
  dueSoonHours: 72,
  dueHours: 24,
} as const;

export type FixedHopeWorkflowStatus =
  | "workflow_not_initialized"
  | "not_applicable"
  | "upcoming"
  | "open"
  | "late"
  | "completed"
  | "expired"
  | "skipped";

export type HopeFixedAttentionKind = "01_admission" | "02_huv1" | "03_huv2" | "05_discharge";
export type HopeSfvAttentionStatus = "open" | "overdue" | "missed" | "completed" | "withdrawn";

const FIXED_ACTIONS: Record<HopeFixedAttentionKind, HopeAttentionAction> = {
  "01_admission": "COMPLETE_ADMISSION_RFA",
  "02_huv1": "COMPLETE_HUV1",
  "03_huv2": "COMPLETE_HUV2",
  "05_discharge": "COMPLETE_DISCHARGE_RFA",
};

const NONE: HopeAttention = {
  state: "none",
  severity: "none",
  action: "NONE",
  message: null,
  deadline: null,
};

function hoursUntil(nowIso: string, deadlineIso: string | null | undefined): number | null {
  if (!deadlineIso) return null;
  const now = Date.parse(nowIso);
  const deadline = Date.parse(deadlineIso);
  if (Number.isNaN(now) || Number.isNaN(deadline)) return null;
  return (deadline - now) / 3_600_000;
}

export function evaluateFixedHopeAttention(input: {
  readonly kind: HopeFixedAttentionKind;
  readonly workflowStatus: FixedHopeWorkflowStatus;
  readonly windowOpensAt: string | null;
  readonly windowClosesAt: string | null;
  readonly lateDeadlineAt: string | null;
  readonly completedAt: string | null;
  readonly nowIso: string;
  readonly policy?: HopeAttentionPolicy;
}): HopeAttention {
  const policy = input.policy ?? DEFAULT_HOPE_ATTENTION_POLICY;
  const action = FIXED_ACTIONS[input.kind];
  switch (input.workflowStatus) {
    case "workflow_not_initialized":
      return {
        state: "workflow_issue",
        severity: "warn",
        action: "REPAIR_WORKFLOW",
        message: "The expected HOPE schedule was not initialized for this Admission.",
        deadline: null,
      };
    case "not_applicable":
    case "completed":
    case "skipped":
      return NONE;
    case "upcoming":
      return {
        state: "upcoming",
        severity: "info",
        action: "NONE",
        message: input.windowOpensAt ? "This HOPE item is not open yet." : null,
        deadline: input.windowOpensAt,
      };
    case "late":
      return {
        state: "overdue",
        severity: "critical",
        action,
        message: "The normal completion window has closed. Late completion is still available.",
        deadline: input.lateDeadlineAt,
      };
    case "expired":
      return {
        state: "window_expired",
        severity: "critical",
        action: "NONE",
        message: "Standard and late completion windows have closed.",
        deadline: input.lateDeadlineAt,
      };
    case "open": {
      const remaining = hoursUntil(input.nowIso, input.windowClosesAt);
      if (remaining !== null && remaining <= policy.dueHours) {
        return {
          state: "due",
          severity: "warn",
          action,
          message: "The normal completion window is closing.",
          deadline: input.windowClosesAt,
        };
      }
      if (remaining !== null && remaining <= policy.dueSoonHours) {
        return {
          state: "due_soon",
          severity: "warn",
          action,
          message: "The normal completion window is approaching.",
          deadline: input.windowClosesAt,
        };
      }
      return NONE;
    }
  }
}

export function evaluateSfvAttention(input: {
  readonly status: HopeSfvAttentionStatus;
  readonly dueAt: string;
  readonly completedAt: string | null;
  readonly nowIso: string;
  readonly policy?: HopeAttentionPolicy;
}): HopeAttention {
  const policy = input.policy ?? DEFAULT_HOPE_ATTENTION_POLICY;
  switch (input.status) {
    case "completed":
    case "withdrawn":
      return NONE;
    case "missed":
      return {
        state: "missed",
        severity: "critical",
        action: "NONE",
        message: "The Symptom Follow-Up Visit deadline passed without completion.",
        deadline: input.dueAt,
      };
    case "overdue":
      return {
        state: "overdue",
        severity: "critical",
        action: "OPEN_SFV",
        message: "This Symptom Follow-Up Visit is overdue.",
        deadline: input.dueAt,
      };
    case "open": {
      const remaining = hoursUntil(input.nowIso, input.dueAt);
      if (remaining !== null && remaining <= 0) {
        return {
          state: "due",
          severity: "warn",
          action: "OPEN_SFV",
          message: "This Symptom Follow-Up Visit is due.",
          deadline: input.dueAt,
        };
      }
      if (remaining !== null && remaining <= policy.dueSoonHours) {
        return {
          state: "due_soon",
          severity: "warn",
          action: "OPEN_SFV",
          message: "This Symptom Follow-Up Visit is approaching its due time.",
          deadline: input.dueAt,
        };
      }
      return NONE;
    }
  }
}
