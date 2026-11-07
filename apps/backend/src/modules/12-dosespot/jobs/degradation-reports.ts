// apps/backend/src/modules/12-dosespot/jobs/degradation-reports.ts — the two ways a tenant's signed orders can wait with nobody told,
// each raised ONCE per episode (and its clearing once) through the existing `m12.dosespot_degraded` / `m12.dosespot_recovered` events
// (the M36 alert path the circuit breaker already uses; `lastErrorClass` names which):
//   config_unavailable   the org's DoseSpot config could not be read or opened (a database, key-ring, KEK or credential fault). The
//                        transmit pass skips the org entirely until it can, so this alert is the only thing that says why.
//   queued_orders_stale  signed orders have sat in `queued_for_transmission` longer than {@link QUEUED_ORDER_ALERT_AGE_MS}, whatever
//                        the reason (a deactivated registration, a fault, an outage): "queued ones wait" must not mean "forever".
// Publishing is best effort and never fails a tick: a failed publish un-raises the episode so the next tick tries again.
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

/** Raise `kind` for `org`: an alert on the first report of an episode, nothing on the rest. */
export async function reportDegradation(
  deps: M12CronDeps,
  org: string,
  kind: DegradationKind,
): Promise<void> {
  const key = keyOf(kind, org);
  if (!deps.episodes?.raise(key)) return;
  try {
    await publish(deps, org, kind, "opened");
  } catch (cause) {
    deps.episodes.clear(key); // not alerted: let the next tick try again
    deps.warn?.(
      { organizationId: org, kind, cause: cause instanceof Error ? cause.name : "unknown" },
      "M12 degradation alert could not be published",
    );
  }
}

/** End the episode for `org` (an event only when one was open). */
export async function reportRecovery(
  deps: M12CronDeps,
  org: string,
  kind: DegradationKind,
): Promise<void> {
  if (!deps.episodes?.clear(keyOf(kind, org))) return;
  try {
    await publish(deps, org, kind, "closed");
  } catch (cause) {
    deps.warn?.(
      { organizationId: org, kind, cause: cause instanceof Error ? cause.name : "unknown" },
      "M12 recovery event could not be published",
    );
  }
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
