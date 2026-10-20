// apps/backend/src/modules/36-messaging/ack-escalation/supervisor-attention.ts - ADR-0079 (G-3, G-5): the ONE way the platform tells the
// supervisor audience that an acknowledgment request has no human known to be handling it (ladder exhausted, router unavailable, every
// route to the assignee failed, or unreachable and still unwatched). It goes through the AlertEmitter seam only: in-app always, plus an
// out-of-band page to each supervisor's VERIFIED endpoint when the notification policy is on for the tenant (SUPERVISOR_PAGE_EVENT_TYPES,
// the class floor of ADR-0073). NO vendor transport exists in any environment, so this cannot promise a phone rang: when the emit planned
// no out-of-band route the ops sink is told ("unpaged"), and `ack-delivery-failure` tells it when a planned page failed. Never silent.
// Fixed generic text, ids and codes only: no name, patient or message text, here or on the ops notice.
import type { AlertEmitter } from "@wardenx/messaging";
import type { AckClass } from "@wardenx/types";

export const ACK_SUPERVISOR_ATTENTION_EVENT = "m36.ack.supervisor_attention" as const;
export const SUPERVISOR_UNPAGED_OPS_KIND = "m36.ack.supervisor_unpaged" as const;
export const SUPERVISOR_PAGE_FAILED_OPS_KIND = "m36.ack.supervisor_page_failed" as const;
export const UNWATCHED_OPS_KIND = "m36.ack.failed_unreachable_unwatched" as const;

/**
 * Why the supervisors are being told. `unwatched` = unreachable and still open after its deadline (G-5). `assignee_departed` = WP 5.9
 * (ADR-0084): the person it waits on has left and offboarding found nobody eligible to take it.
 */
export type SupervisorAttentionReason =
  | "ladder_exhausted"
  | "route_unavailable"
  | "failed_unreachable"
  | "unwatched"
  | "assignee_departed";

export const SUPERVISOR_ATTENTION_TEXT: Readonly<Record<SupervisorAttentionReason, string>> = {
  ladder_exhausted:
    "A clinical message was not acknowledged in time and there is no further escalation tier; it needs a supervisor",
  route_unavailable:
    "A clinical message was not acknowledged in time and could not be escalated; it needs a supervisor",
  failed_unreachable:
    "A clinical message could not be delivered to anyone and nobody is known to have received it; it needs a supervisor",
  unwatched:
    "A clinical message that could not be delivered is still waiting and past its deadline; it needs a supervisor",
  assignee_departed:
    "A clinical message is waiting on a person who has left and nobody eligible could take it; it needs a supervisor",
};

/** Shape of `buildPlatformOpsNoticeSink`'s notice, restated so this module does not import bootstrap internals. */
export interface SupervisorOpsNotice {
  readonly kind: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, string | number>>;
  readonly correlationId: string;
}

export interface SupervisorAttentionDeps {
  readonly alerts: AlertEmitter;
  readonly opsNotice: (notice: SupervisorOpsNotice) => void;
}

/** Where a supervisor goes: the unacknowledged queue (a supervisor may not be a member of the conversation, so no thread link). */
export const SUPERVISOR_QUEUE_DEEP_LINK = "/messaging/unacknowledged";

/**
 * Emit the supervisor alert (idempotent on `correlationId`: a redelivery or a second worker converges on the same alert), then, when no
 * out-of-band route was planned for any supervisor, raise the ops notice. A throw from the emit propagates (the outbox retries).
 */
export async function raiseSupervisorAttention(
  deps: SupervisorAttentionDeps,
  organizationId: string,
  request: { readonly id: string; readonly ackClass: AckClass },
  reason: SupervisorAttentionReason,
  correlationId: string,
  /**
   * Asked only when no out-of-band route was planned: false skips the unpaged ops notice. The unreachable watch re-emits (idempotent on
   * `correlationId`) and gates the notice on its own claim, so a repeat emit never repeats the notice. Event-driven callers omit it.
   */
  unpagedGate: () => Promise<boolean> = async () => true,
): Promise<void> {
  const result = await deps.alerts.emit(organizationId, {
    eventType: ACK_SUPERVISOR_ATTENTION_EVENT,
    severity: "warn",
    correlationId,
    payload: {
      reason,
      requestId: request.id,
      // The class the notification policy takes its platform floor from (a class, not PHI).
      ackClass: request.ackClass,
      message: SUPERVISOR_ATTENTION_TEXT[reason],
      deepLink: SUPERVISOR_QUEUE_DEEP_LINK,
    },
  });
  if ((result.outOfBandPlanned ?? 0) > 0 || !(await unpagedGate())) return;
  deps.opsNotice({
    kind: SUPERVISOR_UNPAGED_OPS_KIND,
    summary:
      result.resolvedRecipientCount === 0
        ? "No supervisor could be told about an acknowledgment request that needs one (no recipient resolved)"
        : "Supervisors were told in-app only about an acknowledgment request that needs one (no out-of-band route was planned)",
    details: {
      organizationId,
      requestId: request.id,
      ackClass: request.ackClass,
      reason,
      supervisors: result.resolvedRecipientCount,
    },
    correlationId: `unpaged:${correlationId}`,
  });
}

/** Remembers the last `cap` keys; true the first time a key is seen. In-process only: used to keep a retried handler from repeating an ops notice. */
export function createOnceGuard(cap = 1000): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > cap) seen.delete(seen.values().next().value as string);
    return true;
  };
}
