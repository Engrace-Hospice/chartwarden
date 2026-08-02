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
  BereavedPortalScopeProvider,
  BereavementAssignmentReader,
  BereavementComplianceProvider,
  BereavementOutreachProvider,
  BereavementPlanProvider,
  BereavementRiskFactorsProvider,
  BereavementRiskTierProvider,
  BillableEncounterReader,
  CarePlanReader,
  CaseloadProvider,
  CertificationReader,
  DeathDischargeReader,
  ComfortKitDispatchProvider,
  DisciplineComplianceProvider,
  DisciplinePlanReader,
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
  FhirClientReader,
  FhirGatewayMetricsProvider,
  FhirInboundProposalReader,
  HopeJ2051Provider,
  HopeOrgRollupProvider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
  HospitalizationRiskProvider,
  IdgDecisionProvider,
  IdgPacketProvider,
  IdgScheduleProvider,
  IntakeMetricsProvider,
  LatestAssessmentProvider,
  LevelOfCareReader,
  MedicationAdministrationProvider,
  MedicationOrderProvider,
  MileagePayrollReader,
  MswRiskFactorReader,
  OnCallProvider,
  OrderProvider,
  OrderSignatureProvider,
  PatientCoverageReader,
  PatientMutator,
  PatientReader,
  PortalDocumentReader,
  PortalTriageReader,
  PortalVisitReader,
  ProtocolSuggestionProvider,
  ReconciliationProvider,
  RefillInboxProvider,
  RenderedDocumentProvider,
  SafetyCheckInProvider,
  SafetyContextReader,
  SafetyDashboardProvider,
  SafetyIncidentReader,
  SafetyMetricsProvider,
  SafetyPolicyProvider,
  SafetySupervisorProvider,
  ScaleSeriesProvider,
  SeamName,
  SessionContextResolver,
  SignedEncountersReader,
  SupplyCostProvider,
  SupplyFulfillmentProvider,
  SupervisoryCadencePlanReader,
  SupervisoryCadenceReader,
  TenantOrgCreationProvider,
  TriageCallMetricsProvider,
  TriageCallProvider,
  TriageCallReader,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
  VolunteerComplianceProvider,
  VolunteerGateExpiryReader,
} from "../interfaces";
// M32-T06 — the §2.2/W9 refusal envelope M32's ten inference deny-stubs answer with. A LEAF type
// (`@wardenx/types`), imported directly rather than through `../interfaces` because it is not a seam
// contract: it is the value those seams return. M1 may not import `@wardenx/ai-platform`, which is
// exactly why T01 put this shape in the leaf.
import type { AiCapabilityUnavailable } from "@wardenx/types";

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

/**
 * M5 §3.4 — the coverage read M23/M24 resolve a claim's payer from. Fail-closed: an unregistered
 * reader denies loudly, so claim assembly reports "coverage unresolved" rather than billing a claim
 * against a payer nobody confirmed.
 */
