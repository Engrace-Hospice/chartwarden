// apps/backend/src/modules/41-billing-commercial/jobs/unbound-alert.ts - what a SHARED M41 cron does for an organization that has work
// waiting but no live clearinghouse (ADR-0053 amendment 2026-11-06).
//
// The submission drain and the acknowledgment pull run for EVERY organization in one BullMQ job. With tenant clearinghouses one org can
// have rows waiting while its own config is not live (nothing chosen, a draft, `outside`): that is that tenant's setup, not a fault of the
// job. It used to fail the whole tick, so BullMQ retried the job into the DLQ for every tenant, forever. It is now reported PER ORG as one
// alert (and a log line) and the tick carries on: the other orgs drain, and the waiting rows stay queued until the tenant finishes setup.
// ponytail: the once-per-window alert memory is per process; a durable one only if several workers must share it.
import {
  CLEARINGHOUSE_HOLD_ALERT_CODES,
  CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS,
  ChartWardenError,
} from "@chartwarden/types";

export const M41_UNBOUND_WITH_WORK_ALERT = CLEARINGHOUSE_HOLD_ALERT_CODES.m41;
/** One alert per (org, queue) per window: the cron ticks every few minutes and must not page every time. */
const ALERT_QUIET_MS = CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS;

export interface UnboundAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

const lastAlertAt = new Map<string, number>();

/** Test seam: forget which orgs were already alerted, so a suite's cases do not depend on each other's order. */
export const __resetUnboundAlertMemoryForTest = (): void => lastAlertAt.clear();

/** Raise the once-per-window alert for an org with `waiting` work and no live clearinghouse. Never throws, never fails the tick. */
export async function reportUnboundWithWork(
  deps: {
    readonly alerts?: UnboundAlertPort | undefined;
    readonly log?:
      | ((event: { readonly event: string; readonly code?: string }) => void)
      | undefined;
  },
  input: {
    readonly organizationId: string;
    readonly queue: string;
    readonly waiting: number;
    /**
     * Why the org has no live clearinghouse when it is not simply unbound: the code of the typed refusal (its credential cannot be
     * opened, its config could not be read). A code only, never a message.
     */
    readonly code?: string;
    readonly now?: () => number;
  },
): Promise<void> {
  const at = (input.now ?? Date.now)();
  const key = `${input.organizationId}:${input.queue}`;
  if (at - (lastAlertAt.get(key) ?? Number.NEGATIVE_INFINITY) < ALERT_QUIET_MS) return;
  deps.log?.({ event: "clearinghouse.unbound_with_work", code: input.code ?? "CH_NOT_WIRED" });
  try {
    await deps.alerts?.dispatch({
      alertCode: M41_UNBOUND_WITH_WORK_ALERT,
      severity: "warn",
      organizationId: input.organizationId,
      payload: {
        queue: input.queue,
        waiting: input.waiting,
        ...(input.code ? { code: input.code } : {}),
      },
    });
    // Only a dispatch that went out (persisted with a resolved recipient; M36's emitter persists, it does not guarantee delivery)
    // starts the quiet window: this alert is the one signal that the org's work is held, so a router that threw must be tried again
    // on the next tick, not silenced for six hours. The correlation id the composition root sends carries the queue, code and window.
    lastAlertAt.set(key, at);
  } catch (err) {
    // an alert router that is down must not turn one tenant's setup into a failed tick for all of them
    deps.log?.({
      event: "clearinghouse.unbound_alert_failed",
      code: err instanceof ChartWardenError ? err.code : "ALERT_FAILED",
    });
  }
}
