// apps/backend/src/modules/36-messaging/ack-escalation/binding.ts - WP 4.4: the composition-root binding of the escalation timers.
// The ops flag `messaging.escalation_timers` (FeatureFlagReaderPort: tenant row wins, absent = off, cached a few seconds per org)
// gates the ACTION only. Arming a timer is always safe (it writes nothing to the request), so the arming consumer ignores the flag;
// with the flag off a due request is left exactly as it is, open and visible (ADR-0070).
import { runWithRequestContext, systemOrgContext } from "@wardenx/tenancy";
import { ACK_ESCALATION_TIMERS_FLAG_KEY, type EscalationRouter } from "@wardenx/types";
import type { AckRow, AckStore } from "../ack-requests/ack-types";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { type GuardOptions, guardEscalationRouter } from "./escalation-router-guard";
import { type EscalationService, createEscalationService } from "./escalation-service";
import type { EscalationTimerPort } from "./escalation-timers";

export interface EscalationBindingInput {
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly store: AckStore;
  readonly outbox?: HintOutboxPort | undefined;
  /** The raw seam (`getEscalationRouter()`); the binding wraps it in the org-checking guard. */
  readonly router: EscalationRouter;
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Tests only (a live suite drives the real binding with a fake router). Production never sets it. */
  readonly routerGuard?: GuardOptions;
  /** Absent when there is no queue connection: nothing is armed and the sweeper alone wakes the escalation. */
  readonly timers?: EscalationTimerPort | undefined;
  readonly onError?: (
    context: { organizationId: string; requestId: string },
    error: unknown,
  ) => void;
  readonly now?: () => Date;
}

export interface EscalationBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: EscalationService;
  /** A tenant-scoped read of the request (no acting user), for the consumers' stale-event checks. */
  readonly readRequest: (orgId: string, requestId: string) => Promise<AckRow | null>;
  /** Arms the timer for the request's CURRENT window if it is still waiting. Idempotent; a throw means "not armed" (retry). */
  readonly armFromRequest: (orgId: string, requestId: string) => Promise<void>;
}

/**
 * A timer is not a request: a real router (M19) opens `withOrgContextFromRequest` and checks `orgId` against the ambient context, which
 * does not exist in a worker. Give it the tenant's system scope for exactly the call (the established worker pattern).
 */
function inOrgScope(router: EscalationRouter): EscalationRouter {
  return {
    resolveTier: (orgId, request) =>
      runWithRequestContext(systemOrgContext(orgId), () => router.resolveTier(orgId, request)),
  };
}

export function buildEscalationBinding(input: EscalationBindingInput): EscalationBinding {
  const now = input.now ?? (() => new Date());
  const isEnabled = cacheFlagRead(async (organizationId) =>
    input.flags
      ? (await input.flags.forOrg(organizationId))[ACK_ESCALATION_TIMERS_FLAG_KEY] === true
      : false,
  );
  const service = createEscalationService({
    store: input.store,
    isEnabled,
    router: guardEscalationRouter(inOrgScope(input.router), input.routerGuard),
    stillQualified: input.stillQualified,
    outbox: input.outbox,
    now,
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const readRequest = (orgId: string, requestId: string) =>
    input.store.readAsSystem(orgId, (tx) => tx.findById(requestId, false));
  return {
    isEnabled,
    service,
    readRequest,
    async armFromRequest(orgId, requestId) {
      if (!input.timers) return;
      const row = await readRequest(orgId, requestId);
      // Any waiting request is armed for its current window, whatever event announced it: a stale event arms the right job.
      if (!row || (row.status !== "pending" && row.status !== "escalated")) return;
      await input.timers.arm(
        { orgId, requestId: row.id, tier: row.currentTier, deadlineAt: row.deadlineAt },
        now(),
      );
    },
  };
}
