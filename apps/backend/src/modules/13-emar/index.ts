// apps/backend/src/modules/13-emar — M13 (eMAR & Med Administration) backend module surface.
//
// M13-T07 lands the two §2.12 D16 owned seams (MedicationAdministrationProvider — the administration read path
// M14/M28/M30/M31/M33/M37 consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30
// consume) registered into the M1 registry via `registerEmarSeams` (driven from the composition root's
// wireModuleSeams()).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerEmarAbacPredicates as _registerM13Abac } from "./abac-predicates";
import { createDbEmarBackend } from "./emar-route-service-db";
import { registerEmarRoutes as _registerM13Routes } from "./routes/emar-routes";

/**
 * M13L-T01 — mount the M13 eMAR routes over the PRODUCTION Drizzle backend (route service + ABAC resolver in
 * one object, RLS-scoped under `withOrgContext`; mirrors M6L-T01 / M12-T08). Called from the composition
 * root's db branch. Reads are live (administration record + census, IV session, scheduled/missed doses,
 * reconciliation worksheets, comfort-kit deployments, policy); writes fail-closed 501 until the M13L-T02+
 * Drizzle write lifecycle lands. Replaces the in-memory clinical-core scaffold mount for M13.
 */
export function mountEmarRoutes(app: FastifyInstance, db: DbClient): void {
  const backend = createDbEmarBackend(db);
  _registerM13Abac({ resolver: backend });
  _registerM13Routes(app, { service: backend });
}

export { createDbEmarBackend } from "./emar-route-service-db";
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
  createInMemoryEmarSeamStore,
  createMedicationAdministrationProvider,
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
