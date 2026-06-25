// apps/backend/src/bootstrap/seams/providers.ts — DENY-STUB seam implementations +
// the Phase-1 module-registration hook.
//
// This is the "deny-stub" home (PHASE_0_SCAFFOLD_PLAN.md PR-0.4): code stubs, NOT manifest
// edges. Each required seam has a deny-stub whose every method throws NotImplementedError.
// REQUIRED_SEAMS (registry.ts) references these as its fail-closed defaults, and
// validateSeams() applies them for any seam no module registered (§3.18.3) — so an
// unregistered cross-module contract denies LOUDLY on call instead of failing open. The
// owning module (M5/M17 CaseloadProvider+PatientReader, M22 DocumentRenderer, M39
// ConsentEvaluator) overwrites its stub by calling registerSeam() in its own init();
// wireSeams() is where boot invokes those Phase-1 registrations.

import type {
  AdmissionCensusReader,
  AdmissionStatusReader,
  AuditorSessionMinter,
  BillableEncounterReader,
  CarePlanReader,
  CaseloadProvider,
  CertificationReader,
  DocumentReader,
  DocumentRenderer,
  DocumentStorageProvider,
  ElectionPeriodReader,
  EncounterCreator,
  EvvAggregatorReferenceReader,
  EvvBracketResolver,
  EvvComplianceReader,
  EvvLocationProvider,
  EvvMetricsProvider,
  EvvVerificationProvider,
  ExtractionProvenanceReader,
  FaceToFaceReader,
  HopeJ2051Provider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
  IdgDecisionProvider,
  IdgPacketProvider,
  IdgScheduleProvider,
  IntakeMetricsProvider,
  LatestAssessmentProvider,
  LevelOfCareReader,
  MedicationAdministrationProvider,
  MedicationOrderProvider,
  MileagePayrollReader,
  OrderProvider,
  OrderSignatureProvider,
  PatientMutator,
  PatientReader,
  PortalDocumentReader,
  PortalVisitReader,
  ReconciliationProvider,
  RefillInboxProvider,
  RenderedDocumentProvider,
  ScaleSeriesProvider,
  SeamName,
  SessionContextResolver,
  SignedEncountersReader,
  SupervisoryCadenceReader,
  TenantOrgCreationProvider,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
  VolunteerComplianceProvider,
} from "../interfaces";

export class NotImplementedError extends Error {
  constructor(seam: string) {
    super(`${seam}: Phase-0 deny-stub — not implemented until its owning module lands`);
    this.name = "NotImplementedError";
  }
}

export const caseloadDenyStub: CaseloadProvider = {
  isInCaseload() {
    throw new NotImplementedError("CaseloadProvider");
  },
  caseloadPatientIds() {
    throw new NotImplementedError("CaseloadProvider");
  },
};

export const patientReaderDenyStub: PatientReader = {
  findByMrn() {
    throw new NotImplementedError("PatientReader");
  },
  findByExternalMrn() {
    throw new NotImplementedError("PatientReader");
  },
  findBySsnLast4AndDob() {
    throw new NotImplementedError("PatientReader");
  },
  findByNameDobSex() {
    throw new NotImplementedError("PatientReader");
  },
  findByLooseName() {
    throw new NotImplementedError("PatientReader");
  },
  findById() {
    throw new NotImplementedError("PatientReader");
  },
};

export const patientMutatorDenyStub: PatientMutator = {
  apply() {
    throw new NotImplementedError("PatientMutator");
  },
};

export const documentRendererDenyStub: DocumentRenderer = {
  render() {
    throw new NotImplementedError("DocumentRenderer");
  },
};

export const documentStorageProviderDenyStub: DocumentStorageProvider = {
  presignDownload() {
    throw new NotImplementedError("DocumentStorageProvider");
  },
  destroyAllObjectVersions() {
    throw new NotImplementedError("DocumentStorageProvider");
  },
};

// M22 (§4.3) the five PUBLISHED reader seams. LEAF-TYPED (interfaces in @wardenx/types) → concrete typed
// deny-stubs (like M6/M17's readers). Each denies LOUDLY until M22 registers the real Drizzle-backed reader
// over it (M22-T05). All five are READ-only document/provenance/metrics projections.

