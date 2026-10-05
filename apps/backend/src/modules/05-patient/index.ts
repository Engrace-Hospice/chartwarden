// apps/backend/src/modules/05-patient — Module 5 (Patient & Demographics) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/05-patient`. M5 has NO package —
// its code lives only here; the cross-module CONTRACTS (identifier strategy, outbox event names,
// PatientReader data shape) live in the leaf @wardenx/types (M5-T01, re-exported below).
//
// Build order (Wave C plan): T01 enums + layout + identifier strategy (this) → T02/T03/T04 schema
// (packages/db) → T05 RLS/audit/migration → T06 matching pipeline → T07 CaseloadProvider seam
// (closes the M3 boot-gate) → T08 PatientReader + PatientMutator seams → T09 routes + perm keys →
// T10 outbox/jobs/privacy-flag recompute/SUD enforcement → T11 M29 proposal consumer (deny-stub) +
// deceased cascade → T12 screens/audit/eraser/DR-INT/tests.
//
// DR/INT (ADR-0009): M5 is **DR Tier 1** — the patient master record is on the critical path for
// every clinical and billing workflow; a degradation blocks admissions and chart access.
export {
  PATIENT_IDENTIFIER_RULES,
  MBI_ALLOWED_LETTERS,
  M5_PATIENT_EVENT_NAMES,
  type PatientIdentifierKind,
  type PatientIdentifierRule,
  type M5PatientEventName,
  type PatientIdentity,
  type ExternalMrn,
} from "@wardenx/types";

// M5-T07/T08 — the three boot-gate seams: CaseloadProvider (§4.1, + caseload_membership predicate),
// PatientReader (§4.8, merge-redirect), PatientMutator (§4.9, D12 strip). registerPatientSeams closes
// all three for validateSeams().
export {
  type PatientSeamDeps,
  type CaseloadStore,
  type CaseloadSeamDeps,
  type SeedAssignment,
  type CareTeamStore,
  type CareTeamSeamDeps,
  type SeedCareTeamAssignment,
  type PatientReaderStore,
  type PatientMutatorStore,
  CASELOAD_MEMBERSHIP_PREDICATE,
  FORBIDDEN_PATCH_FIELDS,
  MAX_MERGE_HOPS,
  createCaseloadProvider,
  createInMemoryCaseloadStore,
  createCareTeamProvider,
  createInMemoryCareTeamStore,
  createPatientReader,
  createInMemoryPatientReaderStore,
  createPatientMutator,
  createInMemoryPatientMutatorStore,
  createDrizzlePatientReaderStore,
  createDrizzlePatientMutatorStore,
  createDrizzleCaseloadStore,
  createDrizzleCareTeamStore,
  getCaseloadProvider,
  getCareTeamProvider,
  getPatientReader,
  getPatientMutator,
  getPatientCoverageReader,
  getPatientHopeAdmissionPrefillReader,
  getPatientPrivacyFlagReader,
  registerPatientSeams,
  membershipUserIdForOrg,
  createCaseloadStoreWithShiftCache,
  readShiftAssignedPatientIds,
  readShiftIsAssigned,
} from "./seams/index";

// M5-T09 — the §4.2 route inventory behind requirePermission on the §4.7 keys + the route service.
export { type PatientRouteDeps, registerPatientRoutes } from "./routes/patient-routes";
export {
  type PatientRouteService,
  type AdmitInput,
  type AdmitResult,
  type PatientView,
  type AddressView,
  type AddAddressInput,
  type AmendmentView,
  type InMemoryPatientSeed,
  createInMemoryPatientRouteService,
} from "./routes/service";

// GAP-015 — the §4.3 care-team assignment contract + routes (the DB port is wired in `mountPatientRoutes`).
export type {
  AssignClinicianInput,
  AssignmentView,
  EndAssignmentInput,
  PatientAssignmentsPort,
} from "./assignments";
export {
  type PatientAssignmentRouteDeps,
  registerPatientAssignmentRoutes,
} from "./routes/assignment-routes";

// M5-T10 — outbox events (§4.6), jobs (§4.5 geocode), privacy-flag recompute + SUD enforcement (§7.6).
export { M5_OUTBOX_EVENTS } from "./events-by-m5";

