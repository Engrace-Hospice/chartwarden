// apps/backend/src/modules/06-admission — Module 6 (Admission, Election & Certification).
// M6-T04 lands the pure domain core (state machines + validation + side-effect rules, §2.3–2.5);
// schema/RLS shipped in T02/T03; seams (T05), routes (T06), intake+wizard workflows (T07) build on
// this. T07 (§7.1/§7.2): referral idempotency + triage/accept state guards, the
// `admission.draft_from_referral` bundle, and the R-AC-01 activation gate (intake/). T08 (§7.3–7.5):
// recert CTI sign + F2F window math + window override — the pure org-TZ window math (certification/).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../bootstrap/index";
import { registerAdmissionAbacPredicates as _registerM6Abac } from "./abac-predicates";
import {
  type AdmissionWriteOutboxPort,
  type DpoaConsentCheckPort,
  type IpuBedAssignmentReaderPort,
  type ProviderEntityLocationPort,
  type ProviderEntityOrgCheckPort,
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "./admission-route-service-db";
import { registerAdmissionRoutes as _registerM6Routes } from "./routes/admission-routes";

export * from "./state-machines";
export * from "./admission-evidence-service";
export * from "./admission-uploaded-evidence";

/**
 * M6L-T01 — mount the M6 admission routes over the PRODUCTION Drizzle route service + ABAC resolver
 * (RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads are live
 * (referral inbox, admission census + detail, election periods, compliance windows); writes fail-closed
 * 501 until the M6L-T02+ Drizzle write lifecycle lands. Replaces the in-memory clinical-core scaffold
 * mount for M6.
 */
export function mountAdmissionRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: AdmissionWriteOutboxPort,
  ipuBedAssignmentReader?: IpuBedAssignmentReaderPort,
  providerEntityOrgCheck?: ProviderEntityOrgCheckPort,
  providerEntityLocations?: ProviderEntityLocationPort,
): void {
  _registerM6Abac({ resolver: createDbAdmissionAbacResolver(db) });
  _registerM6Routes(app, {
    service: createDbAdmissionRouteService(
      db,
      outbox,
      ipuBedAssignmentReader,
      providerEntityOrgCheck,
      providerEntityLocations,
      dpoaConsentCheck(),
    ),
  });
}

/** The narrow slice of M39's `ConsentEvaluator` the R-EL-01 representative-authority guard needs. */
interface ConsentEvaluatorPort {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: "dpoa_healthcare";
    sessionContext: { sessionClass: string };
    callerModule: string;
  }): Promise<{ allowed: boolean }>;
}

/**
 * R-EL-01's DPOA fact, resolved through M39's registered `ConsentEvaluator` seam rather than a second
 * reading of `consent_record` — the evaluator already applies the status / effective-at / expiry /
 * post-death rules, and re-deriving "is there an active DPOA" in M6 would be a fork of them.
 *
 * `getSeam` opaquely + a locally-declared narrow port is the M22 `consent-gate.ts` / M12
 * `seams/index.ts` convention (no `@wardenx/consent` import edge from M6). Resolved as a THUNK per call
 * so it binds after `wireModuleSeams()`, and the M1 registry fails closed on an unregistered seam.
 */
function dpoaConsentCheck(): DpoaConsentCheckPort {
  return {
    async hasActiveDpoaHealthcareConsent(organizationId, patientId) {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorPort;
      const verdict = await evaluator.evaluate({
        organizationId,
        patientId,
        consentType: "dpoa_healthcare",
        // The election statement is signed on a STAFF-driven route (the clinician records the
        // representative's wet-ink or witnessed signature); the question is whether the consent EXISTS,
        // not whether a portal session may read it.
        sessionContext: { sessionClass: "staff" },
        callerModule: "m6",
      });
      return verdict.allowed;
    },
  };
}

