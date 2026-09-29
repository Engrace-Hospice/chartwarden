// apps/backend/src/modules/12-dosespot/jobs/index.ts — barrel for the `dosespot_sync_queue` job tier
// (M12 `handlers-unbound` group, #248).
//
// Reconciled from two independent concurrent builds of this same tier: a durable Postgres debounce table
// (this barrel) and a pure-BullMQ `jobId`-dedup mechanism. The table wins as the queue backend — its
// partial-unique `dosespot_sync_queue_pending_uq` (`@wardenx/db`'s `schema.dosespotSyncQueue`) collapses
// TWO DIFFERENT trigger events for the same patient arriving close together (e.g. `.created` then
// `.updated` seconds apart) onto one pending row, which a BullMQ `jobId: sourceEventId` dedupe cannot do
// (that only catches an exact redelivery of the SAME event) — proven by `m12-sync-triggers.live.test.ts`.
// The other build's event-ingestion binding layer (`../consumers/sync-trigger-bindings.ts` — parsing each
// of the six source payloads + running the pure `decidePatientSyncTrigger`/`decideMedHxFetch` deciders +
// the injected-port pattern for `m6.cti.signed`'s missing `admissionId`) is kept as-is, repointed at this
// barrel's `DosespotSyncQueueRepository` instead of a raw BullMQ `Queue.add()`
// (`../consumers/sync-trigger-queue-adapters.ts`).
export { type DosespotSyncQueueKind, type DosespotSyncQueueReason, type DosespotSyncQueueRow } from "@wardenx/db/schema";
export { type EnqueueInput, type EnqueueResult, DosespotSyncQueueRepository } from "./repository";
export {
  M12DosespotPatientIdUnbound,
  type DosespotPatientIdResolver,
  type DosespotSyncDemographicsForOrg,
  type PatientSyncSnapshotResolver,
  createDrizzlePatientSyncSnapshotResolver,
  createUnboundDosespotPatientIdResolver,
} from "./vendor-boundary";
export {
  type ActiveOrgListPort,
  type DoseSpotSyncWorkerDeps,
  M12_DOSESPOT_SYNC_QUEUE,
  M12_DOSESPOT_SYNC_SCHEDULE,
  registerDoseSpotSyncQueueWorker,
  runDoseSpotSyncQueueDrain,
  scheduleDoseSpotSyncQueueDrain,
} from "./worker";
export { M12_PLATFORM_JOB_ID, wireM12Tenancy } from "./wiring";
