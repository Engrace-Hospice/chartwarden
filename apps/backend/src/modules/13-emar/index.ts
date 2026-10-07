// apps/backend/src/modules/13-emar — M13 (eMAR & Med Administration) backend module surface.
//
// M13-T07 lands the two §2.12 D16 owned seams (MedicationAdministrationProvider — the administration read path
// M14/M28/M30/M31/M33/M37 consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30
// consume) registered into the M1 registry via `registerEmarSeams` (driven from the composition root's
// wireModuleSeams()).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../bootstrap/index";
import { registerEmarAbacPredicates as _registerM13Abac } from "./abac-predicates";
import { toAdministrationIdentity } from "./administration-identity";
import { type EmarWriteOutboxPort, createDbEmarBackend } from "./emar-route-service-db";
import { registerEmarRoutes as _registerM13Routes } from "./routes/emar-routes";

/**
 * M13L — mount the M13 eMAR routes over the PRODUCTION Drizzle backend (route service + §4.7 ABAC resolver in
 * one object, RLS-scoped under `withOrgContext`; mirrors M6L / M12L). Called from the composition root's db
 * branch. Reads + the full write lifecycle are live over Drizzle+RLS; every mutation emits `m13.*` on the
 * bound transactional `outbox`. Replaces the in-memory clinical-core scaffold mount for M13.
 */
export function mountEmarRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: EmarWriteOutboxPort,
): void {
  // GAP-022 — the §2.9 D10 caregiver-review gate's RN-case-manager fact, through M5's published
  // CareTeamProvider seam. `getSeam` is the M1 registry (M13 dependsOn 1) and the seam INTERFACE is a
  // @wardenx/types leaf, so this adds no M13→M5 compile edge. Passed as a thunk so it resolves per call,
  // after wireModuleSeams() has registered M5's provider.
  // F-031 — M12's already-published `MedicationOrderProvider` seam, narrowed to the identity facts an
  // administration is FILED under (patient / admission / drug name / route). Thunked for the same reason as
  // the case-manager reader above: seams register after the route mount. Adds no M13->M12 compile edge (the
  // seam interface is a @wardenx/types leaf) and no new manifest dependency — M13 already dependsOn 12.
  const backend = buildEmarBackend(db, outbox);
  _registerM13Abac({ resolver: backend });
  _registerM13Routes(app, { service: backend });
}

/** The production backend wired to M5 / M12 / M37's published seams (shared by the route mount and the M31 port). */
function buildEmarBackend(db: DbClient, outbox?: EmarWriteOutboxPort) {
  return createDbEmarBackend(
    db,
    outbox,
    () => getSeam("CareTeamProvider"),
    () => ({
      async administrationIdentity({ organizationId, medicationOrderId }) {
        const ctx = await getSeam("MedicationOrderProvider").getAdministrationContext(
          organizationId,
          medicationOrderId,
        );
        if (ctx === null) return null;
        return toAdministrationIdentity(ctx);
      },
    }),
    // GAP-107 — M37's IV-continuous safety overlay (M37 §2.6 / D7), through its published seam; thunked so it
    // resolves per call, after M37 has registered over the deny-stub.
    () => getSeam("IpuIvSafetyOverlayProvider"),
  );
}

/**
 * GAP-092 — M31's caregiver-attested write port. The portal calls this to land a REAL M13
 * `administration_record` (pending_caregiver_review, RN review required) instead of a fake 202.
 */
export function buildPortalCaregiverAttestationPort(
  db: DbClient,
  outbox?: EmarWriteOutboxPort,
): {
  record(input: {
    organizationId: string;
    patientId: string;
    medicationOrderId: string;
    administeredAt: string;
    caregiverSessionId: string;
    route: string;
    doseAmount: number;
    doseUnit: string;
  }): Promise<{ administrationId: string; status: string }>;
} {
  const backend = buildEmarBackend(db, outbox);
  return {
    async record({ organizationId, ...args }) {
      const view = await backend.recordCaregiverAttested(organizationId, args);
      return { administrationId: view.id, status: view.status };
    },
  };
}