// M6-T05 — the six §4.7 reader seams (ElectionPeriod/Certification/FaceToFace/LevelOfCare/
// AdmissionStatus/AdmissionCensus), registered over their boot deny-stubs by registerAdmissionSeams.
export {
  type AdmissionSeamDeps,
  type AdmissionReaderStore,
  type AdmissionReaderSeed,
  type ElectionPeriodRecord,
  type ActiveAdmissionDraftContext,
  type AdmissionSchedulingContext,
  type ElectionPeriodContext,
  type ClaimAssemblyRangeContext,
  type ClaimRangeAdmission,
  type ClaimRangeCertification,
  type ClaimRangeElectionPeriod,
  type ClaimRangeFaceToFace,
  type ClaimRangeLevelOfCarePeriod,
  type ActiveAdmissionSitingContext,
  type IdgPacketInclusionCandidate,
  AdmissionNotFoundError,
  AdmissionSeamDataGapError,
  activeAdmissionDraftContextForPatient,
  activeAdmissionSitingForPatientForOrg,
  admissionIsActiveForOrg,
  admissionSchedulingContextForOrg,
  electionPeriodContextForOrg,
  claimAssemblyRangeContextForOrg,
  createDrizzleAdmissionReaderStore,
  idgCurrentLevelOfCareForOrg,
  idgPacketInclusionForOrg,
  idgRecertWindowsForOrg,
  IDG_HOSPITAL_EVENTS_MAX_PATIENTS,
  type IdgHospitalEvent,
  idgHospitalEventsForOrg,
  projectHospitalEvent,
  PORTAL_DISCHARGE_GRACE_MAX_PATIENTS,
  type PortalDischargedPastGrace,
  isPastGraceAndNotReadmitted,
  portalDischargedPastGraceForOrg,
  IDG_RECERT_WINDOWS_MAX_PATIENTS,
  type IdgRecertF2fStatus,
  type IdgRecertWindow,
  projectIdgRecertWindow,
  createInMemoryAdmissionReaderStore,
  createElectionPeriodReader,
  createCertificationReader,
  createFaceToFaceReader,
  createLevelOfCareReader,
  createAdmissionStatusReader,
  createAdmissionCensusReader,
  createDeathDischargeReader,
  createLevelOfCarePeriodReader,
  createDischargeReader,
  createAdmissionOnsetReader,
  toActiveElectionPeriod,
  toCensusEntry,
  toElectionPeriodSummary,
  registerAdmissionSeams,
  getElectionPeriodReader,
  getCertificationReader,
  getFaceToFaceReader,
  getLevelOfCareReader,
  getAdmissionStatusReader,
  getAdmissionCensusReader,
  getDeathDischargeReader,
  getLevelOfCarePeriodReader,
  getDischargeReader,
  getAdmissionOnsetReader,
} from "./seams/index";

// M6-T06 — the §4.1 route inventory (46 routes) behind requirePermission on the §4.5 keys M6
// contributes to M3 (M6_CONTRIBUTED_PERMISSIONS) + the §4.6 ABAC predicates M6 registers into M3.
// Routes compose over the injected AdmissionRouteService (in-memory slice here; Drizzle in prod under
// withOrgContext so RLS backstops). The §6.3 reason-derived discharge permission is enforced server-
// side. M5 (Patient/Caseload), M38 (ICD-10/value sets), M40 (physician/facility/referral-source) and
// M39 (election authority / DPOA / Part 2) bindings ride on the seams already registered (M6-T05) and
// cross-module ids validated app-side — no cross-module schema import.
export { type AdmissionRouteDeps, registerAdmissionRoutes } from "./routes/admission-routes";
export {
  type AdmissionRouteService,
  type AdmissionAbacResolver,
  type AdmissionBackendSeed,
  type AdmissionSeedRecord,
  type AdmissionDetail,
  type AcceptReferralInput,
  type MutationResult,
  type DischargeResult,
  VersionMismatchError,
  ResourceNotFoundError,
  ExternalReferralAlreadyIngestedError,
  InvalidReferralStateError,
  ReferralNotTriagedError,
  ActivationPreconditionError,
  F2fScheduleOutOfWindowError,
  createInMemoryAdmissionBackend,
} from "./routes/service";

// M6-T09 — discharge / revocation / transfer / LOC (§6.3 reason-specific permission mapping + §7.6
// workflows). PURE domain logic the route slice composes over: the §6.3 reason→permission derivation +
// per-reason narrative gates, the M6-owned bereavement-eligibility rule (W-DC-01), the for-cause cosign
// cascade (W-DC-02 / D11), and the transfer-in inherited-period sequencing (W-DC-03 / D9).
export {
  DISCHARGE_REASONS,
  DISCHARGE_POLICY,
  DISCHARGE_FALLBACK_PERMISSION,
  type DischargeReason,
  type DischargePolicy,
  type DischargeNarrativeIssue,
  type BereavementFacts,
  type BereavementEligibility,
  type ForCauseFiling,
  type ForCauseResolution,
  type ForCauseOutcome,
  type TransferInInput,
  type TransferInPlan,
  type TransferInPeriodPlan,
  isDischargeReason,
  deriveDischargePermissionKey,
  dischargeRequiresCosign,
  checkDischargeNarrative,
  decideBereavementEligibility,
  fileForCauseDischarge,
  resolveForCauseDischarge,
  planTransferIn,
} from "./discharge";

// M6-T08 — recert CTI sign (§7.3), F2F window math (§7.4), F2F window override (§7.5). The pure
// org-timezone window math (D4 written-cert deadline + CMS 418.22 F2F window) is the single source of
// truth the slice and the screens key off; the §2.3.3/§2.3.4 machines own the per-event guards.
export {
  DEFAULT_ORG_TIME_ZONE,
  F2F_PRIOR_WINDOW,
  WRITTEN_CERT_DEADLINE_DAYS,
  type F2fWindow,
  type F2fWindowStatus,
  type RecertSignFacts,
  type RecertSignOutcome,
  addCalendarDays,
  endOfOrgDayInstant,
  computeWrittenCertDeadline,
  isWrittenCertOverdue,
  computeF2fWindow,
  isF2fScheduledWithinWindow,
  decideF2fWindowStatus,
  decideRecertSign,
} from "./certification";

