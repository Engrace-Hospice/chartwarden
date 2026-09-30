// apps/backend/src/modules/12-dosespot/consumers/sync-trigger-bindings.ts — the six §2.6 D4 / §2.8 D10 LIVE
// `OutboxConsumerBinding`s for M12's patient-sync + MedHx-fetch triggers (F-16x, #248).
//
// WHAT WAS MISSING. `decidePatientSyncTrigger` / `decideMedHxFetch` (`./sync-triggers.ts`) are complete,
// pure, unit-tested decision cores; `M12_OUTBOX_SUBSCRIPTIONS` (`./index.ts`) has named all six consumer
// names (`m12.patient-sync-created` / `-updated` / `-address-changed` / `-payer-changed` /
// `m12.admission-activated-medhx` / `m12.recertification-medhx`) since it was written; and all six source
// events already declare `m12` in their catalogs (F-143, `events-by-m5.ts` / `events-by-m6.ts`). Nothing
// ever bound any of the six to a live `OutboxConsumerBinding` — no file existed to do it, and M12 had no
// job-queue infrastructure at all for either trigger to enqueue onto (see `../jobs/`, added alongside this
// file). Each binding here does exactly one thing: parse the source module's OWN catalogued payload shape
// (never import M5/M6's schema — string-literal event names + a hand-typed payload subset, mirroring every
// sibling binding in this module), run the matching pure decider, and — when the decider says to — enqueue
// via the injected {@link PatientSyncEnqueuePort} / {@link MedHxFetchEnqueuePort}.
//
// QUEUE BACKEND (reconciled from two independent concurrent builds of this same tier, #248). The real
// implementation of both ports is `./sync-trigger-queue-adapters.ts`, which writes a debounced row into
// `dosespot_sync_queue` (`../jobs/repository.ts`'s `DosespotSyncQueueRepository`, INSIDE the delivering
// `withOrgContext` transaction) rather than a raw BullMQ `Queue.add()` — chosen over pure BullMQ because a
// Postgres partial-unique index can collapse TWO DIFFERENT trigger events for the same patient arriving
// close together (e.g. `.created` then `.updated` seconds apart) onto one pending row, which a BullMQ
// `jobId` dedupe cannot do (that only catches an exact redelivery of the SAME event) — see
// `../jobs/index.ts`'s header and `m12-sync-triggers.live.test.ts`. `../jobs/worker.ts`'s scheduled drain
// (not this binding layer) is what actually calls the DoseSpot vendor client.
//
// `m6.cti.signed`'S PAYLOAD GAP (recertification MedHx). `AdmissionMedHxPayload` needs `admissionId`, but
// `m6.cti.signed`'s catalogued payload (`events-by-m6.ts`) carries `ctiId` / `electionPeriodId` / `signedAt`
// / `patientId` — no `admissionId`. M12's manifest `dependsOn` is `[1, 5, 11, 38, 40]`: M6 is NOT a declared
// dependency, so this binding may not import M6's schema or read an M6-owned table directly, and building a
// new M6-owned org-explicit seam (the `admissionSchedulingContextForOrg` shape) is a change to a module
// outside this task's file-ownership scope (`06-admission/`). `admissionIdForElectionPeriod` is therefore an
// INJECTED port, defaulted to a documented lazy-unbound implementation (RULE 4 — never throws at
// construction, only a real `m6.cti.signed` delivery does). The other five bindings need no such port: every
// other source payload already carries everything `decidePatientSyncTrigger` / `decideMedHxFetch` reads.
// See the coordinator handoff for the two ways to close this (payload-widen `m6.cti.signed` to carry
// `admissionId` directly — the F-146 `evvMissingReason` precedent, the cheaper fix — or add M6 to M12's
// `dependsOn` and build a real M6-side org-explicit seam).
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type AdmissionMedHxPayload,
  type PatientChangedPayload,
  decideMedHxFetch,
  decidePatientSyncTrigger,
} from "./sync-triggers";

/** The job this binding layer hands to whichever queue backend implements {@link PatientSyncEnqueuePort} —
 *  today `./sync-trigger-queue-adapters.ts`'s `DosespotSyncQueueRepository`-backed adapter. `reason` mirrors
 *  the branch that decided to enqueue, so the backend can stamp `dosespot_sync_queue.reason` without
 *  re-deriving it. */
