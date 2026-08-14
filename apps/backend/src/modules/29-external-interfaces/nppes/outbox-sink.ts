// apps/backend/src/modules/29-external-interfaces/nppes/outbox-sink.ts — the boot-side `NppesOutboxSink`
// (GAP-045). Bridges the orchestrator's pure `{ name, payload }` descriptors to the M1 transactional
// outbox.
//
// PLATFORM-WIDE (organization_id IS NULL). NPPES is one public directory shared by every tenant: a
// provider_synced event does not belong to any single org, and fanning the same registry fact out per-org
// would multiply one platform record into N identical tenant rows. The M1 publisher already routes a null
// `organizationId` through the migration-0186 SECURITY DEFINER insert, so this needs no new infrastructure.
//
// HONEST LIMIT, RECORDED HERE BECAUSE IT IS LOAD-BEARING: the boot dispatcher's `pollPlatform()` pass can
// CLAIM and finalize platform rows but cannot yet DELIVER them to a consumer — the
// `OutboxConsumerBinding`/`DispatchableOutboxEvent` pair is non-null-organizationId by design (~150
// org-scoped bindings depend on it) and no `PlatformOutboxConsumerBinding` type exists. So M40's
// `m40.nppes-provider-synced-applier` cannot receive these events until that path is built, and the rows
// will sit `pending` with `last_error = 'deferred: one or more declared consumers are not live'` —
// DURABLE and honestly reported, never dropped. That is the pre-existing state of every platform-wide
// event in this system (the `m33.mv.*` rows behave identically today), not something this sink introduces:
// before GAP-045 the sync never ran at all, so there was no row to defer. `declaredConsumers: ["m40"]` on
// the two provider events is the correct declaration regardless — declaring `[]` to make them dispatch
// immediately would make `buildOutboxRoutingPlan` THROW at boot the day M40's binding lands.
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
