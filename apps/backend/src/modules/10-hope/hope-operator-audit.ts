// apps/backend/src/modules/10-hope/hope-operator-audit.ts — the explicit audit events for the operator writes that
// used to rely on the M4 row-diff trigger alone: cancelling an iQIES package (`hope.submission_cancelled`), skipping
// a timepoint window (`hope.schedule_skipped`), the admin regenerate of an admission's windows
// (`hope.schedules_regenerated`), and the refused SFV completion (`hope.sfv_completion_denied`).
//
// Why an explicit event on top of the trigger: M10's services open `withOrgContext(..., userId: "")`, so the trigger's
// `actor_user_id` is only whatever the ambient request context carries (GAP-111), and the trigger records a row diff,
// not the operator's act. These rows name the acting MEMBERSHIP (in the context) and the SESSION user (`actor_user_id`),
// exactly as the signature events do (hope-signature-audit.ts, the pattern this file follows: M4 `audit()`, a
// SERVER-generated correlation id, the client's own correlation id only as a trace hint in the context, a sanitised
// user agent, a free un-prefixed `hope.*` event type).
//
// Context is ids and enums only: no free text, no PHI. The three success events are written by the caller on the SAME
// transaction as the write they record, so they commit or roll back together. The denied event records a refusal whose
// own transaction rolled back, so its caller writes it on a NEW transaction (see hope-sfv-completion-guards.ts).
import { audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  type HopeAuditRequestFacts,
  clientCorrelationContext,
  hopeAuditActor,
} from "./hope-signature-audit";

export const HOPE_SUBMISSION_CANCELLED_EVENT = "hope.submission_cancelled";
export const HOPE_SCHEDULE_SKIPPED_EVENT = "hope.schedule_skipped";
export const HOPE_SCHEDULES_REGENERATED_EVENT = "hope.schedules_regenerated";
export const HOPE_SFV_COMPLETION_DENIED_EVENT = "hope.sfv_completion_denied";

/** Who did it and through which request. M10's acting id is the MEMBERSHIP id, so it rides in the context. */
interface OperatorAuditBase {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly request?: HopeAuditRequestFacts;
}

interface OperatorEvent {
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly outcome: "success" | "denied";
  readonly severity?: "info" | "warn";
  readonly context: Record<string, unknown>;
}

async function writeOperatorEvent(
  t: DbClient,
  base: OperatorAuditBase,
  event: OperatorEvent,
): Promise<void> {
  await audit(
    t as never,
    hopeAuditActor(
      base.organizationId,
      `${event.eventType.replace(/[._]/g, "-")}:${event.resourceId}`,
      base.request,
    ),
    {
      eventType: event.eventType,
      resourceKind: event.resourceKind,
      resourceId: event.resourceId,
      outcome: event.outcome,
      ...(event.severity ? { severity: event.severity } : {}),
      context: {
        ...event.context,
        byMembershipId: base.membershipId,
        ...clientCorrelationContext(base.request),
      },
    },
  );
}

/**
 * A package cancelled before upload: the batch, why, and the hash of the package whose bytes were purged with it. When the bytes
 * were KEPT, `bytesKeptReason` says why: `legal_hold` (an M4 hold applies) or `hold_scope_unreadable` (the hold scope could not
 * be read, so nothing could be shown not to be held); `bytesKeptForLegalHold` is true only for the first. A REPEAT cancel that
 * purged bytes kept earlier writes this event too (`repeatCancel: true`, `packageBytesPurged: true`, `itemsCancelled: 0`).
 * Ids, enums and booleans only.
 */
export const auditHopeSubmissionCancelled = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly submissionId: string;
    readonly providerEntityId: string;
    readonly reasonCode: string;
    readonly priorStatus: string;
    readonly packageSha256: string | null;
    readonly itemsCancelled: number;
    readonly bytesKeptReason: "legal_hold" | "hold_scope_unreadable" | "none";
    readonly repeatCancel: boolean;
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SUBMISSION_CANCELLED_EVENT,
    resourceKind: "hope_submission",
    resourceId: input.submissionId,
    outcome: "success",
    context: {
      providerEntityId: input.providerEntityId,
      reasonCode: input.reasonCode,
      priorStatus: input.priorStatus,
      // The hash survives as the evidence that this exact package existed; the bytes it hashes do not (CW-DS-01).
      packageSha256: input.packageSha256,
      packageBytesPurged: input.bytesKeptReason === "none",
      // Kept for the registers and callers that read the first spelling: true only for a real hold, never for an unreadable scope.
      bytesKeptForLegalHold: input.bytesKeptReason === "legal_hold",
      bytesKeptReason: input.bytesKeptReason,
      repeatCancel: input.repeatCancel,
      itemsCancelled: input.itemsCancelled,
    },
  });

/** A timepoint window skipped: the schedule, its RFA, and the closed reason code (never free text). */
export const auditHopeScheduleSkipped = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly scheduleId: string;
    readonly admissionId: string;
    readonly rfaKind: string;
    readonly skipReasonCode: string;
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SCHEDULE_SKIPPED_EVENT,
    resourceKind: "hope_timepoint_schedule",
    resourceId: input.scheduleId,
    outcome: "success",
    context: {
      admissionId: input.admissionId,
      rfaKind: input.rfaKind,
      skipReasonCode: input.skipReasonCode,
    },
  });

/** An admin regenerate of an admission's windows: which windows it created (none, when it was a no-op). */
export const auditHopeSchedulesRegenerated = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly admissionId: string;
    readonly createdScheduleIds: readonly string[];
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SCHEDULES_REGENERATED_EVENT,
    resourceKind: "admission",
    resourceId: input.admissionId,
    outcome: "success",
    context: {
      createdCount: input.createdScheduleIds.length,
      createdScheduleIds: [...input.createdScheduleIds],
    },
  });

/**
 * An SFV completion refused because no SFV obligation is bound to the URL admission (R-01): the probe for another
 * admission's SFV. The triggering assessment id is a BODY value, so it is recorded only when it is a canonical uuid
 * (`triggeringAssessmentId: null` and the flag otherwise); free text from a client never enters the immutable trail.
 */
export const auditHopeSfvCompletionDenied = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly admissionId: string;
    readonly triggeringAssessmentId: string | null;
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SFV_COMPLETION_DENIED_EVENT,
    resourceKind: "admission",
    resourceId: input.admissionId,
    outcome: "denied",
    severity: "warn",
    context: {
      reason: "sfv_not_bound_to_admission",
      triggeringAssessmentId: input.triggeringAssessmentId,
      triggeringAssessmentIdIsUuid: input.triggeringAssessmentId !== null,
    },
  });