export const patientCoverageReaderDenyStub: PatientCoverageReader = {
  coveragesForPatient() {
    throw new NotImplementedError("PatientCoverageReader");
  },
  activeCoverageOfKind() {
    throw new NotImplementedError("PatientCoverageReader");
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

/** M33 — the embedded dashboard-metric read seam. Opaque rich-seam (interface in @wardenx/reporting).
 *  Denies until M33 registers the real provider (which returns forward-seam-empty until its MVs populate). */
export const metricsProviderDenyStub: unknown = denyingSeamProxy("MetricsProvider");

/** M26 — the cap-period aggregate read for the M27 cost-report cap calc. Opaque rich-seam (interface in
 *  @wardenx/cap-management). Denies until M26 registers the real provider (db-present boot). */
export const capAccrualReaderDenyStub: unknown = denyingSeamProxy("CapAccrualReader");

/** M26 — the agency/patient/inpatient cap projection for the M23 §11.A cap rules. Opaque rich-seam. The M23
 *  adapter catches this deny-stub throw and DEGRADES to `status:"unavailable"` (warn, not block, per D8). */
export const capProjectionProviderDenyStub: unknown = denyingSeamProxy("CapProjectionProvider");

/** M23 — billed-and-accepted census patient-days for a FY. Opaque rich-seam; M27's ValidationContextBuilder
 *  catches this deny-stub throw and leaves `billedCensusPatientDays` null (the reconcile rule SKIPS). */
export const patientDaysProviderDenyStub: unknown = denyingSeamProxy("PatientDaysProvider");

/** M12 — drug-cost basis for a FY (M27 Worksheet-A pharmacy cross-check). RESERVATION deny-stub: hospice
 *  billing is per-diem (no M23 drug line) and `medication_orders` has no cost column yet, so this stays
 *  fail-closed until M12 materializes med-order cost; M27 degrades to `drugCostBillingReaderBound:false`
 *  (the drug-reconcile rule SKIPS). */
export const drugCostBillingReaderDenyStub: unknown = denyingSeamProxy("DrugCostBillingReader");

/** M25 — actual interim Medicare payments (835 CLP04) for a FY. Opaque rich-seam; M27 degrades to
 *  `claimSettlementProviderBound:false` (the E-1↔D tie rule SKIPS) when this denies. */
export const claimSettlementProviderDenyStub: unknown = denyingSeamProxy("ClaimSettlementProvider");

/** M23 — the per-LOC billed claim-line day rollup for a window, the M30 HCI claims-derived indicators'
 *  input. Opaque rich-seam; M30's adapter catches this deny-stub throw and DEGRADES to the forward-seam
 *  "unavailable" marker so the indicator is SUPPRESSED, never computed from a fabricated claims number. */
export const claimLineReaderDenyStub: unknown = denyingSeamProxy("ClaimLineReader");

/** M27 — the cost-report filing posture per FY, the M30 CoP 418.310 failure-to-file indicator's input.
 *  Opaque rich-seam; same degrade-to-suppressed contract as ClaimLineReader above. */
export const costReportFilingStatusReaderDenyStub: unknown = denyingSeamProxy("CostReportFilingStatusReader");

/** M30 §4.3 — the five HQRP/Quality read seams. Opaque rich-seams (interfaces in @wardenx/quality);
 *  M22 / M28 / M33 / M34 resolve via `getSeam` + cast. Deny until M30 registers the live Drizzle-backed
 *  providers (db-present boot) — a quality number is never fabricated when the seam is unbound (D6/D13). */
export const qualityMeasureProviderDenyStub: unknown = denyingSeamProxy("QualityMeasureProvider");
export const incidentRegisterProviderDenyStub: unknown = denyingSeamProxy(
  "IncidentRegisterProvider",
);
export const qapiProjectProviderDenyStub: unknown = denyingSeamProxy("QapiProjectProvider");
export const complianceStatusProviderDenyStub: unknown = denyingSeamProxy(
  "ComplianceStatusProvider",
);
export const securityRiskAssessmentReaderDenyStub: unknown = denyingSeamProxy(
  "SecurityRiskAssessmentReader",
);

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

// ── M28 (FHIR Gateway) §4.3 published + §4.4 forward-consumed deny-stubs (M28-T06) ──────────────────────

/** M28 §4.3 — per-tenant utilization + the §164.528 disclosure metric. Leaf-typed; denies until M28
 *  registers the real Drizzle-backed provider over its own tables (M28-T08). */
export const fhirGatewayMetricsProviderDenyStub: FhirGatewayMetricsProvider = {
  async metricsForOrg() {
    throw new NotImplementedError("FhirGatewayMetricsProvider");
  },
  async disclosureMetricsForOrg() {
    throw new NotImplementedError("FhirGatewayMetricsProvider");
  },
};

/** M28 §4.3 — the FHIR client registry read (M34 SaaS console). Denies until M28 registers the real reader. */
export const fhirClientReaderDenyStub: FhirClientReader = {
  async clientsForOrg() {
    throw new NotImplementedError("FhirClientReader");
  },
  async clientDetail() {
    throw new NotImplementedError("FhirClientReader");
  },
};

/** M28 §4.3 — the staged inbound-proposal review queue (M5/M12). Denies until M28 registers the real reader. */
export const fhirInboundProposalReaderDenyStub: FhirInboundProposalReader = {
  async pendingForOwnerModule() {
    throw new NotImplementedError("FhirInboundProposalReader");
  },
  async proposalDetail() {
    throw new NotImplementedError("FhirInboundProposalReader");
  },
};

/** M23 — the W-FHIR-07 Claim/ClaimResponse/EOB FHIR projection M28 CONSUMES. Opaque rich-seam; the M28
 *  Claim/EOB routes short-circuit to 404 (§7.7) while `fhir.write` is OFF and never reach it, but the seam
 *  is required so a boot without M23's D1 unlock fails CLOSED rather than serving a Phase-2 resource. */
export const claimReaderDenyStub: unknown = denyingSeamProxy("ClaimReader");

/** M29 — the §4.11 DiagnosticReport result-value read M28 CONSUMES. Opaque rich-seam; M29 is a Phase-1
 *  placeholder, so this stays fail-closed and M28's DiagnosticReport projection refuses at egress until
 *  M29 registers the real reader. */
export const labObservationReaderDenyStub: unknown = denyingSeamProxy("LabObservationReader");

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

/** M6 — death-discharge census for a period (M30 HVLDL denominator, §4.11). Denies until M6 registers it. */
export const deathDischargeReaderDenyStub: DeathDischargeReader = {
  listDeathDischargesInPeriod() {
    throw new NotImplementedError("DeathDischargeReader");
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
  fifteenDayCycleCountsForOrg() {
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
  lateEntryCountsForOrg() {
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
  getComplianceCounts() {
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

/** M10 — ORG-LEVEL aggregate HOPE rollup (M30 measure-recompute; aggregate-only COUNTS, D6). Denies until M10 registers it. */
export const hopeOrgRollupProviderDenyStub: HopeOrgRollupProvider = {
  timepointCompletionRollup() {
    throw new NotImplementedError("HopeOrgRollupProvider");
  },
  submissionPostureRollup() {
    throw new NotImplementedError("HopeOrgRollupProvider");
  },
  sfvTimelinessRollup() {
    throw new NotImplementedError("HopeOrgRollupProvider");
  },
  j2051FollowUpRollup() {
    throw new NotImplementedError("HopeOrgRollupProvider");
  },
  openSfvObligationCount() {
    throw new NotImplementedError("HopeOrgRollupProvider");
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
  getOrder() {
    throw new NotImplementedError("OrderProvider");
  },
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
  getVerbalTimelinessCountsForOrg() {
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
  getMissedDoseCountsForOrg() {
    throw new NotImplementedError("MedicationAdministrationProvider");
  },
  getPrnEffectivenessCountsForOrg() {
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
  getCadenceCountsForOrg() {
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
  getOnTimeVisitCounts() {
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

// M15 (Discipline Care Plans) seams M17 CONSUMES (§4.4). LEAF-TYPED (interfaces in @wardenx/types), so each
// gets a concrete typed deny-stub. Per M17-F06/ADR-0009 M17 (Phase 1) never hard-required M15 to boot — these
// stand fail-closed for any boot that does not wire M15 (registerDisciplinePlanSeams, M15-T05). The volunteer
// gate denies LOUDLY exactly when a `volunteer_visit` is scheduled without M15 wired (a non-volunteer visit
// never invokes predicate 6, M17-T06).

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

// The rest of M15's §4.3 PUBLISHED surface (M15-T05). All read-only; each denies until
// registerDisciplinePlanSeams() stands the real impl over it.

/** M15 — the discipline-plan read path M14's IDG packet builder + M22/M28/M31/M33 consume (§4.3). */
export const disciplinePlanReaderDenyStub: DisciplinePlanReader = {
  activePlansForPatient() {
    throw new NotImplementedError("DisciplinePlanReader");
  },
  planById() {
    throw new NotImplementedError("DisciplinePlanReader");
  },
  planSummaryForIdg() {
    throw new NotImplementedError("DisciplinePlanReader");
  },
};

/** M15 — the MSW psychosocial risk factors M16's bereavement rubric scores (§4.3; M15 never scores, §1.2). */
export const mswRiskFactorReaderDenyStub: MswRiskFactorReader = {
  riskFactorsForAdmission() {
    throw new NotImplementedError("MswRiskFactorReader");
  },
};

/** M15 — the 42 CFR §418.78 gate-expiry sweep (coordinator worklist + the §4.7 M36 alerts). */
export const volunteerGateExpiryReaderDenyStub: VolunteerGateExpiryReader = {
  listExpiringGates() {
    throw new NotImplementedError("VolunteerGateExpiryReader");
  },
};

/** M15 — the per-PLAN 418.76(h) cadence state + overdue worklist (M14 dashboard, M30 supervisory measure). */
export const supervisoryCadencePlanReaderDenyStub: SupervisoryCadencePlanReader = {
  nextSupervisoryDueFor() {
    throw new NotImplementedError("SupervisoryCadencePlanReader");
  },
  listOverdueSupervisory() {
    throw new NotImplementedError("SupervisoryCadencePlanReader");
  },
};

/** M15 — the M30 HQRP / M33 dashboard compliance rollups + the 418.78(e) ratio (§4.3). */
export const disciplineComplianceProviderDenyStub: DisciplineComplianceProvider = {
  supervisoryOnTimeRate() {
    throw new NotImplementedError("DisciplineComplianceProvider");
  },
  mswInitialOnTimeRate() {
    throw new NotImplementedError("DisciplineComplianceProvider");
  },
  chaplainInitialOnTimeRate() {
    throw new NotImplementedError("DisciplineComplianceProvider");
  },
  volunteerGateComplianceRate() {
    throw new NotImplementedError("DisciplineComplianceProvider");
  },
  volunteerHourCostRatio() {
    throw new NotImplementedError("DisciplineComplianceProvider");
  },
};

// M16 (Bereavement) §4.6 / D13 PUBLISHED seams (M16-T05). LEAF-TYPED (interfaces in @wardenx/types), so each
// gets a concrete typed deny-stub that denies until `registerBereavementSeams()` stands the real impl over it.
// A deny here is the right answer for every consumer: M36 must not open a bereavement channel it cannot prove
// a window for, M31 must not mint a bereaved-family session scope it cannot resolve, and M30/M33 must show a
// measure as UNAVAILABLE rather than as a zero the agency did not earn.

/** M16 — the plan header / roster / closeout rollup (M28 FHIR, M30 HQRP, M31 portal, M33, M36 channel). */
export const bereavementPlanProviderDenyStub: BereavementPlanProvider = {
  planById() {
    throw new NotImplementedError("BereavementPlanProvider");
  },
  planByAdmissionId() {
    throw new NotImplementedError("BereavementPlanProvider");
  },
  isInBereavementWindow() {
    throw new NotImplementedError("BereavementPlanProvider");
  },
  contactsForPlan() {
    throw new NotImplementedError("BereavementPlanProvider");
  },
  summarize() {
    throw new NotImplementedError("BereavementPlanProvider");
  },
};

/** M16 — the touchpoint reads + the CoP 418.64(d) counts (M30's rate, M33's operational dashboard). */
export const bereavementOutreachProviderDenyStub: BereavementOutreachProvider = {
  listForPlan() {
    throw new NotImplementedError("BereavementOutreachProvider");
  },
  countByStatus() {
    throw new NotImplementedError("BereavementOutreachProvider");
  },
  copComplianceCounts() {
    throw new NotImplementedError("BereavementOutreachProvider");
  },
};

/** M16 — the D3/D17 factor snapshot + deterministic score + the M32 Layer-2 append (§4.6's one write). */
export const bereavementRiskFactorsProviderDenyStub: BereavementRiskFactorsProvider = {
  factorsForContact() {
    throw new NotImplementedError("BereavementRiskFactorsProvider");
  },
  deterministicScore() {
    throw new NotImplementedError("BereavementRiskFactorsProvider");
  },
  registerAugmentation() {
    throw new NotImplementedError("BereavementRiskFactorsProvider");
  },
};

/** M16 — plan assignment + counselor caseload (M36's recipient resolver, M3's `bereavement_window`). */
export const bereavementAssignmentReaderDenyStub: BereavementAssignmentReader = {
  assignmentForPlan() {
    throw new NotImplementedError("BereavementAssignmentReader");
  },
  plansForCounselor() {
    throw new NotImplementedError("BereavementAssignmentReader");
  },
};

/** M16 — the M31 bereaved-family session scope (§1.2 / D10 narrow: own row, own touchpoints, opt-out). */
export const bereavedPortalScopeProviderDenyStub: BereavedPortalScopeProvider = {
  scopeForPortalAccount() {
    throw new NotImplementedError("BereavedPortalScopeProvider");
  },
};

/** M16 — the M30 HQRP measure inputs + M33 rollups, as COUNTS (never a pre-divided rate). */
export const bereavementComplianceProviderDenyStub: BereavementComplianceProvider = {
  copOutreachCounts() {
    throw new NotImplementedError("BereavementComplianceProvider");
  },
  riskScreeningCompletenessCounts() {
    throw new NotImplementedError("BereavementComplianceProvider");
  },
  planClosureCounts() {
    throw new NotImplementedError("BereavementComplianceProvider");
  },
};

/** M16 — the risk-tier distribution (M30's chart, M33's dashboard). */
export const bereavementRiskTierProviderDenyStub: BereavementRiskTierProvider = {
  tierDistribution() {
    throw new NotImplementedError("BereavementRiskTierProvider");
  },
};

// M21 (Supplies, DME & Comfort Kits) §4.8 / D14 PUBLISHED seams (M21-T05). LEAF-TYPED (interfaces in
// @wardenx/types), so each gets a concrete typed deny-stub that denies until `registerSuppliesSeams()`
// stands the real impl over it. A deny is the right answer for every consumer here, and one of them is
// safety-critical: M13 must NOT be told a comfort kit's controlled-substance inventory is empty when the
// truth is that M21 could not answer. An empty list would read at the bedside as "there is no morphine in
// this kit"; a throw reads as "ask again".
export const supplyFulfillmentProviderDenyStub: SupplyFulfillmentProvider = {
  createDirectSupplyRequest() {
    throw new NotImplementedError("SupplyFulfillmentProvider");
  },
  getSupplyRequestStatus() {
    throw new NotImplementedError("SupplyFulfillmentProvider");
  },
  isTerminal() {
    throw new NotImplementedError("SupplyFulfillmentProvider");
  },
};

/** M21 — bedside kit inventory + lot detail + the D17 IPU-room stock kit (M13, M27, M30, M33, M37). */
export const comfortKitDispatchProviderDenyStub: ComfortKitDispatchProvider = {
  listActiveDispatchesForPatient() {
    throw new NotImplementedError("ComfortKitDispatchProvider");
  },
  getDispatchDetail() {
    throw new NotImplementedError("ComfortKitDispatchProvider");
  },
  getIpuRoomKitInventory() {
    throw new NotImplementedError("ComfortKitDispatchProvider");
  },
  notifyAdministrationDrawdown() {
    throw new NotImplementedError("ComfortKitDispatchProvider");
  },
};

/** M21 — per-patient / per-org supply spend in integer CENTS (M23 cap analysis, M27 cost report). */
export const supplyCostProviderDenyStub: SupplyCostProvider = {
  getPatientSupplyCostSummary() {
    throw new NotImplementedError("SupplyCostProvider");
  },
  getOrgSupplySpendSummary() {
    throw new NotImplementedError("SupplyCostProvider");
  },
};

// M19 (On-Call Triage) §4.3 PUBLISHED seams (M19-T06). LEAF-TYPED (interfaces in @wardenx/types), so each
// gets a concrete typed deny-stub that denies until `registerOncallSeams()` stands the real impl over it.
//
// ALL FIVE THROW, and `OnCallProvider` is the one that decides the shape. It answers "who is on call right
// now" for M36's alert routing and M20's after-hours SOS. An unregistered/unreadable M19 must NOT resolve to
// an empty actor list: `[]` is a real, meaningful answer there — it means a COVERAGE GAP, the thing the §4.8
// watchdog exists to alert on — and returning it on an outage would silently swallow a 2 a.m. escalation
// into "nobody was on call". A throw is what lets M36 fall back to its degraded alert path (the same
// distinction `OnCallRosterRead` draws on the consumed side, M19-T04).
export const onCallProviderDenyStub: OnCallProvider = {
  currentOnCallActors() {
    throw new NotImplementedError("OnCallProvider");
  },
  activeShiftsAt() {
    throw new NotImplementedError("OnCallProvider");
  },
};

/** M19 — M32's PHI-free feature read + M14's since-last-IDG digest. */
export const triageCallReaderDenyStub: TriageCallReader = {
  recentCallsForPatient() {
    throw new NotImplementedError("TriageCallReader");
  },
  callsForPatientSince() {
    throw new NotImplementedError("TriageCallReader");
  },
};

/** M19 — M14's full packet slice + M11's verbal-order → triage-context reverse lookup. */
export const triageCallProviderDenyStub: TriageCallProvider = {
  callForPacket() {
    throw new NotImplementedError("TriageCallProvider");
  },
  triageContextForVerbalOrder() {
    throw new NotImplementedError("TriageCallProvider");
  },
};

/** M19 — the ONLY M19 surface M31's portal may reach (lay-language, D11/D13 scrubbed). */
export const portalTriageReaderDenyStub: PortalTriageReader = {
  summaryForPatient() {
    throw new NotImplementedError("PortalTriageReader");
  },
};

/** M19 — M30/M33 operational + quality measures. Throws rather than answering 0: a zeroed p95 or a
 *  fabricated `{numerator:0, denominator:0}` is a reportable misstatement on a quality surface, not a
 *  degraded read (the M21 `SupplyCostProvider` posture, for the same reason). */
export const triageCallMetricsProviderDenyStub: TriageCallMetricsProvider = {
  getResponseTimeP95() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getHospitalizationAvoidanceRate() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getHospitalizationAvoidanceCounts() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getEscalationDistribution() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getAfterHoursVisitConversionRate() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getAfterHoursVisitConversionCounts() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getChiefComplaintPareto() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
  getCoverageGapMinutes() {
    throw new NotImplementedError("TriageCallMetricsProvider");
  },
};

// M32 (AI Platform) — the two ADVISORY seams M19 consumes (§4.4 / §8.6, D11/D12). Non-throwing deny-stubs,
// deliberately, on the `tenantOrgCreationProviderDenyStub` precedent above: the contract's own discriminated
// result is the degradation path, so denying is expressed as a VALUE rather than an exception.
//
// Every other seam here guards a fact a caller acts on, so denying is the safe direction. These two guard
// an ADVISORY that architecture §17 / D11 / D12 forbid from gating anything: the clinician selects the
// protocol and the disposition either way. Throwing would let an unlanded M32 take down the 2 a.m.
// call-open path on behalf of a banner. §8.6 is explicit about the alternative — with M32 deny-stubbed the
// AI block renders "visibly disabled — no silent fallback or guess" and `m19_ai_block_disabled_total`
// counts it — which needs `unavailable` to arrive as a VALUE the caller can branch on, distinct from the
// model genuinely having no suggestion. `provider_unregistered` is exactly what these are.
export const protocolSuggestionProviderDenyStub: ProtocolSuggestionProvider = {
  async suggestProtocol() {
    return { kind: "unavailable", reason: "provider_unregistered" };
  },
};

/** M32 — D11's 30-day risk band. Same non-throwing advisory posture as its sibling above. */
export const hospitalizationRiskProviderDenyStub: HospitalizationRiskProvider = {
  async hospitalizationRiskForPatient() {
    return { kind: "unavailable", reason: "provider_unregistered" };
  },
};

// M20 (Field Safety) §4.3 PUBLISHED seams (M20-T05). LEAF-TYPED (interfaces in @wardenx/types), so each
// gets a concrete typed deny-stub that denies until `registerFieldSafetySeams()` stands the real impl over
// it.
//
// ALL SEVEN THROW, and the two that decide the shape are `SafetyDashboardProvider` and
// `SafetySupervisorProvider`. Both have an EMPTY answer that means something specific and load-bearing:
// an empty board means "no clinician is in the field", and an empty recipient set means "nobody is
// subscribed to this clinician" — which is the §7.8 coverage gap the system-locked critical alert wakes
// the DON for. Resolving an unregistered or unreadable M20 to `[]` would make an outage indistinguishable
// from either fact: a supervisor asking "is everyone OK?" would read a blank board as "everyone is fine",
// and a 3 a.m. SOS would conclude it has no recipients instead of falling back to the tenant emergency
// number (M20-F01). A throw is what makes the caller render UNKNOWN and take its degraded path — the
// M19-T08 three-state banner rule, one layer down.
export const safetyDashboardProviderDenyStub: SafetyDashboardProvider = {
  clinicianStatusForLocation() {
    throw new NotImplementedError("SafetyDashboardProvider");
  },
  clinicianStatusForSupervisor() {
    throw new NotImplementedError("SafetyDashboardProvider");
  },
};

/** M20 — M8's encounter-authoring surface: was there an incident during the visit being documented? */
export const safetyContextReaderDenyStub: SafetyContextReader = {
  activeIncidentForVisit() {
    throw new NotImplementedError("SafetyContextReader");
  },
  activeIncidentsForClinicianToday() {
    throw new NotImplementedError("SafetyContextReader");
  },
};

/** M20 — M32's §8.6 minimum-necessary incident projection (rounded coordinates; cleartext never crosses). */
export const safetyIncidentReaderDenyStub: SafetyIncidentReader = {
  recentIncidentsForArea() {
    throw new NotImplementedError("SafetyIncidentReader");
  },
  recentIncidentsForClinician() {
    throw new NotImplementedError("SafetyIncidentReader");
  },
};

/** M20 — M30/M33 aggregates. Throws rather than answering a zeroed rate: "0 incidents" on a safety tile
 *  is a reportable claim, and an outage must not be able to make it (the M21 `SupplyCostProvider` posture). */
export const safetyMetricsProviderDenyStub: SafetyMetricsProvider = {
  getSosFrequency() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
  getOverdueRate() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
  getIncidentRate() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
  getResponseTimeMedian() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
  getCheckInComplianceRate() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
  getAfterHoursSosCount() {
    throw new NotImplementedError("SafetyMetricsProvider");
  },
};

/** M20 — M17's per-visit pre/mid/post badge trio. `not_required` is a real badge value, so a failed read
 *  must not be able to produce it: M17's day grid would render "no check-in was ever owed" for a visit
 *  whose clinician is overdue. */
export const safetyCheckInProviderDenyStub: SafetyCheckInProvider = {
  checkInStatusForVisit() {
    throw new NotImplementedError("SafetyCheckInProvider");
  },
};

/** M20 — the ONLY read path to the effective policy (§2.2.4), including the `policyAtTime` replay arm. */
export const safetyPolicyProviderDenyStub: SafetyPolicyProvider = {
  effectivePolicy() {
    throw new NotImplementedError("SafetyPolicyProvider");
  },
  policyAtTime() {
    throw new NotImplementedError("SafetyPolicyProvider");
  },
};

/** M20 — who gets paged + the §7.8 coverage gaps. See the block header on why `[]` is not the deny value. */
export const safetySupervisorProviderDenyStub: SafetySupervisorProvider = {
  supervisorsForClinician() {
    throw new NotImplementedError("SafetySupervisorProvider");
  },
  coverageGapsForOrg() {
    throw new NotImplementedError("SafetySupervisorProvider");
  },
};

// ── M32 (AI Platform) §4.2 PUBLISHED seams (M32-T06) ──────────────────────────────────────────────
//
// TEN INFERENCE SEAMS THAT DO NOT THROW, AND ONE SAFETY SEAM THAT DOES. The split is the whole design.
//
// The ten inference seams (`NarrativeEnhancementProvider`, the four DocLens arms,
// `BereavementRiskNarrativeProvider`, `DenialOutcomePredictionProvider`, `EmbeddingsProvider`,
// `SemanticSearchProvider`, `CopilotProvider`) all guard an ENHANCEMENT over a path that already works
// without it: M8 has an unenhanced note, M22 has manual intake review, M16 has the deterministic grief
// score, M25 submits the claim either way. §4.2.1 states the posture for the family — "this seam never
// throws to indicate AI absence — absence is a first-class result, not an error" — and the reason is the
// M20-T01 finding: a throwing deny-stub makes falling back conditional on somebody remembering a
// try/catch, and on the encounter-finalize path one of them will forget. So they answer a VALUE the
// caller branches on. This is the same call M19-T01 already made for `ProtocolSuggestionProvider` /
// `HospitalizationRiskProvider` above.
//
// `AIPromptRegistry` is the opposite and must be. It is not an inference surface: it is the D18/§8.5
// query M12, M13, M18, M21, M27 and M28 each run at their own boot to prove no active prompt template
// targets their AI-prohibited zone. Its empty answer MEANS "no contraband found". A non-throwing
// deny-stub would hand six boot validators a clean bill of health minted by an unwired registry — the
// one answer §4.5 says it must never invent. It throws, and those boots refuse to start.
//
// The refusal literal is built structurally from `@wardenx/types` values rather than imported from
// `@wardenx/ai-platform`: M1 may not import a downstream module's package (ARCHITECTURE §25.15), and
// `AiCapabilityUnavailable` is a leaf type precisely so this boundary can be spoken here.

/**
 * An opaque M32 inference seam that REFUSES rather than throws. Every method resolves to
 * `{ available: false, unavailable: { reason: 'provider_unregistered' }, detail }`.
 *
 * `provider_unregistered`, NOT `phase_1_capability_shell`: in Phase 1 the two are behaviourally
 * identical, but the registered seam answers the latter, so an operator can tell "the boot did not wire
 * M32" from "M32 is wired and the `ai.full` flag is off" — a wiring fault from a policy decision.
 */
function refusingAiSeamProxy(seam: SeamName): unknown {
  const unavailable: AiCapabilityUnavailable = {
    status: "capability_unavailable",
    reason: "provider_unregistered",
  };
  const refusal = {
    available: false as const,
    unavailable,
    detail: `no M32 implementation is registered for '${seam}'; the fail-closed deny-stub answered`,
  };
  return new Proxy(
    {},
    {
      get() {
        return async () => refusal;
      },
    },
  );
}

/** M32 — §4.2.1 HearthNote Layer 2 / IDG polish / bereavement narrative. Refuses; never throws. */
export const narrativeEnhancementProviderDenyStub: unknown = refusingAiSeamProxy(
  "NarrativeEnhancementProvider",
);

/** M32 — §4.2.2 DocLens document-type classification (M22). Refuses; never throws. */
export const docLensClassifierDenyStub: unknown = refusingAiSeamProxy("DocLensClassifier");

/** M32 — §4.2.2 DocLens structured field extraction (M22). Refuses; never throws. */
export const docLensExtractorDenyStub: unknown = refusingAiSeamProxy("DocLensExtractor");

/** M32 — §4.2.2 DocLens signature/redaction/page-integrity vision check (M22). Refuses; never throws. */
export const docLensVisionVerifierDenyStub: unknown = refusingAiSeamProxy("DocLensVisionVerifier");

/** M32 — §4.2.2 DocLens 42 CFR Part 2 SUD indicator detection (M22). Refuses; never throws. */
export const docLensSudDetectorDenyStub: unknown = refusingAiSeamProxy("DocLensSudDetector");

/** M32 — §4.2.4 complicated-grief risk narrative (M16, optional). Refuses; never throws. */
export const bereavementRiskNarrativeProviderDenyStub: unknown = refusingAiSeamProxy(
  "BereavementRiskNarrativeProvider",
);

/** M32 — §4.2.5 denial/appeal probability (M25). Advisory: it never gates submission, so it never throws. */
export const denialOutcomePredictionProviderDenyStub: unknown = refusingAiSeamProxy(
  "DenialOutcomePredictionProvider",
);

/** M32 — §4.2.6 tenant-scoped embedding vectors. Contract locked, no Phase-1 consumer. */
export const embeddingsProviderDenyStub: unknown = refusingAiSeamProxy("EmbeddingsProvider");

/** M32 — §4.2.6 chart-scoped semantic search. Contract locked, no Phase-1 consumer. */
export const semanticSearchProviderDenyStub: unknown = refusingAiSeamProxy("SemanticSearchProvider");

/** M32 — §4.2.6 chart copilot Q&A. Contract locked, no Phase-1 consumer. */
export const copilotProviderDenyStub: unknown = refusingAiSeamProxy("CopilotProvider");

/**
 * M32 — §4.5 the D18 prompt-registry query API. THROWS, unlike its ten siblings above.
 *
 * `getActivePromptsTargeting('medication_') === []` is the answer M12's boot validator reads as "no
 * contraband template exists, start the module". An unwired registry that returned `[]` would produce
 * that clearance out of nothing, in all six protected modules at once, and §8.5's first enforcement leg
 * would be a no-op nobody could see. Throwing makes those boots fail — loudly, and in the right place.
 */
export const aiPromptRegistryDenyStub: unknown = denyingSeamProxy("AIPromptRegistry");

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
