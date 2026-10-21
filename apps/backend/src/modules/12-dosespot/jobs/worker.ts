// apps/backend/src/modules/12-dosespot/jobs/worker.ts — the `dosespot_sync_queue` drain worker
// (M12 `handlers-unbound` group, #248).
//
// DATA-PLANE-VS-SCHEDULING-PLANE DECISION (per this pass's own instruction to reason it, not copy the
// nearest file). Two real precedents exist in this codebase for "how does an outbox-triggered fact
// become a background job": M30's F-150 build (`30-quality/outbox-consumers/upstream-consumer-ports.ts`)
// enqueues into a plain Postgres table (`measure_recompute_queue`) with NO BullMQ involved anywhere in
// that path, because "the worker already existed and only needed a producer" — its DRAIN is `m30-jobs.ts`'s
// existing BullMQ `measure_recompute` worker, which polls the table. M11's `jobs/standing-spawn-worker.ts`
// is the opposite shape: a pure hourly BullMQ Queue+Worker with NO Postgres queue table at all, because
// there is nothing to DEBOUNCE — `spawnDueStandingOrders` recomputes "what's due" fresh from
// `standing_order` state on every tick.
//
// This module needs BOTH halves, for two independent reasons. (1) DEBOUNCE NEEDS A DB TABLE, NOT A
// BULLMQ JOB ID: the requirement is "two triggers for the same patient close together collapse onto one
// pending job" — BullMQ's own dedup is a `jobId` string comparison at `.add()` time, which cannot express
// "collapse onto whichever job is still PENDING" once a job has started processing (a `jobId` reused after
// completion just re-adds); a Postgres partial-unique index on `status = 'pending'` expresses exactly the
// state-dependent debounce needed, and DOES SO IN THE SAME TRANSACTION as the outbox delivery — a BullMQ
// `.add()` call cannot participate in the Postgres transaction the outbox dispatcher wraps consumer
// `handle()` calls in, so a crash between "decided" and "`.add()`" could lose the enqueue or (if `.add()`
// succeeds but the surrounding tx then rolls back) leave a BullMQ job for a decision the DB never
// recorded. (2) THE DRAIN DESERVES ITS OWN SCHEDULED WORKER PROCESS, NOT AN INLINE CALL: unlike M30's
// `enqueueRecompute` (a same-process DB write with no network I/O), draining THIS queue means an outbound
// HTTP call to a third-party vendor (DoseSpot) with its own retry/circuit-breaker/backoff policy
// (`@chartwarden/dosespot`'s `client/circuit-breaker.ts` + `retry.ts`) — exactly the "real vendor call
// justifies a distinct worker process" case this pass's own instructions named. So: a Postgres table
// (`./schema.ts`, `./repository.ts`) is the debounced work list the outbox consumers write into
// transactionally (`./sync-trigger-bindings.ts`), and a BullMQ repeatable Queue+Worker (below) is the
// scheduled process that drains it — the `M11_STANDING_SPAWN_QUEUE`/`registerM11StandingSpawnWorker`
// shape, fanning out over active orgs the same way, just polling a debounced table instead of
// recomputing from scratch.
//
// THE VENDOR-CALL BOUNDARY IS HONEST, NOT FABRICATED. `deps.doseSpotClient` defaults to
// `createUnboundDoseSpotClient()` (`@chartwarden/dosespot`) — confirmed no `DOSESPOT_*` env var or HTTP base
// URL exists anywhere in this repository, so building a "working" transport here would fabricate an
// integration that does not exist. Every processed row therefore fails closed with a `DegradedError`
// (`retryable: false`, INT-009's own contract) and is marked `failed` with a clear, structured
// `last_error` — never a fabricated success.
//
// F-230 (#248): everything on OUR side of that boundary is now real and runs only from a real vendor
// response. A successful `upsertPatient` records the vendor id in `dosespot_patient_sync` (+ emits
// `m12.dosespot_patient_synced`); a `medhx_fetch` resolves that id through the REAL
// `createDrizzleDosespotPatientIdResolver` (null -> an honest "no DoseSpot-side patient id is recorded"
// failure, vendor never called), pulls, and folds `ingestPullResult` (`../history/ingest.ts`) in: ledger +
// records + `m12.medication_history_pulled`, one org-scoped tx, idempotent on the queue row id. With the
// unbound client the vendor call rejects and none of that runs — no row, no event. The other edge that
// used to be deferred (resolving the M5 demographic snapshot for a `patient_sync` job) is REAL:
// `createDrizzlePatientSyncSnapshotResolver` is a thin adapter over M5's own org-explicit
// `dosespotSyncDemographicsForOrg` seam, injected as a port (M5's `patient_address`/`patient_phone` are
// not in `check-table-ownership.ts`'s cross-module-read exempt set, so a direct schema read here would
// be a boundary violation even though M5 is a declared dependency) — see `./vendor-boundary.ts`'s header.
import type { DbClient, schema } from "@chartwarden/db";
import {
  type DoseSpotClient,
  buildPatientUpsertPayload,
  createUnboundDoseSpotClient,
  isDegradedError,
  patientSyncIdempotencyKey,
} from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import { ingestMedicationHistoryPull } from "../history/ingest";
import {
  createDrizzleDosespotPatientIdResolver,
  recordPatientSyncFailure,
  recordPatientSyncSuccess,
} from "./patient-sync-store";
import { DosespotSyncQueueRepository } from "./repository";
import { invalidateRxBenefitCacheForPatient } from "./rx-benefit-prewarm";
import {
  type DosespotPatientIdResolver,
  type DosespotSyncDemographicsForOrg,
  type PatientSyncSnapshotResolver,
  createDrizzlePatientSyncSnapshotResolver,
} from "./vendor-boundary";