// M12 job-queue infra (#248) — the org-explicit, worker-callable demographic read M12's
// `dosespot_sync_queue` drain needs, injected as a port rather than read via a direct cross-module
// schema import (see the file for why `patient_address`/`patient_phone` are not in
// `check-table-ownership.ts`'s exempt set the way bare `patient` is).
export {
  type DosespotSyncDemographics,
  dosespotSyncDemographicsForOrg,
} from "./seams/dosespot-sync-snapshot-for-org";

// F-181 (#248) — the minimum-necessary PID facts + fail-closed SUD flag M11's outbound lab-ORM producer reads,
// on the caller's transaction, injected as a port (M11 has no `dependsOn` edge to 5).
export { type Hl7OrmDemographics, hl7OrmDemographicsInTx } from "./seams/hl7-orm-demographics";

// M14 IDG screens — the org-explicit BATCHED minimum-necessary display read ("First L." + MRN last-4), injected
// into M14's route layer as a port at the composition root (M14 imports no M5 code/schema).
export {
  type PatientDisplayLabel,
  PATIENT_DISPLAY_MAX_IDS,
  patientDisplayLabelsForOrg,
  toPatientDisplayLabel,
} from "./seams/patient-display-for-org";

// F-152 (#248) — the §3.3/ARCH-011 admission-siting denormalization, bound live for the first time.
export {
  M5_ADMISSION_SITING_CONSUMER,
  buildM5AdmissionSitingConsumer,
  type AdmissionSitingDeps,
} from "./outbox-consumers/m6-admission-activated";
// F-165 (#248) — the M17 shift-assignment caseload cache write path.
export {
  type VisitAssignmentDeps,
  buildM5VisitAssignedConsumer,
  buildM5VisitUnassignedConsumer,
} from "./outbox-consumers/m17-visit-assignment";
// F-167 (#248) — the §7.6/D10 privacy-flag-snapshot recompute off M39's signed/revoked/supersedes/
// renewed consent lifecycle.
export {
  M5_CONSENT_PRIVACY_CONSUMER,
  buildM5ConsentPrivacyConsumer,
} from "./outbox-consumers/m39-consent-privacy";
export {
  M5_QUEUES,
  M5_JOB_SCHEDULES,
  runGeocodeAddress,
  type M5QueueName,
  type GeocodeAddressPorts,
  type GeocodeResult,
} from "./jobs/index";
// M5 §4.5 `patient.snapshot_rebuild` — the quarterly (+ manual admin route) full privacy-snapshot rebuild.
export {
  SNAPSHOT_REBUILD_PAGE_SIZE,
  SnapshotRebuildPartialFailure,
  type SnapshotRebuildDeps,
  type SnapshotRebuildSummary,
  rebuildPrivacySnapshotsForOrg,
} from "./jobs/snapshot-rebuild";
export {
  M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID,
  M5_SNAPSHOT_REBUILD_QUEUE,
  M5_SNAPSHOT_REBUILD_SCHEDULE,
  type SnapshotRebuildRunSummary,
  type SnapshotRebuildWorkerDeps,
  registerSnapshotRebuildWorker,
  runSnapshotRebuildFanout,
  scheduleSnapshotRebuild,
} from "./jobs/snapshot-rebuild-worker";
export {
  type PrivacyFlag,
  type ConsentSignal,
  type M39ConsentChangedPayload,
  type PrivacySnapshotPorts,
  SudConsentRequiredError,
  M39_CONSENT_CONSUMER_DEFERRED,
  recomputePrivacyFlags,
  mergeConsentSignal,
  isSudReadAllowed,
  assertSudReadAllowed,
  applyConsentChanged,
} from "./privacy/index";

// M5-T11 — the deceased cascade (§7.8) + the M29 proposal-accept consumer (§4.10, forward-seam/deny-stub).
export {
  DECEASED_CASCADE_TARGETS,
  InvalidDeceasedDateError,
  recordDeath,
  type DeceasedCascadePorts,
  type RecordDeathResult,
} from "./deceased";
export {
  M29_PROPOSAL_CONSUMER,
  M29_PROPOSAL_CONSUMER_DEFERRED,
  decideProposalApply,
  type ProposalAcceptedPayload,
  type ProposedPatientCandidate,
  type ProposalDecision,
} from "./outbox-consumers/m29-proposal-accepted";
// TASK-006 — the LIVE m5.proposal-applier binding the boot outbox dispatcher registers.
export {
  type M5ProposalApplierBinding,
  buildM29ProposalApplierConsumer,
} from "./outbox-consumers/live-binding";