export {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "./emar-route-service-db";
export {
  type ComfortKitAdministrationTimeline,
  type DoseScheduleRow,
  type DoseScheduleSeedRow,
  type EmarSeamDeps,
  type EmarSeamSeed,
  type EmarSeamStore,
  type IvContinuousSessionRow,
  type PrnEffectivenessRow,
  type PrnEffectivenessSeedRow,
  type ReconciliationTimelinessAnchor,
  IDG_MISSED_DOSES_MAX_PATIENTS,
  type IdgMissedDoseEvent,
  createDrizzleEmarSeamStore,
  createInMemoryEmarSeamStore,
  createMedicationAdministrationProvider,
  idgMissedDosesForOrg,
  IV_SESSION_ACTIVITY_MAX_ORDERS,
  type IvSessionActivity,
  ivActivityOf,
  ivSessionActivityForOrg,
  missedDoseSeverity,
  createReconciliationProvider,
  getMedicationAdministrationProvider,
  getReconciliationProvider,
  registerEmarSeams,
} from "./seams/index";
// M13-T09 — the M31 caregiver-attested-portal forward seam (deny-stub; §2.9 D10). Forward declaration only;
// no registry wiring, no dependsOn edge (mirrors M12's M28 FHIR-publisher deny-stub).
export {
  type CaregiverPortalSessionResolution,
  type CaregiverPortalSessionResolver,
  denyStubCaregiverPortalSessionResolver,
} from "./seams/index";
// M13-T08 — the four §4.7 ABAC predicates M13 owns (`administering_clinician_eligible` /
// `controlled_substance_witness_eligible` / `caregiver_attested_review_required` /
// `reconciliation_authoring_eligible`). The §4.6 permission keys M13 contributes to M3 live in @wardenx/auth
// (M13_CONTRIBUTED_PERMISSIONS).
export {
  type CaregiverReviewAbacFacts,
  type EmarAbacDeps,
  type EmarAbacResolver,
  type WitnessAbacFacts,
  ADMINISTERING_ELIGIBLE_DISCIPLINES,
  M13_ABAC_PREDICATES,
  RECONCILIATION_AUTHORING_DISCIPLINES,
  actorDisciplinesOf,
  buildEmarAbacPredicates,
  registerEmarAbacPredicates,
} from "./abac-predicates";
// M13-T08 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops).
export { type EmarRouteDeps, registerEmarRoutes } from "./routes/emar-routes";
export {
  type AdministrationPolicyView,
  type AdministrationView,
  type DeploymentView,
  type EmarOrderSeed,
  type EmarPatientSeed,
  type EmarRouteSeed,
  type EmarRouteService,
  type IvSessionView,
  type MissedDoseView,
  type RecordAdministrationArgs,
  type RecordCaregiverAttestedArgs,
  type RecordedEmarEvent,
  type ReconciliationDecisionView,
  type ScheduledDoseView,
  type WorksheetView,
  createInMemoryEmarBackend,
} from "./routes/service";
// M13-T08 — the §4.4 outbox contract (the full `m13.*` taxonomy; check-fitness-gaps.ts scans events-by-m13.ts
// for naming + ownership + declared consumers).
export { M13_OUTBOX_EVENTS } from "./events-by-m13";
// M13-T08 — the §4.5 outbox subscriptions: M12 medication-order materialize/cancel + the four M6 reconciliation
// triggers + the discharge cascade + M21 comfort-kit deploy/return + M22 PDF back-ref + M9 PRN-overdue signal.
// Pure reconciliation-trigger decider + the event → consumer binding registry; consumed event names are string
// literals (no dependsOn edge).
export {
  M6_RECONCILIATION_TRIGGER_KIND,
  M13_OUTBOX_SUBSCRIPTIONS,
  decideReconciliationTrigger,
} from "./consumers/index";
// M13-T10 — the `emar_record` destruction-cert eraser (§7.7). Registered over the Phase-0 deny-stub via the
// composition root's wireModuleErasers() (apps/backend/src/index.ts).
export {
  type EmarEraseCounts,
  type EmarEraseOptions,
  type EmarEraserDeps,
  type EmarEraseStore,
  type InMemoryEmarEraseSeed,
  createDrizzleEmarEraseStore,
  createEmarEraser,
  createInMemoryEmarEraseStore,
  eraseEmarRecord,
  registerEmarErasers,
} from "./erasers/emar-eraser";
// M13-T10 — the M22 eMAR/reconciliation-PDF (Wave F) + M28 FHIR `MedicationAdministration` (Wave H) forward
// seams (DENY-STUBS). No M1 seam-registry entry, no `dependsOn` edge — M13 only shapes the payloads the
// consumers will pull when they lock; the deny-stubs fail closed until then.
export {
  type AdministrationPdfKind,
  type AdministrationPdfRenderer,
  type AdministrationPdfRenderPayload,
  type AdministrationPdfResult,
  denyStubAdministrationPdfRenderer,
} from "./seams/m22-administration-pdf";
export {
  type FhirMedicationAdministrationPublisher,
  type FhirMedicationAdministrationPublishResult,
  denyStubFhirMedicationAdministrationPublisher,
} from "./seams/m28-fhir-medication-administration";
export {
  M13_DOCUMENT_BACKREF_CONSUMER,
  buildM13DocumentBackrefConsumer,
} from "./outbox-consumers/m22-document-rendered";
// F-152 (#248) — the §2.8 D17 medication-reconciliation worksheet open, bound live for the first time.
export {
  type AdmissionAnchor,
  type ReconciliationTriggerDeps,
  M13_RECONCILIATION_TRIGGER_CONSUMER,
  buildM13ReconciliationTriggerConsumer,
} from "./outbox-consumers/m6-reconciliation-triggers";
// F-155 (#248) — the §2.5/§2.7 D14 admission-discharge cascade (cancel future doses, flag comfort kits
// for return), bound live for the first time.
export {
  type DischargeCascadeAdmissionAnchor,
  type DischargeCascadeConsumerDeps,
  M13_ADMISSION_DISCHARGED_CASCADE_CONSUMER,
  buildM13AdmissionDischargedCascadeConsumer,
} from "./outbox-consumers/m6-admission-discharged-cascade";
// F-166 (#248) — the §2.3 D2 scheduled-dose materializer + order-discontinue cascade, bound live for the
// first time.
export {
  type MaterializeScheduleAdmissionAnchor,
  type MaterializeScheduleConsumerDeps,
  type MaterializeScheduleOrderContext,
  M13_MATERIALIZE_SCHEDULE_CONSUMER,
  buildM13MaterializeScheduleConsumer,
} from "./outbox-consumers/m12-medication-order-active";
export {
  type CancelFutureScheduleConsumerDeps,
  M13_CANCEL_FUTURE_SCHEDULE_CONSUMER,
  buildM13CancelFutureScheduleConsumer,
} from "./outbox-consumers/m12-medication-order-discontinued";
// F-166 (#248) — the §2.5/§2.7 D5 comfort-kit deployment/replenishment/return chain, bound live for the
// first time. See each file's own header for what was blocked (nullable `medicationOrderId` for
// IPU-floor-stock lines) and how it was scoped.
export {
  type ComfortKitDeployedIntakeDeps,
  M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER,
  buildM13ComfortKitDeployedConsumer,
} from "./outbox-consumers/m21-comfort-kit-deployed";
export {
  type ComfortKitReplenishedConsumerDeps,
  M13_COMFORT_KIT_REPLENISHED_CONSUMER,
  buildM13ComfortKitReplenishedConsumer,
} from "./outbox-consumers/m21-comfort-kit-replenished";
export {
  type ComfortKitReturnedConsumerDeps,
  M13_COMFORT_KIT_RETURNED_CONSUMER,
  buildM13ComfortKitReturnedConsumer,
} from "./outbox-consumers/m21-comfort-kit-returned";
export {
  type ComfortKitReturnReconciliationConsumerDeps,
  M13_COMFORT_KIT_RETURN_RECONCILIATION_CONSUMER,
  buildM13ComfortKitReturnReconciliationConsumer,
} from "./outbox-consumers/m21-comfort-kit-return-reconciliation";

// GAP-038/039/040 — the §4.8 crons (extend-schedule, missed-dose-sweep, reconciliation-due-warning,
// kit-return-overdue, prn-reassessment-overdue, purge-offline-queue) + their platform-tenancy registration.
export {
  M13_CRON_QUEUES,
  MISSED_DOSE_SWEEP_LOOKBACK_HOURS,
  OFFLINE_QUEUE_RETENTION_DAYS,
  type M13ActiveOrgListPort,
  type M13CronDeps,
  buildM13CronRunners,
  registerM13CronWorkers,
  runExtendScheduleForOrg,
  runKitReturnOverdueForOrg,
  runMissedDoseSweepForOrg,
  runPrnReassessmentOverdueForOrg,
  runPurgeOfflineQueueForOrg,
  runReconciliationDueWarningForOrg,
  scheduleM13Jobs,
} from "./jobs/index";
export { M13_PLATFORM_JOB_ID, wireM13Tenancy } from "./wiring";
