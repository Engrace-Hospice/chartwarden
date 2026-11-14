/**
 * Evidence-based lifecycle and deadline projection for the currently supported hospice notices.
 * CMS deadlines are calendar dates in the Medicare (Eastern) receipt-day convention already used by M23.
 * This projection is deliberately read-only: it never grants an exception or changes notice state.
 */
export type MedicareNoticeKind = "noe" | "notr" | "transfer_8xc" | "cancellation_8xd";
export type NoticeDeadlineRisk =
  | "not_applicable"
  | "not_determinable"
  | "on_track"
  | "approaching"
  | "due_today"
  | "overdue"
  | "submitted_awaiting_verification"
  | "accepted_within_deadline"
  | "accepted_after_deadline"
  | "filing_timeliness_unknown"
  | "transport_rejected"
  | "rejected";
export type NoticeLifecycleStage =
  | "draft"
  | "ready"
  | "submission_requested"
  | "dispatch_started"
  | "transport_receipt_confirmed"
  | "transport_rejected"
  | "known_not_sent"
  | "outcome_unknown"
  | "awaiting_mac_acknowledgment"
  | "mac_accepted_verified"
  | "mac_rejected_verified"
  | "external_filing_recorded"
  | "cancelled"
  | "unknown";

export interface NoticeDeadlineAssessment {
  readonly applies: boolean;
  readonly basis: string;
  readonly policyVersion: "CMS-100-04-Ch11-20.1.1-20.1.2-2024-06-03";
  readonly triggerDate: string | null;
  readonly dueDate: string | null;
  readonly risk: NoticeDeadlineRisk;
  readonly lifecycle: NoticeLifecycleStage;
  readonly acceptance: "verified" | "not_verified" | "unknown";
  readonly acceptedAt: string | null;
  readonly timeliness: "timely" | "late" | "unknown" | "not_applicable";
  readonly followUp: string;
}

export interface NoticeDeadlineInput {
  readonly kind: MedicareNoticeKind;
  readonly state: string;
  /** Persisted effective event date: admission/election for NOE; discharge-alive/revocation for NOTR. */
  readonly triggerDate: string | null;
  /** Existing persisted target is retained as historical authority; no deadline is silently rewritten. */
  readonly persistedDueDate: string | null;
  /** Only verified MAC acknowledgment timestamps qualify; clearinghouse receipt is not accepted here. */
  readonly acceptedAt: string | null;
  readonly rejectedAt?: string | null;
  readonly externalFilingOn?: string | null;
  readonly attempt?: {
    readonly dispatchState: "pending" | "sending" | "in_doubt" | "finished";
    readonly outcome: string;
    readonly submittedAt: string | null;
    readonly dispatchStartedAt: string | null;
  } | null;
  /** Derived from the organization-scoped final-claim evidence; used only for the NOTR final-claim exception. */
  readonly finalClaimFiled?: boolean;
  readonly now: Date;
}

const DAY_MS = 86_400_000;
const POLICY_VERSION = "CMS-100-04-Ch11-20.1.1-20.1.2-2024-06-03" as const;

function validDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dayAtEastern(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dateDistance(due: string, today: string): number {
  return Math.round((Date.parse(`${due}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS);
}

function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function lifecycle(
  state: string,
  acceptedAt: string | null,
  rejectedAt: string | null,
  externalFilingOn: string | null,
  attempt: NoticeDeadlineInput["attempt"],
): NoticeLifecycleStage {
  if (acceptedAt) return "mac_accepted_verified";
  if (rejectedAt || state === "ack_rejected" || state === "rejected") return "mac_rejected_verified";
  if (state === "cancelled") return "cancelled";
  if (attempt?.dispatchState === "in_doubt") return "outcome_unknown";
  if (attempt?.dispatchState === "sending") return "dispatch_started";
  if (attempt?.dispatchState === "finished" && attempt.outcome === "submitted" && attempt.submittedAt) return "transport_receipt_confirmed";
  if (attempt?.dispatchState === "finished" && attempt.outcome === "failed_portal") return "transport_rejected";
  if (attempt?.dispatchState === "finished" && attempt.outcome === "failed_worker" && !attempt.dispatchStartedAt) return "known_not_sent";
  if (state === "ack_pending") return "awaiting_mac_acknowledgment";
  if (externalFilingOn) return "external_filing_recorded";
  if (state === "draft") return "draft";
  if (state === "ready") return "ready";
  if (state === "queued" || state === "submission_requested") return "submission_requested";
  if (state === "submitted") return "submission_requested";
  return "unknown";
}

/**
 * 8xC readiness is governed by transfer-specific prerequisites, not the NOE/NOTR five-day rule.
 * The limited supported 8xD cancellation also has no generic five-day filing rule.
 */
export function assessNoticeDeadline(input: NoticeDeadlineInput): NoticeDeadlineAssessment {
  const stage = lifecycle(input.state, input.acceptedAt, input.rejectedAt ?? null, input.externalFilingOn ?? null, input.attempt);
  if (
    input.kind === "notr" && input.finalClaimFiled === true &&
    !input.acceptedAt && !input.rejectedAt &&
    !["ack_accepted", "accepted", "ack_rejected", "rejected"].includes(input.state) &&
    input.attempt?.dispatchState !== "in_doubt"
  ) {
    return {
      applies: false,
      basis: "CMS-100-04 Chapter 11 §20.1.2: a discharge-alive NOTR is not required when the final claim has already been filed; this is derived from the persisted M23 final-claim submission state.",
      policyVersion: POLICY_VERSION,
      triggerDate: validDay(input.triggerDate) ? input.triggerDate : null,
      dueDate: null,
      risk: "not_applicable",
      lifecycle: stage,
      acceptance: input.acceptedAt ? "verified" : "not_verified",
      acceptedAt: input.acceptedAt,
      timeliness: "not_applicable",
      followUp: "The organization-scoped final-claim record satisfies the NOTR filing exception. This does not imply payment or claim adjudication.",
    };
  }
  if (input.kind === "transfer_8xc" || input.kind === "cancellation_8xd") {
    return {
      applies: false,
      basis: input.kind === "transfer_8xc"
        ? "CMS-100-04 Chapter 11 §20.1.3: transfer-specific sequence; no generic NOE/NOTR five-day deadline is applied."
        : "CMS-100-04 Chapter 11 §20.1.4: cancellation-specific workflow; no generic NOE/NOTR five-day deadline is applied.",
      policyVersion: POLICY_VERSION,
      triggerDate: validDay(input.triggerDate) ? input.triggerDate : null,
      dueDate: null,
      risk: "not_applicable",
      lifecycle: stage,
      acceptance: input.acceptedAt ? "verified" : "not_verified",
      acceptedAt: input.acceptedAt,
      timeliness: "not_applicable",
      followUp: "Follow the transaction-specific transfer or cancellation prerequisites; this projection does not imply filing readiness.",
    };
  }

  const dueDate = validDay(input.persistedDueDate) ? input.persistedDueDate : null;
  const triggerDate = validDay(input.triggerDate) ? input.triggerDate : null;
  const basis = input.kind === "noe"
    ? "CMS-100-04 Chapter 11 §20.1.1: submitted to and accepted by the A/B MAC (HHH) within 5 calendar days after hospice admission; CWF posting date is not the timeliness evidence."
    : "CMS-100-04 Chapter 11 §20.1.2: submitted to and accepted by the A/B MAC (HHH) within 5 calendar days after effective discharge-alive or revocation; transfer is not an ordinary NOTR event and the final-claim exception may apply.";

  if (
    (input.acceptedAt && input.rejectedAt) ||
    (input.acceptedAt && ["ack_rejected", "rejected"].includes(input.state)) ||
    (input.rejectedAt && ["ack_accepted", "accepted"].includes(input.state))
  ) {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "filing_timeliness_unknown", lifecycle: "unknown", acceptance: "unknown", acceptedAt: null,
      timeliness: "unknown", followUp: "Conflicting accepted and rejected acknowledgment evidence exists. Reconcile the source evidence before determining filing status.",
    };
  }

  if (input.attempt?.dispatchState === "in_doubt") {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "filing_timeliness_unknown", lifecycle: "outcome_unknown", acceptance: "unknown", acceptedAt: null,
      timeliness: "unknown", followUp: "A prior dispatch may have reached the transport, but no verified MAC acknowledgment is recorded. Reconcile the original attempt; do not resend automatically.",
    };
  }

  if (triggerDate && dueDate && addCalendarDays(triggerDate, 5) !== dueDate) {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "not_determinable", lifecycle: stage,
      acceptance: input.acceptedAt ? "verified" : "not_verified", acceptedAt: input.acceptedAt,
      timeliness: "unknown", followUp: "The persisted filing target does not match the five-calendar-day policy from the authoritative event date. Review the source record; the stored deadline is not rewritten.",
    };
  }

  if (input.acceptedAt) {
    const acceptedInstant = new Date(input.acceptedAt);
    const acceptedDate = Number.isNaN(acceptedInstant.getTime()) ? "" : dayAtEastern(acceptedInstant);
    const acceptedDateIsValid = validDay(acceptedDate);
    const timely = dueDate && acceptedDateIsValid && acceptedDate <= dueDate;
    return {
      applies: true,
      basis,
      policyVersion: POLICY_VERSION,
      triggerDate,
      dueDate,
      risk: timely ? "accepted_within_deadline" : dueDate && acceptedDateIsValid ? "accepted_after_deadline" : "filing_timeliness_unknown",
      lifecycle: stage,
      acceptance: "verified",
      acceptedAt: input.acceptedAt,
      timeliness: timely ? "timely" : dueDate && acceptedDateIsValid ? "late" : "unknown",
      followUp: timely ? "MAC acceptance is recorded within the filing window." : dueDate && acceptedDateIsValid ? "Review late-filing consequences and any separately documented external exception determination." : "Acceptance is recorded, but the trigger or deadline evidence is insufficient to determine timeliness.",
    };
  }

  if (input.attempt?.dispatchState === "finished" && input.attempt.outcome === "failed_portal") {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "transport_rejected", lifecycle: "transport_rejected", acceptance: "not_verified", acceptedAt: null,
      timeliness: "unknown", followUp: "A transport rejection is recorded, but no Medicare acceptance exists. Review the response and follow the authorized correction/retry policy.",
    };
  }

  if (input.state === "submitted" || input.state === "ack_pending") {
    const isRequestOnly = input.state === "submitted" && (!input.attempt || input.attempt.dispatchState === "pending");
    if (isRequestOnly) {
      // Submission API acceptance/outbox enqueue is not transport dispatch. Leave risk governed by the deadline below.
    } else {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "submitted_awaiting_verification", lifecycle: stage, acceptance: "not_verified", acceptedAt: null,
      timeliness: "unknown", followUp: "Submission is recorded, but no verified MAC acceptance evidence is available. Do not treat a transport receipt as filing acceptance.",
    };
    }
  }
  if (input.state === "accepted" || input.state === "ack_accepted") {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "filing_timeliness_unknown", lifecycle: "unknown", acceptance: "unknown", acceptedAt: null,
      timeliness: "unknown", followUp: "The notice state indicates acceptance but a verified acknowledgment timestamp is missing. Reconcile the underlying evidence; do not infer timeliness.",
    };
  }
  if (input.rejectedAt || input.state === "ack_rejected" || input.state === "rejected") {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "rejected", lifecycle: stage, acceptance: "not_verified", acceptedAt: null,
      timeliness: "unknown", followUp: "Review the verified rejection and correction path; rejection is not filing acceptance.",
    };
  }
  if (!triggerDate || !dueDate) {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "not_determinable", lifecycle: stage, acceptance: "not_verified", acceptedAt: null,
      timeliness: "unknown", followUp: "Resolve the authoritative event date and persisted filing target; no date is inferred.",
    };
  }
  if (input.externalFilingOn) {
    return {
      applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate,
      risk: "filing_timeliness_unknown", lifecycle: "external_filing_recorded", acceptance: "not_verified", acceptedAt: null,
      timeliness: "unknown", followUp: "A tenant-recorded external filing date is present, but no verified MAC acceptance timestamp is available. Treat filing timeliness as unknown.",
    };
  }
  const distance = dateDistance(dueDate, dayAtEastern(input.now));
  const risk: NoticeDeadlineRisk = distance < 0 ? "overdue" : distance === 0 ? "due_today" : distance <= 2 ? "approaching" : "on_track";
  return {
    applies: true, basis, policyVersion: POLICY_VERSION, triggerDate, dueDate, risk,
    lifecycle: stage, acceptance: "not_verified", acceptedAt: null, timeliness: "unknown",
    followUp: distance < 0 ? "Escalate immediately. No verified MAC acceptance is recorded; do not infer an exception." : "Complete prerequisites and obtain verified MAC acceptance by the due date.",
  };
}
