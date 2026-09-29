// apps/backend/src/modules/12-dosespot/consumers/sync-trigger-queue-adapters.ts — the real
// `PatientSyncEnqueuePort` / `MedHxFetchEnqueuePort` implementations for `./sync-trigger-bindings.ts`,
// backed by the durable `dosespot_sync_queue` table (`../jobs/repository.ts`) rather than a raw BullMQ
// `Queue.add()`. See `../jobs/index.ts`'s header for why the DB-table queue was chosen over pure BullMQ
// (debounce across DIFFERENT trigger events for the same patient, atomic with the outbox delivery).
//
// Each `enqueue()` call opens its OWN `withOrgContext` transaction — the outbox dispatcher's `handle()`
// call for a consumer binding is not itself wrapped in the delivering transaction (see
// `bootstrap/outbox-dispatcher.ts`), so this is the same shape `12-dosespot/jobs/worker.ts`'s drain uses,
// not a nested-transaction hazard.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { DosespotSyncQueueRepository } from "../jobs/repository";
import type {
  AdmissionIdForElectionPeriodPort,
  MedHxFetchEnqueuePort,
  MedHxFetchJob,
  PatientSyncEnqueuePort,
  PatientSyncJob,
} from "./sync-trigger-bindings";

/** §3.3 — a worker/consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** Real `PatientSyncEnqueuePort`: writes a debounced `kind: 'patient_sync'` row. */
export function createDrizzlePatientSyncEnqueuePort(db: DbClient): PatientSyncEnqueuePort {
  return {
    async enqueue(job: PatientSyncJob): Promise<{ readonly jobId: string }> {
      return withOrgContext(
        db,
        { organizationId: job.organizationId, userId: CONSUMER_USER_ID },
        async (tx) => {
          const repo = new DosespotSyncQueueRepository(tx as DbClient);
          const { row } = await repo.enqueue({
            organizationId: job.organizationId,
            kind: "patient_sync",
            reason: job.reason,
            patientId: job.patientId,
            invalidateRxBenefitCache: job.invalidateRxBenefitCache,
            triggeringEventOutboxId: job.sourceEventId,
          });
          return { jobId: row.id };
        },
      );
    },
  };
}

/** Real `MedHxFetchEnqueuePort`: writes a debounced `kind: 'medhx_fetch'` row. */
export function createDrizzleMedHxFetchEnqueuePort(db: DbClient): MedHxFetchEnqueuePort {
  return {
    async enqueue(job: MedHxFetchJob): Promise<{ readonly jobId: string }> {
      return withOrgContext(
        db,
        { organizationId: job.organizationId, userId: CONSUMER_USER_ID },
        async (tx) => {
          const repo = new DosespotSyncQueueRepository(tx as DbClient);
          const { row } = await repo.enqueue({
            organizationId: job.organizationId,
            kind: "medhx_fetch",
            reason: job.reason,
            patientId: job.patientId,
            admissionId: job.admissionId,
            triggeringEventOutboxId: job.sourceEventId,
          });
          return { jobId: row.id };
        },
      );
    },
  };
}

/** M6's `electionPeriodContextForOrg` seam, injected as a port — M12's manifest `dependsOn` is
 *  `[1, 5, 11, 38, 40]` (no 6), so this cannot be imported directly (`arch:boundaries` refuses it — an
 *  earlier draft of this file did exactly that and was caught). The composition root imports M6's seam
 *  function directly (only a feature module's own code is boundary-restricted) and passes it in, the
 *  `bereavementPlanSitingForOrg` / `dosespotSyncDemographicsForOrg` shape. */
export type ElectionPeriodContextForOrg = (
  db: DbClient,
  organizationId: string,
  electionPeriodId: string,
) => Promise<{ readonly admissionId: string } | null>;

/**
 * Real `AdmissionIdForElectionPeriodPort`: resolves `m6.cti.signed`'s missing `admissionId` through M6's
 * own org-explicit `electionPeriodContextForOrg` seam (the F-106 `admissionSchedulingContextForOrg`
 * sibling), injected as a port rather than imported (see the file header).
 */
export function createDrizzleAdmissionIdForElectionPeriodPort(
  db: DbClient,
  electionPeriodContextForOrg: ElectionPeriodContextForOrg,
): AdmissionIdForElectionPeriodPort {
  return {
    async resolve(organizationId: string, electionPeriodId: string): Promise<string | null> {
      const context = await electionPeriodContextForOrg(db, organizationId, electionPeriodId);
      return context?.admissionId ?? null;
    },
  };
}
