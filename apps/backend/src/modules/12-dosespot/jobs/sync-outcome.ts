// apps/backend/src/modules/12-dosespot/jobs/sync-outcome.ts — what a `dosespot_sync_queue` row becomes when its vendor call (or the config
// read behind it) throws. Pure: the drain worker (`worker.ts`) applies it, the unit test pins it.
//
//   defer     the row goes back to `pending` with NO attempt spent and no sync failure recorded. The tenant's registration is not live
//             right now (deactivated, rotating its key, not yet activated: ADR-0111 D6, "queued ones wait") or the platform could not
//             read its config: neither is this row's fault, so neither may end it. Without this the rows of a tenant that merely paused
//             DoseSpot were failed for good and never re-enqueued.
//   requeue   a transient vendor failure: back to `pending`, one attempt spent. The claim backs off by attempt count (`repository.ts`)
//             and the row ends at {@link SYNC_MAX_ATTEMPTS}, so a vendor that never recovers cannot be retried every two minutes forever.
//   failed    ends the row: a rejection the same call would repeat, a bug, or the attempt budget spent.
import {
  isConfigUnavailableError,
  isDegradedError,
  isNotEnabledError,
} from "@chartwarden/dosespot";

/** The attempt budget of a row (attempts that reached the vendor and failed transiently). 8 attempts back off 1+2+4+8+16+32+60 minutes. */
export const SYNC_MAX_ATTEMPTS = 8;

export type SyncFaultOutcome =
  | { readonly kind: "defer"; readonly error: string }
  | { readonly kind: "requeue"; readonly error: string }
  | { readonly kind: "failed"; readonly error: string };

export interface SyncFaultContext {
  /** Attempts already spent on the row (`attempt_count` as claimed, before this one). */
  readonly attemptCount: number;
  /**
   * The org has a DoseSpot registration row (it started onboarding or paused it). A "not enabled" answer then means "not live YET", so the
   * row waits; for an org that never registered anything it stays what it always was: a row that cannot be served, failed.
   */
  readonly orgHasRegistration: boolean;
}

export function classifySyncFault(error: unknown, ctx: SyncFaultContext): SyncFaultOutcome {
  if (isConfigUnavailableError(error)) return { kind: "defer", error: error.customerMessage };
  if (isNotEnabledError(error)) {
    return ctx.orgHasRegistration
      ? { kind: "defer", error: error.customerMessage }
      : { kind: "failed", error: error.customerMessage };
  }
  if (isDegradedError(error)) {
    if (!error.retryable) return { kind: "failed", error: error.customerMessage };
    return ctx.attemptCount + 1 >= SYNC_MAX_ATTEMPTS
      ? {
          kind: "failed",
          error: `${error.customerMessage} (gave up after ${SYNC_MAX_ATTEMPTS} attempts)`,
        }
      : { kind: "requeue", error: error.customerMessage };
  }
  // A plain Error is deterministic and non-retryable — reported as-is.
  return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}
