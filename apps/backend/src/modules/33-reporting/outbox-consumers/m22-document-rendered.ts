// M33's live `m22.document.rendered` back-ref consumer (§1.1 render handshake, downstream half) — GAP-051.
//
// `packages/reporting/src/scheduled/delivery.ts` has carried the whole downstream half since M33 landed: the
// pure decider (`decideScheduledDelivery`), the thin applier (`applyScheduledDelivery`), the consumer NAME,
// and a `M33_SCHEDULED_DELIVERY_SUBSCRIPTION_DEFERRED = true` flag saying "P2C binds the dispatcher". P2C
// never did, and until GAP-051 there was nothing to bind TO — M22 had no `m22.document.rendered` event at all
// and no consumer for M33's render request either. So `report_schedule_run` occurrences that reached
// `rendered_pending` stayed there forever: the render was requested, never performed, never answered.
//
// This file is the binding, not new logic. It resolves the five `ScheduledDeliveryFacts` under the tenant's
// own `withOrgContext` and hands them to the package's decider.
//
// FAIL-CLOSED / SHARED DISPATCHER: `m22.document.rendered` is one event with several subscribers, so a reply
// whose `aggregateType` is not `report_schedule_run` is a deliberate no-op — the decider's FIRST gate. Note
// M33's OTHER artifact (`report_export`, the ad-hoc "export now" path) is deliberately not handled: there is
// no `report_export` table to stamp, and the rendered document is already reachable by
// `document.(aggregate_type, aggregate_id) = ('report_export', exportId)` — the exportId the 202 handed back.
//
// Event name is a STRING literal; no M22 import, no new `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import {
  type M22DocumentRenderedPayload,
  M22_DOCUMENT_RENDERED,
  M33_SCHEDULED_DELIVERY_CONSUMER_NAME,
  M33_SCHEDULED_REPORT_AGGREGATE_TYPE,
  type ScheduledDeliveryAction,
  applyScheduledDelivery,
  decideScheduledDelivery,
} from "@wardenx/reporting";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const RUN = schema.reportScheduleRun;
const SCHEDULE = schema.reportSchedule;

/** The system actor a background settle writes under (no acting user — the §4.8 worker sentinel). */
const M33_CONSUMER_SYSTEM_USER_ID = "";

export interface M33DocumentBackrefConsumerDeps {
  readonly db: DbClient;
  /**
   * Emits `m33.scheduled_report.delivered` for the §4.9 M36 fan-out. Optional: with no publisher the run is
   * still settled `delivered` with its `document_id` — the ledger is correct either way — and only the
   * notification is skipped. Wiring it is the composition root's call.
   */
  readonly emitDelivered?: (payload: {
    readonly organizationId: string;
    readonly scheduleId: string;
    readonly runId: string;
    readonly documentId: string;
    readonly recipientCount: number;
  }) => Promise<void>;
  /** Overridable clock (the `finished_at` stamp). */
  readonly now?: () => Date;
  /** Structured sink for the non-happy dispositions (a re-delivery, or a run that no longer exists). */
  readonly onDisposition?: (action: ScheduledDeliveryAction) => void;
}

export const M33_DOCUMENT_BACKREF_CONSUMER = {
  eventName: M22_DOCUMENT_RENDERED,
  consumerName: M33_SCHEDULED_DELIVERY_CONSUMER_NAME,
} as const;

export function buildM33DocumentBackrefConsumer(deps: M33DocumentBackrefConsumerDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    consumerName: M33_SCHEDULED_DELIVERY_CONSUMER_NAME,
    consumerModule: "m33" as const,
    eventTypes: [M22_DOCUMENT_RENDERED] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      // The tenant anchor is the OUTBOX ROW's org, never the payload's (the row is the RLS-scoped,
      // dispatcher-verified fact). The decider's payload type carries one, so it is filled from the row.
      const payload: M22DocumentRenderedPayload = {
        organizationId: event.organizationId,
        aggregateType: typeof raw.aggregateType === "string" ? raw.aggregateType : "",
        aggregateId: typeof raw.aggregateId === "string" ? raw.aggregateId : "",
        documentId: typeof raw.documentId === "string" ? raw.documentId : "",
      };
      // Cheap route-out BEFORE opening a transaction: most `m22.document.rendered` rows belong to another
      // module, and the decider would reject them anyway on its first gate.
      if (payload.aggregateType !== M33_SCHEDULED_REPORT_AGGREGATE_TYPE) return;
      if (!payload.aggregateId || !payload.documentId) return;

      const action = await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: M33_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          // The run is read by id ALONE: `report_schedule_run` is partitioned on `scheduled_for`, which is
          // half its composite PK and is precisely what this reply does not carry — the whole point of the
          // lookup is to recover it.
          const [run] = await tx
            .select({
              id: RUN.id,
              scheduledFor: RUN.scheduledFor,
              scheduleId: RUN.scheduleId,
              status: RUN.status,
              documentId: RUN.documentId,
            })
            .from(RUN)
            .where(
              and(eq(RUN.organizationId, event.organizationId), eq(RUN.id, payload.aggregateId)),
            )
            .limit(1);

          const [schedule] = run
            ? await tx
                .select({ recipients: SCHEDULE.recipientMembershipIds })
                .from(SCHEDULE)
                .where(
                  and(
                    eq(SCHEDULE.organizationId, event.organizationId),
                    eq(SCHEDULE.id, run.scheduleId),
                  ),
                )
                .limit(1)
            : [];

          const decided = decideScheduledDelivery(payload, {
            runExists: run !== undefined,
            scheduledFor: run?.scheduledFor ?? null,
            scheduleId: run?.scheduleId ?? null,
            // Idempotency (D14): either terminal state counts. A re-delivery after a crash between the
            // settle and the emit re-stamps the same `document_id`, which changes nothing.
            alreadyDelivered: run?.status === "delivered" || run?.documentId != null,
            recipientCount: schedule?.recipients?.length ?? 0,
          });

          return applyScheduledDelivery(decided, {
            runs: {
              async settleDelivered(runId, scheduledFor, patch) {
                await tx
                  .update(RUN)
                  .set(patch)
                  .where(and(eq(RUN.id, runId), eq(RUN.scheduledFor, scheduledFor)));
              },
            },
            outbox: {
              async emitDelivered(p) {
                await deps.emitDelivered?.(p);
              },
            },
            now,
          });
        },
      );

      if (action.kind !== "apply_delivery") deps.onDisposition?.(action);
    },
  };
}