// GAP-004 — the real DB-backed §7.8 death-cascade port + the LIVE `m6.discharge.death` consumer
// binding the boot outbox dispatcher registers (mountPatientRoutes never covered "record death";
// M6's discharge flow is the actual source of a hospice death — see the consumer file header).
export {
  type DeathCascadeOutcome,
  type M5OutboxEmission,
  type M5OutboxPort,
  InvalidDeceasedTransitionError,
  recordDeathFromDischarge,
} from "./deceased-db";
export {
  M5_DEATH_CASCADE_CONSUMER,
  buildM5DeathCascadeConsumer,
} from "./outbox-consumers/m6-discharge-death";
// F-235 (#248) — M5's half of the DocLens chart-writeback handshake: `m22.extraction.commit_requested` →
// low-risk contact demographics on the batch's resolved patient → `m5.patient.draft_created_from_extraction`.
export {
  type ExtractionWritebackPlan,
  M5_EXTRACTION_WRITEBACK_CONSUMER,
  applyExtractionWriteback,
  buildM5ExtractionWritebackConsumer,
  normalizePhoneE164,
  parseCommitRequested,
  planExtractionWriteback,
} from "./outbox-consumers/m22-extraction-writeback";
// F-238 — the DocLens allergy writeback: `m22.extraction.allergies_requested` → unverified `patient_allergy`
// rows → `m5.patient_allergy.draft_created_from_extraction`; plus the allergy list / verify routes.
export {
  M5_EXTRACTION_ALLERGY_CONSUMER,
  applyAllergyWriteback,
  buildM5ExtractionAllergyConsumer,
} from "./outbox-consumers/m22-extraction-allergies";
export {
  type PatientAllergyRouteDeps,
  registerPatientAllergyRoutes,
} from "./routes/allergy-routes";
export {
  M5_INTAKE_SUD_PRIVACY_CONSUMER,
  type SudFlagDecision,
  type SudFlagOrigin,
  type SudSnapshotFacts,
  buildM5IntakeSudPrivacyConsumer,
  decideSudFlag,
} from "./outbox-consumers/m22-intake-sud-privacy";

// F-171 (#248) — the real §2.4/§4.3 direct patient-merge write path (`POST /patients/:id/merge`):
// folds a duplicate into a survivor, applies field resolutions to the survivor, and emits the real
// `m5.patient.merged` event this event's catalog entry had zero producers for.
export {
  MERGEABLE_PATIENT_FIELDS,
  MERGEABLE_SOURCE_STATUSES,
  SelfMergeError,
  SourceAlreadyMergedError,
  TargetAlreadyMergedError,
  UnknownMergeFieldError,
  UnmergeableSourceStatusError,
  planMerge,
  type FieldResolution,
  type FieldResolutionKeep,
  type FieldResolutions,
  type MergeablePatientField,
  type MergedFieldDiffEntry,
  type PatientMergeSubject,
  type PlanMergeInput,
  type PlannedMerge,
} from "./merges";
export {
  PatientNotFoundError,
  mergePatients,
  type MergePatientsInput,
  type MergePatientsResult,
} from "./merges-db";

// M5-T12 — the `clinical_record` destruction eraser (§8/§10, D7/D8). Screens DEFER (no apps/web
// codePath in the M5 manifest — the entity/admit/merge screens are tracked for the ADR-0030 UI
// follow-up). DR Tier 1 (the patient spine is on every clinical/billing critical path) — see
// M5_DR_INT_INVENTORY.md. The m5.patient.mutator_applied audit action ships in @wardenx/audit.
export {
  type PatientEraserDeps,
  type PatientEraseStore,
  type PatientEraseCounts,
  erasePatientClinicalRecord,
  createInMemoryPatientEraseStore,
  createDrizzlePatientEraseStore,
  createPatientEraser,
  registerPatientErasers,
} from "./erasers/patient-eraser";
export { createDbPatientRouteService } from "./patient-route-service-db";
// GAP-006 — the M5 side of the portal §164.526 amendment submit (bound onto M31's route port at the root).
export {
  type PortalAmendmentIntake,
  type PortalAmendmentRecord,
  type PortalAmendmentSubmission,
  createDbPortalAmendmentIntake,
} from "./portal-amendment-intake";

