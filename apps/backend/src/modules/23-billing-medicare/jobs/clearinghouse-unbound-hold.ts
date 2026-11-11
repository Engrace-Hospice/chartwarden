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
// A held NOE / NOTR / transfer notice may cost a CMS deadline, and shadow mode does not shield it (the hold is a transport fact, not a
// claims-billing enforcement one): its alert is CRITICAL (`severity`), a held claim's only `warn`. Each severity has its own quiet
// window, so a claim's warning never silences a notice's critical alert.
// The quiet window starts only AFTER a dispatch that went out and resolved a recipient: this alert is the one signal that the org's
// work is held, so a router that threw, or an alert nobody was addressed by, must be tried again on the next held job, not silenced for
// six hours. "Went out" is PERSISTED by M36's emitter, not delivered: out-of-band delivery follows each recipient's own preferences.
// The emitter absorbs a repeat of the same (org, correlation id), so the correlation id the composition root sends carries the severity,
// queue, reason and six-hour window (cron-alert-correlation.ts): a held NOE's critical alert is not absorbed by a held claim's warning,
// and the re-alert after a window reaches the tenant again.
// ponytail: the once-per-window alert memory is per process; a durable one only if several workers must share it.
import {
  CLEARINGHOUSE_HOLD_ALERT_CODES,
  CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS,
  ChartWardenError,
} from "@chartwarden/types";
import type { UnboundReason } from "@chartwarden/x12-837-client";
import { DelayedError } from "bullmq";
import { CLAIMS_BILLING_HOLD_MS, type HoldableJob } from "../../../bootstrap/claims-billing-gate";
import { type M23TransportDeps, transportForOrg } from "./clearinghouse-submission";

export const CLEARINGHOUSE_UNBOUND_ALERT = CLEARINGHOUSE_HOLD_ALERT_CODES.m23;
/** One alert per (org, reason) per window: a held job asks again every 15 minutes and must not page every time. */
const ALERT_QUIET_MS = CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS;

export type ClearinghouseState =
  | { readonly state: "bound" }
  | { readonly state: "unbound"; readonly reason: UnboundReason };

/** The typed refusal the per-org resolver throws for a stored credential it cannot open (tenant-clearinghouse/resolver.ts). */
const CREDENTIAL_UNREADABLE_CODE = "CLEARINGHOUSE_CREDENTIAL_UNREADABLE";

/**
 * True when `err` is the org's stored credential failing to open (CH-7): that tenant has to enter it again, which is setup to wait
 * for like a draft config, not a fault of the job. A pre-flight HOLDS the job for it (and says so once); it must not fail it into
 * the retry/DLQ path.
 */
export const isCredentialUnreadable = (err: unknown): err is ChartWardenError =>
  err instanceof ChartWardenError && err.code === CREDENTIAL_UNREADABLE_CODE;

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
/** Keys whose dispatch is awaiting an answer: concurrent held jobs of one org raise one alert, not one each. */
const dispatching = new Set<string>();

/** Test seam: forget which orgs were already alerted, so a suite's cases do not depend on each other's order. */
export const __resetClearinghouseAlertMemoryForTest = (): void => {
  lastAlertAt.clear();
  dispatching.clear();
};

interface AlertDeps {
  readonly alerts?: AlertPort | undefined;
  readonly logger?: { error(fields: Record<string, unknown>, message: string): void } | undefined;
}

/** `critical` for a held CMS-deadline notice (NOE, NOTR, transfer notice); `warn` for a held claim. */
export type HoldAlertSeverity = "warn" | "critical";

/** Raise the once-per-(org, reason, severity)-per-window alert. Never throws: a broken alert router must not keep a job from being held. */
async function alertOncePerWindow(
  deps: AlertDeps,
  input: {
    readonly queue: string;
    readonly organizationId: string;
    readonly reason: string;
    readonly severity: HoldAlertSeverity;
    readonly at: number;
  },
): Promise<void> {
  const { queue, organizationId, reason, severity, at } = input;
  const key = `${organizationId}:${reason}:${severity}`;
  if (dispatching.has(key)) return;
  if (at - (lastAlertAt.get(key) ?? Number.NEGATIVE_INFINITY) < ALERT_QUIET_MS) return;
  dispatching.add(key);
  try {
    await deps.alerts?.dispatch({
      alertCode: CLEARINGHOUSE_UNBOUND_ALERT,
      severity,
      organizationId,
      payload: { queue, reason },
    });
    lastAlertAt.set(key, at); // only a dispatch that went out starts the quiet window
  } catch {
    deps.logger?.error(
      { organizationId, queue, reason },
      "clearinghouse hold alert not dispatched",
    );
  } finally {
    dispatching.delete(key);
  }
}

/**
 * Hold the job (moved back to delayed, no attempt spent) and raise the once-per-window alert. Always throws {@link DelayedError}.
 * `reason` is the unbound reason, or the code of the typed refusal when the org's binding could not be resolved at all.
 */
export async function holdJobWhileUnbound(input: {
  readonly deps: AlertDeps;
  readonly job: HoldableJob;
  readonly token: string | undefined;
  readonly queue: string;
  readonly organizationId: string;
  readonly reason: string;
  /** Default `warn`; a CMS-deadline notice is `critical`. */
  readonly severity?: HoldAlertSeverity;
  readonly now?: () => number;
}): Promise<never> {
  const { deps, job, token, queue, organizationId, reason } = input;
  const at = (input.now ?? Date.now)();
  await alertOncePerWindow(deps, {
    queue,
    organizationId,
    reason,
    severity: input.severity ?? "warn",
    at,
  });
  await job.moveToDelayed(at + CLAIMS_BILLING_HOLD_MS, token);
  throw new DelayedError();
}

/**
 * A SHARED cron (ack pull) could not resolve ONE organization's clearinghouse (its sealed credential cannot be opened, its config
 * read failed). Reported for that organization (a log line and the same once-per-window alert, `reason` = the error code or class,
 * never a message) so the tick carries on: failing it would retry the job into the DLQ for every other tenant.
 */
export async function reportClearinghouseUnresolved(
  deps: AlertDeps,
  input: {
    readonly queue: string;
    readonly organizationId: string;
    readonly code: string;
    readonly now?: () => number;
  },
): Promise<void> {
  const { queue, organizationId, code } = input;
  deps.logger?.error(
    { organizationId, queue, code },
    "clearinghouse could not be resolved for this organization; the shared job carries on without it",
  );
  await alertOncePerWindow(deps, {
    queue,
    organizationId,
    reason: code,
    severity: "warn",
    at: (input.now ?? Date.now)(),
  });
}
