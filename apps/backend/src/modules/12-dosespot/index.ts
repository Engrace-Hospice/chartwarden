// apps/backend/src/modules/12-dosespot — M12 (DoseSpot Integration) backend module surface.
//
// M12-T07 lands the two §2.10 D17 owned seams (MedicationOrderProvider — the medication-order read path
// M13/M14/M19/M28/M30/M31/M33 consume — + RefillInboxProvider — the refill-inbox read path the prescriber UI
// and M19/M33 consume) registered into the M1 registry via `registerDoseSpotSeams` (driven from the
// composition root's wireModuleSeams()).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerDoseSpotAbacPredicates as _registerM12Abac } from "./abac-predicates";
import { type DoseSpotWriteOutboxPort, createDbDoseSpotBackend } from "./dosespot-route-service-db";
import { registerDoseSpotRoutes as _registerM12Routes } from "./routes/dosespot-routes";

/**
 * M12L — mount the M12 DoseSpot routes over the PRODUCTION Drizzle backend (service + §4.7 ABAC resolver in
 * one object, RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads + the
 * full write lifecycle are live over Drizzle+RLS; every mutation emits `m12.*` on the bound transactional
 * `outbox`. EPCS stays OFF (D18) — the controlled-substance branch fail-closes at requestSignature. Replaces
 * the in-memory clinical-core scaffold mount for M12.
 */
export function mountDoseSpotRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: DoseSpotWriteOutboxPort,
): void {
  const backend = createDbDoseSpotBackend(db, outbox);
  _registerM12Abac({ resolver: backend });
  _registerM12Routes(app, { service: backend });
}

