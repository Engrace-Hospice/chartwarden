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
import type { HopeSignerLicenceMode } from "@chartwarden/types";
import {
  type HopeAuditRequestFacts,
  clientCorrelationContext,
  hopeAuditActor,
} from "./hope-signature-audit";

/**
 * What a licence refusal records: closed values only (an enum, a discipline code, the licence kinds held), never free text.
 * Built by hope-signer-licence.ts; defined HERE, the lower layer, so the two files do not import each other.
 */
export interface SignerLicenceRefusalDetail {
  readonly operation: "timepoint_sign" | "sfv_complete";
  readonly reason: "no_active_licence" | "wrong_discipline";
  readonly rfaKind: string;
  /** The record's frozen author discipline; null for a legacy row that carries none (nothing to match a licence to). */
  readonly requiredDiscipline: string | null;
  readonly heldKinds: readonly string[];
  /** The calendar day (UTC) the licences were judged on. */
  readonly asOf: string;
}

/**
 * CW-AC-46 — a signature refused because the signer holds no active licence in the record's discipline. Catalogued
 * (`m10.*`, packages/audit/src/actions/m10.ts) because the CW-MON-01 rule `signature.licence_refusal_burst` reads it.
 */
export const HOPE_SIGNER_LICENCE_REFUSED_EVENT = "m10.signature.licence_refused";
/** CW-AC-46 — an organization's enforcement mode for the signer-licence check was set (catalogued, m10.ts). */
export const HOPE_SIGNER_LICENCE_POLICY_CHANGED_EVENT = "m10.signature.licence_policy_changed";
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

/**
 * A signature refused for the signer's licence (CW-AC-46): which signing act (`operation`), why (`reason`: no active licence
 * on the day vs. a licence held in another discipline only), the discipline the record is attributed to, the licence KINDS
 * the signer did hold (a closed M17 enum, no number or issuing body) and the day they were judged on. The resource is the
 * draft being signed, or the admission an SFV completion was filed under (that RFA-04 does not exist yet).
 *
 * `mode` is the organization's enforcement mode when it was judged. `enforce`: the signature WAS refused (outcome `denied`),
 * written on a NEW transaction after the refused one rolled back (see hope-signer-licence.ts). `shadow`: the signature went
 * through and this is the finding of what enforce would have refused (outcome `success`), written on the signing transaction.
 * Both are the same event type, so the CW-MON-01 burst rule counts them alike.
 */
export const auditHopeSignerLicenceRefused = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly resourceKind: "hope_assessment" | "admission";
    readonly resourceId: string;
    readonly code: string;
    readonly mode: HopeSignerLicenceMode;
    readonly refusal: SignerLicenceRefusalDetail;
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SIGNER_LICENCE_REFUSED_EVENT,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    outcome: input.mode === "enforce" ? "denied" : "success",
    severity: "warn",
    context: {
      mode: input.mode,
      errorCode: input.code,
      operation: input.refusal.operation,
      reason: input.refusal.reason,
      rfaKind: input.refusal.rfaKind,
      requiredDiscipline: input.refusal.requiredDiscipline,
      heldLicenceKinds: [...input.refusal.heldKinds],
      licenceAsOf: input.refusal.asOf,
    },
  });

/**
 * An organization's enforcement mode for the signer-licence check was set (CW-AC-46): the previous and the new mode, and for
 * `shadow` the reason the operator gave, which is the only durable record of why the control was lowered (it was length-checked
 * and screened for patient identifiers by the service before it got here; `justification` is the key the late-deadline override
 * uses for the same kind of text). Severity `warn` when the organization moves below enforce, `info` on the return. Written on the
 * same transaction as the row, so they commit or roll back together. The resource is the organization.
 */
export const auditHopeSignerLicencePolicyChanged = (
  t: DbClient,
  input: OperatorAuditBase & {
    readonly previousMode: HopeSignerLicenceMode;
    readonly mode: HopeSignerLicenceMode;
    readonly reason: string | null;
  },
): Promise<void> =>
  writeOperatorEvent(t, input, {
    eventType: HOPE_SIGNER_LICENCE_POLICY_CHANGED_EVENT,
    resourceKind: "organization",
    resourceId: input.organizationId,
    outcome: "success",
    severity: input.mode === "enforce" ? "info" : "warn",
    context: {
      previousMode: input.previousMode,
      mode: input.mode,
      justification: input.reason,
    },
  });
