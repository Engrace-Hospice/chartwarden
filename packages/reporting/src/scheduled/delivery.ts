// @wardenx/reporting · scheduled — the scheduled-report DELIVERY consumer + recipient-revocation cascade
// (M33 §2.2 / §2.4 / §4.3 / D7 / D14).
//
// THE DOWNSTREAM HALF OF THE §1.1 RENDER HANDSHAKE. The runner emitted `m33.scheduled_report.render_requested`
// with `aggregateId = runId`; M22 renders + stores the artifact and replies (the real M22 wire name is
// `m22.document.rendered`, carrying the new `document_id` keyed by that `runId`; the spec D7 prose names the
// reply `m22.document.created` — M22 publishes `m22.document.rendered`, so that is what M33 consumes). This
// consumer writes the `document_id` onto the occurrence, flips it `rendered_pending → rendered_complete →
// delivered`, and emits `m33.scheduled_report.delivered` for the M36 fan-out to the surviving recipients.
//
// This file also carries the §4.3 RECIPIENT-REVOCATION CASCADE that backs `ScheduledReportProvider.
// cascadeRecipientRevocation` (M34 calls it on membership revocation): drop the revoked membership from every
// recipient list and auto-pause any schedule left with zero recipients.
//
// PURE DECISION CORES (the M34 `m22-document-backref` precedent): {@link decideScheduledDelivery} +
// {@link decideRecipientRevocationCascade} are total functions — no Drizzle, no `getSeam`, no outbox import.
// The thin appliers run the single resolved effect under the tenant's `withOrgContext` (F09). The consumed
// event name is a string literal + a locally-declared structural-minimum payload (M22 owns the wire superset);
// M33 reads M22 SOLELY through the outbox event STRING, so this adds NO new manifest `dependsOn` edge.
import type { schema } from "@wardenx/db";

/** The M22 reply event this consumer subscribes to (the downstream half of the §1.1 handshake). */
export const M22_DOCUMENT_RENDERED = "m22.document.rendered" as const;

/** The M22 `aggregate_type` the runner's render-request named — so we act only on a scheduled-report reply,
 *  never another module's render reply on the shared dispatcher. */
export const M33_SCHEDULED_REPORT_AGGREGATE_TYPE = "report_schedule_run" as const;

// ── the delivery consumer (M22 reply → run back-ref + delivered) ──────────────────────────────────────────

/** The structural minimum M33 reads off `m22.document.rendered` (M22 owns the canonical superset). The
 *  `aggregateId` is the `runId` the runner put in the render-request, so the consumer resolves the
 *  occurrence to patch without M22 knowing anything about `report_schedule_run`. */
export interface M22DocumentRenderedPayload {
  readonly organizationId: string;
  /** The owning-module artifact the rendered document materialized (we act only on the scheduled-report value). */
  readonly aggregateType: string;
  /** The aggregate the rendered document back-refs — the `report_schedule_run.id` the runner sent. */
  readonly aggregateId: string;
  /** The newly-stored M22 document the rendered report lives under. */
  readonly documentId: string;
}

/** The facts the live consumer resolves before deciding (kept as data so the decider stays pure). */
export interface ScheduledDeliveryFacts {
  /** The `report_schedule_run` the `aggregateId` resolves to still exists for this org (RLS-scoped lookup). */
  readonly runExists: boolean;
  /** The run's partition key (needed to settle the composite-PK row); null when the run is absent. */
  readonly scheduledFor: Date | null;
  /** The owning `schedule_id` (for the delivered event); null when the run is absent. */
  readonly scheduleId: string | null;
  /** Already `delivered` / a `document_id` already set — a prior delivery applied (idempotency, D14). */
  readonly alreadyDelivered: boolean;
  /** The surviving recipient count to fan the §4.9 `scheduledReportDelivered` alert out to. */
  readonly recipientCount: number;
}

/** The single effect the delivery decider returns for one delivered `m22.document.rendered` reply. */
export type ScheduledDeliveryAction =
  /** The reply is not a scheduled-report back-ref (different `aggregateType`) — ignore (shared dispatcher). */
  | { readonly kind: "not_scheduled_report" }
  /** A re-delivery whose back-ref is already applied — no-op (idempotency, D14). */
  | { readonly kind: "idempotent_skip" }
  /** The named run is gone (failed/destroyed before the render landed) — drop; nothing to settle. */
  | { readonly kind: "run_absent"; readonly runId: string }
  /** Settle the run `delivered` with `document_id` + emit the §4.9 delivered fan-out (the happy path). */
  | {
      readonly kind: "apply_delivery";
      readonly runId: string;
      readonly scheduledFor: Date;
      readonly scheduleId: string;
      readonly documentId: string;
      readonly organizationId: string;
      readonly recipientCount: number;
    };

/**
 * Decide the single effect for one delivered `m22.document.rendered` reply (PURE). Gate order: is-scheduled-
 * report → idempotency → run-present → apply. The `aggregateId` IS the `report_schedule_run.id`.
 */
export function decideScheduledDelivery(
  payload: M22DocumentRenderedPayload,
  facts: ScheduledDeliveryFacts,
): ScheduledDeliveryAction {
  // 1. Only scheduled-report render replies are ours — other modules share this dispatcher event.
  if (payload.aggregateType !== M33_SCHEDULED_REPORT_AGGREGATE_TYPE) {
    return { kind: "not_scheduled_report" };
  }
  // 2. Idempotency (D14): re-delivery never re-settles a delivered occurrence.
  if (facts.alreadyDelivered) return { kind: "idempotent_skip" };
  // 3. The run may have failed / been destroyed between request and reply — nothing to settle onto.
  if (!facts.runExists || facts.scheduledFor === null || facts.scheduleId === null) {
    return { kind: "run_absent", runId: payload.aggregateId };
  }
  // 4. Happy path — settle `delivered` + emit the fan-out.
  return {
    kind: "apply_delivery",
    runId: payload.aggregateId,
    scheduledFor: facts.scheduledFor,
    scheduleId: facts.scheduleId,
    documentId: payload.documentId,
    organizationId: payload.organizationId,
    recipientCount: facts.recipientCount,
  };
}

