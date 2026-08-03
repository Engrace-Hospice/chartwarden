// apps/backend/src/bootstrap/seams/registry.ts — the M1 SEAM REGISTRY + boot gate (§3.18).
//
// Cross-module contracts are injected at boot (ADR-0005 D1): a producer module's init calls
// registerSeam(); consumers call getSeam(). After ALL modules initialize and BEFORE the
// server listens, validateSeams() runs (§3.18.3). For every required seam that no module
// registered it applies that seam's deny-stub default — so the contract is ALWAYS present
// and fails CLOSED (denies on call) rather than open — and it refuses to boot only when an
// entry has neither a registration nor a deny-stub: an unrecoverable contract gap.
//
// M1 owns the registry + the gate (resolves M03-F12: M1 cannot import an M3-owned registry,
// so REQUIRED_SEAMS is M1-owned, with each owning module's entry declared here until those
// modules contribute their own at init). This file lives under seams/ so
// check-fitness-gaps.ts (seam-registry sub-check) scans it: the `REQUIRED_SEAMS = [...]`
// literal and registerSeam/getSeam are the tokens it keys on.

import type { RequiredSeam, SeamContracts, SeamName } from "../interfaces";
import {
  admissionCensusReaderDenyStub,
  admissionStatusReaderDenyStub,
  alertEmitterDenyStub,
  auditorSessionMinterDenyStub,
  baaStatusProviderDenyStub,
  bereavedPortalScopeProviderDenyStub,
  bereavementAssignmentReaderDenyStub,
  bereavementComplianceProviderDenyStub,
  bereavementOutreachProviderDenyStub,
  bereavementPlanProviderDenyStub,
  bereavementRiskFactorsProviderDenyStub,
  bereavementRiskTierProviderDenyStub,
  billableEncounterReaderDenyStub,
  capAccrualReaderDenyStub,
  claimLineReaderDenyStub,
  complianceStatusProviderDenyStub,
  costReportFilingStatusReaderDenyStub,
  incidentRegisterProviderDenyStub,
  qapiProjectProviderDenyStub,
  qualityMeasureProviderDenyStub,
  securityRiskAssessmentReaderDenyStub,
  capProjectionProviderDenyStub,
  carePlanReaderDenyStub,
  caseloadDenyStub,
  certificationReaderDenyStub,
  claimSettlementProviderDenyStub,
  comfortKitDispatchProviderDenyStub,
  consentEvaluatorDenyStub,
  deathDischargeReaderDenyStub,
  disciplineComplianceProviderDenyStub,
  disciplinePlanReaderDenyStub,
  documentReaderDenyStub,
  documentRendererDenyStub,
  documentStorageProviderDenyStub,
  drugCostBillingReaderDenyStub,
  electionPeriodReaderDenyStub,
  encounterCreatorDenyStub,
  evvAggregatorReferenceReaderDenyStub,
  evvBracketResolverDenyStub,
  evvComplianceReaderDenyStub,
  evvLocationProviderDenyStub,
  evvMetricsProviderDenyStub,
  evvVerificationProviderDenyStub,
  extractionProvenanceReaderDenyStub,
  faceToFaceReaderDenyStub,
  fhirClientReaderDenyStub,
  fhirGatewayMetricsProviderDenyStub,
  fhirInboundProposalReaderDenyStub,
  claimReaderDenyStub,
  externalFeedReaderDenyStub,
  externalGriefResourceReaderDenyStub,
  hl7InboundProposalReaderDenyStub,
  labObservationReaderDenyStub,
  nppesProviderReaderDenyStub,
  subscriptionStateProviderDenyStub,
  billingStatusProviderDenyStub,
  usageMeteringIngestDenyStub,
  patientCounterProviderDenyStub,
  revenueMetricsProviderDenyStub,
  planCatalogReaderDenyStub,
  onboardingStatusProviderDenyStub,
  externalInterfaceMetricsProviderDenyStub,
  aiTokenMeterProviderDenyStub,
  ipuAdmissionReaderDenyStub,
  ipuBedAssignmentProviderDenyStub,
  ipuCensusProviderDenyStub,
  ipuIvSafetyOverlayProviderDenyStub,
  ipuQualityReaderDenyStub,
  ipuShiftCoverageReaderDenyStub,
  ipuTenantPostureReaderDenyStub,
  ipuVisitorReaderDenyStub,
  hopeJ2051ProviderDenyStub,
  hopeOrgRollupProviderDenyStub,
  hopeSubmissionProviderDenyStub,
  hopeTimepointProviderDenyStub,
  hospitalizationRiskProviderDenyStub,
  idgDecisionProviderDenyStub,
  idgPacketProviderDenyStub,
  idgScheduleProviderDenyStub,
  intakeMetricsProviderDenyStub,
  latestAssessmentProviderDenyStub,
  levelOfCareReaderDenyStub,
  mdmEntityProviderDenyStub,
  medicationAdministrationProviderDenyStub,
  medicationOrderProviderDenyStub,
  messagingProviderDenyStub,
  metricsProviderDenyStub,
  mileagePayrollReaderDenyStub,
  mswRiskFactorReaderDenyStub,
  onCallProviderDenyStub,
  orderProviderDenyStub,
  orderSignatureProviderDenyStub,
  patientAddressReaderDenyStub,
  patientCaregiverReaderDenyStub,
  patientCoverageReaderDenyStub,
  patientDaysProviderDenyStub,
  patientMutatorDenyStub,
  patientReaderDenyStub,
  portalDocumentReaderDenyStub,
  portalTriageReaderDenyStub,
  portalVisitReaderDenyStub,
  protocolSuggestionProviderDenyStub,
  reconciliationProviderDenyStub,
  refillInboxProviderDenyStub,
  renderedDocumentProviderDenyStub,
  safetyCheckInProviderDenyStub,
  safetyContextReaderDenyStub,
  safetyDashboardProviderDenyStub,
  safetyIncidentReaderDenyStub,
  safetyMetricsProviderDenyStub,
  safetyPolicyProviderDenyStub,
  safetySupervisorProviderDenyStub,
  aiPromptRegistryDenyStub,
  bereavementRiskNarrativeProviderDenyStub,
  copilotProviderDenyStub,
  denialOutcomePredictionProviderDenyStub,
  docLensClassifierDenyStub,
  docLensExtractorDenyStub,
  docLensSudDetectorDenyStub,
  docLensVisionVerifierDenyStub,
  embeddingsProviderDenyStub,
  narrativeEnhancementProviderDenyStub,
  semanticSearchProviderDenyStub,
  scaleSeriesProviderDenyStub,
  sessionContextResolverDenyStub,
  signedEncountersReaderDenyStub,
  supervisoryCadencePlanReaderDenyStub,
  supervisoryCadenceReaderDenyStub,
  supplyCostProviderDenyStub,
  supplyFulfillmentProviderDenyStub,
  tenantOrgCreationProviderDenyStub,
  organizationReaderDenyStub,
  terminologyProviderDenyStub,
  triageCallMetricsProviderDenyStub,
  triageCallProviderDenyStub,
  triageCallReaderDenyStub,
  visitAssignmentReaderDenyStub,
  visitMetricsProviderDenyStub,
  visitReaderDenyStub,
  volunteerComplianceProviderDenyStub,
  volunteerGateExpiryReaderDenyStub,
} from "./providers";

export class SeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamError";
  }
}

const registry = new Map<SeamName, unknown>();

