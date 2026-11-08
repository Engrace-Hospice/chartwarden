// apps/backend/src/modules/12-dosespot/jobs/degradation-reports.ts — the two ways a tenant's signed orders can wait with nobody told,
// each raised ONCE per episode (and its clearing once) through the existing `m12.dosespot_degraded` / `m12.dosespot_recovered` events
// (the M36 alert path the circuit breaker already uses; `lastErrorClass` names which):
//   config_unavailable   the org's DoseSpot config could not be read or opened (a database, key-ring, KEK or credential fault). The
//                        transmit pass skips the org entirely until it can, so this alert is the only thing that says why.
//   queued_orders_stale  signed orders have sat in `queued_for_transmission` longer than {@link QUEUED_ORDER_ALERT_AGE_MS}, whatever
//                        the reason (a deactivated registration, a fault, an outage): "queued ones wait" must not mean "forever".
// "Once per episode" is remembered in a store shared by every process (episode-store.ts), so a restart or a second replica does not alert
// again and the process that sees the recovery announces it, after two consecutive clean ticks. Reporting is best effort and never fails a tick:
// each announcement is a short-lived claim confirmed after its event commits, so an unreachable store, a failed publish or a crash delays the
// alert (or the recovery) to a later tick and never drops it. (At-least-once: a crash after the commit announces it twice.)
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, exists, lt, sql } from "drizzle-orm";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;

/** Orders normally leave within a minute of signing; an hour in `queued` is an incident, not backoff. */
export const QUEUED_ORDER_ALERT_AGE_MS = 60 * 60_000;

export type DegradationKind = "config_unavailable" | "queued_orders_stale";

const keyOf = (kind: DegradationKind, org: string): string => `${kind}:${org}`;
const breakerNameOf = (kind: DegradationKind, org: string): string => `dosespot-${kind}:${org}`;

async function publish(
  deps: M12CronDeps,
  org: string,
  kind: DegradationKind,
  edge: "opened" | "closed",
): Promise<void> {
  const at = nowOf(deps).toISOString();
  await inOrg(deps.db, org, (tx) =>
    deps.outbox.publish(tx, {
      eventName: edge === "opened" ? "m12.dosespot_degraded" : "m12.dosespot_recovered",
      payload:
        edge === "opened"
          ? { breakerName: breakerNameOf(kind, org), openedAt: at, lastErrorClass: kind }
          : { breakerName: breakerNameOf(kind, org), closedAt: at },
      organizationId: org,
      aggregateKind: "dosespot_adapter",
      aggregateId: org,
    }),
  );
}

const causeNameOf = (cause: unknown): string => (cause instanceof Error ? cause.name : "unknown");

/**
 * Raise `kind` for `org`: an alert on the first report of an episode (in any process), nothing on the rest. Never throws.
 * The alert is a CLAIM confirmed after the publish commits: an unreachable store, a failed publish, or a crash anywhere in between leaves
 * only a short-lived claim that expires, so the next tick publishes. Late, never lost; a crash AFTER the publish committed but before the
 * confirm announces it twice (see episode-store.ts).
 */
export async function reportDegradation(
  deps: M12CronDeps,
  org: string,
  kind: DegradationKind,
): Promise<void> {
  const episodes = deps.episodes;
  if (!episodes) return;
  const key = keyOf(kind, org);
  const fields = { organizationId: org, kind };
  try {
    if (!(await episodes.raise(key))) return;
  } catch (cause) {
    deps.warn?.(
      { ...fields, cause: causeNameOf(cause) },
      "M12 degradation episode store unavailable; the alert is retried on the next tick",
    );
    return;
  }
  try {
    await publish(deps, org, kind, "opened");
  } catch (cause) {
    deps.warn?.(
      { ...fields, cause: causeNameOf(cause) },
      "M12 degradation alert could not be published",
    );
    // release the claim so the next tick tries at once; if that fails too the claim expires on its own
    await episodes.abortRaise(key).catch(() => undefined);
    return;
  }
  await episodes
    .confirmRaised(key)
    .catch((cause: unknown) =>
      deps.warn?.(
        { ...fields, cause: causeNameOf(cause) },
        "M12 degradation alert was published but the episode could not be confirmed; it may be announced again",
      ),
    );
}

/**
 * End the episode for `org` once it has been clean long enough (an event only when one was open, whichever process opened it). Never
 * throws. Symmetric to {@link reportDegradation}: the recovery is a claim confirmed after its publish commits, so a crash or a failed
 * publish leaves the episode open and the next clean tick announces it.
 */
export async function reportRecovery(
  deps: M12CronDeps,
  org: string,
  kind: DegradationKind,
): Promise<void> {
  const episodes = deps.episodes;
  if (!episodes) return;
  const key = keyOf(kind, org);
  const fields = { organizationId: org, kind };
  try {
    if (!(await episodes.clear(key))) return;
  } catch (cause) {
    deps.warn?.(
      { ...fields, cause: causeNameOf(cause) },
      "M12 degradation episode store unavailable; the recovery is retried on the next tick",
    );
    return;
  }
  try {
    await publish(deps, org, kind, "closed");
  } catch (cause) {
    deps.warn?.(
      { ...fields, cause: causeNameOf(cause) },
      "M12 recovery event could not be published",
    );
    await episodes.abortClear(key).catch(() => undefined);
    return;
  }
  await episodes
    .confirmCleared(key)
    .catch((cause: unknown) =>
      deps.warn?.(
        { ...fields, cause: causeNameOf(cause) },
        "M12 recovery event was published but the episode could not be closed; it may be announced again",
      ),
    );
}

/**
 * The age probe, as a builder so a test can EXPLAIN the very statement that runs. It starts from the queued set
 * (`medication_order_queued_idx`, partial, so a handful of rows however large the table) and asks whether ONE of
 * those orders has a transmission row queued before the cutoff (`mot_order_idx`), instead of joining every
 * transmission row of the tenant to its order. Both organization predicates are explicit so the indexes lead
 * with the tenant column even before RLS adds its own.
 */
export function staleQueuedOrdersQuery(tx: DbClient, org: string, cutoff: Date) {
  return tx
    .select({ id: MO.id })
    .from(MO)
    .where(
      and(
        eq(MO.organizationId, org),
        eq(MO.status, "queued_for_transmission"),
        eq(MO.dosespotSendState, "queued"),
        exists(
          tx
            .select({ one: sql`1` })
            .from(MOT)
            .where(
              and(
                eq(MOT.organizationId, org),
                eq(MOT.medicationOrderId, MO.id),
                lt(MOT.queuedAt, cutoff),
              ),
            ),
        ),
      ),
    )
    .limit(1);
}

/** Alert once when any of the org's signed orders has waited in `queued` past {@link QUEUED_ORDER_ALERT_AGE_MS}; clear when none has. */
export async function runQueuedAgeAlertForOrg(deps: M12CronDeps, org: string): Promise<boolean> {
  const cutoff = new Date(nowOf(deps).getTime() - QUEUED_ORDER_ALERT_AGE_MS);
  const stale = await inOrg(
    deps.db,
    org,
    async (tx) => (await staleQueuedOrdersQuery(tx, org, cutoff)).length > 0,
  );
  if (stale) await reportDegradation(deps, org, "queued_orders_stale");
  else await reportRecovery(deps, org, "queued_orders_stale");
  return stale;
}