/** M22 — rendered-document-for-aggregate read (every source module's back-ref consume). Denies until M22 registers. */
export const renderedDocumentProviderDenyStub: RenderedDocumentProvider = {
  getRenderedDocumentForAggregate() {
    throw new NotImplementedError("RenderedDocumentProvider");
  },
};

/** M22 — document/version digest read (M28 FHIR / M31 portal list / M33 reporting). Denies until M22 registers. */
export const documentReaderDenyStub: DocumentReader = {
  documentsForPatient() {
    throw new NotImplementedError("DocumentReader");
  },
  documentMetadata() {
    throw new NotImplementedError("DocumentReader");
  },
};

/** M22 — portal-safe document read + download-URL mint (M31). Denies until M22 registers the real reader. */
export const portalDocumentReaderDenyStub: PortalDocumentReader = {
  documentsForPatient() {
    throw new NotImplementedError("PortalDocumentReader");
  },
  mintPortalDownloadUrl() {
    throw new NotImplementedError("PortalDocumentReader");
  },
};

/** M22 — intake-throughput metrics read (M33/M30). Denies until M22 registers the real provider. */
export const intakeMetricsProviderDenyStub: IntakeMetricsProvider = {
  metricsForOrg() {
    throw new NotImplementedError("IntakeMetricsProvider");
  },
};

/** M22 — per-chart-field extraction provenance read (M28 FHIR Provenance / M30). Denies until M22 registers. */
export const extractionProvenanceReaderDenyStub: ExtractionProvenanceReader = {
  provenanceForTargetAggregate() {
    throw new NotImplementedError("ExtractionProvenanceReader");
  },
};

export const sessionContextResolverDenyStub: SessionContextResolver = {
  resolveActor() {
    throw new NotImplementedError("SessionContextResolver");
  },
  resolveStepUpState() {
    throw new NotImplementedError("SessionContextResolver");
  },
};

export const auditorSessionMinterDenyStub: AuditorSessionMinter = {
  mintAuditorSession() {
    throw new NotImplementedError("AuditorSessionMinter");
  },
};

// M2 — the fail-closed default for the org-creation seam M34's provision worker consumes (§7.1 step 3).
// Unlike most deny-stubs this RETURNS `unavailable` rather than throwing: the contract's discriminated
// result is designed for graceful degradation (the worker branches on `kind`, never fabricates an org id,
// never fails open). M2 registers the real Drizzle-backed provider over this at init.
export const tenantOrgCreationProviderDenyStub: TenantOrgCreationProvider = {
  async createOrganizationForTenant() {
    return { kind: "unavailable", reason: "m2_org_creation_not_yet_locked" };
  },
};

/**
 * Generic fail-closed deny-stub for a seam whose interface is too rich to live in the leaf
 * @wardenx/types (so M1 cannot name it here). Every property access yields a function that
 * throws NotImplementedError, so an unregistered such seam denies LOUDLY on its first call
 * rather than failing open. M38's `TerminologyProvider` is the first of these (M40's
 * MdmEntityProvider/BaaStatusProvider and M36's AlertEmitter follow the same shape).
 */
function denyingSeamProxy(seam: SeamName): unknown {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new NotImplementedError(seam);
        };
      },
    },
  );
}

/** M38 — version-aware terminology resolution. Denies until M38 registers the real provider. */
export const terminologyProviderDenyStub: unknown = denyingSeamProxy("TerminologyProvider");

/** M36 — event → rules/recipients/fan-out. Denies until M36 registers the real emitter (T06). */
export const alertEmitterDenyStub: unknown = denyingSeamProxy("AlertEmitter");

/** M36 — channel/message surface (DEK-encrypted bodies). Denies until M36 registers the real
 *  provider (its DB-backed impl lands with the routes/realtime tasks, M36-T07/T08). */
export const messagingProviderDenyStub: unknown = denyingSeamProxy("MessagingProvider");

/** M40 — master-data read surface (physician/facility/payer; merge-aware). Denies until M40
 *  registers the real provider (M40-T05). */
export const mdmEntityProviderDenyStub: unknown = denyingSeamProxy("MdmEntityProvider");

/** M40 — focused §7.7 BAA disclosure gate (as-of). Denies until M40 registers the real provider
 *  (M40-T06). M22/M28/M29 consume this before any PHI leaves the perimeter. */