type DosespotSyncQueueRow = schema.DosespotSyncQueueRow;

export const M12_DOSESPOT_SYNC_QUEUE = "dosespot.sync_queue_drain";
/** Every 2 minutes — this queue is patient-facing (DoseSpot demographic sync + MedHx availability for
 *  prescribing) rather than a nightly aggregate, but not SLA-timed like M20's SOS watchdog either. */
export const M12_DOSESPOT_SYNC_SCHEDULE = "*/2 * * * *";
export const M12_PLATFORM_JOB_ID_LABEL = "m12.dosespot_sync_drain";

/** §3.3 — a worker-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { organizationId: string }[]>;
}

export interface DoseSpotSyncWorkerDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  /** Defaults to the Phase-1 deny-stub — the only implementation that exists anywhere today. */
  readonly doseSpotClient?: DoseSpotClient;
  /** Defaults to the REAL resolver built from `demographicsForOrg` (see `./vendor-boundary.ts`) — not a
   *  deny-stub. Required unless `snapshotResolver` is supplied directly (e.g. a test double). */
  readonly snapshotResolver?: PatientSyncSnapshotResolver;
  /** M5's org-explicit `dosespotSyncDemographicsForOrg` seam, injected as a port — see the file header
   *  for why this cannot be a direct schema read. Used only to build the default `snapshotResolver`. */
  readonly demographicsForOrg?: DosespotSyncDemographicsForOrg;
  /** Defaults to the REAL `dosespot_patient_sync`-backed resolver (F-230, migration 0303): `null` until a
   *  successful `upsertPatient` has recorded the vendor-side id. */
  readonly dosespotPatientIdResolver?: DosespotPatientIdResolver;
  /** Publishes `m12.dosespot_patient_synced` on a real (future) successful upsert. Optional — a missing
   *  port just means the completion event is not announced; the row is still marked completed. */
  readonly outbox?: DoseSpotWriteOutboxPort;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly connection?: ConnectionOptions;
}

/** One claimed row's outcome, processed OUTSIDE any held DB transaction (the vendor call is network I/O;
 *  holding a Postgres lock across it would serialize the whole org's queue behind the slowest call). */