// The Privacy Officer surface (M5 §4.2 / §5.1 "Privacy flags"): the per-patient view, the §4.2 resync and
// the restricted-patients work queue, over ports M39 (Part 2 consent state), M22 (DocLens SUD batches) and
// M4 (the snapshot's audit trail) implement — bound at the composition root.
export {
  NO_PART2_CONSENT,
  PRIVACY_FLAG_ORIGINS,
  type IntakeSudBatchFact,
  type IntakeSudBatchReader,
  type Part2ConsentState,
  type Part2ConsentStateReader,
  type PrivacyDrift,
  type PrivacyFlagOrigin,
  type PrivacyOfficerPorts,
  type PrivacySnapshotHistoryEvent,
  type PrivacySnapshotHistoryReader,
  batchContributes,
  decideResync,
  detectDrift,
  flagSinceFromHistory,
  snapshotNeedsWrite,
} from "./privacy/officer";
export {
  type PatientPrivacyView,
  type PrivacyOfficerService,
  type PrivacyResyncResult,
  type PrivacySnapshotRederivation,
  createDbPrivacyOfficerService,
  rederivePrivacySnapshot,
} from "./privacy/officer-db";
export {
  type PatientPrivacyRouteDeps,
  registerPatientPrivacyRoutes,
} from "./routes/privacy-routes";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { createDbAssignmentsPort as _dbAssignmentsPort } from "./assignments-db";
import type { M5OutboxPort } from "./deceased-db";
import { rebuildPrivacySnapshotsForOrg as _rebuildPrivacySnapshotsForOrg } from "./jobs/snapshot-rebuild";
import { mergePatients as _mergePatients } from "./merges-db";
import { createDbPatientRouteService as _dbPatientService } from "./patient-route-service-db";
import type { PrivacyOfficerPorts } from "./privacy/officer";
import { createDbPrivacyOfficerService as _dbPrivacyOfficerService } from "./privacy/officer-db";
import { registerPatientAllergyRoutes as _registerPatientAllergyRoutes } from "./routes/allergy-routes";
import { registerPatientAssignmentRoutes as _registerPatientAssignmentRoutes } from "./routes/assignment-routes";
import { registerPatientRoutes as _registerPatientRoutes } from "./routes/patient-routes";
import { registerPatientPrivacyRoutes as _registerPatientPrivacyRoutes } from "./routes/privacy-routes";

/**
 * Mount the M5 patient REST routes (census list, chart-resolve, admit, addresses, amendments, the
 * §4.3 direct merge) on a server (composition root, when a DB client is present). The READS
 * (list / getPatient) and the writes this file mounts all run on the real Drizzle PatientRouteService
 * / `mergePatients` over `patient` under RLS. Backs the Patient List/Census + the Patient Chart banner
 * with real data. `outbox` is the module-scoped `m5` outbox port (F-171, #248) `mergePatients` emits
 * `m5.patient.merged` through — required, not optional, so a caller cannot silently mount a merge
 * route with no way to ever publish the event a survivor needs. `privacy` binds the Privacy Officer
 * routes' cross-module reads (M39 consent state, M22 DocLens batches, M4 snapshot trail) — required for
 * the same reason: a resync that cannot see M39 would re-derive nothing.
 */
export function mountPatientRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox: M5OutboxPort,
  privacy: PrivacyOfficerPorts,
): void {
  _registerPatientRoutes(app, {
    service: _dbPatientService(db),
    mergePatients: (input) => _mergePatients(db, outbox, input),
  });
  // GAP-015 — the §4.3 care-team assignment routes: the first production writer of `patient_assignment`.
  _registerPatientAssignmentRoutes(app, { assignments: _dbAssignmentsPort(db, outbox) });
  // F-238 — the allergy list (unverified DocLens rows included, labelled) + verify / entered-in-error.
  _registerPatientAllergyRoutes(app, { db });
  // M5 §4.2 / §5.1 — the Privacy Officer view, the resync, and the restricted-patients queue; §4.5 — the
  // manual trigger of the quarterly snapshot rebuild (same derivation as the resync, run as the officer).
  _registerPatientPrivacyRoutes(app, {
    service: _dbPrivacyOfficerService(db, outbox, privacy),
    rebuildSnapshots: (organizationId, actorUserId) =>
      _rebuildPrivacySnapshotsForOrg(db, organizationId, {
        outbox,
        ports: privacy,
        actorUserId,
      }),
  });
}