export const baaStatusProviderDenyStub: unknown = denyingSeamProxy("BaaStatusProvider");

/** M39 — the §4.3 disclosure/redaction gate. Rich-seam pattern (interface in @wardenx/consent).
 *  Denies until M39 registers the real evaluator (M39-T05). Every PHI-egress module consumes it. */
export const consentEvaluatorDenyStub: unknown = denyingSeamProxy("ConsentEvaluator");

// M6 (Admission) reader seams (§4.7). These are LEAF-TYPED (interfaces in @wardenx/types), so —
// unlike the opaque rich-seams above — they get concrete typed deny-stubs (like CaseloadProvider /
// PatientReader). Each denies LOUDLY until M6 registers the real Drizzle-backed reader (M6-T05).

/** M6 — election-period reads (M23 NOE/NOTR window math). Denies until M6 registers the real reader. */
export const electionPeriodReaderDenyStub: ElectionPeriodReader = {
  findActivePeriodForPatient() {
    throw new NotImplementedError("ElectionPeriodReader");
  },
  listPeriodsForAdmission() {
    throw new NotImplementedError("ElectionPeriodReader");
  },
};

/** M6 — CTI recert-gating reads. Denies until M6 registers the real reader. */
export const certificationReaderDenyStub: CertificationReader = {
  getActiveCertification() {
    throw new NotImplementedError("CertificationReader");
  },
  isCertificationSignedForPeriod() {
    throw new NotImplementedError("CertificationReader");
  },
};

/** M6 — F2F recert-gating reads. Denies until M6 registers the real reader. */
export const faceToFaceReaderDenyStub: FaceToFaceReader = {
  getAttestedF2fForPeriod() {
    throw new NotImplementedError("FaceToFaceReader");
  },
  isF2fAttestedForPeriod() {
    throw new NotImplementedError("FaceToFaceReader");
  },
};

/** M6 — level-of-care reads (current LOC + LOC-days, M26 cap). Denies until M6 registers the reader. */
export const levelOfCareReaderDenyStub: LevelOfCareReader = {
  getCurrentLevelOfCare() {
    throw new NotImplementedError("LevelOfCareReader");
  },
  getLevelOfCareDays() {
    throw new NotImplementedError("LevelOfCareReader");
  },
};

/** M6 — admission-status projection (M14/M30 queues). Denies until M6 registers the real reader. */
export const admissionStatusReaderDenyStub: AdmissionStatusReader = {
  getAdmissionSummary() {
    throw new NotImplementedError("AdmissionStatusReader");
  },
};

/** M6 — active-admission census/list. Denies until M6 registers the real reader. */
export const admissionCensusReaderDenyStub: AdmissionCensusReader = {
  listActiveAdmissions() {
    throw new NotImplementedError("AdmissionCensusReader");
  },
};

// M7 (Care Plan) reader seam (§7.8). LEAF-TYPED (interface in @wardenx/types), so — like M6's readers
// — it gets a concrete typed deny-stub. Denies LOUDLY until M7 registers the real reader (M7-T04).

/** M7 — encounter-relevance picker + the 5-/15-day overdue sign-gate. Denies until M7 registers it. */
export const carePlanReaderDenyStub: CarePlanReader = {
  relevantElementsForEncounter() {
    throw new NotImplementedError("CarePlanReader");
  },
  isReviewOverdue() {
    throw new NotImplementedError("CarePlanReader");
  },
};

// M8 (Encounters) owned seams (§4.7). LEAF-TYPED (interfaces in @wardenx/types) like M6/M7's readers,
// so each gets a concrete typed deny-stub. Denies LOUDLY until M8 registers the real impl (M8-T08).

/** M8 — per-encounter claim-line eligibility (M23/M24). Denies until M8 registers the real reader. */
export const billableEncounterReaderDenyStub: BillableEncounterReader = {
  billability() {
    throw new NotImplementedError("BillableEncounterReader");
  },
};

/** M8 — signed-encounter digests + render payload (M14 IDG, M22 PDF). Denies until M8 registers it. */
export const signedEncountersReaderDenyStub: SignedEncountersReader = {
  signedEncountersForPatientSince() {
    throw new NotImplementedError("SignedEncountersReader");
  },
  renderPayloadFor() {
    throw new NotImplementedError("SignedEncountersReader");
  },
};