export interface PatientSyncJob {
  readonly organizationId: string;
  readonly patientId: string;
  readonly reason: "created" | "updated" | "address_changed" | "payer_changed";
  readonly invalidateRxBenefitCache: boolean;
  readonly sourceEventId: string;
}

/** The job this binding layer hands to whichever queue backend implements {@link MedHxFetchEnqueuePort}. */
export interface MedHxFetchJob {
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly reason: "admission_activated" | "recertification";
  readonly sourceEventId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, field: string, consumerName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${consumerName}: payload.${field} must be a non-empty string`);
  }
  return value;
}
function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

export interface PatientSyncEnqueuePort {
  enqueue(job: PatientSyncJob): Promise<{ readonly jobId: string }>;
}
export interface MedHxFetchEnqueuePort {
  enqueue(job: MedHxFetchJob): Promise<{ readonly jobId: string }>;
}

/** §2.8 D10 — resolve the admission a `m6.cti.signed` delivery's `electionPeriodId` belongs to. See the
 *  file header for why this is a port rather than a direct M6 read. */
export interface AdmissionIdForElectionPeriodPort {
  resolve(organizationId: string, electionPeriodId: string): Promise<string | null>;
}
export function unboundAdmissionIdForElectionPeriod(): AdmissionIdForElectionPeriodPort {
  return {
    async resolve(): Promise<string | null> {
      throw new Error(
        "m12.recertification-medhx: no seam resolves an election period's admission id — M6 is not in " +
          "M12's dependsOn (architecture/module-manifest.ts). Needs either a payload-widen of " +
          "m6.cti.signed to carry admissionId directly, or a new M6-owned org-explicit seam + a dependsOn " +
          "edge. See consumers/sync-trigger-bindings.ts's file header.",
      );
    },
  };
}

export interface SyncTriggerBindingDeps {
  readonly patientSync: PatientSyncEnqueuePort;
  readonly medHxFetch: MedHxFetchEnqueuePort;
  /** Defaults to the lazy-unbound port above — only the `m12.recertification-medhx` binding uses it. */
  readonly admissionIdForElectionPeriod?: AdmissionIdForElectionPeriodPort;
}

function buildPatientChangedPayload(
  payload: unknown,
  consumerName: string,
  extra?: { readonly changedField?: string },
): PatientChangedPayload {
  if (!record(payload)) throw new Error(`${consumerName}: payload must be an object`);
  const patientId = requiredString(payload.patientId, "patientId", consumerName);
  const organizationId = requiredString(payload.organizationId, "organizationId", consumerName);
  const changedFields = extra?.changedField
    ? optionalStringArray(payload[extra.changedField])
    : undefined;
  return { organizationId, patientId, ...(changedFields ? { changedFields } : {}) };
}

/** `m5.patient.created` → always syncs (§2.6). */
export function buildM12PatientSyncCreatedConsumer(deps: SyncTriggerBindingDeps): OutboxConsumerBinding {
  const consumerName = "m12.patient-sync-created";
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m5.patient.created"],
    async handle(event) {
      const payload = buildPatientChangedPayload(event.payload, consumerName);
      const action = decidePatientSyncTrigger("created", payload);
      if (!action.enqueueSync) return;
      await deps.patientSync.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        reason: "created",
        invalidateRxBenefitCache: action.invalidateRxBenefitCache,
        sourceEventId: event.id,
      });
    },
  };
}

/** `m5.patient.updated` → syncs only when a DoseSpot-relevant field changed (§2.6 D4). */
export function buildM12PatientSyncUpdatedConsumer(deps: SyncTriggerBindingDeps): OutboxConsumerBinding {
  const consumerName = "m12.patient-sync-updated";
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m5.patient.updated"],
    async handle(event) {
      const payload = buildPatientChangedPayload(event.payload, consumerName, { changedField: "changed" });
      const action = decidePatientSyncTrigger("updated", payload);
      if (!action.enqueueSync) return;
      await deps.patientSync.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        reason: "updated",
        invalidateRxBenefitCache: action.invalidateRxBenefitCache,
        sourceEventId: event.id,
      });
    },
  };
}

/** `m5.patient.address_changed` → always syncs (§2.6). */
export function buildM12PatientSyncAddressChangedConsumer(
  deps: SyncTriggerBindingDeps,
): OutboxConsumerBinding {
  const consumerName = "m12.patient-sync-address-changed";
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m5.patient.address_changed"],
    async handle(event) {
      const payload = buildPatientChangedPayload(event.payload, consumerName);
      const action = decidePatientSyncTrigger("address_changed", payload);
      if (!action.enqueueSync) return;
      await deps.patientSync.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        reason: "address_changed",
        invalidateRxBenefitCache: action.invalidateRxBenefitCache,
        sourceEventId: event.id,
      });
    },
  };
}

/** `m5.patient.payer_changed` → syncs AND invalidates the RxBenefit cache (§2.6). */
export function buildM12PatientSyncPayerChangedConsumer(
  deps: SyncTriggerBindingDeps,
): OutboxConsumerBinding {
  const consumerName = "m12.patient-sync-payer-changed";
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m5.patient.payer_changed"],
    async handle(event) {
      const payload = buildPatientChangedPayload(event.payload, consumerName);
      const action = decidePatientSyncTrigger("payer_changed", payload);
      if (!action.enqueueSync) return;
      await deps.patientSync.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        reason: "payer_changed",
        invalidateRxBenefitCache: action.invalidateRxBenefitCache,
        sourceEventId: event.id,
      });
    },
  };
}

/** `m6.admission.activated` → always fetches MedHx (§2.8 D10). Both `patientId`/`admissionId` are on the
 *  catalogued payload directly — no resolver needed. */
export function buildM12AdmissionActivatedMedHxConsumer(
  deps: SyncTriggerBindingDeps,
): OutboxConsumerBinding {
  const consumerName = "m12.admission-activated-medhx";
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m6.admission.activated"],
    async handle(event) {
      if (!record(event.payload)) throw new Error(`${consumerName}: payload must be an object`);
      const payload: AdmissionMedHxPayload = {
        organizationId: event.organizationId,
        patientId: requiredString(event.payload.patientId, "patientId", consumerName),
        admissionId: requiredString(event.payload.admissionId, "admissionId", consumerName),
      };
      const action = decideMedHxFetch("admission_activated", payload);
      await deps.medHxFetch.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        admissionId: action.admissionId,
        reason: action.reason,
        sourceEventId: event.id,
      });
    },
  };
}

/** `m6.cti.signed` → always fetches MedHx (§2.8 D10) — the recertification pull. See the file header for
 *  the `admissionId` resolution gap. */
export function buildM12RecertificationMedHxConsumer(deps: SyncTriggerBindingDeps): OutboxConsumerBinding {
  const consumerName = "m12.recertification-medhx";
  const admissionIdForElectionPeriod =
    deps.admissionIdForElectionPeriod ?? unboundAdmissionIdForElectionPeriod();
  return {
    consumerName,
    consumerModule: "m12",
    eventTypes: ["m6.cti.signed"],
    async handle(event) {
      if (!record(event.payload)) throw new Error(`${consumerName}: payload must be an object`);
      const patientId = requiredString(event.payload.patientId, "patientId", consumerName);
      const electionPeriodId = requiredString(
        event.payload.electionPeriodId,
        "electionPeriodId",
        consumerName,
      );
      const admissionId = await admissionIdForElectionPeriod.resolve(event.organizationId, electionPeriodId);
      if (admissionId === null) return; // no such election period under this org — safe no-op
      const payload: AdmissionMedHxPayload = { organizationId: event.organizationId, patientId, admissionId };
      const action = decideMedHxFetch("recertification", payload);
      await deps.medHxFetch.enqueue({
        organizationId: event.organizationId,
        patientId: action.patientId,
        admissionId: action.admissionId,
        reason: action.reason,
        sourceEventId: event.id,
      });
    },
  };
}

/** Every §2.6/§2.8 sync-trigger `OutboxConsumerBinding` this pass adds. */
export function buildM12SyncTriggerConsumers(deps: SyncTriggerBindingDeps): OutboxConsumerBinding[] {
  return [
    buildM12PatientSyncCreatedConsumer(deps),
    buildM12PatientSyncUpdatedConsumer(deps),
    buildM12PatientSyncAddressChangedConsumer(deps),
    buildM12PatientSyncPayerChangedConsumer(deps),
    buildM12AdmissionActivatedMedHxConsumer(deps),
    buildM12RecertificationMedHxConsumer(deps),
  ];
}