/**
 * Every seam the platform requires before it may serve traffic, each with its owning
 * module, a fail-closed deny-stub default, and whether it guards PHI (§3.18.2). Written as
 * a `satisfies` literal so the keys stay statically discoverable to the seam-registry
 * fitness check. Phase-1 producer modules register their REAL implementation over the
 * deny-stub via registerSeam() at init.
 */
export const REQUIRED_SEAMS = [
  { key: "CaseloadProvider", ownerModule: 5, phi: true, denyStub: caseloadDenyStub },
  { key: "PatientReader", ownerModule: 5, phi: true, denyStub: patientReaderDenyStub },
  // M5 (§3.4) — the coverage list M23/M24 resolve a claim's billed payer from. PHI: carries the
  // member/subscriber id, so it is boot-validated and fail-closed like the other M5 reads.
  {
    key: "PatientCoverageReader",
    ownerModule: 5,
    phi: true,
    denyStub: patientCoverageReaderDenyStub,
  },
  // M5 — TASK-015/ARCH-018: the M31 `portal_caregiver_is_primary_or_dpoa` ABAC read. Deny-stub only —
  // no caregiver→user schema link exists (see the interface doc in @wardenx/types).
  {
    key: "PatientCaregiverReader",
    ownerModule: 5,
    phi: true,
    denyStub: patientCaregiverReaderDenyStub,
  },
  // M5 — TASK-015/ARCH-018: the M31 `state_two_party_recording_consent_present` ABAC read (D9/§3.8).
  // PHI: a residence state is PHI-adjacent (M5 owns patient_address); M5 registers a real impl over
  // `patient_address` at boot.
  { key: "PatientAddressReader", ownerModule: 5, phi: true, denyStub: patientAddressReaderDenyStub },
  // M40 — TASK-015/ARCH-018: the M31 bereaved-portal `/resources` read. Deny-stub only — no
  // `external_grief_resource` table exists yet (M40 has not built this catalog).
  {
    key: "ExternalGriefResourceReader",
    ownerModule: 40,
    phi: false,
    denyStub: externalGriefResourceReaderDenyStub,
  },
  // M5 (§4.9) — applies an M29-proposal/amendment field diff (D12 strip). PHI write surface;
  // boot-validated and fail-closed until M5 registers the real mutator (M5-T08).
  { key: "PatientMutator", ownerModule: 5, phi: true, denyStub: patientMutatorDenyStub },
  { key: "DocumentRenderer", ownerModule: 22, phi: true, denyStub: documentRendererDenyStub },
  // M22 (§4.3 / §11 D1) — the per-tenant object-storage seam (presign download + version-aware destroy).
  // The presigned URL is never logged and the keys are PHI-free by construction (D11), but the surface
  // reaches PHI bytes → phi: true; boot-validated and fail-closed until M22 registers the real provider
  // (M22-T04). The M22 lifecycle/eraser paths resolve it through the typed accessor.
  {
    key: "DocumentStorageProvider",
    ownerModule: 22,
    phi: true,
    denyStub: documentStorageProviderDenyStub,
  },
  // M22 (§4.3) — the five PUBLISHED reader seams. All read PHI document/provenance projections except
  // IntakeMetricsProvider (aggregate counts only → phi: false). Boot-validated and fail-closed until M22
  // registers the real Drizzle-backed readers over the deny-stubs (M22-T05).
  {
    key: "RenderedDocumentProvider",
    ownerModule: 22,
    phi: true,
    denyStub: renderedDocumentProviderDenyStub,
  },
  { key: "DocumentReader", ownerModule: 22, phi: true, denyStub: documentReaderDenyStub },
  {
    key: "PortalDocumentReader",
    ownerModule: 22,
    phi: true,
    denyStub: portalDocumentReaderDenyStub,
  },
  {
    key: "IntakeMetricsProvider",
    ownerModule: 22,
    phi: false,
    denyStub: intakeMetricsProviderDenyStub,
  },
  {
    key: "ExtractionProvenanceReader",
    ownerModule: 22,
    phi: true,
    denyStub: extractionProvenanceReaderDenyStub,
  },
  { key: "ConsentEvaluator", ownerModule: 39, phi: true, denyStub: consentEvaluatorDenyStub },
  // M2 published seams (§4.7): authenticated request context + auditor session minter. Not PHI
  // (identity/session metadata, not a patient record), but still boot-validated and fail-closed.
  {
    key: "SessionContextResolver",
    ownerModule: 2,
    phi: false,
    denyStub: sessionContextResolverDenyStub,
  },
  {
    key: "AuditorSessionMinter",
    ownerModule: 2,
    phi: false,
    denyStub: auditorSessionMinterDenyStub,
  },
  // M2 (org creation) — the per-tenant `organization` create/attach surface M34's `tenant.provision`
  // worker consumes (§7.1 step 3). Owned by M2 (it owns the `organization` table); not PHI (org metadata).
  // Fail-closed default RETURNS `unavailable` (graceful degradation, never fabricates an org) until M2
  // registers the real Drizzle-backed provider at init.
  {
    key: "TenantOrgCreationProvider",
    ownerModule: 2,
    phi: false,
    denyStub: tenantOrgCreationProviderDenyStub,
  },
  // M2 (org display metadata) — the by-id `organization` label reader M35's platform-ops admin lists consume
  // to render a cross-tenant row's org NAME instead of a raw UUID (M35A-T03). Owned by M2 (it owns the
  // `organization` table); org display metadata (name/slug), not a patient record → not PHI. Fail-closed
  // default RESOLVES NO NAMES (graceful — a display enrichment never fails an authorized list) until M2
  // registers the real Drizzle-backed reader at init.
  {
    key: "OrganizationReader",
    ownerModule: 2,
    phi: false,
    denyStub: organizationReaderDenyStub,
  },
  // M38 (Terminology) — the version-aware code/value-set resolution surface every clinical and
  // billing module imports (§4.5). Reference data, not a patient record → not PHI; still
  // boot-validated and fail-closed (denies on call) until M38 registers the real provider.
  {
    key: "TerminologyProvider",
    ownerModule: 38,
    phi: false,
    denyStub: terminologyProviderDenyStub,
  },
  // M36 (Messaging) — the alert routing surface every clinical/billing module emits through
  // (§4.6). Not a PHI READ surface (events route in; PHI never leaves out-of-band by rule, §4.7);
  // boot-validated and fail-closed until M36 registers the real emitter (T06).
  {
    key: "AlertEmitter",
    ownerModule: 36,
    phi: false,
    denyStub: alertEmitterDenyStub,
  },
  // M36 (Messaging) — the channel/message surface; `listMessages` decrypts bodies for entitled
  // readers, so this DOES guard a PHI read surface. Declared fail-closed here; its DB-backed
  // implementation registers over the deny-stub with the routes/realtime tasks (M36-T07/T08).
  {
    key: "MessagingProvider",
    ownerModule: 36,
    phi: true,
    denyStub: messagingProviderDenyStub,
  },
  // M40 (MDM) — the master-data read surface (physician/facility/payer; merge-aware, §4.5) every
  // clinical/billing/interop module consumes. Canonical reference data + this-tenant overlay, not a
  // patient record → not PHI; boot-validated and fail-closed until M40 registers the real provider.
  {
    key: "MdmEntityProvider",
    ownerModule: 40,
    phi: false,
    denyStub: mdmEntityProviderDenyStub,
  },
  // M33 (Reporting) — the embedded dashboard-metric read (aggregate-only, org-scoped; D6 — no row-level
  // PHI). Boot-validated and fail-closed until M33 registers the real provider (which returns a forward-seam
  // empty value until its materialized views populate).
  {
    key: "MetricsProvider",
    ownerModule: 33,
    phi: false,
    denyStub: metricsProviderDenyStub,
  },
  // M26 (Cap Management) — the cap-period aggregate the M27 cost-report Worksheet-E cap calc + cap
  // validation rules consume (D13; aggregate $/days, no row-level PHI). Boot-validated and fail-closed
  // until M26 registers the real provider (db-present boot); M27 reads it via getSeam + casts to its own view.
  {
    key: "CapAccrualReader",
    ownerModule: 26,
    phi: false,
    denyStub: capAccrualReaderDenyStub,
  },
  // M26 (Cap Management) — the agency/patient/inpatient cap projection the M23 §11.A pre-submission cap rules
  // consume (D8; cap utilization %/band, no clinical PHI). Boot-validated and fail-closed until M26 registers
  // the real provider; the M23 adapter degrades a deny-stub throw to status:"unavailable" (warn, never block).
  {
    key: "CapProjectionProvider",
    ownerModule: 26,
    phi: false,
    denyStub: capProjectionProviderDenyStub,
  },
  // M23 (Billing-Medicare) → M27 cost-report binds. The FIRST M23→M1 publishes (M23 was outbox-only before).
  // Aggregate, FY-scoped, PHI-free (D18 — billed day counts / drug charges, no patient row). Boot-validated and
  // fail-closed until M23 registers the real providers (db-present boot); M27 reads via getSeam + casts.
  {
    key: "PatientDaysProvider",
    ownerModule: 23,
    phi: false,
    denyStub: patientDaysProviderDenyStub,
  },
  // DrugCostBillingReader — the M27 Worksheet-A pharmacy cross-check. Owner M12 (the drug-cost-basis module;
  // M23 is per-diem with no drug line). RESERVATION: M12's med-order cost is not yet materialized (no cost
  // column), so this stays on the deny-stub and M27's drug-reconcile rule SKIPS until M12 publishes real cost.
  {
    key: "DrugCostBillingReader",
    ownerModule: 12,
    phi: false,
    denyStub: drugCostBillingReaderDenyStub,
  },
  // M25 (Remittance & Denials) → M27 — the actual interim Medicare payments (835 CLP04) the E-1 settlement
  // tie reconciles against. Aggregate $ for a FY, no row-level PHI. Fail-closed until M25 registers the provider.
  {
    key: "ClaimSettlementProvider",
    ownerModule: 25,
    phi: false,
    denyStub: claimSettlementProviderDenyStub,
  },
  // M23 → M30 — the per-LOC billed claim-line day rollup the HCI claims-derived indicators read. M23's
  // SECOND M1 publish (PatientDaysProvider above was the first, for M27). Aggregate day counts by level of
  // care over a window: no patient row, no MBI (D18). Fail-closed until M23 registers the real reader —
  // M30's adapter degrades the deny-stub throw to "suppressed", never a fabricated claims number.
  {
    key: "ClaimLineReader",
    ownerModule: 23,
    phi: false,
    denyStub: claimLineReaderDenyStub,
  },
  // M27 → M30 — the cost-report filing posture per FY. M27's FIRST M1 publish (it was a pure consumer
  // before). CoP 418.310 makes failure to file grounds for termination, so M30's compliance indicator needs
  // the filing state + the statutory deadline, not the cost-report CONTENT. Metadata only → phi:false.
  {
    key: "CostReportFilingStatusReader",
    ownerModule: 27,
    phi: false,
    denyStub: costReportFilingStatusReaderDenyStub,
  },
  // M30 (HQRP & Quality) §4.3 — the FIVE read seams M30 publishes. Until these entries existed, M30 was
  // reachable cross-module ONLY through its §4.10 outbox events: M22's quality report, M28's FHIR
  // MeasureReport/AdverseEvent, M33's executive dashboards and M34's FY-rollover tenant gate had no read
  // path to the measure ledger, the incident register, QAPI, CoP status, or the SRA posture at all.
  //
  // Four are aggregate-only (the `quality_measure_value` ledger and the QAPI/CoP/SRA surfaces carry no
  // patient row). `IncidentRegisterProvider` is the exception: an incident may be patient-linked, so it
  // is phi:true and its own methods take the caller's actor context and require patient scope.
  {
    key: "QualityMeasureProvider",
    ownerModule: 30,
    phi: false,
    denyStub: qualityMeasureProviderDenyStub,
  },
  {
    key: "IncidentRegisterProvider",
    ownerModule: 30,
    phi: true,
    denyStub: incidentRegisterProviderDenyStub,
  },
  {
    key: "QapiProjectProvider",
    ownerModule: 30,
    phi: false,
    denyStub: qapiProjectProviderDenyStub,
  },
  {
    key: "ComplianceStatusProvider",
    ownerModule: 30,
    phi: false,
    denyStub: complianceStatusProviderDenyStub,
  },
  {
    key: "SecurityRiskAssessmentReader",
    ownerModule: 30,
    phi: false,
    denyStub: securityRiskAssessmentReaderDenyStub,
  },
  // M40 (MDM) — the focused §7.7 BAA disclosure gate (as-of time-travel + sending-facility
  // resolution), registered separately from the omnibus above. M22/M28/M29 consult it before any
  // PHI leaves the perimeter. BAA status metadata, not a patient record → not PHI; fail-closed.
  {
    key: "BaaStatusProvider",
    ownerModule: 40,
    phi: false,
    denyStub: baaStatusProviderDenyStub,
  },
  // M28 (FHIR Gateway) §4.3 — the three PUBLISHED read seams M28 registers into the M1 registry (M28-T06).
  // Until these entries existed, M28 was reachable cross-module ONLY through its §4.10 outbox events: M33's
  // utilization dashboards, M30's §164.528 disclosure scorecard, M34's SaaS-console client registry, and
  // M5/M12's inbound-proposal review queues had no read path to M28's utilization, client-registry or
  // staged-proposal rows at all. M28 registers the real Drizzle-backed impls over the deny-stubs when its
  // routes/repos land (M28-T08); until then `validateSeams()` applies the fail-closed deny-stub.
  //
  // `FhirInboundProposalReader` reaches the raw FHIR payload before an owner module accepts it → phi:true.
  // The other two are aggregate utilization / client-registry metadata (NO patient row) → phi:false.
  {
    key: "FhirGatewayMetricsProvider",
    ownerModule: 28,
    phi: false,
    denyStub: fhirGatewayMetricsProviderDenyStub,
  },
  { key: "FhirClientReader", ownerModule: 28, phi: false, denyStub: fhirClientReaderDenyStub },
  {
    key: "FhirInboundProposalReader",
    ownerModule: 28,
    phi: true,
    denyStub: fhirInboundProposalReaderDenyStub,
  },
  // M28 §4.4 forward-seams — the two CONSUMED reader seams M28 requires but whose owner modules do not
  // publish them yet. Both stay on the fail-closed deny-stub the whole of Phase 1.
  //   · `ClaimReader` (M23) — the W-FHIR-07 Claim/ClaimResponse/EOB projection. `fhir.write` OFF ⇒ the M28
  //     route returns 404 (§7.7) before reaching this seam; declaring it REQUIRED makes a boot without M23's
  //     D1 unlock fail CLOSED rather than serving a Phase-2 resource. PHI (a claim is patient-linked).
  //   · `LabObservationReader` (M29) — the §4.11 DiagnosticReport result-value source. M29 is a Phase-1
  //     placeholder, so M28's DiagnosticReport projection refuses at egress until M29 registers it. PHI.
  { key: "ClaimReader", ownerModule: 23, phi: true, denyStub: claimReaderDenyStub },
  {
    key: "LabObservationReader",
    ownerModule: 29,
    phi: true,
    denyStub: labObservationReaderDenyStub,
  },
  // M29 §4.4 — the three OTHER published read seams M29 registers into the M1 registry (M29-T08). Each stays
  // on the fail-closed deny-stub until M29's Drizzle seam store is bound at the composition root. The proposal
  // reader reaches a demographic candidate (PHI); the other two are feed metadata / public-directory data.
  {
    key: "Hl7InboundProposalReader",
    ownerModule: 29,
    phi: true,
    denyStub: hl7InboundProposalReaderDenyStub,
  },
  { key: "ExternalFeedReader", ownerModule: 29, phi: false, denyStub: externalFeedReaderDenyStub },
  {
    key: "NppesProviderReader",
    ownerModule: 29,
    phi: false,
    denyStub: nppesProviderReaderDenyStub,
  },
  // M35 (Subscription Billing) §4.5 — the SIX published read seams M35 registers into the M1 registry
  // (M35-T05). Until these entries existed, M35 was reachable cross-module ONLY through its §4.11 outbox
  // events: M33's revenue/subscription dashboards and M34's SaaS console (ADR-0025: seam-both-ways, NO edge
  // either direction) had no read path to the subscription header, the billing-block gate, the MRR/ARR
  // snapshots, or the plan catalog at all. M35 registers the real Drizzle-backed impls over the deny-stubs
  // when its routes/stores land (M35-T06); until then `validateSeams()` applies the fail-closed deny-stub.
  //
  // All SIX are aggregate/subscription-header/catalog metadata — no patient row crosses (usage counts are
  // pseudonymized, D6/§8.5) → phi:false throughout.
  {
    key: "SubscriptionStateProvider",
    ownerModule: 35,
    phi: false,
    denyStub: subscriptionStateProviderDenyStub,
  },
  {
    key: "BillingStatusProvider",
    ownerModule: 35,
    phi: false,
    denyStub: billingStatusProviderDenyStub,
  },
  {
    key: "UsageMeteringIngest",
    ownerModule: 35,
    phi: false,
    denyStub: usageMeteringIngestDenyStub,
  },
  {
    key: "PatientCounterProvider",
    ownerModule: 35,
    phi: false,
    denyStub: patientCounterProviderDenyStub,
  },
  {
    key: "RevenueMetricsProvider",
    ownerModule: 35,
    phi: false,
    denyStub: revenueMetricsProviderDenyStub,
  },
  { key: "PlanCatalogReader", ownerModule: 35, phi: false, denyStub: planCatalogReaderDenyStub },
  // M35 §4.6 — the THREE forward-seam consumer views M35 CONSUMES but whose owner modules do not publish
  // them yet. Each stays on the fail-closed deny-stub the whole of Phase 1; M35's metering/billing paths
  // (M35-T06) resolve them via `getSeam` + the interim fallback. `OnboardingStatusProvider` is M34's
  // (ADR-0025 no-edge, interface home is packages/types); the other two are M29/M32 placeholders.
  //   · `OnboardingStatusProvider` (M34) — billability metadata, not a patient record → phi:false.
  //   · `ExternalInterfaceMetricsProvider` (M29) — aggregate HL7 message COUNTS, no message body → phi:false.
  //   · `AITokenMeterProvider` (M32) — aggregate token COUNT per org, PHI-free by construction → phi:false.
  {
    key: "OnboardingStatusProvider",
    ownerModule: 34,
    phi: false,
    denyStub: onboardingStatusProviderDenyStub,
  },
  {
    key: "ExternalInterfaceMetricsProvider",
    ownerModule: 29,
    phi: false,
    denyStub: externalInterfaceMetricsProviderDenyStub,
  },
  {
    key: "AITokenMeterProvider",
    ownerModule: 32,
    phi: false,
    denyStub: aiTokenMeterProviderDenyStub,
  },
  // M6 (Admission, Election & Certification) reader seams (§4.7). Each is a read-only DTO surface over
  // M6's PHI tables (admission/election/CTI/F2F/LOC status), consumed by M14/M22/M23/M26/M30 in later
  // waves instead of importing M6's schema. PHI read surfaces (patient-linked clinical status) → phi:
  // true; boot-validated and fail-closed until M6 registers the real Drizzle-backed readers (M6-T05).
  {
    key: "ElectionPeriodReader",
    ownerModule: 6,
    phi: true,
    denyStub: electionPeriodReaderDenyStub,
  },
  {
    key: "CertificationReader",
    ownerModule: 6,
    phi: true,
    denyStub: certificationReaderDenyStub,
  },
  {
    key: "FaceToFaceReader",
    ownerModule: 6,
    phi: true,
    denyStub: faceToFaceReaderDenyStub,
  },
  {
    key: "LevelOfCareReader",
    ownerModule: 6,
    phi: true,
    denyStub: levelOfCareReaderDenyStub,
  },
  {
    key: "AdmissionStatusReader",
    ownerModule: 6,
    phi: true,
    denyStub: admissionStatusReaderDenyStub,
  },
  {
    key: "AdmissionCensusReader",
    ownerModule: 6,
    phi: true,
    denyStub: admissionCensusReaderDenyStub,
  },
  // M6 (Admission) death-discharge census reader (§4.11). A read-only DTO surface over M6's `discharge_event`
  // death rows (joined to `admission` for the patient id), consumed by M30's HVLDL measure-recompute worker as
  // the measure denominator instead of importing M6's schema. Patient-linked decedent census → phi: true;
  // boot-validated and fail-closed until M6 registers the real Drizzle-backed reader.
  {
    key: "DeathDischargeReader",
    ownerModule: 6,
    phi: true,
    denyStub: deathDischargeReaderDenyStub,
  },
  // M7 (Care Plan / IPOC) reader seam (§7.8). A read-only DTO surface over M7's PHI tables
  // (problems/goals/interventions + the version clock), consumed by M8 (encounter authoring + sign
  // gate), M14 (IDG packet), M15 (discipline plans) in later waves instead of importing M7's schema.
  // PHI read surface (patient-linked clinical content) → phi: true; boot-validated and fail-closed
  // until M7 registers the real Drizzle-backed reader (M7-T04).
  {
    key: "CarePlanReader",
    ownerModule: 7,
    phi: true,
    denyStub: carePlanReaderDenyStub,
  },
  // M8 (Encounters & Visit Notes) owned seams (§4.7). Leaf-typed read/mutate surfaces over M8's PHI
  // tables (encounter status/narrative, mileage, encounter creation), consumed by M23/M24 (billability),
  // M14/M22 (signed digests + render), M27 (payroll mileage), M16/M17 (encounter creation) in later
  // waves instead of importing M8's schema. PHI surfaces (patient-linked encounter data) → phi: true;
  // boot-validated and fail-closed until M8 registers the real Drizzle-backed impls (M8-T08).
  {
    key: "BillableEncounterReader",
    ownerModule: 8,
    phi: true,
    denyStub: billableEncounterReaderDenyStub,
  },
  {
    key: "SignedEncountersReader",
    ownerModule: 8,
    phi: true,
    denyStub: signedEncountersReaderDenyStub,
  },
  {
    key: "MileagePayrollReader",
    ownerModule: 8,
    phi: true,
    denyStub: mileagePayrollReaderDenyStub,
  },
  {
    key: "EncounterCreator",
    ownerModule: 8,
    phi: true,
    denyStub: encounterCreatorDenyStub,
  },
  // M18 (EVV) forward seam M8 CONSUMES (§4.7 / D9). A read-only bracket surface over M18's `evv_event`
  // rows (check-in/out ids + authoritative timestamps), consumed by M8 at finalize. PHI read surface
  // (patient-visit-linked timing) → phi: true; boot-validated and fail-closed until M18 registers the
  // real resolver (Wave F). M8's EVV-missing-documented fallback (route 10) stays operative meanwhile.
  {
    key: "EvvBracketResolver",
    ownerModule: 18,
    phi: true,
    denyStub: evvBracketResolverDenyStub,
  },
  // M18 (EVV) other five owned seams (§4.3 / D15). The sixth published M18 seam is `EvvBracketResolver` above (the
  // EXISTING M8-consumed contract M18 publishes the impl over). All five are READ-only DTO surfaces over M18's
  // `evv_event` / `evv_missing_resolution` / `evv_aggregator_submission` tables, consumed by M20 (field-safety),
  // M23/M24 (billing pre-submission gate + claim aggregator id), M25 (denial back-link), M30/M33 (measures), M31
  // (portal arrival) in later waves instead of importing M18's schema. Patient-visit-linked (the location seam is
  // coordinate-bearing, D10) → phi: true; boot-validated and fail-closed until M18 registers the real impls (M18-T05).
  {
    key: "EvvComplianceReader",
    ownerModule: 18,
    phi: true,
    denyStub: evvComplianceReaderDenyStub,
  },
  {
    key: "EvvAggregatorReferenceReader",
    ownerModule: 18,
    phi: true,
    denyStub: evvAggregatorReferenceReaderDenyStub,
  },
  {
    key: "EvvLocationProvider",
    ownerModule: 18,
    phi: true,
    denyStub: evvLocationProviderDenyStub,
  },
  {
    key: "EvvMetricsProvider",
    ownerModule: 18,
    phi: true,
    denyStub: evvMetricsProviderDenyStub,
  },
  {
    key: "EvvVerificationProvider",
    ownerModule: 18,
    phi: true,
    denyStub: evvVerificationProviderDenyStub,
  },
  // M9 (Clinical Assessments) owned seams (§4.7 / D7). Leaf-typed read-only DTO surfaces over M9's PHI
  // tables (the latest active scale capture + the windowed scored series/delta), consumed by M7 (CTI/IDG
  // latest), M10 (HOPE prognosis), M14 (IDG deltas), M28 (FHIR Observation), M32 (AI trajectory) instead
  // of importing M9's schema. PHI read surfaces (patient-linked scores) → phi: true; boot-validated and
  // fail-closed until M9 registers the real Drizzle-backed impls (M9-T04).
  {
    key: "LatestAssessmentProvider",
    ownerModule: 9,
    phi: true,
    denyStub: latestAssessmentProviderDenyStub,
  },
  {
    key: "ScaleSeriesProvider",
    ownerModule: 9,
    phi: true,
    denyStub: scaleSeriesProviderDenyStub,
  },
  // M10 (HOPE Engine) owned seams (§2 / D10). Leaf-typed read-only DTO surfaces over M10's PHI tables (the
  // timepoint schedule + completion state, the J2051 trigger/SFV obligations, the per-PE submission batch
  // status), consumed by M14 (open HOPE windows on the IDG packet), M22 (per-admission HOPE timeline PDF),
  // M30 (HQRP on-time / acceptance / Timely-Follow-Up measures), M32 (AI symptom-trajectory + decline
  // prediction) instead of importing M10's schema. PHI read surfaces (patient-linked timepoints/triggers/
  // submissions) → phi: true; boot-validated and fail-closed until M10 registers the real impls (M10-T05).
  {
    key: "HopeTimepointProvider",
    ownerModule: 10,
    phi: true,
    denyStub: hopeTimepointProviderDenyStub,
  },
  {
    key: "HopeJ2051Provider",
    ownerModule: 10,
    phi: true,
    denyStub: hopeJ2051ProviderDenyStub,
  },
  {
    key: "HopeSubmissionProvider",
    ownerModule: 10,
    phi: true,
    denyStub: hopeSubmissionProviderDenyStub,
  },
  // M10 (HOPE Engine) ORG-LEVEL rollup seam (§2 / D10). An org-scoped AGGREGATE surface (COUNTS only, never
  // a patient row, D6) the M30 `m30.measure_recompute` worker consumes to compute the four HOPE-family HQRP
  // measures (timepoint on-time, submission acceptance, SFV timeliness, J2051 timely-follow-up). The rollup
  // counts derive from patient-linked HOPE rows under RLS → phi: true; boot-validated and fail-closed until
  // M10 registers the real Drizzle-aggregate-backed impl over the deny-stub.
  {
    key: "HopeOrgRollupProvider",
    ownerModule: 10,
    phi: true,
    denyStub: hopeOrgRollupProviderDenyStub,
  },
  // M11 (Orders) owned seams (§2.8 D14 / §4.3). `OrderSignatureProvider` is the polymorphic clinical-
  // signature WRITE primitive (sign / record-verbal / cosign / discontinue) M12 routes medication-order
  // signatures through (no SQL FK across `order_signature.target_kind`, D4); `OrderProvider` is the read-
  // side counterpart M14 (orders since last IDG), M23 ("covering order" claim rule), M30 (completion +
  // verbal-timeliness measures), and M7 (intervention → order back-ref) consume instead of importing M11's
  // schema. Both touch patient-linked clinical orders → phi: true; boot-validated and fail-closed until M11
  // registers the real impls (M11-T05).
  {
    key: "OrderSignatureProvider",
    ownerModule: 11,
    phi: true,
    denyStub: orderSignatureProviderDenyStub,
  },
  {
    key: "OrderProvider",
    ownerModule: 11,
    phi: true,
    denyStub: orderProviderDenyStub,
  },
  // M12 (DoseSpot Integration) owned seams (§2.10 D17). Both are READ-only DTO surfaces over M12's
  // `medication_order` / `refill_request` tables: `MedicationOrderProvider` is the medication-order read path
  // M13 (eMAR administration context), M14 (IDG packet), M19/M30/M33 (derived signals + cost + quality), M28
  // (FHIR `MedicationRequest`), M31 (portal summary) consume; `RefillInboxProvider` is the refill-inbox read
  // path the prescriber inbox UI, M19 (on-call), and M33 (SLA dashboards) consume — all instead of importing
  // M12's schema. Both touch patient-linked medication records → phi: true; boot-validated and fail-closed
  // until M12 registers the real impls (M12-T07).
  {
    key: "MedicationOrderProvider",
    ownerModule: 12,
    phi: true,
    denyStub: medicationOrderProviderDenyStub,
  },
  {
    key: "RefillInboxProvider",
    ownerModule: 12,
    phi: true,
    denyStub: refillInboxProviderDenyStub,
  },
  // M13 (eMAR & Med Administration) owned seams (§2.12 D16). Both are READ-only DTO surfaces over M13's
  // `administration_record` / `medication_reconciliation_*` tables: `MedicationAdministrationProvider` is the
  // administration read path M14 (IDG "administrations since last meeting"), M28 (FHIR `MedicationAdministration`),
  // M30 (PRN-effectiveness / missed-dose / comfort-kit-timeliness measures), M31 (portal summary), M33 (dashboards),
  // M37 (IPU IV-pump overlay) consume; `ReconciliationProvider` is the reconciliation-worksheet read path M14
  // (IDG packet) + M30 (timeliness measure) consume — all instead of importing M13's schema. Both touch
  // patient-linked clinical records → phi: true; boot-validated and fail-closed until M13 registers the real
  // impls (M13-T07).
  {
    key: "MedicationAdministrationProvider",
    ownerModule: 13,
    phi: true,
    denyStub: medicationAdministrationProviderDenyStub,
  },
  {
    key: "ReconciliationProvider",
    ownerModule: 13,
    phi: true,
    denyStub: reconciliationProviderDenyStub,
  },
  // M14 (Interdisciplinary Group / IDG) owned seams (§4.8). All three are READ-only DTO surfaces over M14's
  // `idg_*` tables: `IdgPacketProvider` is the packet-snapshot + M22 render handshake M22 + M33 consume;
  // `IdgDecisionProvider` is the decision read path M30 (decision-to-careplan-update latency) + M33 consume;
  // `IdgScheduleProvider` is the meeting-schedule + 15-day-cadence read path M28 (FHIR `CareTeam`/`Encounter`) +
  // M30 (cadence-adherence measure) + M33 consume — all instead of importing M14's schema. All touch
  // patient-linked clinical records → phi: true; boot-validated and fail-closed until M14 registers the real
  // impls (M14-T05).
  {
    key: "IdgPacketProvider",
    ownerModule: 14,
    phi: true,
    denyStub: idgPacketProviderDenyStub,
  },
  {
    key: "IdgDecisionProvider",
    ownerModule: 14,
    phi: true,
    denyStub: idgDecisionProviderDenyStub,
  },
  {
    key: "IdgScheduleProvider",
    ownerModule: 14,
    phi: true,
    denyStub: idgScheduleProviderDenyStub,
  },
  // M17 (Scheduling & Route Optimization) owned seams (§4.3). All four are READ-only DTO surfaces over M17's
  // `visit` / `visit_state_history` / `route_segment` rows: `VisitReader` is the visit read path M8 (encounter-
  // authoring context — closes M8's visit-seeding inert consumer, M8 D9) + M18 (EVV geofence target) + M14 (IDG
  // packet) consume; `VisitAssignmentReader` is the assignment read path M5 (the §4.5 D11 caseload-contribution
  // projection) + M19 (on-call triage) + M20 (field-safety live-awareness) consume; `PortalVisitReader` is the M31
  // portal upcoming-visit read path (lay-language, scrubbed); `VisitMetricsProvider` is the M30/M33 productivity +
  // quality measures read path — all instead of importing M17's schema. Visit times + addresses are patient-linked
  // → phi: true; boot-validated and fail-closed until M17 registers the real impls (M17-T05).
  {
    key: "VisitReader",
    ownerModule: 17,
    phi: true,
    denyStub: visitReaderDenyStub,
  },
  {
    key: "VisitAssignmentReader",
    ownerModule: 17,
    phi: true,
    denyStub: visitAssignmentReaderDenyStub,
  },
  {
    key: "PortalVisitReader",
    ownerModule: 17,
    phi: true,
    denyStub: portalVisitReaderDenyStub,
  },
  {
    key: "VisitMetricsProvider",
    ownerModule: 17,
    phi: true,
    denyStub: visitMetricsProviderDenyStub,
  },
  // M15 (Discipline Care Plans) seams M17 CONSUMES (§4.4). M15-T05 registers the real impls over these
  // deny-stubs (M17-F06/ADR-0009 — M17 Phase 1 never hard-required M15 to boot, so a boot that does not wire
  // M15 stays FAIL-CLOSED here). The volunteer gate is patient-agnostic staff compliance (phi: false); the
  // supervisory cadence is admission-linked (phi: true). The volunteer deny-stub denies LOUDLY only when a
  // `volunteer_visit` is scheduled with M15 unwired.
  {
    key: "VolunteerComplianceProvider",
    ownerModule: 15,
    phi: false,
    denyStub: volunteerComplianceProviderDenyStub,
  },
  {
    key: "SupervisoryCadenceReader",
    ownerModule: 15,
    phi: true,
    denyStub: supervisoryCadenceReaderDenyStub,
  },
  // The rest of M15's §4.3 PUBLISHED seams (M15-T05) — leaf-typed in @wardenx/types/discipline-plans. All five
  // are READ surfaces over M15's `discipline_care_plan` / `discipline_assessment` / `aide_supervisory_visit` /
  // `volunteer_*` rows that forward consumers attach to instead of importing M15's schema (architecture §25.15):
  // `DisciplinePlanReader` — the plan read path M14 (IDG packet) / M22 (plan PDF) / M28 / M31 / M33 consume;
  // `MswRiskFactorReader` — the psychosocial factors M16's bereavement rubric SCORES (M15 exposes only, §1.2);
  // `VolunteerGateExpiryReader` — the 418.78 expiry sweep; `SupervisoryCadencePlanReader` — the per-plan
  // 418.76(h) cadence + overdue worklist M14/M30 consume; `DisciplineComplianceProvider` — the M30/M33 rollups.
  // Plan/assessment/supervisory/risk-factor reads are patient-linked → phi: true; the volunteer-gate expiry sweep
  // is staff compliance and the compliance rollups are aggregate rates → phi: false.
  {
    key: "DisciplinePlanReader",
    ownerModule: 15,
    phi: true,
    denyStub: disciplinePlanReaderDenyStub,
  },
  {
    key: "MswRiskFactorReader",
    ownerModule: 15,
    phi: true,
    denyStub: mswRiskFactorReaderDenyStub,
  },
  {
    key: "VolunteerGateExpiryReader",
    ownerModule: 15,
    phi: false,
    denyStub: volunteerGateExpiryReaderDenyStub,
  },
  {
    key: "SupervisoryCadencePlanReader",
    ownerModule: 15,
    phi: true,
    denyStub: supervisoryCadencePlanReaderDenyStub,
  },
  {
    key: "DisciplineComplianceProvider",
    ownerModule: 15,
    phi: false,
    denyStub: disciplineComplianceProviderDenyStub,
  },
  // M16 (Bereavement) §4.6 / D13 PUBLISHED seams (M16-T05). Seven surfaces over M16's `bereavement_plan` /
  // `bereaved_contact` / `bereavement_outreach` / `bereavement_risk_score` / `bereavement_plan_closure` rows
  // that M28 (FHIR), M30 (HQRP), M31 (portal), M32 (Layer-2 narrative), M33 (dashboards) and M36 (the
  // bereavement channel) attach to instead of importing M16's schema (architecture §25.15).
  //
  // PHI split: the plan / outreach / risk-factor / assignment / portal-scope reads are all survivor- and
  // decedent-linked → phi: true (the plan header carries `patientId`, the portal scope a `contactId`). The two
  // ROLLUP seams answer COUNTS over a scope — no subject id crosses — → phi: false, matching M15's
  // `DisciplineComplianceProvider`.
  {
    key: "BereavementPlanProvider",
    ownerModule: 16,
    phi: true,
    denyStub: bereavementPlanProviderDenyStub,
  },
  {
    key: "BereavementOutreachProvider",
    ownerModule: 16,
    phi: true,
    denyStub: bereavementOutreachProviderDenyStub,
  },
  {
    key: "BereavementRiskFactorsProvider",
    ownerModule: 16,
    phi: true,
    denyStub: bereavementRiskFactorsProviderDenyStub,
  },
  {
    key: "BereavementAssignmentReader",
    ownerModule: 16,
    phi: true,
    denyStub: bereavementAssignmentReaderDenyStub,
  },
  {
    key: "BereavedPortalScopeProvider",
    ownerModule: 16,
    phi: true,
    denyStub: bereavedPortalScopeProviderDenyStub,
  },
  {
    key: "BereavementComplianceProvider",
    ownerModule: 16,
    phi: false,
    denyStub: bereavementComplianceProviderDenyStub,
  },
  {
    key: "BereavementRiskTierProvider",
    ownerModule: 16,
    phi: false,
    denyStub: bereavementRiskTierProviderDenyStub,
  },
  // M21 (Supplies, DME & Comfort Kits) §4.8 / D14 PUBLISHED seams (M21-T05). Three surfaces over M21's
  // `supply_request` / `comfort_kit_dispatch` / `comfort_kit_dispatched_content` rows that M11 (the order
  // cascade's status read-back), M13 (bedside controlled-substance inventory), M22, M23/M27 (cap + cost
  // report), M28, M30, M33 and M37 (the D17 IPU-room stock kit) attach to instead of importing M21's schema
  // (architecture §25.15).
  //
  // PHI split: the fulfillment and dispatch surfaces are patient-linked (`patientId` on every DTO, and the
  // dispatch detail carries the lot-level controlled-substance manifest) → phi: true. `SupplyCostProvider`
  // is the odd one: `getOrgSupplySpendSummary` is a pure aggregate, but `getPatientSupplyCostSummary` names
  // a patient and returns that patient's spend, so the SEAM is phi: true — the classification is per seam,
  // and the widest method on it decides.
  {
    key: "SupplyFulfillmentProvider",
    ownerModule: 21,
    phi: true,
    denyStub: supplyFulfillmentProviderDenyStub,
  },
  {
    key: "ComfortKitDispatchProvider",
    ownerModule: 21,
    phi: true,
    denyStub: comfortKitDispatchProviderDenyStub,
  },
  {
    key: "SupplyCostProvider",
    ownerModule: 21,
    phi: true,
    denyStub: supplyCostProviderDenyStub,
  },
  // M19 (On-Call Triage) §4.3 PUBLISHED seams (M19-T06). Five read surfaces over M19's `on_call_shift` /
  // `triage_call` / `triage_call_answer` / `triage_escalation` / `triage_protocol` rows that M14 (IDG
  // packet), M20 (after-hours SOS recipient), M30/M33 (operational + quality measures), M31 (portal
  // care-log), M32 (hospitalization-risk features) and M36 (`on_call` channel membership + alert routing)
  // attach to instead of importing M19's schema (architecture §25.15).
  //
  // PHI split — per SEAM, decided by its widest method:
  //   • `OnCallProvider` is phi: FALSE. Nothing on it names a patient: a shift row is staffing evidence
  //     (CoP 418.100(c)(2)), and the actors are memberships and vendor labels. It is still boot-validated
  //     and fail-closed, because "who is on call" is what routes a 2 a.m. escalation.
  //   • `TriageCallReader` is phi: TRUE even though `TriageCallFeatureDto` carries no verbatim PHI —
  //     `recentCallsForPatient` names a patient and returns that patient's after-hours history, and the
  //     digest arm carries the chief-complaint label. A "features only" DTO does not de-identify the
  //     REQUEST.
  //   • `TriageCallProvider` and `PortalTriageReader` are phi: TRUE (a full call slice; a family-facing
  //     care-log entry for one patient).
  //   • `TriageCallMetricsProvider` is phi: FALSE — window-scoped aggregates only, no patient argument
  //     and no per-patient row (the M17 `VisitMetricsProvider` / M18 `EvvMetricsProvider` precedent).
  { key: "OnCallProvider", ownerModule: 19, phi: false, denyStub: onCallProviderDenyStub },
  { key: "TriageCallReader", ownerModule: 19, phi: true, denyStub: triageCallReaderDenyStub },
  {
    key: "TriageCallProvider",
    ownerModule: 19,
    phi: true,
    denyStub: triageCallProviderDenyStub,
  },
  {
    key: "PortalTriageReader",
    ownerModule: 19,
    phi: true,
    denyStub: portalTriageReaderDenyStub,
  },
  {
    key: "TriageCallMetricsProvider",
    ownerModule: 19,
    phi: false,
    denyStub: triageCallMetricsProviderDenyStub,
  },
  // M32 (AI Platform) — the two ADVISORY seams M19 consumes (§4.4 / §8.6, D11/D12). Owned by M32, which is
  // a placeholder module, so these stand on their deny-stubs until it lands. Both are phi: TRUE — the
  // suggestion input carries the caller's chief-complaint free text and the risk read names a patient, and
  // PHI leaving the platform for a model is exactly the boundary AI Governance §2.1.4 governs.
  //
  // Their deny-stubs do NOT throw (see providers.ts): an advisory that D11/D12 forbid from gating anything
  // must not be able to fail the intake path. `unavailable` is the answer, and it is a value, not silence.
  {
    key: "ProtocolSuggestionProvider",
    ownerModule: 32,
    phi: true,
    denyStub: protocolSuggestionProviderDenyStub,
  },
  {
    key: "HospitalizationRiskProvider",
    ownerModule: 32,
    phi: true,
    denyStub: hospitalizationRiskProviderDenyStub,
  },
  // M20 (Field Safety) §4.3 PUBLISHED seams (M20-T05). Seven read surfaces over M20's thirteen `safety_*`
  // tables that M8 (encounter-authoring context), M17 (visit-day badging + the board embed), M19
  // (after-hours window default), M30/M33 (operational dashboards), M32 (the future high-risk-area
  // suggestion model) and M36 (the §4.5 `field_safety_composed` recipient resolver) attach to instead of
  // importing M20's schema (architecture §25.15).
  //
  // PHI split — per SEAM, decided by its widest method:
  //   • `SafetyDashboardProvider` is phi: TRUE. The board row carries `currentPatientFirstName` and a
  //     `currentVisitId`, which name a served person — the minimum-necessary projection (§4.4) narrows
  //     WHAT crosses, it does not de-identify it.
  //   • `SafetyContextReader` is phi: TRUE — an incident summary names the visit and the affected
  //     clinician, and M8 renders it beside the encounter it happened during.
  //   • `SafetyIncidentReader` is phi: TRUE. §8.6 strips identity and rounds the geography to ~110 m, but
  //     a category + severity + instant + coarse location for a hospice visit is re-identifiable at agency
  //     scale, and PHI leaving the platform for a model is precisely the AI Governance §2.1.4 boundary.
  //   • `SafetyMetricsProvider` is phi: FALSE — window-scoped aggregates only, no patient argument and no
  //     per-patient row (the M17 `VisitMetricsProvider` / M19 `TriageCallMetricsProvider` precedent).
  //   • `SafetyCheckInProvider` is phi: TRUE — the argument is a `visitId`, so the badge trio is a fact
  //     ABOUT one patient's visit even though the response is three enum values.
  //   • `SafetyPolicyProvider` is phi: FALSE — per-tenant configuration thresholds, no person at all.
  //   • `SafetySupervisorProvider` is phi: FALSE — workforce paging configuration and coverage gaps
  //     (memberships, never patients). It is still boot-validated and fail-closed, because who gets paged
  //     is what routes a 3 a.m. SOS.
  {
    key: "SafetyDashboardProvider",
    ownerModule: 20,
    phi: true,
    denyStub: safetyDashboardProviderDenyStub,
  },
  {
    key: "SafetyContextReader",
    ownerModule: 20,
    phi: true,
    denyStub: safetyContextReaderDenyStub,
  },
  {
    key: "SafetyIncidentReader",
    ownerModule: 20,
    phi: true,
    denyStub: safetyIncidentReaderDenyStub,
  },
  {
    key: "SafetyMetricsProvider",
    ownerModule: 20,
    phi: false,
    denyStub: safetyMetricsProviderDenyStub,
  },
  {
    key: "SafetyCheckInProvider",
    ownerModule: 20,
    phi: true,
    denyStub: safetyCheckInProviderDenyStub,
  },
  {
    key: "SafetyPolicyProvider",
    ownerModule: 20,
    phi: false,
    denyStub: safetyPolicyProviderDenyStub,
  },
  {
    key: "SafetySupervisorProvider",
    ownerModule: 20,
    phi: false,
    denyStub: safetySupervisorProviderDenyStub,
  },
  // M32 (AI Platform) §4.2 PUBLISHED seams (M32-T06). Owned by M32; the real implementations register
  // over these when a DB client is present, and even then they refuse for the whole of Phase 1 because
  // `ai.full` is off for every tenant. The deny-stubs are what a DB-less boot stands on.
  //
  // PHI SPLIT — per SEAM, decided by what crosses the boundary TO A MODEL VENDOR, which is the strictest
  // reading available and the right one: §8.8 makes every cloud-routed invocation a §164.528 disclosure.
  //
  //   • The eight patient-scoped inference seams are phi: TRUE. A narrative draft IS the chart note; a
  //     DocLens page IS the intake document; a copilot question names the patient it is asked about; an
  //     embedding vector is a lossy but re-identifiable projection of the text it encodes (D20 gives
  //     each tenant its own HNSW index for exactly that reason). `BereavementRiskNarrativeProvider`
  //     carries a survivor's relationship and grief-risk factors — a decedent's family is still the
  //     patient's PHI under §164.502(f).
  //   • `DenialOutcomePredictionProvider` is phi: TRUE. §4.2.5's feature vector carries
  //     `patientLengthOfStayDays` against a claim id: a length of stay for an identified hospice
  //     admission is a health fact about a named individual, and "it is only billing" is the mistake
  //     that reading would be.
  //   • `AIPromptRegistry` is phi: FALSE, and this is the one place that is genuinely true rather than
  //     conveniently so. §3.2.5 is platform-shared reference data with a platform-floor "no PHI in
  //     template" invariant (D3); the registry answers with template metadata and a git-resolved prompt
  //     body, never with a patient's anything.
  {
    key: "NarrativeEnhancementProvider",
    ownerModule: 32,
    phi: true,
    denyStub: narrativeEnhancementProviderDenyStub,
  },
  { key: "DocLensClassifier", ownerModule: 32, phi: true, denyStub: docLensClassifierDenyStub },
  { key: "DocLensExtractor", ownerModule: 32, phi: true, denyStub: docLensExtractorDenyStub },
  {
    key: "DocLensVisionVerifier",
    ownerModule: 32,
    phi: true,
    denyStub: docLensVisionVerifierDenyStub,
  },
  { key: "DocLensSudDetector", ownerModule: 32, phi: true, denyStub: docLensSudDetectorDenyStub },
  {
    key: "BereavementRiskNarrativeProvider",
    ownerModule: 32,
    phi: true,
    denyStub: bereavementRiskNarrativeProviderDenyStub,
  },
  {
    key: "DenialOutcomePredictionProvider",
    ownerModule: 32,
    phi: true,
    denyStub: denialOutcomePredictionProviderDenyStub,
  },
  { key: "EmbeddingsProvider", ownerModule: 32, phi: true, denyStub: embeddingsProviderDenyStub },
  {
    key: "SemanticSearchProvider",
    ownerModule: 32,
    phi: true,
    denyStub: semanticSearchProviderDenyStub,
  },
  { key: "CopilotProvider", ownerModule: 32, phi: true, denyStub: copilotProviderDenyStub },
  { key: "AIPromptRegistry", ownerModule: 32, phi: false, denyStub: aiPromptRegistryDenyStub },
  // M37 §4.11 — the eight published IPU reader seams. M37 registers the REAL Drizzle-backed impls over these
  // deny-stubs via the composition-root hook (registerIpuSeams); until then validateSeams() applies the
  // fail-closed default. All ids + counts + policy flags — no raw PHI row crosses (D17/§8.5) → phi:false.
  { key: "IpuAdmissionReader", ownerModule: 37, phi: false, denyStub: ipuAdmissionReaderDenyStub },
  { key: "IpuCensusProvider", ownerModule: 37, phi: false, denyStub: ipuCensusProviderDenyStub },
  { key: "IpuBedAssignmentProvider", ownerModule: 37, phi: false, denyStub: ipuBedAssignmentProviderDenyStub },
  { key: "IpuShiftCoverageReader", ownerModule: 37, phi: false, denyStub: ipuShiftCoverageReaderDenyStub },
  { key: "IpuIvSafetyOverlayProvider", ownerModule: 37, phi: false, denyStub: ipuIvSafetyOverlayProviderDenyStub },
  { key: "IpuVisitorReader", ownerModule: 37, phi: false, denyStub: ipuVisitorReaderDenyStub },
  { key: "IpuQualityReader", ownerModule: 37, phi: false, denyStub: ipuQualityReaderDenyStub },
  { key: "IpuTenantPostureReader", ownerModule: 37, phi: false, denyStub: ipuTenantPostureReaderDenyStub },
] satisfies readonly RequiredSeam[];