export { type DoseSpotWriteOutboxPort, createDbDoseSpotBackend } from "./dosespot-route-service-db";
export {
  type ComfortKitTimeline,
  type CostBasisRow,
  type CostBasisLine,
  type DoseSpotSeamDeps,
  type DoseSpotSeamSeed,
  type DoseSpotSeamStore,
  DoseSpotSeamGapError,
  costBasisOfLines,
  createDrizzleDoseSpotSeamStore,
  createInMemoryDoseSpotSeamStore,
  createMedicationOrderProvider,
  createRefillInboxProvider,
  getDoseSpotConsentValidator,
  getDoseSpotMdmValidator,
  getDoseSpotTerminologyValidator,
  getMedicationOrderProvider,
  getRefillInboxProvider,
  type MedicationOrderScheduleContext,
  medicationOrderPatientAndDrugForOrg,
  medicationOrderScheduleContextForOrg,
  idgMedicationHistoryForOrg,
  type IdgMedicationHistoryState,
  registerDoseSpotSeams,
} from "./seams/index";
// M12-T08 — the §4.7 ABAC predicates M12 owns (`prescriber_eligible` / `dea_schedule_authorized` /
// `refill_inbox_scope`). The §4.6 permission keys M12 contributes to M3 live in @wardenx/auth
// (M12_CONTRIBUTED_PERMISSIONS).
export {
  type DoseSpotAbacDeps,
  M12_ABAC_PREDICATES,
  buildDoseSpotAbacPredicates,
  prescriberDisciplinesOf,
  registerDoseSpotAbacPredicates,
} from "./abac-predicates";
export {
  CONTROLLED_PRESCRIBE_DISCIPLINES,
  PRESCRIBE_DISCIPLINES,
  prescriberEligible,
} from "./prescriber-eligibility";
// M12-T08 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops).
export { type DoseSpotRouteDeps, registerDoseSpotRoutes } from "./routes/dosespot-routes";
export {
  type ApproveRefillArgs,
  type ControlledSubstancePolicyView,
  type CreateMedicationOrderArgs,
  type DenyRefillArgs,
  type DiscontinueArgs,
  type DoseSpotAbacResolver,
  type DoseSpotConsentValidator,
  type DoseSpotMdmValidator,
  type DoseSpotRouteSeed,
  type DoseSpotTerminologyValidator,
  type MedicationOrderRouteService,
  type MedicationOrderView,
  type PrescriberRosterView,
  type RecordedDoseSpotEvent,
  type RecordVerbalArgs,
  type RefillInboxPolicyView,
  type RefillRequestView,
  type RefillScopeFacts,
  type OrderListScope,
  type SignArgs,
  MEDICATION_ORDER_LIST_LIMIT,
  createInMemoryDoseSpotBackend,
} from "./routes/service";
// M12-T08 — the §4.4 outbox contract (the full `m12.*` taxonomy; check-fitness-gaps.ts scans events-by-m12.ts
// for naming + ownership + declared consumers).
export { M12_OUTBOX_EVENTS } from "./events-by-m12";
export {
  type M12IdgAdmissionContext,
  type M12IdgConsumerOutboxPort,
  M12_IDG_DECISION_CONSUMER,
  buildM12IdgDecisionConsumer,
} from "./outbox-consumers/m14-idg-decision-recorded";
// F-238 — the DocLens medication-history writeback: reconciliation-only `medication_history_record` rows
// (source `doclens_intake`); never a medication_order (D10/D12).
export {
  M12_EXTRACTION_MEDICATION_HISTORY_CONSUMER,
  applyMedicationHistoryWriteback,
  buildM12ExtractionMedicationHistoryConsumer,
} from "./outbox-consumers/m22-extraction-medication-history";
// M12-T08 — the §4.5 outbox subscriptions: M5 patient-sync triggers + M6 discharge cascade / MedHx fetch + the
// M11 verbal-expiry backref. Pure deciders + the event → consumer binding registry; consumed event names are
// string literals (no dependsOn edge).
export {
  type AdmissionDischargedPayload,
  type AdmissionMedHxPayload,
  type MedHxFetchAction,
  type MedicationDischargeCascadeAction,
  type MedicationDischargeCascadeFacts,
  type MedicationDischargeDiscontinueAction,
  type MedicationOrderOnAdmission,
  type PatientChangedPayload,
  type PatientSyncTriggerAction,
  type VerbalExpiredAction,
  type VerbalExpiredConsumerDeps,
  type VerbalExpiredFacts,
  type VerbalExpiredPayload,
  M12_DISCHARGE_CASCADE_CONSUMER,
  M12_OUTBOX_SUBSCRIPTIONS,
  M12_VERBAL_EXPIRED_CONSUMER,
  buildM12DischargeCascadeConsumer,
  buildM12VerbalExpiredConsumer,
  decideMedHxFetch,
  decideMedicationDischargeCascade,
  decidePatientSyncTrigger,
  decideVerbalExpiry,
} from "./consumers/index";
// F-161 (#248) — the §2.8 D17 reconciliation-discontinue handshake.
export {
  type ReconciliationDiscontinueConsumerDeps,
  M12_RECONCILIATION_DISCONTINUE_CONSUMER,
  buildM12ReconciliationDiscontinueConsumer,
} from "./consumers/reconciliation-discontinue-binding";
// F-164 (#248) — the §2.8 D17 reconciliation "draft order" handshake (a real `medication_order` draft,
// never the historical hardcoded `{}` payload).
export {
  type DraftOrderAdmissionContext,
  type DraftOrderRequestedPayload,
  type PlannedMedicationOrderDraft,
  planDraftMedicationOrder,
} from "./consumers/draft-order-requested";
export {
  type DraftOrderRequestedConsumerDeps,
  M12_DRAFT_ORDER_REQUESTED_CONSUMER,
  buildM12DraftOrderRequestedConsumer,
} from "./consumers/draft-order-requested-binding";
// F-164 (#248) — the six §2.6 D4 / §2.8 D10 patient-sync + MedHx-fetch consumers, backed by the durable
// `dosespot_sync_queue` table (`./jobs/`).
export {
  type AdmissionIdForElectionPeriodPort,
  type MedHxFetchEnqueuePort,
  type MedHxFetchJob,
  type PatientSyncEnqueuePort,
  type PatientSyncJob,
  type SyncTriggerBindingDeps,
  buildM12AdmissionActivatedMedHxConsumer,
  buildM12PatientSyncAddressChangedConsumer,
  buildM12PatientSyncCreatedConsumer,
  buildM12PatientSyncPayerChangedConsumer,
  buildM12PatientSyncUpdatedConsumer,
  buildM12RecertificationMedHxConsumer,
  buildM12SyncTriggerConsumers,
  createDrizzleAdmissionIdForElectionPeriodPort,
  createDrizzleMedHxFetchEnqueuePort,
  createDrizzlePatientSyncEnqueuePort,
  unboundAdmissionIdForElectionPeriod,
} from "./consumers/index";
export {
  type ActiveOrgListPort,
  type DoseSpotSyncWorkerDeps,
  type DosespotPatientIdResolver,
  type EnqueueInput,
  type EnqueueResult,
  type PatientSyncSnapshotResolver,
  DosespotSyncQueueRepository,
  M12DosespotPatientIdUnbound,
  M12_DOSESPOT_SYNC_QUEUE,
  M12_DOSESPOT_SYNC_SCHEDULE,
  M12_PLATFORM_JOB_ID,
  createDrizzlePatientSyncSnapshotResolver,
  createUnboundDosespotPatientIdResolver,
  registerDoseSpotSyncQueueWorker,
  runDoseSpotSyncQueueDrain,
  scheduleDoseSpotSyncQueueDrain,
  wireM12Tenancy,
} from "./jobs/index";
// M12-T09 — the `medication_order_record` destruction-cert eraser (§7.7 / D15). Registered over the Phase-0
// deny-stub via the composition root's wireModuleErasers() (apps/backend/src/index.ts).
export {
  type InMemoryMedicationOrderEraseSeed,
  type MedicationOrderEraseCounts,
  type MedicationOrderEraseOptions,
  type MedicationOrderEraserDeps,
  type MedicationOrderEraseStore,
  createDrizzleMedicationOrderEraseStore,
  type DrizzleMedicationOrderEraseDeps,
  createInMemoryMedicationOrderEraseStore,
  createMedicationOrderEraser,
  eraseMedicationOrderRecord,
  registerDoseSpotErasers,
} from "./erasers/dosespot-eraser";
// M12-T09 — the M22 medication-order-PDF (Wave F) + M28 FHIR `MedicationRequest` (Wave H) forward seams
// (DENY-STUBS). No M1 seam-registry entry, no `dependsOn` edge — M12 only shapes the payloads the consumers
// will pull when they lock; the deny-stubs fail closed until then.
export {
  type MedicationOrderPdfRenderer,
  type MedicationOrderPdfRenderPayload,
  type MedicationOrderPdfResult,
  denyStubMedicationOrderPdfRenderer,
} from "./seams/m22-medication-order-pdf";
export {
  type FhirMedicationRequestPublisher,
  type FhirMedicationRequestPublishResult,
  denyStubFhirMedicationRequestPublisher,
} from "./seams/m28-fhir-medication-request";
export {
  M12_DOCUMENT_BACKREF_CONSUMER,
  buildM12DocumentBackrefConsumer,
} from "./outbox-consumers/m22-document-rendered";

