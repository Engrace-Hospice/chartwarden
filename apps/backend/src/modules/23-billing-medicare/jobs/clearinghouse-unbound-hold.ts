// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-unbound-hold.ts — what a worker does for an organization whose
// clearinghouse is not live (ADR-0053 amendment 2026-11-06).
//
// With tenant clearinghouses a job for an org with NO usable vendor used to throw CH_NOT_WIRED, and BullMQ retried it into the DLQ.
// That is wrong for a tenant that simply has not finished setup (nothing chosen yet, or a config dropped back to `draft` by a
// credential rotation or a vendor change): the work is fine, it is waiting for the tenant. So such a job is HELD — moved back to
// delayed, no attempt spent, no DLQ — and ONE alert says so. The unbound reason decides the rest:
//   not_chosen / not_active   hold (this file);
//   outside                   the tenant bills elsewhere: a claim job holds too (nothing may be sent), while a NOE / NOTR
//                             is parked for the tenant to file itself (the notice workers decide that).
// The check is a PRE-FLIGHT, before the job opens its transaction, so a hold leaves no half-written state.
// ponytail: the once-per-window alert memory is per process; a durable one only if several workers must share it.
import type { UnboundReason } from "@chartwarden/x12-837-client";
import { DelayedError } from "bullmq";
import {
  CLAIMS_BILLING_HOLD_MS,
  type HoldableJob,
} from "../../../bootstrap/claims-billing-gate";
import { type M23TransportDeps, transportForOrg } from "./clearinghouse-submission";

export const CLEARINGHOUSE_UNBOUND_ALERT = "m23.clearinghouse.unbound_hold";
/** One alert per (org, reason) per window: a held job asks again every 15 minutes and must not page every time. */
const ALERT_QUIET_MS = 6 * 60 * 60_000;

export type ClearinghouseState =
  | { readonly state: "bound" }
  | { readonly state: "unbound"; readonly reason: UnboundReason };

/** Whether the org's own clearinghouse is live. A legacy single binding (no per-org resolution) counts as bound. */
export async function clearinghouseStateFor(
  deps: { readonly transport?: M23TransportDeps },
  organizationId: string,
): Promise<ClearinghouseState> {
  const transport = await transportForOrg(deps, organizationId);
  if (!transport || transport.binding.vendor !== null) return { state: "bound" };
  return { state: "unbound", reason: transport.binding.unboundReason ?? "not_chosen" };
}

interface AlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

const lastAlertAt = new Map<string, number>();

/** Hold the job (moved back to delayed, no attempt spent) and raise the once-per-window alert. Always throws {@link DelayedError}. */
export async function holdJobWhileUnbound(input: {
  readonly deps: {
    readonly alerts?: AlertPort | undefined;
    readonly logger?: { error(fields: Record<string, unknown>, message: string): void } | undefined;
  };
  readonly job: HoldableJob;
  readonly token: string | undefined;
  readonly queue: string;
  readonly organizationId: string;
  readonly reason: UnboundReason;
  readonly now?: () => number;
}): Promise<never> {
  const { deps, job, token, queue, organizationId, reason } = input;
  const at = (input.now ?? Date.now)();
  const key = `${organizationId}:${reason}`;
  if (at - (lastAlertAt.get(key) ?? Number.NEGATIVE_INFINITY) >= ALERT_QUIET_MS) {
    lastAlertAt.set(key, at);
    // Not awaited past a failure: a broken alert router must never keep a job from being held.
    await Promise.resolve(
      deps.alerts?.dispatch({
        alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
        severity: "warn",
        organizationId,
        payload: { queue, reason },
      }),
    ).catch(() => {
      deps.logger?.error({ organizationId, queue, reason }, "clearinghouse hold alert not dispatched");
    });
  }
  await job.moveToDelayed(at + CLAIMS_BILLING_HOLD_MS, token);
  throw new DelayedError();
}