/** M8 — authoritative per-clinician mileage for payroll/AP (M27). Denies until M8 registers it. */
export const mileagePayrollReaderDenyStub: MileagePayrollReader = {
  mileageForPayrollPeriod() {
    throw new NotImplementedError("MileagePayrollReader");
  },
};

/** M8 — open a draft encounter for an upstream reuser (M16/M17). Denies until M8 registers it. */
export const encounterCreatorDenyStub: EncounterCreator = {
  createDraftEncounter() {
    throw new NotImplementedError("EncounterCreator");
  },
};

// M18 (EVV) forward seam M8 CONSUMES (§4.7 / D9). LEAF-TYPED (interface in @wardenx/types), so it gets a
// concrete typed deny-stub. Denies LOUDLY until M18 registers the real resolver (Wave F); M8's
// EVV-missing-documented fallback path (route 10) stays operative while this denies.

/** M18 — authoritative EVV bracket for an encounter's visit at finalize (D9). Denies until M18 lands. */
export const evvBracketResolverDenyStub: EvvBracketResolver = {
  resolveBracket() {
    throw new NotImplementedError("EvvBracketResolver");
  },
};

// M18 (EVV) other five owned seams (§4.3 / D15). LEAF-TYPED (interfaces in @wardenx/types) like M6..M17's readers,
// so each gets a concrete typed deny-stub. Denies LOUDLY until M18 registers the real impls (M18-T05).

/** M18 — billing compliance gate (M23/M24 pre-submission) + M30 HQRP rate. Denies until M18 registers it. */
export const evvComplianceReaderDenyStub: EvvComplianceReader = {
  bracketStateForVisit() {
    throw new NotImplementedError("EvvComplianceReader");
  },
  complianceRateForWindow() {
    throw new NotImplementedError("EvvComplianceReader");
  },
};

/** M18 — per-state aggregator transaction-id back-link (M24 claim / M25 denial). Denies until M18 registers it. */
export const evvAggregatorReferenceReaderDenyStub: EvvAggregatorReferenceReader = {
  aggregatorIdForVisit() {
    throw new NotImplementedError("EvvAggregatorReferenceReader");
  },
  submissionForVisit() {
    throw new NotImplementedError("EvvAggregatorReferenceReader");
  },
};

/** M18 — last-known clinician location (M20 field-safety live-awareness). Denies until M18 registers it. */
export const evvLocationProviderDenyStub: EvvLocationProvider = {
  lastKnownLocationForClinician() {
    throw new NotImplementedError("EvvLocationProvider");
  },
  lastKnownLocationsForOrgShift() {
    throw new NotImplementedError("EvvLocationProvider");
  },
};

/** M18 — productivity + quality measures (M30/M33 dashboards). Denies until M18 registers it. */
export const evvMetricsProviderDenyStub: EvvMetricsProvider = {
  getComplianceRate() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
  getLateCheckoutRate() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
  getGeofenceDeviationRate() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
  getGpsSpoofingDetectedRate() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
  getAggregatorSubmissionSuccessRate() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
  getDeviceRegistrationCoverage() {
    throw new NotImplementedError("EvvMetricsProvider");
  },
};

/** M18 — portal arrival/verification surface (timestamp only, no coordinates). Denies until M18 registers it. */
export const evvVerificationProviderDenyStub: EvvVerificationProvider = {
  arrivalEventForVisit() {
    throw new NotImplementedError("EvvVerificationProvider");
  },
  visitVerificationSummaryForPortal() {
    throw new NotImplementedError("EvvVerificationProvider");
  },
};

// M9 (Clinical Assessments) owned seams (§4.7 / D7). LEAF-TYPED (interfaces in @wardenx/types) like
// M6/M7/M8's readers, so each gets a concrete typed deny-stub. Denies LOUDLY until M9 registers the real
// impls (M9-T04).

/** M9 — latest-active-per-scale read (CTI draft, IDG packet, HOPE context). Denies until M9 registers it. */
export const latestAssessmentProviderDenyStub: LatestAssessmentProvider = {
  latest() {
    throw new NotImplementedError("LatestAssessmentProvider");
  },
  latestBatch() {
    throw new NotImplementedError("LatestAssessmentProvider");
  },
};