/** The run-ledger settle + the §4.9 delivered emit the applier drives. */
export interface ScheduledDeliveryPorts {
  readonly runs: {
    settleDelivered(
      runId: string,
      scheduledFor: Date,
      patch: Pick<schema.NewReportScheduleRun, "status" | "documentId" | "finishedAt">,
    ): Promise<void>;
  };
  readonly outbox: {
    emitDelivered(payload: {
      readonly scheduleId: string;
      readonly runId: string;
      readonly documentId: string;
      readonly recipientCount: number;
      readonly organizationId: string;
    }): Promise<void>;
  };
  now(): Date;
}

/**
 * Execute a {@link ScheduledDeliveryAction} (the live-consumer side; thin, so the decision stays the unit-
 * tested core). Only `apply_delivery` writes: it settles the occurrence `delivered` with the `document_id`
 * (the `rendered_complete` flip is subsumed into this terminal settle) and emits `m33.scheduled_report.
 * delivered` for the M36 fan-out. MUST run inside the requesting tenant's `withOrgContext` (F09). Returns the
 * action so the caller can log/audit the disposition.
 */
export async function applyScheduledDelivery(
  action: ScheduledDeliveryAction,
  ports: ScheduledDeliveryPorts,
): Promise<ScheduledDeliveryAction> {
  if (action.kind === "apply_delivery") {
    await ports.runs.settleDelivered(action.runId, action.scheduledFor, {
      status: "delivered",
      documentId: action.documentId,
      finishedAt: ports.now(),
    });
    await ports.outbox.emitDelivered({
      scheduleId: action.scheduleId,
      runId: action.runId,
      documentId: action.documentId,
      recipientCount: action.recipientCount,
      organizationId: action.organizationId,
    });
  }
  return action;
}

// ── the §4.3 recipient-revocation cascade (backs ScheduledReportProvider.cascadeRecipientRevocation) ──────

/** The cascade outcome for one schedule when a membership is revoked (PURE result). */
export interface RecipientRevocationCascadeResult {
  /** The recipient list with the revoked membership removed (unchanged if it was not present). */
  readonly newRecipientMembershipIds: readonly string[];
  /** True when the revoked membership was actually on this schedule's recipient list. */
  readonly affected: boolean;
  /** True when zero recipients remain post-cascade — the schedule auto-pauses (§4.3 / §2.5). */
  readonly autoPause: boolean;
}

/**
 * Decide the recipient-revocation cascade for one schedule (PURE). Removes `revokedMembershipId` from the
 * recipient list; a schedule left with zero recipients auto-pauses. Total + idempotent — re-running with an
 * already-removed membership reports `affected=false` and changes nothing.
 */
export function decideRecipientRevocationCascade(
  currentRecipients: readonly string[],
  revokedMembershipId: string,
): RecipientRevocationCascadeResult {
  const next = currentRecipients.filter((id) => id !== revokedMembershipId);
  const affected = next.length !== currentRecipients.length;
  return {
    newRecipientMembershipIds: next,
    affected,
    autoPause: affected && next.length === 0,
  };
}

/** The schedule recipient/status write the cascade applier drives. */
export interface RecipientRevocationApplyPorts {
  readonly schedules: {
    setRecipients(
      scheduleId: string,
      recipientMembershipIds: readonly string[],
      status?: schema.ReportSchedule["status"],
    ): Promise<void>;
  };
}

/**
 * Execute a {@link RecipientRevocationCascadeResult} for one schedule (thin). A no-op when the membership was
 * not on the list; otherwise writes the trimmed recipient list and (when emptied) flips the schedule
 * `paused`. MUST run inside the tenant's `withOrgContext`. Returns the result for the seam's affected/paused
 * counts.
 */
export async function applyRecipientRevocationCascade(
  scheduleId: string,
  result: RecipientRevocationCascadeResult,
  ports: RecipientRevocationApplyPorts,
): Promise<RecipientRevocationCascadeResult> {
  if (result.affected) {
    await ports.schedules.setRecipients(
      scheduleId,
      result.newRecipientMembershipIds,
      result.autoPause ? "paused" : undefined,
    );
  }
  return result;
}

// ── forward-declared subscription binding (the boot dispatcher wires this; P2C binds the live rail) ───────

/** The consumer name the delivery binding registers under. Consumer dedup is keyed `(eventId, consumerName)`
 *  per the M1 outbox-consumer pattern (the M22/M34 `consumerName` precedent). */
export const M33_SCHEDULED_DELIVERY_CONSUMER_NAME = "m33.scheduled-report-delivery" as const;

/** The forward-declared `{ eventName, consumerName }` binding (the M22 `bindings.ts` / M34 subscription
 *  shape) the boot dispatcher wires once the live transactional-outbox dispatcher accessor lands (P2C). */
export const M33_SCHEDULED_DELIVERY_SUBSCRIPTION = {
  eventName: M22_DOCUMENT_RENDERED,
  consumerName: M33_SCHEDULED_DELIVERY_CONSUMER_NAME,
} as const;

/** DEFERRED until the live transactional-outbox dispatcher accessor exists in bootstrap (P2C). Mirrors the
 *  M22/M34 `*_DEFERRED` flag: P2B authors the pure consumer + declares the binding; P2C binds the dispatcher. */
export const M33_SCHEDULED_DELIVERY_SUBSCRIPTION_DEFERRED = true as const;