async function processRow(deps: DoseSpotSyncWorkerDeps, row: DosespotSyncQueueRow): Promise<void> {
  const doseSpotClient = deps.doseSpotClient ?? createUnboundDoseSpotClient();
  const snapshotResolver =
    deps.snapshotResolver ??
    createDrizzlePatientSyncSnapshotResolver(
      deps.demographicsForOrg ??
        (() => {
          throw new Error(
            "DoseSpotSyncWorkerDeps: neither snapshotResolver nor demographicsForOrg was supplied — the " +
              "composition root must inject M5's dosespotSyncDemographicsForOrg seam (see ./vendor-boundary.ts)",
          );
        }),
    );
  const dosespotPatientIdResolver =
    deps.dosespotPatientIdResolver ?? createDrizzleDosespotPatientIdResolver(deps.db);
  const now = deps.now ?? (() => new Date());

  let outcome:
    | { kind: "completed" }
    | { kind: "failed"; error: string }
    | { kind: "requeue"; error: string };
  let errorClass = "unknown";
  try {
    if (row.kind === "patient_sync") {
      const snapshot = await snapshotResolver.resolve(row.organizationId, row.patientId);
      if (snapshot === null) {
        // Genuinely no such patient under this org any more — nothing to sync, not a failure.
        outcome = { kind: "completed" };
      } else {
        // GAP-037 — a patient already known to DoseSpot is EDITED, never re-created (no duplicate chart).
        const knownDosespotPatientId = await dosespotPatientIdResolver.resolve(
          row.organizationId,
          row.patientId,
        );
        const payload = {
          ...buildPatientUpsertPayload(snapshot),
          ...(knownDosespotPatientId ? { existingDosespotPatientId: knownDosespotPatientId } : {}),
        };
        const idempotencyKey = patientSyncIdempotencyKey(row.patientId, snapshot.updatedAt);
        // Reached (past this point) only once the vendor client is real — today it always throws here.
        const response = await doseSpotClient.upsertPatient(
          row.organizationId,
          payload,
          idempotencyKey,
        );
        const outboxPort = deps.outbox;
        // §2.6 "on success": record the vendor-returned id (the ONLY writer of `dosespot_patient_sync`'s
        // id — reached only with a real `upsertPatient` response) and announce it in the SAME tx.
        await withOrgContext(
          deps.db,
          { organizationId: row.organizationId, userId: CONSUMER_USER_ID },
          async (tx) => {
            await recordPatientSyncSuccess(tx as DbClient, {
              organizationId: row.organizationId,
              patientId: row.patientId,
              dosespotPatientId: response.dosespotPatientId,
              syncedAt: new Date(response.upsertedAt),
            });
            if (outboxPort) {
              await outboxPort.publish(tx, {
                eventName: "m12.dosespot_patient_synced",
                organizationId: row.organizationId,
                aggregateKind: "patient",
                aggregateId: row.patientId,
                payload: {
                  patientId: row.patientId,
                  dosespotPatientId: response.dosespotPatientId,
                  syncedAt: response.upsertedAt,
                },
              });
            }
          },
        );
        if (row.invalidateRxBenefitCache) {
          // GAP-037 — demographics / payer changed: the cached coverage may no longer be true, so drop it
          // (the prewarm cron repopulates). Same org scope, after the id is recorded.
          await withOrgContext(
            deps.db,
            { organizationId: row.organizationId, userId: CONSUMER_USER_ID },
            (tx) =>
              invalidateRxBenefitCacheForPatient(tx as DbClient, row.organizationId, row.patientId),
          );
        }
        outcome = { kind: "completed" };
      }
    } else {
      const dosespotPatientId = await dosespotPatientIdResolver.resolve(
        row.organizationId,
        row.patientId,
      );
      if (dosespotPatientId === null) {
        outcome = {
          kind: "failed",
          error:
            "no DoseSpot-side patient id is recorded for this patient — the prior patient-sync has not succeeded yet",
        };
      } else {
        if (!deps.outbox) {
          // Persisting a pull without announcing it would leave `m12.medication_history_pulled` silent; the
          // composition root always injects the publisher, so a missing port is a wiring error, not a skip.
          throw new Error(
            "DoseSpotSyncWorkerDeps.outbox is required to ingest a MedicationHistory pull (F-230)",
          );
        }
        // §2.8 D10: pull the last 12 months. Reached only with a real vendor client; today the unbound
        // deny-stub rejects here and nothing below runs (no row, no event).
        const sinceDate = new Date(now());
        sinceDate.setUTCMonth(sinceDate.getUTCMonth() - 12);
        const result = await doseSpotClient.pullMedicationHistory(row.organizationId, {
          dosespotPatientId,
          sinceDate: sinceDate.toISOString().slice(0, 10),
        });
        // `ingestPullResult` (spec §4.3): persist ledger + records and emit `m12.medication_history_pulled`
        // in one org-scoped tx — only from this REAL pull result; idempotent on the queue row id.
        const outboxPort = deps.outbox;
        await withOrgContext(
          deps.db,
          { organizationId: row.organizationId, userId: CONSUMER_USER_ID },
          (tx) =>
            ingestMedicationHistoryPull(tx as DbClient, outboxPort, {
              organizationId: row.organizationId,
              patientId: row.patientId,
              dosespotPatientId,
              sourceJobId: row.id,
              result,
            }),
        );
        outcome = { kind: "completed" };
      }
    }
  } catch (error) {
    errorClass = isDegradedError(error)
      ? error.retryable
        ? "degraded_retryable"
        : "degraded_non_retryable"
      : error instanceof Error
        ? error.name
        : "unknown";
    if (isDegradedError(error)) {
      outcome = error.retryable
        ? { kind: "requeue", error: error.customerMessage }
        : { kind: "failed", error: error.customerMessage };
    } else if (error instanceof Error) {
      // `./vendor-boundary.ts`'s `M12DosespotPatientIdUnbound` (medhx_fetch's still-deferred edge) lands
      // here — deterministic, non-retryable, honestly reported.
      outcome = { kind: "failed", error: error.message };
    } else {
      outcome = { kind: "failed", error: String(error) };
    }
  }

  await withOrgContext(
    deps.db,
    { organizationId: row.organizationId, userId: CONSUMER_USER_ID },
    async (tx) => {
      const repo = new DosespotSyncQueueRepository(tx as DbClient);
      if (outcome.kind === "completed") await repo.markCompleted(row.id, now());
      else if (outcome.kind === "failed") await repo.markFailed(row.id, outcome.error, now());
      else await repo.requeue(row.id, outcome.error);
      // §2.6 "on failure": record the sync outcome + bump `retry_count` (no id is ever invented).
      if (row.kind === "patient_sync" && outcome.kind !== "completed") {
        await recordPatientSyncFailure(tx as DbClient, {
          organizationId: row.organizationId,
          patientId: row.patientId,
          errorClass,
          at: now(),
        });
      }
    },
  );
}