/** M9 — windowed scored series + latest-vs-window delta (IDG/FHIR/AI). Denies until M9 registers it. */
export const scaleSeriesProviderDenyStub: ScaleSeriesProvider = {
  series() {
    throw new NotImplementedError("ScaleSeriesProvider");
  },
  delta() {
    throw new NotImplementedError("ScaleSeriesProvider");
  },
};

// M10 (HOPE Engine) owned seams (§2 / D10). LEAF-TYPED (interfaces in @wardenx/types) like M6/M7/M8/M9's
// readers, so each gets a concrete typed deny-stub. Denies LOUDLY until M10 registers the real impls
// (M10-T05).

/** M10 — open/all timepoint windows + completion state (IDG, PDF timeline, HQRP, AI). Denies until M10 registers it. */
export const hopeTimepointProviderDenyStub: HopeTimepointProvider = {
  openTimepoints() {
    throw new NotImplementedError("HopeTimepointProvider");
  },
  forAdmission() {
    throw new NotImplementedError("HopeTimepointProvider");
  },
};

/** M10 — J2051 trigger history + open SFV obligations (HQRP Timely-Follow-Up, AI trajectory). Denies until M10 registers it. */
export const hopeJ2051ProviderDenyStub: HopeJ2051Provider = {
  history() {
    throw new NotImplementedError("HopeJ2051Provider");
  },
  openSfvs() {
    throw new NotImplementedError("HopeJ2051Provider");
  },
};

/** M10 — per-PE submission batch status (HQRP acceptance posture, submission dashboards). Denies until M10 registers it. */
export const hopeSubmissionProviderDenyStub: HopeSubmissionProvider = {
  latestForProviderEntity() {
    throw new NotImplementedError("HopeSubmissionProvider");
  },
  submission() {
    throw new NotImplementedError("HopeSubmissionProvider");
  },
};

// M11 (Orders) owned seams (§2.8 D14 / §4.3). LEAF-TYPED (interfaces in @wardenx/types) like M6..M10's
// seams, so each gets a concrete typed deny-stub. Denies LOUDLY until M11 registers the real impls (M11-T05).

/** M11 — the polymorphic signature-write primitive (sign / verbal / cosign / discontinue; M12 med-orders).
 * Denies until M11 registers it; a fail-closed signature surface NEVER silently records a clinical signature. */
export const orderSignatureProviderDenyStub: OrderSignatureProvider = {
  signOrderTarget() {
    throw new NotImplementedError("OrderSignatureProvider");
  },
  recordVerbalOrder() {
    throw new NotImplementedError("OrderSignatureProvider");
  },
  cosignOrder() {
    throw new NotImplementedError("OrderSignatureProvider");
  },
  discontinueOrder() {
    throw new NotImplementedError("OrderSignatureProvider");
  },
};

/** M11 — the order read seam (active / by-patient / since / verbal-timeliness / discontinuation). Denies
 * until M11 registers it (M14/M23/M30/M7 resolve the real impl). */
export const orderProviderDenyStub: OrderProvider = {
  findActiveOrder() {
    throw new NotImplementedError("OrderProvider");
  },
  listByPatient() {
    throw new NotImplementedError("OrderProvider");
  },
  listByAdmission() {
    throw new NotImplementedError("OrderProvider");
  },
  getOrdersSince() {
    throw new NotImplementedError("OrderProvider");
  },
  getDiscontinuationReason() {
    throw new NotImplementedError("OrderProvider");
  },
  getVerbalOrderTimeliness() {
    throw new NotImplementedError("OrderProvider");
  },
  findByTriggeringAssessment() {
    throw new NotImplementedError("OrderProvider");
  },
  findByCarePlanIntervention() {
    throw new NotImplementedError("OrderProvider");
  },
};

// M12 (DoseSpot Integration) owned seams (§2.10 D17). LEAF-TYPED (interfaces in @wardenx/types) like M6..M11's
// seams, so each gets a concrete typed deny-stub. Both are READ-only surfaces over M12's `medication_order` /
// `refill_request` tables; deny LOUDLY until M12 registers the real impls (M12-T07).

/** M12 — the medication-order read seam (active / since / admin-context / controlled flag / cost / portal /
 * FHIR) M13/M14/M19/M28/M30/M31/M33 consume. Denies until M12 registers it (no silent empty medication list). */