// M6-T07 — referral & intake (§7.1) + admission wizard (§7.2). The R-AC-01 activation gate is the
// pure rule both the route-10 read aggregate and route-14 activate share (single source of truth).
export {
  type ActivationGap,
  type ActivationFacts,
  type ActivationGate,
  computeActivationGate,
} from "./intake";
export {
  type AdmissionAbacDeps,
  M6_ABAC_PREDICATES,
  M6_ROLE_PREDICATE_NAMES,
  buildAdmissionAbacPredicates,
  registerAdmissionAbacPredicates,
} from "./abac-predicates";

// M6-T10 — the full §4.4 outbox event contract (the `m6.*` taxonomy other modules subscribe to) +
// the §4.3 BullMQ job catalog with the two pure, idempotent compliance-window scans (recompute +
// window-alert). check-fitness-gaps.ts scans events-by-m6.ts for naming / ownership / consumers.
export { M6_OUTBOX_EVENTS } from "./events-by-m6";
// F-100 — the §4.11 render handshake's downstream half: six `document_id` columns that had no writer.
export {
  M6_DOCUMENT_BACKREF_CONSUMER,
  M6_BACKREF_AGGREGATE_TYPES,
  buildM6DocumentBackrefConsumer,
} from "./outbox-consumers/m22-document-rendered";
// F-159 (#248) — the §2.3.5 LCP transition M11 D9's signed level-of-care-change order drives.
export {
  M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER,
  buildM6LevelOfCareChangeSignedConsumer,
} from "./outbox-consumers/m11-level-of-care-change-signed";
export {
  M6_QUEUES,
  M6_JOB_SCHEDULES,
  M6_PLATFORM_JOB_ID,
  CLOSING_SOON_LEAD_MS,
  type M6QueueName,
  type ComplianceWindowSnapshot,
  type WindowTransition,
  type PlannedWindowEvent,
  type WindowScanPlan,
  jobIdempotencyKey,
  promoteWindowStatus,
  planRecomputeWindows,
  planWindowAlert,
} from "./jobs/index";
export { wireM6Tenancy } from "./wiring";

export {
  buildM6WorkerDeps,
  registerM6CronWorkers,
  runCtiSignatureNotifyCron,
  runF2fDueNotifyCron,
  scheduleM6Jobs,
} from "./jobs/cron-workers";

export type {
  ActiveOrgListPort as M6ActiveOrgListPort,
  AdmissionOutboxPublishPort,
  M6WorkerDeps,
} from "./jobs/cron-workers";

// M6-T11 — the `AdmissionEventApplier` decision core (§4.8): the M29 `hl7_inbound_proposal.accepted`
// consumer for `ownerModule='m6'`. PURE + tested now; the M29 producer is Wave H so the outbox binding
// is forward-declared/deferred (M6_PROPOSAL_ACCEPTED_CONSUMER{,_DEFERRED}). The applier drives exactly
// one admission-lifecycle transition (external-death discharge under the full D14 preconditions); every
// other external signal becomes an informational `compliance_window` (D15) for human triage.
export {
  type ProposedEventContext,
  type ProposalResourceKind,
  type ProposalAcceptedPayload,
  type ApplierFacts,
  type ApplierAction,
  type ApplierProcessedOutcome,
  type ExternalSignalWindowType,
  type ExternalSignalWindowDescriptor,
  decideAdmissionEvent,
} from "./consumers/admission-event-applier";
export {
  M6_PROPOSAL_ACCEPTED_CONSUMER,
  M6_PROPOSAL_ACCEPTED_CONSUMER_DEFERRED,
  decideProposalAccepted,
} from "./outbox-consumers/m29-proposal-accepted";
// task-11 — the INTERIM dispatcher binding (skip m5-owned / dead-letter m6-owned until the applier).
export {
  type M6AdmissionEventApplierBinding,
  buildM6ProposalAcceptedConsumer,
} from "./outbox-consumers/live-binding";

// M6-T12 — the `admission_record` destruction eraser (§3.6 module-init; M4 destruction-cert, D7/D8).
// M6 owns its admission-satellite subtree (election/CTI/F2F/LOC/revocation/discharge/transfer/NOR/
// compliance windows + referrals); the eraser deletes them for the subject patient and tombstones the
// `admission` row for FK integrity. Registered over the Phase-0 deny-stub by wireModuleErasers().
// DR/INT: M6 is **DR Tier 1** — admissions/election/certification gate every downstream clinical and
// billing workflow; a degradation blocks new admissions and CMS-compliance windows (see
// M6_DR_INT_INVENTORY.md). Screens ship in apps/web/src/modules/06-admission (Track B, ADR-0030).
export {
  type AdmissionEraserDeps,
  type AdmissionEraseStore,
  type AdmissionEraseCounts,
  eraseAdmissionRecord,
  createInMemoryAdmissionEraseStore,
  createDrizzleAdmissionEraseStore,
  createAdmissionEraser,
  registerAdmissionErasers,
} from "./erasers/admission-eraser";
