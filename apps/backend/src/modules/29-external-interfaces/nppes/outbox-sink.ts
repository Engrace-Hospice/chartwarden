// apps/backend/src/modules/29-external-interfaces/nppes/outbox-sink.ts — the boot-side `NppesOutboxSink`
// (GAP-045). Bridges the orchestrator's pure `{ name, payload }` descriptors to the M1 transactional
// outbox.
//
// PLATFORM-WIDE (organization_id IS NULL). NPPES is one public directory shared by every tenant: a
// provider_synced event does not belong to any single org, and fanning the same registry fact out per-org
// would multiply one platform record into N identical tenant rows. The M1 publisher already routes a null
// `organizationId` through the migration-0186 SECURITY DEFINER insert, so this needs no new infrastructure.
//
// DELIVERY (was the load-bearing limit here; CLOSED by GAP-099). When this sink was written the boot
// dispatcher's `pollPlatform()` pass could CLAIM and finalize platform rows but not DELIVER them: the
// `OutboxConsumerBinding`/`DispatchableOutboxEvent` pair is non-null-organizationId by design (~150
// org-scoped bindings depend on it) and no platform equivalent existed, so M40's
// `m40.nppes-provider-synced-applier` could not receive these events and every row sat `pending` with
// `last_error = 'deferred: one or more declared consumers are not live'` — durable and honestly reported,
// but never acted on. GAP-099 built the missing three pieces (`PlatformOutboxConsumerBinding`, the
// migration-0201 org-less receipt path, and the migration-0202 `mdm_canonical_writer_*` functions that
// gave M40's canonical a write path at all), and both appliers are now live. `declaredConsumers: ["m40"]`
// was the correct declaration throughout — declaring `[]` to make the rows dispatch immediately would
// have made `buildOutboxRoutingPlan` THROW at boot the day M40's binding landed.
//
// Each publish opens its OWN transaction. The orchestrator is a long walk over thousands of NPIs; holding
// one transaction across the whole run would pin a connection for its duration and lose every event on a
// single late failure. The `nppes_sync_run` row is the run's atomic unit of recovery, not the outbox batch.
import type { DbClient } from "@wardenx/db";
import type { NppesOutboxEvent, NppesOutboxSink } from "./sync-events";

/**
 * The transactional-outbox publish port the composition root binds (the `OutboxPublishPort` shape from
 * `apps/backend/src/bootstrap/outbox-persister.ts`, restated locally so this module takes no bootstrap
 * import edge).
 */
export interface NppesOutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: unknown;
      readonly organizationId: string | null;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The `aggregate_id` each NPPES event is keyed on. An NPI is not a uuid, so a provider event keys on its
 *  run instead — the run id is the aggregate a platform sync actually mutates, and `outbox_event
 *  .aggregate_id` is a NOT NULL uuid column. The NPI itself travels in the payload, where M40 reads it. */
function aggregateIdOf(event: NppesOutboxEvent, syncRunId: string): string {
  return event.name === "m29.nppes.provider_synced" ? event.payload.syncRunId : syncRunId;
}

export interface NppesOutboxSinkDeps {
  readonly db: DbClient;
  readonly outbox: NppesOutboxPublishPort;
  /** The run this sink is publishing for — the aggregate id every event is keyed on. */
  readonly syncRunId: string;
}

/** Build the {@link NppesOutboxSink} the orchestrator publishes its five §4.10 events through. */
export function buildNppesOutboxSink(deps: NppesOutboxSinkDeps): NppesOutboxSink {
  return {
    async publish(event: NppesOutboxEvent): Promise<void> {
      await deps.db.transaction(async (tx) => {
        await deps.outbox.publish(tx as unknown as DbClient, {
          eventName: event.name,
          payload: event.payload,
          organizationId: null,
          aggregateKind: "nppes_sync_run",
          aggregateId: aggregateIdOf(event, deps.syncRunId),
        });
      });
    },
  };
}