/** A producer module registers its implementation of a published seam. */
export function registerSeam<K extends SeamName>(name: K, impl: SeamContracts[K]): void {
  registry.set(name, impl);
}

/** A consumer resolves a seam implementation (throws if requested before registration). */
export function getSeam<K extends SeamName>(name: K): SeamContracts[K] {
  const impl = registry.get(name);
  if (impl === undefined) throw new SeamError(`seam '${name}' requested before registration`);
  return impl as SeamContracts[K];
}

/**
 * Boot gate (§3.18.3): for every required seam that no module registered, apply its
 * deny-stub default so the seam fails CLOSED (denies on call). Refuse to boot — throwing
 * SeamError — only when a required seam has neither a registration nor a deny-stub. Run
 * after every module init() (wireSeams) and before server.listen().
 */
export function validateSeams(): void {
  const missing: string[] = [];
  for (const r of REQUIRED_SEAMS) {
    if (registry.has(r.key)) continue;
    if (r.denyStub !== undefined) {
      registry.set(r.key, r.denyStub); // fail closed: present, but denies on call
    } else {
      missing.push(`seam:${r.key} (owner M${r.ownerModule})`);
    }
  }
  if (missing.length > 0) {
    throw new SeamError(
      `validateSeams: ${missing.length} required seam(s) without a registration or deny-stub — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetSeamsForTest(): void {
  registry.clear();
}