export const medicationOrderProviderDenyStub: MedicationOrderProvider = {
  getActiveMedications() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getMedicationsSince() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getMedicationOrder() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  listForAdmission() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getAdministrationContext() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getControlledSubstanceFlag() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getComfortKitDeploymentTimeline() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getCostBasisSummary() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  getPortalMedicationSummary() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
  asFhirMedicationRequest() {
    throw new NotImplementedError("MedicationOrderProvider");
  },
};

/** M12 — the refill-inbox read seam (pending-by-prescriber / pending-by-patient / by-id) the prescriber
 * inbox UI, M19 (on-call), and M33 (SLA dashboards) consume. Denies until M12 registers it. */
export const refillInboxProviderDenyStub: RefillInboxProvider = {
  getPendingRefillsForPrescriber() {
    throw new NotImplementedError("RefillInboxProvider");
  },
  getPendingRefillsForPatient() {
    throw new NotImplementedError("RefillInboxProvider");
  },
  getRefillRequestById() {
    throw new NotImplementedError("RefillInboxProvider");
  },
};

// M13 (eMAR & Med Administration) owned seams (§2.12 D16). LEAF-TYPED (interfaces in @wardenx/types) like
// M6..M12's seams, so each gets a concrete typed deny-stub. Both are READ-only surfaces over M13's
// `administration_record` / `medication_reconciliation_*` tables; deny LOUDLY until M13 registers the real
// impls (M13-T07).

/** M13 — the medication-administration read seam (by-id / by-patient / by-order / since / PRN-effectiveness /
 * comfort-kit timeline / missed-dose / portal summary / IV session / FHIR) M14/M28/M30/M31/M33/M37 consume.
 * Denies until M13 registers it (no silent empty administration history). */
export const medicationAdministrationProviderDenyStub: MedicationAdministrationProvider = {
  getAdministration() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getAdministrationsForPatient() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getAdministrationsForOrder() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getAdministrationsSince() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getPrnEffectivenessSummary() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getComfortKitDeploymentTimeline() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getMissedDoseSummary() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getPortalAdministrationSummary() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getIvContinuousSession() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  asFhirMedicationAdministration() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
};

/** M13 — the reconciliation-worksheet read seam (worksheet by-id / by-admission / reconciliation-timeliness)
 * M14 (IDG packet) and M30 (timeliness measure) consume. Denies until M13 registers it. */
export const reconciliationProviderDenyStub: ReconciliationProvider = {
  getWorksheet() {
    throw new NotImplementedError("ReconciliationProvider");
  },
  getWorksheetsForAdmission() {
    throw new NotImplementedError("ReconciliationProvider");
  },
  getReconciliationTimelinessByAdmission() {
    throw new NotImplementedError("ReconciliationProvider");
  },
};

/** M14 — the packet read seam (snapshot by-id + the M22 deterministic render payload) M22/M33 consume.
 * Denies until M14 registers it (M14-T05). */
export const idgPacketProviderDenyStub: IdgPacketProvider = {
  getPacketSnapshot() {
    throw new NotImplementedError("IdgPacketProvider");
  },
  renderPayloadFor() {
    throw new NotImplementedError("IdgPacketProvider");
  },
};

/** M14 — the decision read seam (by-care-plan / by-meeting) M30 (decision-latency measure) / M33 consume.
 * Denies until M14 registers it (M14-T05). */
export const idgDecisionProviderDenyStub: IdgDecisionProvider = {
  getDecisionsForCarePlan() {
    throw new NotImplementedError("IdgDecisionProvider");
  },
  getDecisionsForMeeting() {
    throw new NotImplementedError("IdgDecisionProvider");
  },
};

/** M14 — the schedule read seam (meetings-for-location / 15-day-cadence-adherence) M28/M30/M33 consume.
 * Denies until M14 registers it (M14-T05). */
export const idgScheduleProviderDenyStub: IdgScheduleProvider = {
  listMeetingsForLocation() {
    throw new NotImplementedError("IdgScheduleProvider");
  },
  getCadenceAdherence() {
    throw new NotImplementedError("IdgScheduleProvider");
  },
};

/** M17 — the visit read seam (encounter context / EVV geofence target / IDG since-meeting) M8/M18/M14 consume.
 * Denies until M17 registers it (M17-T05). */