/**
 * One drain tick: fan out over every active org, claim its pending rows (`FOR UPDATE SKIP LOCKED`,
 * `./repository.ts`), and process each outside the claiming transaction. One org's failure does not stop
 * the others (`M11_STANDING_SPAWN`/`M20 SOS watchdog` precedent — `AggregateError` at the end).
 */
export async function runDoseSpotSyncQueueDrain(deps: DoseSpotSyncWorkerDeps): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      const claimed = await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (tx) => {
          const repo = new DosespotSyncQueueRepository(tx as DbClient);
          return repo.claimBatchForOrg(
            organizationId,
            deps.batchSize ?? 25,
            deps.now?.() ?? new Date(),
          );
        },
      );
      for (const row of claimed) {
        await processRow(deps, row);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `M12_DOSESPOT_SYNC_DRAIN: ${failures.length} org failure(s)`,
    );
}

export function registerDoseSpotSyncQueueWorker(deps: DoseSpotSyncWorkerDeps): Worker {
  if (!deps.connection) throw new Error("registerDoseSpotSyncQueueWorker: connection is required");
  return new Worker(M12_DOSESPOT_SYNC_QUEUE, async () => runDoseSpotSyncQueueDrain(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleDoseSpotSyncQueueDrain(
  connection: ConnectionOptions,
): Promise<Queue> {
  const queue = new Queue(M12_DOSESPOT_SYNC_QUEUE, { connection });
  await queue.add(
    "drain",
    {},
    {
      repeat: { pattern: M12_DOSESPOT_SYNC_SCHEDULE },
      jobId: "m12-dosespot-sync-drain",
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