// F-230 (#248) — the DoseSpot vendor-boundary tier (OUR side only; credentials do not exist here): the MedHx
// pull ingest (`ingestPullResult`), the `dosespot_patient_sync` mapping, and the `POST /webhooks/dosespot`
// route (HMAC + replay window + dedup + DEK-encrypted receipt + Dispensed/PickedUp -> dispense row + event),
// fail-closed (503) until an operator binds per-tenant webhook secrets.
export {
  type IngestMedHistoryInput,
  type IngestMedHistoryOutcome,
  ingestMedicationHistoryPull,
} from "./history/ingest";
export {
  createDrizzleDosespotPatientIdResolver,
  recordPatientSyncFailure,
  recordPatientSyncSuccess,
} from "./jobs/patient-sync-store";
export {
  type DoseSpotWebhookKeyProvider,
  type WebhookBodyCipher,
  createWebhookBodyCipher,
} from "./webhooks/body-crypto";
export {
  DOSESPOT_WEBHOOK_SECRETS_ENV,
  type DoseSpotWebhookSecretResolver,
  createEnvWebhookSecretResolver,
  createUnboundWebhookSecretResolver,
} from "./webhooks/secrets";
export {
  type DoseSpotWebhookIngestDeps,
  type DoseSpotWebhookRequest,
  type DoseSpotWebhookVerdict,
  ingestDoseSpotWebhook,
} from "./webhooks/ingest";
export { DOSESPOT_WEBHOOK_PATH, registerDoseSpotWebhookRoute } from "./webhooks/webhook-route";