export const visitReaderDenyStub: VisitReader = {
  visitForEncounter() {
    throw new NotImplementedError("VisitReader");
  },
  visitsScheduledForMembershipOnDate() {
    throw new NotImplementedError("VisitReader");
  },
  completedVisitsForPatientSince() {
    throw new NotImplementedError("VisitReader");
  },
};

/** M17 — the assignment read seam (§4.5 D11 caseload contribution / on-call roster / live in_visit) M5/M19/M20
 * consume. Denies until M17 registers it (M17-T05). */
export const visitAssignmentReaderDenyStub: VisitAssignmentReader = {
  activeVisitsForMembershipOnDate() {
    throw new NotImplementedError("VisitAssignmentReader");
  },
  tonightsOnCallRoster() {
    throw new NotImplementedError("VisitAssignmentReader");
  },
  currentVisitForClinician() {
    throw new NotImplementedError("VisitAssignmentReader");
  },
};

/** M17 — the portal upcoming-visit read seam (lay-language, scheduler-internal notes scrubbed) M31 consumes.
 * Denies until M17 registers it (M17-T05). */
export const portalVisitReaderDenyStub: PortalVisitReader = {
  upcomingForPatient() {
    throw new NotImplementedError("PortalVisitReader");
  },
};

/** M17 — the productivity + quality measures read seam (on-time / no-show / reschedule / route / stability)
 * M30/M33 consume. Denies until M17 registers it (M17-T05). */
export const visitMetricsProviderDenyStub: VisitMetricsProvider = {
  getOnTimeVisitRate() {
    throw new NotImplementedError("VisitMetricsProvider");
  },
  getNoShowRate() {
    throw new NotImplementedError("VisitMetricsProvider");
  },
  getRescheduleRate() {
    throw new NotImplementedError("VisitMetricsProvider");
  },
  getRouteEfficiencyForMembership() {
    throw new NotImplementedError("VisitMetricsProvider");
  },
  getScheduleStabilityIndex() {
    throw new NotImplementedError("VisitMetricsProvider");
  },
};

// M15 (Discipline Care Plans, Phase 2) seams M17 CONSUMES (§4.4). LEAF-TYPED (interfaces in @wardenx/types),
// so each gets a concrete typed deny-stub. Per M17-F06/ADR-0009 M17 (Phase 1) no longer hard-requires M15 to
// boot — these stand fail-closed until M15 ships. The volunteer gate denies LOUDLY exactly when a
// `volunteer_visit` is scheduled before M15 lands (a non-volunteer visit never invokes predicate 6, M17-T06).

/** M15 — effective volunteer-compliance status (the D8 gate predicate-6 input). Denies until M15 registers it. */
export const volunteerComplianceProviderDenyStub: VolunteerComplianceProvider = {
  effectiveStatusFor() {
    throw new NotImplementedError("VolunteerComplianceProvider");
  },
};

/** M15 — next-due RN supervisory visit per admission (day-view advisory). Denies until M15 registers it. */
export const supervisoryCadenceReaderDenyStub: SupervisoryCadenceReader = {
  nextSupervisoryDueAt() {
    throw new NotImplementedError("SupervisoryCadenceReader");
  },
};

/**
 * Boot hook for Phase-1 seam registration. Each producer module registers its REAL seam
 * implementation here (or from its own init), e.g. M5 `registerSeam("CaseloadProvider", …)`.
 * M1 (this file) may not import a downstream module, so the actual producer registrations
 * are driven from the composition root (apps/backend/src/index.ts `wireModuleSeams`) via the
 * `registerModuleSeams` boot hook — which runs after this no-op and before validateSeams().
 * For any seam still unregistered, `validateSeams()` applies the REQUIRED_SEAMS deny-stub
 * default, leaving it wired FAIL-CLOSED (present, but throwing on call). This hook still runs
 * in the boot sequence so the M1-local wiring site stays explicit.
 */
export function wireSeams(): void {
  // Phase 1 producer registrations driven from the composition root, ahead of validateSeams():
  //   M2 registerIdentitySeams()  →  registerSeam("SessionContextResolver" | "AuditorSessionMinter", …)
  //   M5 registerSeam("CaseloadProvider" | "PatientReader", …)
  //   M22 registerSeam("DocumentRenderer", …) · M39 registerSeam("ConsentEvaluator", …)
}
