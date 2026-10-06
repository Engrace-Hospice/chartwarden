import type {
  AdmissionCensusReader,
  AdmissionOnsetReader,
  AdmissionStatusReader,
  CertificationReader,
  DeathDischargeReader,
  DischargeReader,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCarePeriodReader,
  LevelOfCareReader,
  ReferralReader,
} from "./admission";
import type { LatestAssessmentProvider, ScaleSeriesProvider } from "./assessment";
import type {
  BereavedPortalScopeProvider,
  BereavementAssignmentReader,
  BereavementComplianceProvider,
  BereavementOutreachProvider,
  BereavementPlanProvider,
  BereavementRiskFactorsProvider,
  BereavementRiskTierProvider,
  ExternalGriefResourceReader,
} from "./bereavement";
import type { CarePlanReader } from "./care-plan";
import type {
  DisciplineComplianceProvider,
  DisciplinePlanReader,
  MswRiskFactorReader,
  SupervisoryCadencePlanReader,
  VolunteerGateExpiryReader,
} from "./discipline-plans";
import type {
  DocumentReader,
  DocumentStorageProvider,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  PortalDocumentReader,
  RenderedDocumentProvider,
} from "./documents";
import type { MedicationOrderProvider, RefillInboxProvider } from "./dosespot";
import type { MedicationAdministrationProvider, ReconciliationProvider } from "./emar";
import type {
  BillableEncounterReader,
  EncounterCreator,
  EvvBracketResolver,
  MileagePayrollReader,
  SignedEncountersReader,
} from "./encounter";
import type {
  EvvAggregatorReferenceReader,
  EvvComplianceReader,
  EvvLocationProvider,
  EvvMetricsProvider,
  EvvVerificationProvider,
} from "./evv";
import type {
  FhirClientReader,
  FhirGatewayMetricsProvider,
  FhirInboundProposalReader,
} from "./fhir";
import type {
  HopeJ2051Provider,
  HopeOrgRollupProvider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
} from "./hope";
import type { NonCoveredItemsReader } from "./hospice-coverage";
import type { IdgDecisionProvider, IdgPacketProvider, IdgScheduleProvider } from "./idg";
import type {
  IpuAdmissionReader,
  IpuBedAssignmentProvider,
  IpuCensusProvider,
  IpuIvSafetyOverlayProvider,
  IpuQualityReader,
  IpuShiftCoverageReader,
  IpuTenantPostureReader,
  IpuVisitorReader,
} from "./inpatient";
import type {
  HospitalizationRiskProvider,
  OnCallProvider,
  PortalTriageReader,
  ProtocolSuggestionProvider,
  TriageCallMetricsProvider,
  TriageCallProvider,
  TriageCallReader,
} from "./oncall";
import type { OrderProvider, OrderSignatureProvider } from "./orders";
import type {
  PatientAddressReader,
  PatientAdmissionClearanceReader,
  PatientAllergyReader,
  PatientCaregiverReader,
  PatientCoverageReader,
  PatientHopeAdmissionPrefillReader,
  PatientIntakeResolver,
  PatientMutator,
  PatientPrivacyFlagReader,
  PatientReader,
} from "./patient";
// @wardenx/types — Boot-registered SEAM contracts (Phase 0 skeleton).
//
// Per ADR-0005 D1, cross-module consumption via a boot-registered seam needs NO
// dependsOn import edge: the INTERFACE lives here in a leaf package, and the
// IMPLEMENTATION is injected at boot and validated by validateSeams(). This file is
// the leaf-typed home for those interfaces. Phase 1 fills in real method shapes per
// each producer module's published seam contract; Phase 0 ships the minimal shape the
// bootstrap registry needs to compile and self-validate.
import type { StepUpFactor } from "./policy/step-up-policy";
import type {
  SafetyCheckInProvider,
  SafetyContextReader,
  SafetyDashboardProvider,
  SafetyIncidentReader,
  SafetyMetricsProvider,
  SafetyPolicyProvider,
  SafetySupervisorProvider,
} from "./safety";
import type {
  PortalVisitReader,
  SupervisoryCadenceReader,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
  VolunteerComplianceProvider,
} from "./scheduling";
import type {
  AITokenMeterProvider,
  BillingStatusProvider,
  ExternalInterfaceMetricsProvider,
  OnboardingStatusProvider,
  PatientCounterProvider,
  PlanCatalogReader,
  RevenueMetricsProvider,
  SubscriptionStateProvider,
  UsageMeteringIngest,
} from "./subscription-billing";
import type {
  ComfortKitDispatchProvider,
  SupplyCostProvider,
  SupplyFulfillmentProvider,
} from "./supplies";

/** Opaque tenant scope every seam call carries (resolved by withOrgContext). */
export interface OrgScope {
  readonly orgId: string;
}

/**
 * Canonical seam names. The bootstrap REQUIRED_SEAMS list and registerSeam()/getSeam()
 * calls key on these. Add a new name here when a producer module publishes a seam.
 */
export type SeamName =
  | "CaseloadProvider" // M5/M17 — which patients an actor may see
  | "CareTeamProvider" // M5 — every user id currently on a patient's care team (M36 channel auto-sync, D5)
  | "CredentialReader" // M17 — a membership's active clinical-license/certification rows as-of a date (§1.1 D8, GAP-093)
  | "ElevatedApprovalReader" // M2 — does a membership hold a named per-tenant approval authority (GAP-043)
  | "PatientReader" // M5 — patient identity/demographics reads (§4.8; M29 cascade)
  | "PatientHopeAdmissionPrefillReader" // M5 — narrow demographic/identifier snapshot for M10 HOPE Admission prefill
  | "PatientIntakeResolver" // M5 — referral-intake patient match/confirm/create orchestration
  | "PatientAdmissionClearanceReader" // M5 — high-level privacy clearance for admission activation
  | "PatientCoverageReader" // M5 — §3.4 coverage list; M23/M24 resolve which payer a claim bills
  | "PatientCaregiverReader" // M5 — TASK-015: is a user the patient's primary caregiver (M31 portal ABAC); deny-stub only
  | "PatientAddressReader" // M5 — TASK-015: patient residence state (M31 portal two-party-recording ABAC)
  | "NonCoveredMedicationsReader" // M12 — COP27: active medication orders determined NOT hospice-covered (M6 election addendum, 42 CFR 418.24(c))
  | "NonCoveredDmeSuppliesReader" // M21 — COP27: active dme/supply requests determined NOT hospice-covered (M6 election addendum)
  | "PatientAllergyReader" // M5 — the patient's current allergy list (M12 requestSignature allergy gate, GAP-036)
  | "PatientPrivacyFlagReader" // M5 §3.5 — sex class + active privacy flags (M37 shared-room gate, GAP-061)
  | "ExternalGriefResourceReader" // M40 — TASK-015: bereaved-portal external resources list; deny-stub only (no M40 table yet)
  | "PatientMutator" // M5 — apply an M29-proposal/amendment field diff (§4.9; D12 strip)
  | "DocumentRenderer" // M22 — render a typed payload to a stored document (W2 handshake)
  | "DocumentStorageProvider" // M22 — per-tenant object storage (presign + version-aware destroy; §4.3/D1)
  // M22's five §4.3 PUBLISHED reader seams — leaf-typed (interfaces in ./documents, this leaf). All read-only
  // projections downstream modules attach to instead of importing M22's schema: `RenderedDocumentProvider` —
  // every source module's `m22-document-backref` consumer resolves the rendered document for its aggregate;
  // `DocumentReader` — M28 (FHIR DocumentReference), M31 (portal list), M33 (reporting); `PortalDocumentReader`
  // — M31 portal (internal tags stripped, SUD filtered per consent); `IntakeMetricsProvider` — M33/M30 intake
  // throughput; `ExtractionProvenanceReader` — M28 (FHIR Provenance) + M30 (HQRP AI-governance) per-chart-field
  // provenance (the data exists even though DocLens is OFF). M22 registers the real impls over the deny-stubs
  // (M22-T05); consumers that list `22` in `dependsOn` resolve them through the typed accessors with no schema edge.
  | "RenderedDocumentProvider" // M22 — rendered-document-for-aggregate read seam (the render back-ref resolve)
  | "DocumentReader" // M22 — document/version digest read seam (FHIR projection / portal list / reporting)
  | "PortalDocumentReader" // M22 — portal-safe document read seam (tags stripped, SUD filtered, mint download URL)
  | "IntakeMetricsProvider" // M22 — intake-throughput metrics read seam (bundles processed / time-to-review)
  | "ExtractionProvenanceReader" // M22 — per-chart-field extraction provenance read seam (data exists, DocLens OFF)
  | "ConsentEvaluator" // M39 — disclosure/redaction gate
  | "SessionContextResolver" // M2 — authenticated, org-scoped request context (actor + step-up state)
  | "AuditorSessionMinter" // M2 — mint a time-boxed auditor magic-link session (M3 calls it)
  | "PortalSessionBinder" // M2 — stamp class + scope on an M31 portal session (M31 calls it)
  | "VendorSessionBinder" // M2 — stamp class + vendor scope on an M19 answering-service session (M19 calls it)
  | "TenantOrgCreationProvider" // M2 — create/attach the per-tenant org M34's provision worker needs (§7.1)
  | "OrganizationReader" // M2 — resolve org display metadata by id (M35 admin lists label cross-tenant rows)
  | "TerminologyProvider" // M38 — version-aware code/value-set resolution (every clinical/billing module)
  | "AlertEmitter" // M36 — emit an event; M36 resolves rules + recipients + fan-out (every module)
  | "MessagingProvider" // M36 — channel/message surface (DEK-encrypted bodies; PHI read surface)
  | "MdmEntityProvider" // M40 — master-data read surface (physician/facility/payer; merge-aware)
  | "BaaStatusProvider" // M40 — focused §7.7 BAA disclosure gate (as-of; M22/M28/M29 import this)
  | "MetricsProvider" // M33 — embedded dashboard-metric read (aggregate-only, org-scoped; M30/M34/M37 embed)
  // M6 (Admission, Election & Certification) reader seams (§4.7) — leaf-typed read-only DTO surfaces
  // every downstream clinical/billing module consumes instead of importing M6's schema. Interfaces
  // live in ./admission (this leaf), so — unlike the opaque rich-seams above — they are typed here.
  | "ElectionPeriodReader" // M6 — M23 binds a NOE/NOTR claim to the correct benefit period/sequence
  | "CertificationReader" // M6 — recert gating: the active CTI for a period + whether it is signed
  | "FaceToFaceReader" // M6 — recert gating: the attested F2F for a period + whether one exists
  | "LevelOfCareReader" // M6 — current LOC + LOC-days by level over a range (M26 aggregate cap)
  | "AdmissionStatusReader" // M6 — admission state projection (M14 queues, M30 dashboard)
  | "AdmissionCensusReader" // M6 — active-admission census/list (M30 dashboards, M22 form prep)
  | "ReferralReader" // M6 — referral existence/visibility for Referral Inbox document artifacts
  | "DeathDischargeReader" // M6 — death-discharge census for a period (M30 HVLDL measure denominator, §4.11)
  | "LevelOfCarePeriodReader" // M6 — election-period × CHC/GIP-day coverage counts (M30 HCI indicator 1)
  | "DischargeReader" // M6 — ALL-discharge-type census + early/late live-discharge counts (M30 HCI 3/4)
  | "AdmissionOnsetReader" // M6 — admissions started in a period (M30 opioid_on_admission_rate denominator)
  // M6's F2F/compliance-window aggregate (F-178, #248) follows the OPAQUE rich-seam pattern instead of its
  // leaf-typed siblings above: the consumer-facing view interface lives in M30's own `@wardenx/quality`
  // package (`ComplianceWindowCountsView`, packages/quality/src/seams/consumed/m6-compliance-window.ts,
  // the `ClaimLineReader`/`PatientDaysProvider` precedent), so the registry holds the instance as `unknown`
  // and M30 resolves it via `getSeam` + a cast to that view. Registered by M6 at boot over the fail-closed
  // deny-stub.
  | "ComplianceWindowCountsProvider" // M6 — F2F/compliance-window on-time + override rate counts (M30 batch pull)
  // M7 (Care Plan / IPOC) reader seam (§7.8) — also leaf-typed (interface in ./care-plan), so it is
  // typed here like M6's readers. M8 (encounter authoring + sign gate), M14 (IDG packet), M15
  // (discipline care plans) consume it instead of importing M7's schema.
  | "CarePlanReader" // M7 — encounter-relevance picker + the 5-/15-day overdue sign-gate
  // M8 (Encounters & Visit Notes) owned seams (§4.7) — also leaf-typed (interfaces in ./encounter), so
  // they are typed here like M6/M7's readers. M23/M24 (billability), M14/M22 (signed digests + render),
  // M27 (payroll mileage), and M16/M17 (encounter creation) consume them instead of importing M8's schema.
  | "BillableEncounterReader" // M8 — per-encounter claim-line eligibility (M23/M24)
  | "SignedEncountersReader" // M8 — signed-encounter digests + render payload (M14 IDG, M22 PDF)
  | "MileagePayrollReader" // M8 — authoritative per-clinician mileage for payroll/AP (M27)
  | "EncounterCreator" // M8 — open a draft encounter for an upstream reuser (M16 bereavement, M17 seeding)
  // M18 (EVV) forward seam M8 CONSUMES (§4.7 / D9) — leaf-typed (interface in ./encounter), so it is
  // typed here like M6/M7's readers. Registered with a fail-closed deny-stub until M18 lands (Wave F);
  // M8 resolves it with NO `dependsOn` edge to M18 (the leaf interface, not @wardenx/evv).
  | "EvvBracketResolver" // M18 — authoritative EVV bracket for an encounter's visit at finalize (D9)
  // M18 (EVV) owned seams (§4.3 / D15) — leaf-typed (interfaces in ./evv, this leaf), so they are typed here
  // like M6..M17's seams. The sixth published M18 seam is `EvvBracketResolver` above (the EXISTING M8-consumed
  // contract M18 publishes the impl over; M18-T01 GOTCHA — never re-declared). These five are the rest: all
  // READ-only projections over M18's `evv_event` / `evv_missing_resolution` / `evv_aggregator_submission` rows.
  // `EvvComplianceReader` — the billing pre-submission compliance gate M23/M24 + the M30 HQRP measure consume;
  // `EvvAggregatorReferenceReader` — the state-aggregator transaction-id back-link M24 (claim) + M25 (denial)
  // consume; `EvvLocationProvider` — the last-known-clinician-location read M20 field-safety live-awareness
  // consumes (coordinate-bearing); `EvvMetricsProvider` — the productivity/quality measures M30/M33 dashboards
  // consume; `EvvVerificationProvider` — the M31 portal "Nurse arrived at HH:MM" surface (timestamp only, no
  // coordinates) — all instead of importing M18's schema. M18 owns the EVV lifecycle internally; none mutates.
  | "EvvComplianceReader" // M18 — billing compliance gate (compliant / documented_missing / unresolved_missing / not_required) + HQRP rate
  | "EvvAggregatorReferenceReader" // M18 — per-state aggregator transaction-id + submission back-link (M24 claim / M25 denial)
  | "EvvLocationProvider" // M18 — last-known clinician location (M20 field-safety live-awareness; coordinate-bearing)
  | "EvvMetricsProvider" // M18 — productivity + quality measures (compliance / late-checkout / geofence / spoof / aggregator / device coverage)
  | "EvvVerificationProvider" // M18 — portal arrival/verification surface (timestamp only, no coordinates)
  // M9 (Clinical Assessments) owned seams (§4.7 / D7) — also leaf-typed (interfaces in ./assessment), so
  // they are typed here like M6/M7/M8's readers. M7 (CTI/IDG latest PPS/FAST/ESAS-r), M10 (HOPE prognosis),
  // M14 (IDG packet deltas), M28 (FHIR Observation series), M32 (AI symptom-trajectory) consume them
  // instead of importing M9's schema.
  | "LatestAssessmentProvider" // M9 — hot latest-active-per-scale read (CTI draft, IDG packet, HOPE context)
  | "ScaleSeriesProvider" // M9 — windowed scored series + latest-vs-window delta (IDG, FHIR, AI trajectory)
  // M10 (HOPE Engine) owned seams (§2 / D10) — also leaf-typed (interfaces in ./hope), so they are typed
  // here like M6/M7/M8/M9's readers. M14 (open HOPE windows on the IDG packet), M22 (per-admission HOPE
  // timeline PDF), M30 (HQRP on-time / acceptance / Timely-Follow-Up measures), M32 (AI symptom-trajectory +
  // decline-prediction) consume them instead of importing M10's schema.
  | "HopeTimepointProvider" // M10 — open/all timepoint windows + completion state (IDG, PDF timeline, HQRP, AI)
  | "HopeJ2051Provider" // M10 — J2051 trigger history + open SFV obligations (HQRP Timely-Follow-Up, AI trajectory)
  | "HopeSubmissionProvider" // M10 — per-PE submission batch status (HQRP acceptance posture, submission dashboards)
  | "HopeOrgRollupProvider" // M10 — ORG-LEVEL aggregate HOPE rollup (M30 measure-recompute; aggregate-only COUNTS, D6)
  // M11 (Orders) owned seams (§2.8 D14 / §4.3) — also leaf-typed (interfaces in ./orders), so they are typed
  // here like M6/M7/M8/M9/M10's seams. M12 (the polymorphic medication-order signature primitive), M14 (IDG
  // "orders since last IDG"), M23 (the claim "every billed line has a covering order" rule), M30 (order-
  // completion + verbal-order-timeliness HQRP measures), M7 (care-plan intervention → order back-ref) consume
  // them instead of importing M11's schema. `OrderSignatureProvider` is the one MUTATE seam (M12 writes med-
  // order signatures through it); `OrderProvider` is the read-side counterpart.
  | "OrderSignatureProvider" // M11 — polymorphic clinical-signature primitive (sign / verbal / cosign / discontinue)
  | "OrderProvider" // M11 — order read seam (active / by-patient / since / verbal-timeliness / discontinuation)
  // M12 (DoseSpot Integration) owned seams (§2.10 D17) — also leaf-typed (interfaces in ./dosespot, this leaf),
  // so they are typed here like M6..M11's seams. Both are READ-only surfaces: `MedicationOrderProvider` is the
  // medication-order read path M13 (eMAR administration context), M14 (IDG packet), M19/M30/M33 (derived
  // signals + cost basis + quality), M28 (FHIR `MedicationRequest`), M31 (portal summary) consume; M12 owns the
  // `medication_order` table + the prescribing workflow and downstream modules NEVER import its schema.
  // `RefillInboxProvider` is the refill-request read path the prescriber inbox UI, M19 (on-call "any pending
  // refills tonight?"), and M33 (SLA dashboards) consume over `refill_request`.
  | "MedicationOrderProvider" // M12 — medication-order read seam (active / since / admin-context / controlled flag / cost / portal / FHIR)
  | "RefillInboxProvider" // M12 — refill-inbox read seam (pending-by-prescriber / pending-by-patient / by-id)
  // M13 (eMAR & Med Administration) owned seams (§2.12 D16) — also leaf-typed (interfaces in ./emar, this leaf),
  // so they are typed here like M6..M12's seams. Both are READ-only surfaces over M13's `administration_record` /
  // `medication_reconciliation_*` tables: `MedicationAdministrationProvider` is the administration read path M14
  // (IDG "administrations since last meeting"), M28 (FHIR `MedicationAdministration`), M30 (PRN-effectiveness /
  // missed-dose / comfort-kit-timeliness measures), M31 (portal lay-language summary, SUD-redacted), M33
  // (dashboards), and M37 (IPU IV-pump overlay) consume; `ReconciliationProvider` is the reconciliation-worksheet
  // read path M14 (IDG packet) and M30 (reconciliation-timeliness measure) consume — all instead of importing
  // M13's schema. M13 owns the recording + reconciliation workflows and downstream modules NEVER import its schema.
  | "MedicationAdministrationProvider" // M13 — administration read seam (by-id / by-patient / by-order / since / measure inputs / portal / IV session / FHIR)
  | "ReconciliationProvider" // M13 — reconciliation read seam (worksheet by-id / by-admission / timeliness)
  // M14 (Interdisciplinary Group / IDG) owned seams (§4.8) — also leaf-typed (interfaces in ./idg, this leaf), so
  // they are typed here like M6..M13's seams. All three are READ surfaces over M14's `idg_*` tables:
  // `IdgPacketProvider` is the packet-snapshot + render handshake M22 (minutes/packet PDF) + M33 (dashboards)
  // consume; `IdgDecisionProvider` is the decision read path M30 (decision-to-careplan-update latency measure) +
  // M33 consume; `IdgScheduleProvider` is the meeting-schedule + 15-day-cadence read path M28 (FHIR
  // `CareTeam`/`Encounter`) + M30 (cadence-adherence measure) + M33 consume — all instead of importing M14's
  // schema. M14 owns the meeting/decision/packet lifecycle internally and downstream modules NEVER import its schema.
  | "IdgPacketProvider" // M14 — packet read seam (snapshot by-id + M22 render payload)
  | "IdgDecisionProvider" // M14 — decision read seam (by-care-plan / by-meeting)
  | "IdgScheduleProvider" // M14 — schedule read seam (meetings-for-location / cadence-adherence)
  // M17 (Scheduling & Route Optimization) owned seams (§4.3) — also leaf-typed (interfaces in ./scheduling,
  // this leaf), so they are typed here like M6..M14's seams. All four are READ surfaces over M17's `visit` /
  // `visit_state_history` / `route_segment` rows: `VisitReader` is the visit read path M8 (encounter-authoring
  // context — closes M8's visit-seeding inert consumer, M8 D9), M18 (EVV geofence target), M14 (IDG packet
  // "completed visits since last meeting") consume; `VisitAssignmentReader` is the assignment/roster/live read
  // path M5 (the §4.5 D11 caseload-contribution projection `patientCaseloadProvider` reads), M19 (on-call
  // triage), M20 (field-safety live-awareness) consume; `PortalVisitReader` is the M31 portal upcoming-visit
  // read path (lay-language, scheduler-internal notes scrubbed); `VisitMetricsProvider` is the M30/M33
  // productivity + quality measures read path — all instead of importing M17's schema. M17 owns the visit
  // lifecycle internally and downstream modules NEVER import its schema; none is a mutate path.
  | "VisitReader" // M17 — visit read seam (encounter context / EVV geofence target / IDG since-meeting)
  | "VisitAssignmentReader" // M17 — assignment read seam (caseload contribution / on-call roster / live in_visit)
  | "PortalVisitReader" // M17 — portal upcoming-visit read seam (lay-language, scrubbed)
  | "VisitMetricsProvider" // M17 — productivity + quality measures read seam (on-time / no-show / reschedule / route / stability)
  // M15 (Discipline Care Plans) owned seams M17 CONSUMES (§4.4) — leaf-typed in ./scheduling because M17 shipped
  // FIRST and its D8 pre-schedule gate (predicate 6) + day-view advisory compile against those LOCKED shapes
  // (per-membership / per-ADMISSION). M15-T05 registers the real impls over the M17-F06/ADR-0009 deny-stubs;
  // the stubs remain the fail-closed default for a boot that does not wire M15. No `dependsOn` edge (registry
  // is M1-owned).
  | "VolunteerComplianceProvider" // M15 — per-membership volunteer-compliance status (gate predicate 6, VOLUNTEER_GATE_UNMET)
  | "SupervisoryCadenceReader" // M15 — next-due RN supervisory visit per admission (day-view advisory + propose-from-frequency)
  // The rest of M15's §4.3 published surface (M15-T05) — leaf-typed in ./discipline-plans. `DisciplinePlanReader`
  // is the plan read path M14's IDG packet builder + M22 (plan PDFs) + M28/M31/M33 consume; `MswRiskFactorReader`
  // exposes the psychosocial factors M16's bereavement rubric SCORES (M15 never scores, §1.2);
  // `VolunteerGateExpiryReader` + `SupervisoryCadencePlanReader` carry the §4.3 surface the two LOCKED M17
  // contracts above do not cover (the expiry sweep, the per-PLAN cadence + overdue worklist);
  // `DisciplineComplianceProvider` is the M30 HQRP / M33 dashboard rollup. All read-only — M15 owns the plan,
  // supervisory and volunteer lifecycles internally and never mutates through a seam.
  | "DisciplinePlanReader" // M15 — discipline-plan read seam (active plans / full plan / IDG one-pager)
  | "MswRiskFactorReader" // M15 — MSW psychosocial risk factors per admission (M16 bereavement rubric input)
  | "VolunteerGateExpiryReader" // M15 — the 418.78 gate-expiry sweep (coordinator worklist + M36 alerts)
  | "SupervisoryCadencePlanReader" // M15 — per-plan 418.76(h) cadence state + the overdue worklist
  | "DisciplineComplianceProvider" // M15 — supervisory / initial-assessment / volunteer-gate rates + the 418.78(e) ratio
  // M16 (Bereavement) owned seams (§4.6 / D13) — leaf-typed in ./bereavement (this package). SIX reads plus
  // ONE write: `BereavementRiskFactorsProvider.registerAugmentation` is M32's Layer-2 write-back, and it
  // APPENDS to the immutable `bereavement_risk_score` ledger (D8) — the narrative can never move the
  // deterministic `rule_tier` a cadence decision was made on (AI Governance §7.4). M16-T05 registers the real
  // impls; the deny-stubs stay the fail-closed default for a boot that does not wire M16.
  | "BereavementPlanProvider" // M16 — plan header / roster / closeout rollup (M28 FHIR, M30, M31, M33, M36 channel)
  | "BereavementOutreachProvider" // M16 — touchpoint reads + the CoP 418.64(d) counts (M30 rate, M33 dashboard)
  | "BereavementRiskFactorsProvider" // M16 — D3/D17 factor snapshot + deterministic score + the M32 Layer-2 append
  | "BereavementAssignmentReader" // M16 — plan assignment + counselor caseload (M36 recipient resolver, M3 ABAC)
  | "BereavedPortalScopeProvider" // M16 — the M31 bereaved-family session scope (§1.2 / D10 narrow)
  | "BereavementComplianceProvider" // M16 — CoP / screening-completeness / closure COUNTS (M30 HQRP, M33)
  | "BereavementRiskTierProvider" // M16 — risk-tier distribution (M30 chart, M33 dashboard)
  // M21 (Supplies, DME & Comfort Kits) owned seams (§4.8 / D14) — leaf-typed in ./supplies (this package).
  // TWO reads plus ONE write-shaped notify: `ComfortKitDispatchProvider.notifyAdministrationDrawdown` is
  // M13's bedside-count report, and it does NOT decide a discrepancy — it cascades INTO M21's §2.6
  // reconciliation, which owns the D8 verdict. M21-T05 registers the real impls; the deny-stubs stay the
  // fail-closed default for a boot that does not wire M21.
  | "SupplyFulfillmentProvider" // M21 — direct request creation + request status / terminality (M11 cascade, M22, M28, M30, M33)
  | "ComfortKitDispatchProvider" // M21 — bedside kit inventory + lot detail + the D17 IPU-room stock kit (M13, M30, M33, M37)
  | "SupplyCostProvider" // M21 — per-patient / per-org supply spend in CENTS (M23 cap analysis, M27 cost report)
  | "CapAccrualReader" // M26 — cap-period aggregate for the M27 cost-report Worksheet-E cap calc (aggregate $/days, no PHI)
  | "CapProjectionProvider" // M26 — agency/patient/inpatient cap projection for the M23 §11.A pre-submission cap rules
  // M23/M25 → M27 cost-report validation binds. M23 is the FIRST module to publish into the typed M1
  // registry (it was outbox-only before); M25 follows. All three are aggregate, FY-scoped, PHI-free (D18):
  | "PatientDaysProvider" // M23 — billed-and-accepted census patient-days for a FY (M27 stats.patient_days_reconcile)
  | "DrugCostBillingReader" // M12 — drug-cost basis for a FY, M27 Worksheet-A pharmacy cross-check (drug_cost.billed_reconciles). RESERVATION: degrades until M12 materializes med-order cost (no cost column today)
  | "ClaimSettlementProvider" // M25 — actual interim Medicare payments (835 CLP04) for a FY (M27 settlement.e1_ties_to_d)
  | "ClaimLineReader" // M23 — per-LOC billed claim-line day rollup for a window (M30 HCI claims-derived indicators)
  | "ClaimSubmissionReader" // M23 — accepted-submission match candidates by payer/patient control number + claim->patient id, for M25 835-to-claim auto-match (D3) and PR-ledger patient resolution (WX-PR-012)
  | "MedicaidClaimMatchProvider" // M24 — Medicaid claim-control-number match candidates + claim->patient id, for M25 835-to-claim auto-match routed by payerKind (F-172, #248 m24 group)
  | "CostReportFilingStatusReader" // M27 — cost-report filing posture per FY (M30 CoP 418.310 failure-to-file indicator)
  // M30 (HQRP & Quality) §4.3 — the five READ-ONLY seams M30 publishes. Before these, M30 was reachable
  // cross-module ONLY through its §4.10 outbox events, with no read path at all. GAP-066: registered and
  // live, but with NO consumer yet — the per-seam consumer notes below name the surfaces each is FOR
  // (M22 minutes, M33 dashboards, M34's tenant gate), none of which is built. Intent, not current wiring.
  | "QualityMeasureProvider" // M30 — HQRP measure values/series/snapshot + the FY measure catalog (aggregate-only)
  | "IncidentRegisterProvider" // M30 — incident register (PHI: patient-scoped rows require caller patient scope)
  | "QapiProjectProvider" // M30 — QAPI projects/PIPs by phase (M22 minutes, M33 dashboards)
  | "ComplianceStatusProvider" // M30 — CoP compliance status per condition (M34 tenant gate, M33 dashboards)
  | "SecurityRiskAssessmentReader" // M30 — SRA cycle posture (§164.308(a)(1)(ii)(A) attestation surface)
  // M19 (On-Call Triage) §4.3 — the five READ-ONLY seams M19 publishes, leaf-typed in ./oncall (this
  // package). Before these, M19 was reachable cross-module ONLY through its §4.10 outbox events, so M36's
  // `on_call` recipient resolver, M20's after-hours SOS parallel recipient, M14's IDG packet, M31's portal
  // care-log and M30/M33's operational measures had no read path at all. M19-T06 registers the real impls;
  // the deny-stubs stay the fail-closed default for a boot that does not wire M19.
  | "BereavementEncounterReader" // M8 — one encounter's type/status/patient facts (M16 verifies a bereavement visit's source encounter)
  | "PatientSitingReader" // M6 — the location ids of a patient's active admission(s) (M36 care-team channel siting)
  | "SupervisorReader" // M3 — supervision/location facts about a membership (M33 scoping, M36 member admin)
  | "AuditorEngagementReader" // M3 — is an auditor engagement active for this auditor now (M31 auditor view, GAP-093)
  | "OnCallProvider" // M19 — who is on call now + the active shifts M36's channel synchronizer re-syncs on
  | "TriageCallReader" // M19 — M32's PHI-free feature read + M14's since-last-IDG digest
  | "TriageCallProvider" // M19 — M14's full packet slice + M11's verbal-order → triage-context reverse lookup
  | "PortalTriageReader" // M19 — the ONLY M19 surface M31's portal may reach (lay-language, D11/D13 scrubbed)
  | "TriageCallMetricsProvider" // M19 — M30/M33 operational + quality measures (rates AND the counts behind them)
  // M32 (AI Platform) — the two ADVISORY seams M19 CONSUMES (§4.4 / §8.6, D11/D12), leaf-typed in ./oncall
  // because M32 is a placeholder module (the M8/`EvvBracketResolver` forward-seam precedent). Their
  // deny-stubs answer `unavailable` rather than throwing: an advisory that gates nothing must not take
  // down the intake path — see the fail-posture note above the interfaces.
  | "ProtocolSuggestionProvider" // M32 — D12 protocol suggestion (advisory; never auto-applied)
  | "HospitalizationRiskProvider" // M32 — D11 30-day risk band (advisory; excluded from the portal projection)
  // M20 (Field Safety) §4.3 PUBLISHED seams (M20-T05). Seven read surfaces over M20's thirteen
  // `safety_*` tables that M8 (encounter-authoring safety context), M17 (visit-day badging + the board
  // embed), M19 (after-hours window default), M30/M33 (operational dashboards), M32 (the future
  // high-risk-area suggestion model) and M36 (the §4.5 `field_safety_composed` recipient resolver)
  // attach to instead of importing M20's schema (architecture §25.15).
  | "SafetyDashboardProvider" // M20 — the supervisor live-awareness board, also embedded by M17's day view
  | "SafetyContextReader" // M20 — M8's "did something happen during this visit?" encounter-authoring read
  | "SafetyIncidentReader" // M20 — M32's minimum-necessary incident projection (§8.6 rounded coordinates)
  | "SafetyMetricsProvider" // M20 — M30/M33 aggregates, every rate WITH its denominator
  | "SafetyCheckInProvider" // M20 — M17's per-visit pre/mid/post check-in badge trio
  | "SafetyPolicyProvider" // M20 — the ONLY read path to the effective policy (§2.2.4), incl. the replay arm
  | "SafetySupervisorProvider" // M20 — who gets paged + the §7.8 coverage gaps (M36's composed resolver)
  // M32 (AI Platform) §4.2 PUBLISHED seams (M32-T06). OPAQUE rich-seams: every interface lives in
  // @wardenx/ai-platform, which this leaf may not import (`leaves-stay-leaves`, ARCHITECTURE §25.15), so
  // the registry holds each instance as `unknown` and consumers that list `32` in their manifest
  // `dependsOn` import the real type and resolve through the typed accessor.
  //
  // ALL ELEVEN ANSWER `{ available: false, unavailable: … }` RATHER THAN THROWING, and that is the
  // single decision that shapes the family. Every consumer of an M32 seam has a Layer-1 path it must
  // fall back to — M8's unenhanced note, M22's manual intake review, M16's deterministic grief score —
  // and a throwing deny-stub makes falling back conditional on somebody remembering a try/catch (the
  // M20-T01 finding). §4.2.1 says it outright: "absence is a first-class result, not an error".
  //
  // `ProtocolSuggestionProvider` / `HospitalizationRiskProvider` are M32's too but are declared ABOVE,
  // leaf-typed in ./oncall by M19-T01, which shipped first and locked their shapes. M32 registers over
  // those names; it does not re-declare them.
  | "NarrativeEnhancementProvider" // M32 — §4.2.1 HearthNote Layer 2 / IDG polish (M8 locked, M14/M16 optional)
  | "DocLensClassifier" // M32 — §4.2.2 document-type classification (M22)
  | "DocLensExtractor" // M32 — §4.2.2 structured field extraction (M22)
  | "DocLensVisionVerifier" // M32 — §4.2.2 signature/redaction/page-integrity vision check (M22)
  | "DocLensSudDetector" // M32 — §4.2.2 42 CFR Part 2 SUD indicator detection (M22)
  | "BereavementRiskNarrativeProvider" // M32 — §4.2.4 complicated-grief risk narrative (M16, optional)
  | "DenialOutcomePredictionProvider" // M32 — §4.2.5 denial/appeal probability (M25; advisory, never gates)
  | "EmbeddingsProvider" // M32 — §4.2.6 tenant-scoped embedding vectors (contract locked, no Phase-1 consumer)
  | "SemanticSearchProvider" // M32 — §4.2.6 chart-scoped semantic search (contract locked, no Phase-1 consumer)
  | "CopilotProvider" // M32 — §4.2.6 chart copilot Q&A (contract locked, no Phase-1 consumer)
  | "AIPromptRegistry" // M32 — §4.5 the D18 prompt-registry query API M12/M13/M18/M21/M27/M28 boot on
  // M28 (FHIR Gateway) §4.3 PUBLISHED seams (M28-T06) — leaf-typed (interfaces in ./fhir, this leaf), so
  // they are typed here like M6..M20's readers. All three are READ-only projections over M28's own
  // `fhir_client` / `fhir_inbound_resource` / disclosure-audit rows that M33 (utilization dashboards) /
  // M30 (§164.528 disclosure scorecard) / M34 (SaaS console client registry) / M5 + M12 (inbound-proposal
  // review queues) consume instead of importing M28's schema. M28 registers the real Drizzle-backed impls
  // over the deny-stubs when its routes/repos land (M28-T08); until then the fail-closed deny-stub stands.
  | "FhirGatewayMetricsProvider" // M28 — per-tenant utilization + the §164.528 disclosure metric (aggregate COUNTS, no PHI)
  | "FhirClientReader" // M28 — FHIR client registry read (M34 SaaS console; registry metadata, no PHI)
  | "FhirInboundProposalReader" // M28 — staged inbound-proposal review queue (M5/M12; PHI — raw FHIR payload)
  // Two §4.4 CONSUMED forward-seams M28 requires but whose owner modules do not publish them yet. OPAQUE
  // rich-seams (their rich interfaces live in @wardenx/billing / @wardenx/external-interfaces, which this
  // leaf may not import), so the registry holds each as `unknown` and M28 resolves via `getSeam` + a cast
  // to its own consumer view. Both stay on the fail-closed deny-stub the whole of Phase 1:
  //   · `ClaimReader` (M23) — the W-FHIR-07 Claim/ClaimResponse/EOB projection. `fhir.write` OFF ⇒ the
  //     route returns 404 (§7.7) and never reaches this seam; it is required so a boot without M23's D1
  //     unlock fails CLOSED rather than serving a Phase-2 resource.
  //   · `LabObservationReader` (M29) — the §4.11 DiagnosticReport result-value source. M29 is a Phase-1
  //     placeholder; the seam is required so M28's DiagnosticReport projection ships only once M29 does.
  | "ClaimReader" // M23 — §4.4 Claim/EOB FHIR projection (W-FHIR-07 forward-seam; 404 until fhir.write/D1 unlock)
  | "LabObservationReader" // M29 — §4.11 DiagnosticReport result-value read (M29-T08 registers the real impl)
  // M29 (External Interfaces) §4.4 — the three OTHER published read seams M29 registers into the M1 registry
  // (M29-T08), alongside `LabObservationReader` (above) + `ExternalInterfaceMetricsProvider` (below, declared
  // for M35). OPAQUE rich-seams: their interfaces live in the M29 backend module (not this leaf, which may
  // not import an app module), so the registry holds each as `unknown` and a consumer (M5/M6/M33/M34/M40)
  // resolves via `getSeam` + a cast to its own view. Each stays on the fail-closed deny-stub until M29's
  // Drizzle seam store is bound (M29-T08). `Hl7InboundProposalReader` reaches a demographic candidate (PHI);
  // `ExternalFeedReader` is feed config/health metadata; `NppesProviderReader` is public-directory data.
  | "Hl7InboundProposalReader" // M29 — pending ADT-proposal review queue (M5/M6 badge; PHI)
  | "ExternalFeedReader" // M29 — per-org feed inventory + health snapshot (M33/M34; no credentials)
  | "NppesProviderReader" // M29 — platform-shared NPPES public-directory lookup (M28/M40)
  // M35 (Subscription Billing) §4.5 — the SIX PUBLISHED seams M35 registers into the M1 registry (M35-T05).
  // Leaf-typed (interfaces in ./subscription-billing, this leaf), so — like M6..M20's readers — the registry
  // is statically typed against the real contract. M35 registers the real Drizzle-backed impls over the
  // deny-stubs when its routes/stores land (M35-T06); until then `validateSeams()` applies the fail-closed
  // deny-stub. M33 (revenue/subscription dashboards) + M34 (SaaS console, ADR-0025 no-edge) consume them.
  // All aggregate/subscription-header metadata — no patient row crosses (D18/§8.5) → phi:false throughout.
  | "SubscriptionStateProvider" // M35 — subscription header + state-history read (M33/M34; ADR-0025)
  | "BillingStatusProvider" // M35 — the billing-block gate + Phase-1 open quota check (M28/M29/M32/M34)
  | "UsageMeteringIngest" // M35 — PHI-free usage-event ingest (M23/M24/M28/M29/M32; redactor-enforced)
  | "PatientCounterProvider" // M35 — pseudonymized active-patient count for a period (reconciles vs M5)
  | "RevenueMetricsProvider" // M35 — platform-shared MRR/ARR snapshots + status counts (M33 revenue dashboard)
  | "PlanCatalogReader" // M35 — public (unauthenticated) plan catalog read (marketing pages + onboarding)
  // M35 §4.6 — the THREE forward-seam CONSUMER VIEWS M35 requires but whose owner modules do not publish them
  // yet. Leaf-typed (M35's consumer view in ./subscription-billing). Each stays on the fail-closed deny-stub
  // until its source module locks; M35's metering/billing paths (M35-T06) resolve them via `getSeam`.
  // (M35 also consumes M28's `FhirGatewayMetricsProvider` above — declared by M28, NOT re-declared here.)
  | "OnboardingStatusProvider" // M34 — SaaS-onboarding billability gate (ADR-0025; interim: active-org = billable)
  | "ExternalInterfaceMetricsProvider" // M29 — HL7 feed-health message counts (M35 `hl7_message` meter input)
  | "AITokenMeterProvider" // M32 — AI-token consumption per org (M35 `ai_token` meter input; PHI-free count)
  // M37 §4.11 — the eight published IPU reader seams. Leaf-typed (interfaces in ./inpatient). M37 registers
  // real Drizzle-backed impls over the deny-stubs at boot; consumers (M23/M26/M27/M13/M30/M31/M34) resolve
  // them via getSeam. All ids + counts + policy flags — no raw PHI row crosses (D17/§8.5) → phi:false.
  | "IpuAdmissionReader" // M37 — bed-assignment-for-date read (M23 GIP-day gate; M26/M27/M28/M30/M34)
  | "IpuCensusProvider" // M37 — inpatient/service-day fiscal roll-ups (M23 per-diem, M26 cap, M27 S-3, M33)
  | "IpuBedAssignmentProvider" // M37 — active-bed-assignment check (M6 §2.3.5 confirm handshake)
  | "IpuShiftCoverageReader" // M37 — unit RN-coverage-active at an instant (M17 cross-check / M19 after-hours)
  | "IpuIvSafetyOverlayProvider" // M37 — the IV-continuous overlay for a signed order (M13 pre-administration gate)
  | "IpuVisitorReader" // M37 — the patient visit-policy (M31 portal visit-policy page)
  | "IpuQualityReader" // M37 — IPU acuity / restraint / mortality reads (M30 measure-detail pages)
  | "IpuTenantPostureReader"; // M37 — tenant unit posture + the offboarding open-admissions gate (M34 console)

/**
 * M5/M17 — resolves an actor's caseload (the patients they may access), the source of truth for
 * the M3 `caseload_membership` ABAC predicate (M5 spec §4.1). M3 declared this seam and boot-
 * validates it; M5 registers the real resolver over `patient_assignment` (open rows), additively
 * unioned with M17's active-shift visit assignments (M5-T07). Leaf-safe (ids only).
 */
export interface CaseloadProvider {
  /** Is `userId` on `patientId`'s care team right now? (drives `caseload_membership`). */
  isInCaseload(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
  /** Every patient id on `userId`'s caseload right now (for §7.5 list-narrowing). */
  caseloadPatientIds(input: {
    organizationId: string;
    userId: string;
  }): Promise<readonly string[]>;
}

/**
 * M8 — the facts M16 needs to verify the `sourceEncounterId` of a completed in-person bereavement visit
 * (D15): that the encounter exists in the caller's tenant, which patient it documents, whether it is of
 * type `bereavement_contact`, and whether it has been SIGNED (signed / cosign_pending / cosigned; a draft
 * or a voided encounter is not). Returns `null` for an unknown or cross-tenant id (never a throw for "no
 * such encounter"; an unbound/unreadable M8 throws via the deny-stub, which M16 treats as a refusal).
 * Ids and enums only — leaf-safe, no clinical content.
 */
export interface BereavementEncounterReader {
  getBereavementEncounterFacts(input: {
    organizationId: string;
    encounterId: string;
  }): Promise<BereavementEncounterFacts | null>;
}

/** The leaf-safe encounter facts behind {@link BereavementEncounterReader}. */
export interface BereavementEncounterFacts {
  readonly encounterId: string;
  readonly patientId: string;
  /** True iff the encounter's type is `bereavement_contact`. */
  readonly isBereavementContact: boolean;
  /** True iff the encounter is signed (signed / cosign_pending / cosigned) and not voided. */
  readonly isSigned: boolean;
}

/**
 * M3 — is an `auditor_engagement` ACTIVE for this auditor right now. M3 owns the engagement entity; a
 * consumer that serves an auditor-session view (M31's engagement view) asks this instead of trusting the
 * engagement id the request names. True only when the engagement belongs to `organizationId`, is `active`
 * (not scheduled / closed / cancelled), `at` lies inside its window, and `auditorUserId` is the auditor it
 * was enrolled for. Anything else — unknown id, another org's engagement, closed, not enrolled — is `false`;
 * a missing/unreadable M3 throws via the deny-stub (consumers fail closed on a throw).
 */
export interface AuditorEngagementReader {
  isEngagementActiveForAuditor(input: {
    organizationId: string;
    engagementId: string;
    auditorUserId: string;
    /** ISO instant the window is compared against (the caller's server clock). */
    at: string;
  }): Promise<boolean>;
  /**
   * What an engagement COVERS, resolved from its own `scope` — only when the engagement passes exactly the
   * {@link isEngagementActiveForAuditor} checks (org, `active`, window); otherwise `null` (a consumer serving
   * the auditor view treats `null` as deny). `tenantWide` is true only when the scope says so explicitly;
   * `patientIds` is the explicit, de-duplicated patient list (malformed entries dropped). A scope that names
   * neither (e.g. provider-entity or claim slices only) covers NO patients here — enumerating a provider
   * entity's patients is not M3's to do, so an unresolvable slice fails closed to the empty set.
   */
  engagementScope(input: {
    organizationId: string;
    engagementId: string;
    auditorUserId: string;
    at: string;
  }): Promise<EngagementCoverage | null>;
}

/** The patient coverage of an auditor engagement (see {@link AuditorEngagementReader.engagementScope}). */
export interface EngagementCoverage {
  readonly tenantWide: boolean;
  readonly patientIds: readonly string[];
}

/**
 * M6 — the location(s) a PATIENT is currently sited at, read from M6's own admission siting. Returns the
 * DISTINCT location ids of the patient's ACTIVE admission(s); an unknown patient, one with no active
 * admission, or one whose active admission is unsited yields `[]` (never a throw for "no data"; a
 * missing/unreadable M6 throws via the deny-stub). Ids only — leaf-safe.
 */
export interface PatientSitingReader {
  getPatientLocationIds(input: {
    organizationId: string;
    patientId: string;
  }): Promise<readonly string[]>;
}

/**
 * M3 — supervision and location-scope facts about a staff MEMBERSHIP. The data model carries NO explicit
 * supervisor/reporting-line relation, so supervision is DERIVED from facts that do exist: a membership is
 * a supervisor at a location when it is ACTIVE, that location is in its location scope, and it holds an
 * unexpired supervisory role (`clinical_supervisor` / `director_of_nursing`). Every method fails closed:
 * unknown / cross-tenant / non-active memberships resolve to `[]` / `false`. Ids only — leaf-safe.
 */
export interface SupervisorReader {
  /** Active memberships a supervisor supervises: the other active memberships sharing a location it supervises. Never includes itself. */
  resolveSupervisedMembershipIds(input: {
    organizationId: string;
    membershipId: string;
  }): Promise<readonly string[]>;
  /** Is the membership a supervisor (see above) AT `locationId`? */
  isSupervisorForLocation(input: {
    organizationId: string;
    membershipId: string;
    locationId: string;
  }): Promise<boolean>;
  /** The membership's location scope (`membership.default_location_ids`) — `[]` unless the membership is active. */
  membershipLocationIds(input: {
    organizationId: string;
    membershipId: string;
  }): Promise<readonly string[]>;
}

/**
 * M5 — the reverse of {@link CaseloadProvider}: every user currently on a PATIENT's care team
 * (M36 spec D5, §2.3). M36's `syncCareTeamChannel` consumes this to reconcile a `care_team`
 * channel's `source:'auto'` membership against the real roster — the source of truth is the
 * care team, not the channel; the channel mirrors it. Same `patient_assignment` open-row source
 * as `CaseloadProvider` (M5-T07), just indexed the other direction. Leaf-safe (ids only).
 */
export interface CareTeamProvider {
  /** Every user id with an OPEN patient_assignment for `patientId` right now. */
  careTeamMembers(input: {
    organizationId: string;
    patientId: string;
  }): Promise<readonly string[]>;
  /**
   * The patient's RN CASE MANAGER — the user id on the open `primary_rn` assignment, or null when the
   * patient has none (GAP-022). A role-filtered form of {@link careTeamMembers}, not a synonym for it:
   * M13's §2.9 D10 RN-review gate on caregiver-attested doses is specifically the case manager's to
   * clear, so "is on the care team" would widen a named-clinician duty into a whole-team one.
   * `patient_assignment` carries a partial unique index enforcing at most one open `primary_rn` per
   * patient, so this is single-valued by construction.
   */
  primaryRnUserId(input: { organizationId: string; patientId: string }): Promise<string | null>;
  /**
   * The same RN case manager as {@link primaryRnUserId}, resolved to their ACTIVE MEMBERSHIP in
   * `organizationId` — or null when the patient has no open `primary_rn` assignment, or the clinician on
   * it no longer holds an active membership in that org.
   *
   * The two id spaces are both real and neither converts the other. `patient_assignment` stores a USER
   * id, which is what M13's D10 gate compares against an ABAC context's `userId`; M8's
   * `cosignature_request.routed_to_membership_id` is a NOT NULL FK to `membership`, and a cosignature is
   * routed to someone acting IN AN ORG, not to a user account. Resolving it here rather than handing the
   * user id out for the caller to join keeps the "which membership counts as current" rule in one place
   * — and makes a lapsed membership answer null, which is the fail-closed direction for a gate that asks
   * whether an eligible cosigner EXISTS (M8 §2.6 check 10). Leaf-safe (ids only).
   */
  primaryRnMembershipId(input: {
    organizationId: string;
    patientId: string;
  }): Promise<string | null>;
}

/**
 * M2 — does a membership hold a NAMED per-tenant approval authority right now (GAP-043)?
 *
 * Deliberately narrower than "what authorities does this membership hold": the only consumer is an ABAC
 * predicate answering one yes/no question, and a list-shaped seam would invite a caller to enumerate a
 * tenant's signatories for a purpose the grant was not made for. Leaf-safe (ids + a kind string).
 *
 * `kind` is a plain string rather than an enum type because this leaf package cannot import
 * `@wardenx/db`'s pgEnum; callers pass their own constant (M27 passes `"cost_report_approval"`). An
 * unrecognized kind resolves to `false`, never to an error — the predicate's whole contract is
 * fail-closed.
 */
export interface ElevatedApprovalReader {
  hasElevatedApproval(input: {
    organizationId: string;
    membershipId: string;
    kind: string;
  }): Promise<boolean>;
}

/** One clinical-license/certification grant, as {@link CredentialReader} reports it (GAP-093). */
export interface CredentialGrant {
  /** The discipline the credential covers (M17's `SchedulingDiscipline` vocab: rn/lpn/chha/msw/
   *  chaplain/volunteer/md/np) — a plain string here since a leaf package may not import a feature
   *  package's enum type; callers compare against their own discipline constants. */
  readonly kind: string;
  readonly status: "active" | "suspended" | "revoked";
}

/**
 * M17 — a membership's clinical-license/certification rows, as of a date (§1.1 D8, GAP-093). The D8
 * `clinician_credentials_active` pre-schedule-gate predicate is the first consumer: it resolves the
 * disciplines a visit purpose requires, then checks every required kind has an `active` row here —
 * a check ORTHOGONAL to the RBAC role grant `discipline_matches_visit` checks (a clinician can hold
 * the "rn" role while their actual nursing license has lapsed or been suspended). Leaf-safe (ids +
 * plain strings only, no PHI).
 */
export interface CredentialReader {
  /** Credential rows for `membershipId` that are genuinely active as of `asOf` (an ISO date):
   *  `status: 'active'` AND `asOf` falls within the credential's effective/expiry window. A
   *  suspended/revoked/not-yet-effective/expired row is simply absent from the result — the
   *  caller does not need to re-derive date/status logic, only match `kind`. */
  activeCredentialsAsOf(input: {
    organizationId: string;
    membershipId: string;
    asOf: string;
  }): Promise<readonly CredentialGrant[]>;
}

// M5's `PatientReader` (§4.8), intake resolver, and `PatientMutator` (§4.9) interfaces live in ./patient (alongside
// PatientIdentity) and are imported above for the SeamContracts map.

/** M22 — render a typed payload to a stored document (forward-seam for M39 etc.). */
export interface DocumentRenderer {
  render(scope: OrgScope, templateKey: string, payload: unknown): Promise<{ documentId: string }>;
}

// M39's `ConsentEvaluator` (§4.3) follows the SAME opaque rich-seam pattern as TerminologyProvider /
// MdmEntityProvider: its rich interface (four typed query methods + the per-category redaction-flag
// shape + ConsentDenyReason) lives in @wardenx/consent, which this leaf may not import
// (`leaves-stay-leaves`). Every PHI-egress consumer already lists `39` in its manifest `dependsOn`, so
// it imports the real `ConsentEvaluator` type from @wardenx/consent and resolves the impl through the
// module-39 typed accessor; the M1 registry holds/validates the instance fail-closed (`unknown`).

/**
 * The authenticated actor a `SessionContextResolver` resolves a request to (M2 spec §4.7).
 * `membershipId` is null for a PRE-ORG session (post-login, before `select-organization`).
 * `providerEntityIds`/`locationIds` are the actor's ABAC scope (ARCH-008/009): the membership's
 * `defaultProviderEntityId`/`defaultLocationIds`, assembled here so `provider_entity_scope` /
 * `location_scope` (packages/auth/src/abac/registry.ts) and every module's own PE/location
 * predicate (M14 `idg_meeting_scope`, M20/M23/M24's PE checks) have real data instead of the
 * permanently-`[]` fields `authenticate.ts` used to leave unassembled.
 */
export interface ResolvedActor {
  readonly userId: string;
  readonly membershipId: string | null;
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
  /**
   * The §2.2.4 session class (`staff` / `auditor` / `external_collaborator` / `funeral_home` / the
   * three M31 portal classes / the two M19 vendor classes). Carried here because M16/M19/M31's ABAC
   * predicates gate on it and nothing produced it — every one of them denied unconditionally (F-030).
   * Typed as `string` rather than the enum union so this leaf stays decoupled from M2's internals,
   * the same reasoning `ConsentSessionClass` gives.
   */
  readonly sessionClass: string;
  /** M31 portal sessions — the portal account the session acts for; null on every other class. */
  readonly portalAccountId: string | null;
  /**
   * The ONE patient this session is pinned to, or null on an org-scoped class.
   *
   * Deliberately NOT named for a class. Three different modules read this same fact under three
   * different names — M31/M19 as `portalPatientId`, M19's portal-triage guard as a `patientId`
   * fallback beside it, and M7's `caseload_or_scope` as a `scopePatientIds` array — and all three
   * resolved to `undefined`, because the one thing none of the names described was the fact itself:
   * `session.scope.patientId`, which a PORTAL session carries after `select-patient` and an
   * `external_collaborator` / `funeral_home` session carries from the moment it is minted (F-030).
   * M7's readers are collaborator sessions, so a key named `portal…` would have been the fourth
   * name rather than the last one.
   *
   * Sourced through `sessionPinnedPatientId`, so an org-scoped class reads null even if its `scope`
   * jsonb somehow carries a patient id — the class decides, not the column.
   */
  readonly sessionPatientId: string | null;
  /**
   * The platform's own verdict on the device this session runs on (SecHardening §12.2/§12.4), or null
   * when the session is bound to no attested device — a browser session, or a mobile session whose
   * attestation has expired or been revoked.
   *
   * Resolved from M2's `device_attestation` row through the session's `device_attestation_id` pointer,
   * and RE-CHECKED there rather than trusted: the pointer is a lookup key, so a stale or dangling one
   * yields null and the gate denies. Never assembled from anything the request carries — a
   * device-integrity claim supplied by the device being judged is not evidence (§8.3.1's argument, one
   * layer down).
   *
   * `valid` is the whole contract M3's `device_attestation_valid` predicate reads; `verifiedAt` is
   * diagnostics. Structural, not an enum, so this leaf stays decoupled from M2's provider vocabulary.
   */
  readonly deviceAttestation: {
    readonly valid: boolean;
    readonly verifiedAt?: string;
    /** The M2 `device_attestation` row id the session points at (server-derived; never a request field). */
    readonly attestationId?: string;
  } | null;
  /**
   * The `external_triage_vendor` row an M19 answering-service session acts for, or null on every other
   * class (F-030 / #75).
   *
   * This is the authorization SUBJECT of M19's `external_triage_actor`, which compares it against the
   * shift's vendor — so it is class-gated at the source (`sessionExternalActorId`) rather than read off
   * the `scope` jsonb. M19's own predicate header states the risk that gating buys: folding the vendor
   * arm into the owner predicate "would let any staff session that happened to carry an
   * `externalActorId` attribute reach a vendor-scoped call".
   */
  readonly externalActorId: string | null;
  /**
   * The `auditor_engagement` an `auditor`-class session was minted for (GAP-093(c)), or null on every other
   * class. SERVER-SIDE session state only (`session.scope.engagementId`, written by M2 at mint and
   * class-gated through `sessionEngagementId`) — it is the session's OWN engagement that M31's
   * `portal_engagement_scope` compares against the engagement the route names, so it must never come from a
   * request field. Optional so existing fixtures keep their shape; absent reads as "no engagement" (deny).
   */
  readonly engagementId?: string | null;
}

/**
 * The SecHardening §12.2 device-posture facts an attestation reports.
 *
 * Every field is what the DEVICE said about itself. The server does not — and for a jailbreak check
 * cannot — independently observe any of them; what it does is refuse to accept them unless they arrive
 * under a MAC it can recompute over a nonce it minted (see M2's `DeviceAttestationVerifier`), and then
 * apply the §12.2 policy to them itself. So the facts are reported and the DECISION is the platform's.
 *
 * Optional throughout: a provider that cannot report a field must be able to say nothing rather than
 * guess, and the policy treats an unreported requirement as unmet.
 */
export interface DeviceAttestationPosture {
  /** The OS version string as the device reports it (§12.2 floor: iOS 16+, Android 12+). */
  readonly osVersion?: string;
  /** The §12.4 detector's verdict. `true` fails the check outright — that is the whole control. */
  readonly jailbrokenOrRooted?: boolean;
  /** Whether a biometric factor is enrolled and available (§12.2). */
  readonly biometricAvailable?: boolean;
  /** Whether the OS screen lock is on (§12.2). */
  readonly screenLockEnabled?: boolean;
  /** Whether the app is running on an emulator (§12.4 refuses these). */
  readonly emulator?: boolean;
}

/** The membership + active role keys for an actor in one org (the actor-context fields M3 owns). */
export interface ActorEnrichment {
  /** `membership.id` for the actor's ACTIVE membership in the scope org (null when none). */
  readonly membershipId: string | null;
  /** The actor's current (enabled, non-expired) role keys in the scope org. */
  readonly roles: readonly string[];
  /** The membership's `defaultProviderEntityId`, as a single-element array (empty when null). */
  readonly providerEntityIds: readonly string[];
  /** The membership's `defaultLocationIds` (empty when the membership has none/is absent). */
  readonly locationIds: readonly string[];
}

/**
 * Reads an actor's `membershipId` + `roles` for one org scope (M2 spec §4.7 enrichment). M2's session
 * store reads only the M1-owned `session` table, so it leaves these empty; this port is the M3-owned
 * path that fills them (membership + membership_role ⋈ role under RLS) without M2 reading M3 tables.
 * Injected into the DB session store at boot; returns null when the actor has no active membership in
 * the org (the session then resolves with no membership/roles).
 */
export interface ActorEnrichmentReader {
  read(scope: OrgScope, userId: string): Promise<ActorEnrichment | null> | ActorEnrichment | null;
}

/**
 * Reports which of an org's memberships hold the `org_admin` role (M2 spec §6 last-admin lockout). A
 * membership's admin status is an M3 fact (`membership_role ⋈ role.key='org_admin'`); M2's member
 * roster/repository can't read M3's tables, so it derives `isAdmin` + `activeAdminCount` through this
 * M3-owned reader. Returns the set of admin `membership.id`s for the org (active grants only).
 */
export interface AdminMembershipReader {
  adminMembershipIds(orgId: string): Promise<ReadonlySet<string>> | ReadonlySet<string>;
}

/**
 * A session's step-up recency state (M2 spec §4.7). Module 3's `step_up_recent` predicate
 * reads these via the published seam — a typed contract, NOT a direct read of the M1-owned
 * `session` table — so the freshness/factor math has one home and cannot drift.
 */
export interface SessionStepUpFields {
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: StepUpFactor | null;
}

/**
 * The effective step-up policy for one (organization, operation) AFTER the tenant's
 * `tenant_step_up_policy_override` row has been tightened against the platform floor
 * `STEP_UP_POLICY` (M2 spec §4.3.2, D9). Tighten-only: `qualifyingFactors` is an INTERSECTION
 * with the floor's set and `maxAgeSec` is a MIN against the floor's window, so a resolved policy
 * can only ever be harder to satisfy than the floor — never easier.
 *
 * The shape lives in this leaf because M2 PRODUCES it and M3's `step_up_recent` predicate
 * CONSUMES it through the seam; neither imports the other's package.
 */
export interface ResolvedStepUpPolicy {
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
}

/**
 * M2 — resolves an authenticated, org-scoped request (by session id) to its actor identity
 * and step-up state. Consumed by M3 (`step_up_recent`), M4 (actor for the audit trail), and
 * every module that needs an authenticated request context (§4.7). Resolution is org-scoped:
 * a session whose org ≠ `scope.orgId` resolves to null (no cross-tenant leak through the seam).
 */
export interface SessionContextResolver {
  resolveActor(scope: OrgScope, sessionId: string): Promise<ResolvedActor | null>;
  resolveStepUpState(scope: OrgScope, sessionId: string): Promise<SessionStepUpFields | null>;
  /**
   * The effective (post-tighten) step-up policy for an operation in this org — the floor when the
   * tenant has configured no override. M3's `step_up_recent` predicate evaluates the session's
   * step-up state against THIS rather than against the raw floor, which is what makes a tenant's
   * per-operation tightening (WebAuthn-only, or a 60-second window on eRx signing) actually bind.
   */
  resolveStepUpPolicy(scope: OrgScope, operationKey: string): Promise<ResolvedStepUpPolicy>;
}

/**
 * M2 — mints a time-boxed auditor magic-link session for an M3-owned engagement (D4 / §4.7).
 * M3 owns the `auditor_engagement` entity + the invite endpoint; M2 owns session mechanics
 * and exposes this boot-validated minter, so an engagement that cannot mint a session fails
 * at startup rather than at the auditor's first click.
 */
export interface AuditorSessionMinter {
  mintAuditorSession(input: {
    engagementId: string;
    organizationId: string;
    identity: { name: string; email: string };
    window: { start: Date; end: Date };
  }): Promise<{ magicLinkToken: string }>;
}

/** The three M31 portal session classes, as the minter names them. */
export type PortalSessionClass = "patient_portal" | "caregiver_portal" | "bereaved_portal";

/**
 * M2 — stamps the class + scope onto an M31 portal session (M31 §2.3 / D2; F-030).
 *
 * Named `Binder`, not `Minter`, on purpose: M31 already publishes a `PortalSessionMinter`
 * (packages/types/src/portal.ts) for M28's SMART user-launch, which is a different surface owned by a
 * different module. This one does not create a session — it writes the class and scope onto a session
 * M2 already authenticated.
 *
 * M31 owns the portal ACCOUNT and the access GRANT; M2 owns the `session` row, so the class and the
 * scope are written here. Split from `AuditorSessionMinter` because the shapes differ: an auditor
 * session is minted whole from an engagement window, whereas a portal session is minted BEFORE its
 * patient is known and bound to one later by `select-patient` — which is exactly why
 * `session_scope_chk` requires the account on a portal session and not the patient.
 *
 * Both operations are org-scoped and fail closed: a session id that is not in `scope.orgId`, or is not
 * a portal session, is refused rather than silently rescoped. `bindPatient` is the only writer of
 * `scope.patientId` on a portal session — the value never comes from a request parameter (§8.3.1).
 */
export interface PortalSessionBinder {
  /** Stamp an authenticated session as a portal session for one account. Returns the class written. */
  bindPortalSession(input: {
    scope: OrgScope;
    sessionId: string;
    portalAccountId: string;
    sessionClass: PortalSessionClass;
  }): Promise<{ sessionClass: PortalSessionClass }>;
  /**
   * Bind the session's ONE patient (§2.3 / D2). The caller must have already proven an active grant
   * for (account, patient); this writes the binding the request context is then assembled from.
   */
  bindPortalPatient(input: {
    scope: OrgScope;
    sessionId: string;
    patientId: string;
  }): Promise<void>;
}

/** The two M19 answering-service session classes (mirrors the `session_class` enum members). */
export type VendorSessionClass = "external_triage_vendor" | "external_triage_operator";

/**
 * M2 — stamp the class + vendor scope on an M19 answering-service session (F-030 / #75).
 *
 * The `PortalSessionBinder` shape, one module over and for the same reason: M19 owns the vendor
 * (`external_triage_vendor`) and the shift that puts it on call; M2 owns the `session` row. Nothing
 * connected the two, so no session ever carried a vendor class or a `scope.externalActorId`, M19's
 * `external_triage_actor` predicate compared the shift's vendor against `undefined`, and every
 * vendor-scoped call was refused.
 *
 * ONE operation, not two. A portal session is minted before its patient is known, which is why that
 * binder splits account-binding from patient-binding — a vendor session has no equivalent gap: it is
 * minted BY the vendor binding, so the vendor is known at the only moment the session exists.
 */
export interface VendorSessionBinder {
  /**
   * Stamp an authenticated session as an M19 vendor session for one `external_triage_vendor` row.
   *
   * The caller must have already proven the vendor is real, active, and BAA-covered for this org —
   * this writes the binding the request context is then assembled from, it does not authorize it.
   */
  bindVendorSession(input: {
    scope: OrgScope;
    sessionId: string;
    externalActorId: string;
    sessionClass: VendorSessionClass;
  }): Promise<{ sessionClass: VendorSessionClass }>;
}

/** The intent M34's `tenant.provision` worker hands M2 to create / attach the per-tenant organization
 *  (M34 §2.5 r2 / §7.1 step 3). PHI-free — every field is resolved by the platform-ops route that
 *  enqueued the provision job. `organizationId` is the org spine the §7.1 step-1 route pre-creates in
 *  Phase 1 (so the provider is an idempotent confirm); the same field is the create target for the
 *  Phase-3 self-serve path. The interface is LEAF-TYPED here (not opaque) because the PRODUCER is M2 and
 *  the CONSUMER is M34 — neither may import the other's package, so the shared contract lives in this leaf. */
export interface TenantOrgCreationIntent {
  readonly tenantAccountId: string;
  readonly organizationId: string;
  readonly legalBusinessName: string;
}

/** The discriminated result of an org-creation request. `available` carries the created/confirmed M2 org
 *  id; `unavailable` is the fail-closed forward-state answer (the deny-stub, until M2 registers the real
 *  provider) — the provision worker branches on `kind` and never fabricates an id / fails open. */
export type TenantOrgCreationResult =
  | { readonly kind: "available"; readonly organizationId: string }
  | { readonly kind: "unavailable"; readonly reason: "m2_org_creation_not_yet_locked" };

/**
 * M2 — create / attach the per-tenant `organization` row M34's `tenant.provision` worker needs at §7.1
 * step 3. M2 owns the `organization` table; M34 consumes this published seam (no M34→M2-internal import,
 * no new `dependsOn` edge — the M2 edge already exists). SELECT-then-create, idempotent confirm in
 * Phase 1 (the org spine is pre-created by the route); the create branch backs Phase-3 self-serve signup.
 */
export interface TenantOrgCreationProvider {
  createOrganizationForTenant(intent: TenantOrgCreationIntent): Promise<TenantOrgCreationResult>;
}

/** A PHI-free display summary of one tenant `organization` row (M2 owns the table). Carries only the
 *  non-sensitive labels a cross-tenant admin surface renders — the display name + legal name + slug —
 *  never secrets, contact PII, or config. `organizationId` echoes the requested id so a caller can build
 *  a lookup map without positional assumptions. */
export interface OrganizationSummary {
  readonly organizationId: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly slug: string;
}

/**
 * M2 — resolve display metadata for a set of organizations by id. M2 owns the `organization` table (the
 * tenancy root, NON_ORG_SCOPED), so it is the natural producer; M35's platform-ops admin lists CONSUME this
 * to label cross-tenant rows with an org NAME instead of a raw UUID (M35A-T03). Consumed through the M1 seam
 * registry (no new `dependsOn` edge — neither module imports the other's package; the contract is leaf-typed
 * here). BATCH by design (the caller resolves a page of ids at once → no N+1); ids with no matching org are
 * simply omitted from the result (the consumer falls back to the raw id), never fabricated. Read-only.
 */
export interface OrganizationReader {
  readByIds(organizationIds: readonly string[]): Promise<readonly OrganizationSummary[]>;
}

/** Map from seam name → its interface type, so the registry is type-safe. */
export interface SeamContracts {
  CaseloadProvider: CaseloadProvider;
  CareTeamProvider: CareTeamProvider;
  CredentialReader: CredentialReader;
  ElevatedApprovalReader: ElevatedApprovalReader;
  PatientReader: PatientReader;
  PatientHopeAdmissionPrefillReader: PatientHopeAdmissionPrefillReader;
  PatientIntakeResolver: PatientIntakeResolver;
  PatientAdmissionClearanceReader: PatientAdmissionClearanceReader;
  PatientCoverageReader: PatientCoverageReader;
  PatientCaregiverReader: PatientCaregiverReader;
  PatientAddressReader: PatientAddressReader;
  PatientAllergyReader: PatientAllergyReader;
  NonCoveredMedicationsReader: NonCoveredItemsReader;
  NonCoveredDmeSuppliesReader: NonCoveredItemsReader;
  PatientPrivacyFlagReader: PatientPrivacyFlagReader;
  ExternalGriefResourceReader: ExternalGriefResourceReader;
  PatientMutator: PatientMutator;
  DocumentRenderer: DocumentRenderer;
  // M22's `DocumentStorageProvider` (§4.3 / §11 D1) is LEAF-TYPED — its interface lives in ./documents
  // (this package), so the registry is statically typed against the real contract. M22 registers the
  // real MinIO-backed provider over the deny-stub (M22-T04); the M22 lifecycle/eraser paths resolve it
  // through the typed accessor. The presign URL itself is never logged; the keys are PHI-free by
  // construction (D11) — but the surface guards a PHI object store → phi: true in REQUIRED_SEAMS.
  DocumentStorageProvider: DocumentStorageProvider;
  // M22's five §4.3 published reader seams are LEAF-TYPED — their interfaces live in ./documents (this
  // package), so the registry is statically typed against the real contract. M22 registers the real
  // Drizzle-backed impls over the deny-stubs (M22-T05); consumers that list `22` in their manifest
  // `dependsOn` (M28/M30/M31/M33 + every source module's back-ref consumer) resolve them through the typed
  // accessors with no schema import edge. All five are READ-only — M22 owns the document lifecycle internally.
  RenderedDocumentProvider: RenderedDocumentProvider;
  DocumentReader: DocumentReader;
  PortalDocumentReader: PortalDocumentReader;
  IntakeMetricsProvider: IntakeMetricsProvider;
  ExtractionProvenanceReader: ExtractionProvenanceReader;
  // M39's `ConsentEvaluator` is OPAQUE (`unknown`) here — the rich §4.3 interface lives in
  // @wardenx/consent (rich-seam pattern, see the note above the interface block). Consumers that
  // list `39` in `dependsOn` import the real type from @wardenx/consent and resolve via the
  // module-39 typed accessor; the M1 registry holds/validates the instance fail-closed.
  ConsentEvaluator: unknown;
  SessionContextResolver: SessionContextResolver;
  AuditorSessionMinter: AuditorSessionMinter;
  PortalSessionBinder: PortalSessionBinder;
  VendorSessionBinder: VendorSessionBinder;
  // M2 — LEAF-TYPED: M34's provision worker (CONSUMER) and M2 (PRODUCER) can't import each other's
  // package, so the contract lives here. M2 registers the real Drizzle-backed provider over the deny-stub.
  TenantOrgCreationProvider: TenantOrgCreationProvider;
  // M2 — LEAF-TYPED: M35's platform-ops admin lists (CONSUMER) and M2 (PRODUCER) can't import each other's
  // package, so the contract lives here. M2 registers the real Drizzle-backed reader over the deny-stub.
  OrganizationReader: OrganizationReader;
  // M38's `TerminologyProvider` is intentionally OPAQUE (`unknown`) here. Its rich interface
  // (per-system generics, FHIR projections) lives in the feature package @wardenx/terminology,
  // which this leaf may not import (`leaves-stay-leaves`, ARCHITECTURE §25.15). Unlike the
  // edge-avoiding seams above, every M38 consumer already lists `38` in its manifest
  // `dependsOn`, so it imports the real `TerminologyProvider` type from @wardenx/terminology
  // and resolves the impl through the module-38 typed accessor — the M1 registry only needs to
  // hold/validate the instance fail-closed, which `unknown` is sufficient for.
  TerminologyProvider: unknown;
  // M36's `AlertEmitter` + `MessagingProvider` follow the SAME opaque rich-seam pattern: their
  // interfaces live in @wardenx/messaging (per-system payloads, DEK-encrypted message bodies),
  // which this leaf may not import (`leaves-stay-leaves`). Consumers that list `36` in their
  // manifest `dependsOn` import the real types from @wardenx/messaging and resolve the impl via
  // the module-36 typed accessor; the M1 registry holds/validates the instance fail-closed.
  AlertEmitter: unknown;
  MessagingProvider: unknown;
  // M40's `MdmEntityProvider` follows the SAME opaque rich-seam pattern: its interface lives in
  // @wardenx/mdm (per-kind `CanonicalFields<K>`/`OverlayFields<K>` generics + the merge-redirect
  // shape), which this leaf may not import (`leaves-stay-leaves`). Consumers that list `40` in
  // their manifest `dependsOn` import the real type from @wardenx/mdm and resolve the impl via the
  // module-40 typed accessor; the M1 registry holds/validates the instance fail-closed.
  MdmEntityProvider: unknown;
  // M33's `MetricsProvider` follows the SAME opaque rich-seam pattern: its interface lives in
  // @wardenx/reporting (this leaf may not import it — `leaves-stay-leaves`), so the registry holds the
  // instance as `unknown` and consumers (M30/M34/M37) resolve it via `getSeam` + cast to their own
  // consumer-defined view. Registered by M33 at boot over the fail-closed deny-stub.
  MetricsProvider: unknown;
  // M26's `CapAccrualReader` follows the OPAQUE rich-seam pattern (like MetricsProvider): the rich interface
  // lives in @wardenx/cap-management, so the registry holds the instance as `unknown` and M27 resolves it via
  // `getSeam` + cast to its own consumer view. Registered by M26 at boot over the fail-closed deny-stub.
  CapAccrualReader: unknown;
  // M26's `CapProjectionProvider` — opaque rich-seam (interface in @wardenx/cap-management). M23 resolves it
  // via getSeam + an adapter for the §11.A `aggregate_cap_projection` / `ipu_cap_projection` rules. Registered
  // by M26 at boot over the fail-closed deny-stub.
  CapProjectionProvider: unknown;
  // M23/M25 → M27 cost-report binds. OPAQUE rich-seam pattern: the consumer-facing aggregate views live in
  // M27's own consumer code (the producer interfaces in @wardenx/billing / @wardenx/remittance are not imported
  // by this leaf), so the registry holds each instance as `unknown` and M27's ValidationContextBuilder resolves
  // via `getSeam` + cast to its minimal view. Registered by M23/M25 at boot over the fail-closed deny-stub.
  PatientDaysProvider: unknown;
  DrugCostBillingReader: unknown;
  ClaimSettlementProvider: unknown;
  // M23/M27 → M30 quality binds. Same opaque rich-seam pattern — M30 resolves each via `getSeam` + a cast
  // to its own consumer view, so the HCI claims-derived indicators and the CoP 418.310 failure-to-file
  // indicator stop resolving to a forward-seam deny-stub now that M23 and M27 are both built.
  ClaimLineReader: unknown;
  // M23 → M25 — the 835-to-claim match-candidate lookup + claim->patient resolution (WX-PR-012). Same
  // opaque rich-seam pattern; M25's ingest service resolves via `getSeam` + a cast to its own
  // ClaimMatchCandidateProvider view. Registered by M23 at boot over the fail-closed deny-stub.
  ClaimSubmissionReader: unknown;
  // M24 → M25 — the Medicaid sibling of ClaimSubmissionReader above (F-172, #248 m24 group): M25's
  // `postAdvice` picks between the two by the advice's own `payerKind` discriminator. Registered by M24
  // at boot over the fail-closed deny-stub.
  MedicaidClaimMatchProvider: unknown;
  CostReportFilingStatusReader: unknown;
  // M30's five §4.3 seams — the SAME opaque rich-seam pattern: the interfaces live in @wardenx/quality
  // (this leaf may not import it — `leaves-stay-leaves`), so the registry holds each instance as
  // `unknown` and consumers (M22 / M28 / M33 / M34) resolve via `getSeam` + cast to their own view.
  // Registered by M30 at boot over the fail-closed deny-stub.
  QualityMeasureProvider: unknown;
  IncidentRegisterProvider: unknown;
  QapiProjectProvider: unknown;
  ComplianceStatusProvider: unknown;
  SecurityRiskAssessmentReader: unknown;
  // M40's `BaaStatusProvider` is the focused §7.7 disclosure gate, registered separately from the
  // omnibus above (different contract: as-of time-travel + sending-facility resolution). Same
  // opaque rich-seam pattern — interface in @wardenx/mdm; M22/M28/M29 import the real type.
  BaaStatusProvider: unknown;
  // M6's reader seams (§4.7) are LEAF-TYPED — their interfaces live in ./admission (this package),
  // so the registry is statically typed against the real contract (no `unknown` opacity needed). M6
  // registers the real Drizzle-backed readers over the deny-stub; consumers that list `6` in their
  // manifest `dependsOn` resolve them through the typed accessors with no schema import edge.
  ElectionPeriodReader: ElectionPeriodReader;
  CertificationReader: CertificationReader;
  FaceToFaceReader: FaceToFaceReader;
  LevelOfCareReader: LevelOfCareReader;
  AdmissionStatusReader: AdmissionStatusReader;
  AdmissionCensusReader: AdmissionCensusReader;
  ReferralReader: ReferralReader;
  // M6's death-discharge census reader (§4.11) is LEAF-TYPED too — interface in ./admission. M6 registers the
  // real Drizzle-backed reader over the deny-stub; M30's HVLDL measure-recompute worker (which lists `6` in its
  // manifest `dependsOn`) resolves it through the typed accessor with no schema import edge.
  DeathDischargeReader: DeathDischargeReader;
  // M6's HCI aggregate readers (§4.11-style, M30-only consumers) — same leaf-typed, DEDICATED-connection
  // posture as DeathDischargeReader above (self-scoping, org-aggregate-only, no schema import edge).
  LevelOfCarePeriodReader: LevelOfCarePeriodReader;
  DischargeReader: DischargeReader;
  AdmissionOnsetReader: AdmissionOnsetReader;
  // M6's `ComplianceWindowCountsProvider` (F-178, #248) is OPAQUE (`unknown`) here — the consumer-facing
  // interface lives in `@wardenx/quality` (M30's own package; see the SeamName union comment above), not
  // in this leaf. M6 registers the real Drizzle-backed provider over the fail-closed deny-stub; M30 resolves
  // it via `getSeam` + a cast to its own `ComplianceWindowCountsView`.
  ComplianceWindowCountsProvider: unknown;
  // M7's reader seam (§7.8) is LEAF-TYPED too — its interface lives in ./care-plan (this package), so
  // the registry is statically typed against the real contract. M7 registers the real Drizzle-backed
  // reader over the deny-stub; consumers that list `7` in their manifest `dependsOn` resolve it through
  // the typed accessor with no schema import edge.
  CarePlanReader: CarePlanReader;
  // M8's owned seams (§4.7) are LEAF-TYPED too — interfaces live in ./encounter (this package), so the
  // registry is statically typed against the real contract. M8 registers the real Drizzle-backed impls
  // over the deny-stubs (M8-T08); consumers that list `8` in their manifest `dependsOn` resolve them
  // through the typed accessors with no schema import edge.
  BillableEncounterReader: BillableEncounterReader;
  SignedEncountersReader: SignedEncountersReader;
  MileagePayrollReader: MileagePayrollReader;
  EncounterCreator: EncounterCreator;
  // M18's EVV-bracket forward seam (§4.7 / D9) is LEAF-TYPED too — interface in ./encounter — so the
  // registry is statically typed against the real contract. M18 registers the real resolver over the
  // deny-stub when it lands (Wave F); M8 resolves it through the typed accessor with no schema import.
  EvvBracketResolver: EvvBracketResolver;
  // M18's other five owned seams (§4.3 / D15) are LEAF-TYPED too — interfaces live in ./evv (this package), so the
  // registry is statically typed against the real contract. M18 registers the real Drizzle-backed impls over the
  // deny-stubs (M18-T05); consumers that list `18` in their manifest `dependsOn` (M20/M23/M24/M25/M30/M31/M33)
  // resolve them through the typed accessors with no schema import edge. All five are READ-only — M18 publishes the
  // compliance / aggregator-reference / location / metrics / verification projections and never a Drizzle row (the
  // GPS coordinate is encrypted at rest, D10, and crosses only the coordinate-bearing `EvvLocationProvider` seam).
  EvvComplianceReader: EvvComplianceReader;
  EvvAggregatorReferenceReader: EvvAggregatorReferenceReader;
  EvvLocationProvider: EvvLocationProvider;
  EvvMetricsProvider: EvvMetricsProvider;
  EvvVerificationProvider: EvvVerificationProvider;
  // M9's owned seams (§4.7 / D7) are LEAF-TYPED too — interfaces live in ./assessment (this package), so
  // the registry is statically typed against the real contract. M9 registers the real Drizzle-backed
  // impls over the deny-stubs (M9-T04); consumers that list `9` in their manifest `dependsOn` resolve
  // them through the typed accessors with no schema import edge.
  LatestAssessmentProvider: LatestAssessmentProvider;
  ScaleSeriesProvider: ScaleSeriesProvider;
  // M10's owned seams (§2 / D10) are LEAF-TYPED too — interfaces live in ./hope (this package), so the
  // registry is statically typed against the real contract. M10 registers the real Drizzle-backed impls
  // over the deny-stubs (M10-T05); consumers that list `10` in their manifest `dependsOn` resolve them
  // through the typed accessors with no schema import edge.
  HopeTimepointProvider: HopeTimepointProvider;
  HopeJ2051Provider: HopeJ2051Provider;
  HopeSubmissionProvider: HopeSubmissionProvider;
  // M10's ORG-LEVEL rollup (§2 / D10 / D6) is LEAF-TYPED too — interface in ./hope (this package). Unlike
  // the three per-entity readers above, this is an org-scoped AGGREGATE surface (COUNTS only, never a
  // patient row); M10 registers the real Drizzle-aggregate-backed impl over the deny-stub at init, and M30's
  // measure-recompute worker resolves it through the typed accessor with no schema import edge.
  HopeOrgRollupProvider: HopeOrgRollupProvider;
  // M11's owned seams (§2.8 D14 / §4.3) are LEAF-TYPED too — interfaces live in ./orders (this package), so
  // the registry is statically typed against the real contract. M11 registers the real Drizzle-backed impls
  // over the deny-stubs (M11-T05); consumers that list `11` in their manifest `dependsOn` (M12/M14/M23/M30/M7)
  // resolve them through the typed accessors with no schema import edge. `OrderSignatureProvider` is the
  // polymorphic signature-write primitive M12 routes medication-order signatures through (no SQL FK across
  // `order_signature.target_kind`, D4); `OrderProvider` is the read-side counterpart.
  OrderSignatureProvider: OrderSignatureProvider;
  OrderProvider: OrderProvider;
  // M12's owned seams (§2.10 D17) are LEAF-TYPED too — interfaces live in ./dosespot (this package), so the
  // registry is statically typed against the real contract. M12 registers the real Drizzle-backed impls over
  // the deny-stubs (M12-T07); consumers that list `12` in their manifest `dependsOn` (M13/M14/M19/M28/M31/M33)
  // resolve them through the typed accessors with no schema import edge. Both are READ-only — M12 publishes the
  // medication-order + refill-inbox read projections; never a Drizzle row and never the free-text PHI (D14).
  MedicationOrderProvider: MedicationOrderProvider;
  RefillInboxProvider: RefillInboxProvider;
  // M13's owned seams (§2.12 D16) are LEAF-TYPED too — interfaces live in ./emar (this package), so the registry
  // is statically typed against the real contract. M13 registers the real Drizzle-backed impls over the deny-stubs
  // (M13-T07); consumers that list `13` in their manifest `dependsOn` (M14/M28/M30/M31/M33/M37) resolve them through
  // the typed accessors with no schema import edge. Both are READ-only — M13 publishes the administration +
  // reconciliation read projections; never a Drizzle row and never the free-text PHI (D12).
  MedicationAdministrationProvider: MedicationAdministrationProvider;
  ReconciliationProvider: ReconciliationProvider;
  // M14's owned seams (§4.8) are LEAF-TYPED too — interfaces live in ./idg (this package), so the registry is
  // statically typed against the real contract. M14 registers the real Drizzle-backed impls over the deny-stubs
  // (M14-T05); consumers that list `14` in their manifest `dependsOn` (M22/M28/M30/M33) resolve them through the
  // typed accessors with no schema import edge. All three are READ-only — M14 publishes the packet / decision /
  // schedule read projections and never the free-text PHI (the SUD-redacted layer crosses, never the raw notes).
  IdgPacketProvider: IdgPacketProvider;
  IdgDecisionProvider: IdgDecisionProvider;
  IdgScheduleProvider: IdgScheduleProvider;
  // M17's owned seams (§4.3) are LEAF-TYPED too — interfaces live in ./scheduling (this package), so the registry
  // is statically typed against the real contract. M17 registers the real Drizzle-backed impls over the deny-stubs
  // (M17-T05); consumers that list `17` in their manifest `dependsOn` (M8/M18/M19/M20/M30/M31/M33) resolve them
  // through the typed accessors with no schema import edge. All four are READ-only — M17 publishes the visit /
  // assignment / portal / metrics read projections and never a Drizzle row (visit metadata, never clinical free-text).
  VisitReader: VisitReader;
  VisitAssignmentReader: VisitAssignmentReader;
  PortalVisitReader: PortalVisitReader;
  VisitMetricsProvider: VisitMetricsProvider;
  // M15's consumed-by-M17 seams (§4.4) are LEAF-TYPED too — interfaces live in ./scheduling because M17 shipped
  // first and locked those shapes (M17-F06/ADR-0009). M15 registers the real impls over the deny-stubs
  // (M15-T05); M17 resolves them through the module-17 consumed-seam accessors with no schema import edge.
  VolunteerComplianceProvider: VolunteerComplianceProvider;
  SupervisoryCadenceReader: SupervisoryCadenceReader;
  // The rest of M15's §4.3 owned seams — interfaces live in ./discipline-plans (this package), so the registry
  // is statically typed against the real contract. M15 registers the real impls over the deny-stubs (M15-T05);
  // consumers that list `15` in their manifest `dependsOn` (M14/M16/M22/M28/M30/M31/M33) resolve them through
  // the typed accessors with no schema import edge. All five are READ-only, and the SUD / family-violence
  // gated assessment bodies never cross (the §4.3 DTOs carry the flags, never the free-text, §2.3).
  DisciplinePlanReader: DisciplinePlanReader;
  MswRiskFactorReader: MswRiskFactorReader;
  VolunteerGateExpiryReader: VolunteerGateExpiryReader;
  SupervisoryCadencePlanReader: SupervisoryCadencePlanReader;
  DisciplineComplianceProvider: DisciplineComplianceProvider;
  // M16's owned seams (§4.6 / D13) — interfaces live in ./bereavement (this package), so the registry is
  // statically typed against the real contract. M16 registers the real impls over the deny-stubs (M16-T05);
  // consumers resolve them through the typed accessors with no schema import edge. The bereaved contact's
  // envelope-encrypted channels (email / phone / address cipher) never cross: the §4.6 DTOs carry
  // reachability and identity, never the values (§3.3.2).
  BereavementPlanProvider: BereavementPlanProvider;
  BereavementOutreachProvider: BereavementOutreachProvider;
  BereavementRiskFactorsProvider: BereavementRiskFactorsProvider;
  BereavementAssignmentReader: BereavementAssignmentReader;
  BereavedPortalScopeProvider: BereavedPortalScopeProvider;
  BereavementComplianceProvider: BereavementComplianceProvider;
  BereavementRiskTierProvider: BereavementRiskTierProvider;
  // M21's owned seams (§4.8 / D14) — interfaces live in ./supplies (this package). No free-text column
  // crosses: `delivery_instructions`, `special_handling_notes`, `disposal_notes` and `discrepancy_notes`
  // are D13-denylisted narrative and stay inside M21. What DOES cross is controlled-substance accounting
  // (lot, expiration, dispatched/returned quantity) — that is the DEA 21 CFR §1304 record M13 must be able
  // to draw down against, not clinical content.
  SupplyFulfillmentProvider: SupplyFulfillmentProvider;
  ComfortKitDispatchProvider: ComfortKitDispatchProvider;
  SupplyCostProvider: SupplyCostProvider;
  // M19's owned seams (§4.3) — interfaces live in ./oncall (this package), so the registry is statically
  // typed against the real contract. M19-T06 registers the real impls over the deny-stubs; consumers
  // (M14 / M20 / M30 / M31 / M32 / M33 / M36) resolve them through the typed accessors with no schema
  // import edge. All five are READ-only — M19 owns the call lifecycle internally and no seam can move a
  // `triage_call` row. NEITHER encrypted column crosses: `caller_quote_cipher` / `transcript_cipher` are
  // §3.6-denylisted and the per-tenant DEK never leaves M19's boundary (D14).
  PatientSitingReader: PatientSitingReader;
  BereavementEncounterReader: BereavementEncounterReader;
  SupervisorReader: SupervisorReader;
  AuditorEngagementReader: AuditorEngagementReader;
  OnCallProvider: OnCallProvider;
  TriageCallReader: TriageCallReader;
  TriageCallProvider: TriageCallProvider;
  PortalTriageReader: PortalTriageReader;
  TriageCallMetricsProvider: TriageCallMetricsProvider;
  // M32's two ADVISORY seams (§4.4 / §8.6, D11/D12) — leaf-typed in ./oncall until M32 lands, which is
  // then the module that registers over these deny-stubs. Both answer a discriminated `unavailable`
  // rather than throwing; see the fail-posture note above the interfaces.
  ProtocolSuggestionProvider: ProtocolSuggestionProvider;
  HospitalizationRiskProvider: HospitalizationRiskProvider;
  // M20's owned seams (§4.3) — interfaces live in ./safety (this package), so the registry is statically
  // typed against the real contract. M20-T05 registers the real Drizzle-backed impls over the deny-stubs;
  // consumers (M8 / M17 / M19 / M30 / M32 / M33 / M36) resolve them through the typed accessors with no
  // schema import edge. All seven are READ-only — M20 owns the SOS / check-in / incident lifecycles
  // internally and no seam can move a row.
  //
  // NO CIPHER COLUMN CROSSES ANY OF THEM. `posted_coordinates_cipher`, `resolution_narrative_cipher`,
  // `acknowledger_dispatch_payload_cipher`, `narrative_cipher`, `witnesses_cipher` and
  // `action_plan_cipher` are §3.6-denylisted and the per-tenant DEK never leaves M20's boundary. The one
  // geography that crosses does so ROUNDED to three decimals (~110 m), computed inside M20 (§8.6), and
  // `SafetyLastKnownLocationDto` carries no coordinates at all — a source and an age, so rendering the
  // board never trips the §8.2 warn-severity coordinate-read audit.
  SafetyDashboardProvider: SafetyDashboardProvider;
  SafetyContextReader: SafetyContextReader;
  SafetyIncidentReader: SafetyIncidentReader;
  SafetyMetricsProvider: SafetyMetricsProvider;
  SafetyCheckInProvider: SafetyCheckInProvider;
  SafetyPolicyProvider: SafetyPolicyProvider;
  SafetySupervisorProvider: SafetySupervisorProvider;
  // M32's §4.2 published seams + the §4.5 prompt registry — OPAQUE rich-seam pattern (interfaces in
  // @wardenx/ai-platform, which this leaf may not import). Consumers that list `32` in `dependsOn`
  // import the real types and resolve via M32's typed accessors; the M1 registry only holds and
  // fail-closed-validates the instance, which `unknown` is sufficient for.
  //
  // `AIPromptRegistry` is the one that is NOT an inference surface: it is the D18/§8.5 typed query
  // M12, M13, M18, M21, M27 and M28 each run at their OWN boot to prove no active prompt template
  // targets their AI-prohibited zone. It is a SAFETY seam whose deny-stub therefore behaves the
  // opposite way to its ten siblings — it THROWS (see providers.ts), because an empty array from an
  // unwired registry reads as "no contraband found", which is the one answer it must never invent.
  NarrativeEnhancementProvider: unknown;
  DocLensClassifier: unknown;
  DocLensExtractor: unknown;
  DocLensVisionVerifier: unknown;
  DocLensSudDetector: unknown;
  BereavementRiskNarrativeProvider: unknown;
  DenialOutcomePredictionProvider: unknown;
  EmbeddingsProvider: unknown;
  SemanticSearchProvider: unknown;
  CopilotProvider: unknown;
  AIPromptRegistry: unknown;
  // M28's three §4.3 published seams are LEAF-TYPED — their interfaces live in ./fhir (this package), so the
  // registry is statically typed against the real contract. M28 registers the real Drizzle-backed impls over
  // the deny-stubs (M28-T08); consumers that list `28` in their manifest `dependsOn` (M30/M33/M34/M5/M12)
  // resolve them through the typed accessors with no schema import edge. `FhirInboundProposalReader` reaches
  // the raw FHIR payload (PHI); the other two are aggregate/registry metadata only.
  FhirGatewayMetricsProvider: FhirGatewayMetricsProvider;
  FhirClientReader: FhirClientReader;
  FhirInboundProposalReader: FhirInboundProposalReader;
  // M23's `ClaimReader` + M29's `LabObservationReader` are the two §4.4 forward-seams M28 CONSUMES. OPAQUE
  // rich-seam pattern (interfaces in @wardenx/billing / @wardenx/external-interfaces, not importable by this
  // leaf), so the registry holds each as `unknown` and M28 resolves via `getSeam` + a cast to its own view.
  // Both stay on the fail-closed deny-stub the whole of Phase 1 (see the SeamName comments above).
  ClaimReader: unknown;
  LabObservationReader: unknown;
  // M29's three OTHER §4.4 published read seams (M29-T08). OPAQUE rich-seams (interfaces in the M29 backend
  // module, not importable by this leaf), so the registry holds each as `unknown`; M29 registers the real
  // Drizzle-backed impl over the deny-stub and a consumer resolves via `getSeam` + a cast to its own view.
  Hl7InboundProposalReader: unknown;
  ExternalFeedReader: unknown;
  NppesProviderReader: unknown;
  // M35's six §4.5 published seams are LEAF-TYPED — their interfaces live in ./subscription-billing (this
  // package), so the registry is statically typed against the real contract. M35 registers the real
  // Drizzle-backed impls over the deny-stubs (M35-T06); consumers that list `35` in `dependsOn` (M33) —
  // and M34, which consumes via seam with NO edge either way (ADR-0025) — resolve them through the typed
  // accessors with no schema import edge. All aggregate/subscription-header metadata (no patient row).
  SubscriptionStateProvider: SubscriptionStateProvider;
  BillingStatusProvider: BillingStatusProvider;
  UsageMeteringIngest: UsageMeteringIngest;
  PatientCounterProvider: PatientCounterProvider;
  RevenueMetricsProvider: RevenueMetricsProvider;
  PlanCatalogReader: PlanCatalogReader;
  // M35's three §4.6 forward-seam consumer views are LEAF-TYPED too (M35's minimal view in
  // ./subscription-billing). Each stays on the fail-closed deny-stub until M29/M32/M34 register the real
  // impl; M35 resolves them through the typed accessor. `OnboardingStatusProvider`'s home is packages/types
  // per ADR-0025. (M28's `FhirGatewayMetricsProvider`, M35's fourth consumed seam, is declared above.)
  OnboardingStatusProvider: OnboardingStatusProvider;
  ExternalInterfaceMetricsProvider: ExternalInterfaceMetricsProvider;
  AITokenMeterProvider: AITokenMeterProvider;
  // M37 §4.11 — the eight published IPU reader seams (leaf-typed in ./inpatient).
  IpuAdmissionReader: IpuAdmissionReader;
  IpuCensusProvider: IpuCensusProvider;
  IpuBedAssignmentProvider: IpuBedAssignmentProvider;
  IpuShiftCoverageReader: IpuShiftCoverageReader;
  IpuIvSafetyOverlayProvider: IpuIvSafetyOverlayProvider;
  IpuVisitorReader: IpuVisitorReader;
  IpuQualityReader: IpuQualityReader;
  IpuTenantPostureReader: IpuTenantPostureReader;
}

/**
 * A boot-time seam requirement (§3.18.2). Each entry names the seam `key`, the module that
 * owns the real implementation (`ownerModule`), a fail-closed `denyStub` default applied
 * when no module registered the seam (so the contract denies on call rather than failing
 * open), and whether the seam guards `phi`. The bootstrap's `validateSeams()` applies the
 * deny-stub for any unregistered required seam and refuses to boot only when an entry has
 * neither a registration nor a deny-stub (§3.18.3).
 */
export interface RequiredSeam {
  readonly key: SeamName;
  readonly ownerModule: number;
  readonly denyStub: unknown;
  readonly phi: boolean;
}

/**
 * A registered destruction handler for one retention/data class. Every PHI data class
 * must register one or boot fails (validateErasers()). See M4 destruction-cert workflow.
 */
export interface DataEraseResult {
  /** Rows or ciphertext-bearing records actually erased by this invocation. */
  readonly erased: number;
  /** Rows retained because 42 CFR Part 2 lifetime/post-death retention has not elapsed. */
  readonly refusedPartTwo?: number;
  /** Rows retained because an active legal hold matched them. */
  readonly refusedLegalHold?: number;
}

export interface DataEraser {
  /** Erase/redact the rows this data class owns for the given subject. */
  erase(scope: OrgScope, subjectId: string): Promise<DataEraseResult>;
}

/** Data classes that require a registered eraser before the server may listen. */
export type DataClass =
  | "audit_event"
  | "clinical_record"
  | "documents"
  | "messages"
  | "consent"
  | "telehealth_recording"
  // M2 (Identity & Org) personal-credential data: the subject's `two_factor` +
  // `passkey` enrollments (user-owned) and any pending `organization_invitation`
  // addressed to them. Erased by M2's registered eraser (M2-T10) so a right-to-erasure
  // request never silently no-ops the identity credential surface.
  | "identity"
  // M38 (Clinical Terminology) tenant data: a tenant's `value_set_tenant_extension` rows
  // (its add-only customizations of platform value sets) + cached expansion overrides. On
  // tenant offboarding (D8) M38's eraser deletes these; the platform terminology tables are
  // NEVER touched — they are shared reference data, not tenant data, so they survive the
  // tenant (M38 §11 D8; same "erase the tenant's view-of-the-world, not the world" pattern
  // as M40 canonical/overlay). The `subjectId` here is the org being offboarded.
  | "terminology_tenant_extensions"
  // M40 (Master Data Management) tenant data: a tenant's overlay rows
  // (`external_physician_tenant_overlay` + the other per-kind overlays as they land), all
  // `mdm_provisional` rows, and all `mdm_baa_record` rows. On tenant offboarding (D7) M40's
  // eraser deletes these; the org-less CANONICAL entities (physician/facility/payer) are NEVER
  // touched — they are shared registry-sourced reference data that survives the tenant (M40 §7.8;
  // same "erase the tenant's view-of-the-world, not the world" pattern). `subjectId` is the org.
  | "mdm_tenant_overlays"
  // M6 (Admission, Election & Certification) per-patient admission record: the admission subtree
  // (election_period / election_statement / certification_of_terminal_illness / face_to_face_encounter
  // / level_of_care_period / revocation_event / discharge_event / transfer_event /
  // notice_of_rights_acknowledgment / compliance_window) plus the `referral` rows for the subject.
  // Erased by M6's registered eraser (M6-T12) under an M4 destruction certificate; the `admission`
  // row is left a tombstone for FK referential integrity (D8 resolver pattern, same as M5's
  // `clinical_record`). `subjectId` is the patient being destroyed — M6 owns its own clinical
  // satellites, distinct from M5's patient-spine `clinical_record` class.
  | "admission_record"
  // M7 (Care Plan / IPOC) per-patient care-plan record: the care-plan subtree M7 owns — the
  // `care_plan_version`, `care_plan_signature`, `problem`, `goal`, and `intervention` rows hung off a
  // patient's `care_plan` root. Erased by M7's registered eraser (M7-T09) under an M4 destruction
  // certificate; the `care_plan` root is left a tombstone for FK referential integrity (D8 resolver
  // pattern, same as M5's `clinical_record` and M6's `admission_record`). `subjectId` is the patient
  // being destroyed — M7 owns its own care-plan satellites, distinct from M5's patient spine and M6's
  // admission subtree.
  | "care_plan_record"
  // M8 (Encounters & Visit Notes) per-patient encounter record: the encounter subtree M8 owns — the
  // `encounter_signature`, `encounter_addendum`, `encounter_care_plan_link`, `cosignature_request`,
  // `vitals`, `mileage`, `hearthnote_selection`, `hearthnote_assembled_output`, and
  // `hearthnote_llm_modification` rows hung off a patient's `encounter` root. Erased by M8's registered
  // eraser (M8-T12) under an M4 destruction certificate; the HearthNote ciphertext is crypto-erased via
  // the tenant DEK (§3.6) and the `encounter` root is left a tombstone for FK referential integrity (D8
  // resolver pattern, same as M5's `clinical_record`, M6's `admission_record`, M7's `care_plan_record`).
  // `subjectId` is the patient being destroyed — M8 owns its own encounter satellites, distinct from
  // M5's patient spine and M6/M7's admission/care-plan subtrees (the spec's §3.6 `clinical_record`
  // mention is reconciled to this disjoint class so the M5 eraser is never double-registered).
  | "encounter_record"
  // M9 (Clinical Assessments Suite) per-patient assessment record: the assessment subtree M9 owns — the
  // `assessment_cosignature` and `significant_change_event` child rows plus the `clinical_assessment` rows
  // themselves (BOTH `active` and `superseded`, so the correction-supersede chain is erased at both ends).
  // Erased by M9's registered eraser (M9-T07) under an M4 destruction certificate (§8.4); unlike the
  // M5/M6/M7/M8 root-tombstone erasers, M9 has no satellite root to keep — the assessment rows are the leaf
  // clinical facts, so they are deleted outright. The org-level `scale_license` / `scale_policy` tables are
  // NEVER touched — they are tenant configuration, not patient data (§8.4 #3). `subjectId` is the patient
  // being destroyed; disjoint from M5's `clinical_record` (patient spine) and M6/M7/M8's subtrees.
  | "clinical_assessment"
  // M10 (HOPE Engine) per-patient HOPE record: the timepoint subtree M10 owns — the
  // `hope_timepoint_schedule`, `symptom_follow_up_visit`, `hope_validation_finding` child rows plus the
  // partitioned `hope_assessment` rows (both `signed` and `superseded`, so the correction-supersede chain is
  // erased at both ends). Erased by M10's registered eraser (M10-T08) under an M4 destruction certificate
  // (§8.4): the `hope_assessment` rows are dropped at partition granularity when a partition is wholly erasable
  // and row-deleted otherwise. Submitted assessments carry the CMS 10-year extended retention — erasing them
  // before that horizon is REFUSED unless a legal-hold override is supplied (§8.4 #1). `hope_submission` /
  // `hope_submission_item` rows SURVIVE (the envelope SHA-256 is operational/compliance evidence); their
  // per-patient envelope content in MinIO is purged by M4's envelope-purge worker, not this eraser (§8.4).
  // `subjectId` is the patient being destroyed; disjoint from M9's `clinical_assessment` (clinical-scale rows)
  // and M5/M6/M7/M8's subtrees.
  | "hope_record"
  // M11 (Orders) per-patient orders record: the orders subtree M11 owns — the monthly-partitioned
  // `order_record` rows plus the cascaded `order_signature`, `verbal_order`, `standing_order_instance`, and
  // `order_discontinuation` child rows, and the patient's `standing_order` templates. Erased by M11's
  // registered eraser (M11-T08) under an M4 destruction certificate (§7.7 / D12): the `order_record` rows are
  // dropped at partition granularity when a partition is wholly erasable and row-deleted otherwise; the cert's
  // `retentionAsOf` boundary enforces M4's standard `compliance` 7-year retention floor (no CMS extended-
  // retention block, unlike M10). The ORG-scoped `order_verbal_policy` is tenant configuration, not patient
  // data, and is NEVER touched (§7.7 #4). `subjectId` is the patient being destroyed; disjoint from M10's
  // `hope_record` and M5/M6/M7/M8/M9's subtrees.
  | "order_record"
  // M12 (DoseSpot Integration) per-patient medication-order record: the prescribing subtree M12 owns — the
  // monthly-partitioned `medication_order` rows plus the cascaded `medication_order_transmission`,
  // `refill_request` (whose source order matches), and `epcs_signing_attempt` child rows. Erased by M12's
  // registered eraser (M12-T09) under an M4 destruction certificate (§7.7 / D15): the `medication_order` rows
  // are dropped at partition granularity when a partition is wholly erasable and row-deleted otherwise; the
  // cert's `retentionAsOf` boundary enforces M4's standard `compliance` retention floor. The ORG-scoped
  // `dosespot_prescriber`, `dosespot_webhook_event`, `refill_inbox_policy`, and `controlled_substance_policy`
  // are tenant configuration / encrypted webhook receipts, not patient data, and are NEVER touched (§7.7 #5).
  // `subjectId` is the patient being destroyed; disjoint from M11's `order_record` (clinical orders) and the
  // M5/M6/M7/M8/M9/M10 subtrees.
  | "medication_order_record"
  // M13 (eMAR & Med Administration) per-patient eMAR record: the administration subtree M13 owns — the
  // monthly-partitioned `administration_record` rows (partitioned by `administered_at`) plus the cascaded
  // `prn_administration`, `administration_witness`, and `barcode_scan_event` child rows, the patient's
  // `scheduled_dose` / `missed_dose` rows, the `comfort_kit_deployment` / `comfort_kit_drawdown` rows, the
  // `medication_reconciliation_worksheet` / `medication_reconciliation_decision` rows, and the
  // `administration_offline_queue` rows. Erased by M13's registered eraser (M13-T10) under an M4 destruction
  // certificate (§7.7): the `administration_record` rows are dropped at partition granularity when a partition
  // is wholly erasable and row-deleted otherwise; the cert's `retentionAsOf` boundary enforces M4's standard
  // `compliance` retention floor (no CMS extended-retention block, like M11/M12). The ORG-scoped
  // `administration_policy` is tenant configuration, not patient data, and is NEVER touched (§7.7 #7).
  // `subjectId` is the patient being destroyed; disjoint from M12's `medication_order_record` (prescribing
  // subtree) and the M5/M6/M7/M8/M9/M10/M11 subtrees.
  | "emar_record"
  // M14 (Interdisciplinary Group / IDG) per-patient IDG record: the patient-scoped IDG artifacts M14 owns —
  // the `idg_agenda_item`, `idg_decision`, `idg_action_item`, and `idg_patient_packet` rows that carry a
  // `patient_id`. Erased by M14's registered eraser (M14-T07) under an M4 destruction certificate (§8.4): the
  // patient's packets / decisions / action-items / agenda items are deleted; the `idg_meeting`,
  // `idg_recurring_policy`, `idg_attendance`, `idg_minutes`, and `idg_minutes_amendment` rows SURVIVE — they are
  // caseload-wide / org-level meeting artifacts (a meeting is not a single patient's record), and patient-
  // specific references inside `idg_minutes` snapshots are hash-redacted by the M4 trigger pattern, not deleted
  // here. `subjectId` is the patient being destroyed; disjoint from every other module's clinical subtree.
  | "idg_record"
  // M15 (Discipline Care Plans) per-patient discipline record: the plan subtree M15 owns — the
  // `discipline_goal`, `discipline_intervention`, `discipline_assessment` (both the signed rows and their
  // append-only amendments), `discipline_care_plan_signature`, `discipline_care_plan_version` and
  // `aide_supervisory_visit` rows hung off a patient's `discipline_care_plan` roots, plus the patient's
  // `volunteer_assignment` rows. Erased by M15's registered eraser (M15-T06) under an M4 destruction
  // certificate (§8.5): the version `state_snapshot` and the assessment `data` jsonb — the two PHI-bearing
  // payload columns — are scrubbed before the rows go, and the four `discipline_care_plan` roots are left
  // as tombstones for FK referential integrity (the M5/M6/M7/M8 root-tombstone pattern). The
  // WORKFORCE-scoped `volunteer_compliance_gate` / `volunteer_hour_ledger` / `volunteer_hour_entry` rows are
  // NEVER touched — they are a volunteer's own credential + hours record, not the patient's (§8.5).
  // `subjectId` is the patient being destroyed; disjoint from M7's `care_plan_record` (the shared IPOC).
  | "discipline_plan_record"
  // M16 (Bereavement) per-patient bereavement record: the survivor-facing subtree M16 owns for one
  // DECEDENT — the `bereaved_contact` roster, the `bereavement_outreach` touchpoints, the monthly-
  // partitioned `bereavement_contact_log` rows, the immutable `bereavement_risk_score` ledger, the
  // `bereavement_opt_out` and `bereavement_anniversary_reminder` rows, and the `bereavement_plan_closure`
  // record, all hung off the patient's single `bereavement_plan` root. Erased by M16's registered eraser
  // (M16-T06) under an M4 destruction certificate (§8.5): the PHI-bearing columns are SHREDDED first — the
  // three `bereaved_contact` channel ciphers, `bereavement_contact_log.contact_notes_cipher`, the risk
  // ledger's `risk_factors_jsonb` + `augmented_narrative_redacted`, and the four redacted narrative columns
  // — and only then are the rows removed, so the PHI is gone even if a later delete step fails. The
  // `bereavement_plan` root is left as a TOMBSTONE for FK referential integrity (the M5/M6/M7/M8/M15
  // root-tombstone pattern) and the `bereavement_plan_closure` row SURVIVES with its narrative shredded,
  // because the §7.15 survey reconstruction has to be able to say a program existed and why it ended even
  // after the survivors' details are destroyed. The ORG-scoped
  // `tenant_bereavement_external_source_gate_override` is tenant configuration, not patient data, and is
  // NEVER touched. `subjectId` is the DECEDENT whose death opened the program — disjoint from M7's
  // `care_plan_record` and M15's `discipline_plan_record`.
  | "bereavement_record"
  // M21 (Supplies, DME & Comfort Kits) per-patient supply record: the request + kit-custody subtree M21
  // owns — `supply_request` (partitioned), `comfort_kit_dispatch` (partitioned) and its
  // `comfort_kit_dispatched_content` lines, `comfort_kit_return` and its `comfort_kit_returned_content`
  // lines. Erased by M21's registered eraser (M21-T05) under an M4 destruction certificate.
  //
  // THE CONTROLLED-SUBSTANCE LEDGER IS DIFFERENT FROM EVERY OTHER CLASS ABOVE, and the difference is
  // statutory: DEA 21 CFR §1304.04 requires the perpetual inventory record of a scheduled drug to be
  // retained for at least two years, and a patient's right to erasure does not reach a DEA registrant's
  // controlled-substance ledger. So the eraser SHREDS the patient-identifying columns and the D13 free
  // text but PRESERVES the lot-level accounting rows themselves, de-identified — quantity, schedule, lot,
  // dispatcher, witness. Deleting them would erase the agency's own compliance evidence in the name of
  // protecting the patient whose kit it documented (§8.2 tags those audit rows `regulatory_dea`).
  //
  // The org-scoped CONFIG — `supply_item`, `tenant_supply_item_extension`, `comfort_kit_template(_medication)`,
  // `vendor_routing_rule`, `par_stock` — is never touched: a catalog, a recipe, a routing ladder and a shelf
  // count are not patient data. `subjectId` is the patient.
  | "supply_record"
  // M17 (Scheduling & Route Optimization) per-patient schedule record: the patient-scoped scheduling rows
  // M17 owns — the partitioned `visit` rows (and their cascaded `visit_state_history` transitions),
  // `recurring_visit` policies, `visit_proposal` rows, and the `route_segment` legs joinable via a visit
  // being erased (§3.7). Registered in M17-T02 (this task) so the contract is present from the schema task;
  // M17-T08 registers the REAL eraser via the composition-root hook over the Phase-0 deny-stub — under an M4
  // destruction certificate it row-deletes the patient's visits / state-history / recurring policies /
  // proposals / route segments (retention class `operational`, 3 years post-discharge, §3.7). The clinician-
  // scoped `clinician_availability` and `time_off` rows SURVIVE (they are workforce data, not a single
  // patient's record). `subjectId` is the patient being destroyed; disjoint from every other module's subtree.
  | "operational_schedule"
  // M18 (EVV) per-patient EVV record: the EVV artifacts joinable to a patient — the partitioned `evv_event`
  // capture rows, their `evv_geofence_evaluation` children (by evv_event_id), and the `evv_missing_resolution`
  // / `evv_aggregator_submission` rows (by visit_id, joinable to M17 visits for the patient). Registered in
  // M18-T02 (this task) so the contract is present from the schema task; M18-T07 registers the REAL eraser via
  // the composition-root hook over the Phase-0 deny-stub — under an M4 destruction certificate it
  // cryptographic-shreds the per-tenant DEK (rendering the GPS coordinate ciphertext unrecoverable) and drops
  // the rows. Retention class `compliance` (`evv_record`, 7 years — the Medicaid EVV / HQRP survey-record
  // artifact, §3.7 / D12). The tenant-config `evv_geofence_policy` and the membership-scoped `evv_device`
  // SURVIVE (not patient data; device erases on workforce departure per M2 D8). `subjectId` is the patient
  // being destroyed; disjoint from every other module's subtree.
  | "evv_record"
  // M19 (On-Call Triage) per-patient triage record: the after-hours subtree M19 owns for one patient — the
  // `triage_call` rows and their `triage_call_answer` / `triage_escalation` / `triage_call_state_history`
  // children. Registered in M19-T02 (the schema task) so the contract is present from the moment the tables
  // exist; the REAL eraser is bound through the composition-root hook over the Phase-0 deny-stub. Under an
  // M4 destruction certificate (§3.7) the children are DELETED outright and the `triage_call` row is left as
  // a de-identified TOMBSTONE — the M5/M6/M7/M8/M15/M16 root-tombstone pattern, and here it is load-bearing
  // for a second reason: M8's signed `triage_telephonic_contact` encounter carries a back-reference to the
  // call, so deleting the row would orphan a signed clinical document. Every PHI-bearing column on it
  // (patient/admission/caregiver ids, caller name + phone, chief complaint, the two DEK ciphers, the
  // disposition payload) is nulled first, so the PHI is unreadable even if a later step fails; a
  // tenant-offboarding DEK shred makes `caller_quote_cipher` / `transcript_cipher` unreadable in the same
  // operation with no per-row delete (§3.7). The ORG-scoped configuration — `tenant_oncall_policy`,
  // `external_triage_vendor`, `on_call_shift`, `triage_protocol` and `triage_protocol_question` — is NEVER
  // touched: a policy, a vendor binding, a roster and a protocol catalog are not one patient's data, and
  // `on_call_shift` in particular is the CoP 418.100(c)(2) evidence that a nurse was reachable, which a
  // right-to-erasure request does not reach. `subjectId` is the patient being destroyed; disjoint from M8's
  // `encounter_record` (which erases its own side in parallel) and from every other module's subtree.
  | "triage_record"
  // M34 (SaaS Tenant Platform) per-TENANT control-plane record (NOT patient data): on tenant offboarding
  // (D6, §3.5/§8.4) M34's eraser deletes the org's operational working rows — `onboarding_task`,
  // `support_consent_grant`, `support_session` headers, `platform_tenant_baa_record`, `tenant_invitation`,
  // `tenant_signup_intent`/`tenant_signup_token`, and `tenant_export_job` (+ its event ledger). The
  // lifecycle/key-ring destruction ledger and the §164.528 disclosure-accounting surfaces (`dsar_export_job`,
  // `support_session_event`) are NEVER touched (§8.4). Unlike every class above, `subjectId` here is the ORG
  // being offboarded (the platform control plane has no patient subject). Registered by M34's eraseFn over
  // the Phase-0 deny-stub via the composition-root hook (same pattern as M40's `mdm_tenant_overlays`).
  | "saas_tenant_platform_class"
  // M33 (Reporting & Dashboards) per-TENANT reporting footprint (NOT patient data): on tenant offboarding
  // (§3.7 / D6 / §8.4) M33's eraseFn deletes the org's OPERATIONAL rows (report_schedule + run ledgers,
  // dashboard_tile_cache, report_view/report_share, report_definition/report_definition_version) in FK-safe
  // order, REFUSES the compliance-class `report_drilldown_audit` (D9 survey-evidence, destruction-blocked),
  // and leaves the PLATFORM catalogs (report_base_catalog/report_metric_catalog/materialized_view_metadata)
  // untouched (shared reference data, migration-retired only). Like M34, `subjectId` here is the ORG being
  // offboarded. Registered by M33's eraseFn over the Phase-0 deny-stub via the composition-root hook.
  | "reporting_class"
  // M20 (Field Safety) per-patient safety footprint. Registered in M20-T02 (the schema task) so the contract
  // is present from the moment the tables exist; the REAL eraser binds through the composition-root hook
  // over the Phase-0 deny-stub. UNLIKE almost every class above this erase DELETES NOTHING (§3.7): ten of
  // M20's thirteen tables are filed "structural row retained with redacted markers", because the SOS
  // event-of-record IS the row, an incident's `category`/`severity` are what a 2031 review of a 2025 assault
  // reads, and a consent row's existence is the proof a coercion review turns on. M20 is a WORKFORCE-safety
  // module, so its patient surface is exactly two logical M5 references — `safety_incident.patient_id` and
  // `safety_sos_alert.last_known_patient_id`. The eraseFn redacts the free text that §3.5 says may describe
  // the patient (incident narrative/witnesses/action plan/location description/reopen reason/WC reference;
  // SOS resolution narrative + dispatch payload), redacts `action_taken` on the attached acknowledgments,
  // and LAST severs the linkage itself. The clinician's own coordinates, the whole
  // `safety_sos_location_stream` (whose destruction path is the §3.7 resolve+90d sweep), both check-in
  // tables (no patient column at all — their only linkage is M17's `visit_id`), the policy/version replay
  // rows, the supervisor subscriptions, the advisory polygons and the clinician's own emergency-contact
  // consent are NEVER touched: they are a different data subject's record, and a patient's right to erasure
  // does not reach the clinician's workers-comp evidence. `subjectId` is the patient being destroyed.
  | "safety_record"
  // M32 (AI Platform) per-patient AI PROVENANCE, in two halves (§3.7). Registered in M32-T02 (the schema
  // task) so the contract exists from the moment the tables do; the REAL erasers bind through the
  // composition-root hook over the Phase-0 deny-stubs. NEITHER DELETES A ROW. `ai_invocation` is the
  // §164.528 disclosure ledger — its token counts, model version pin, ZDR flag and timestamps ARE the
  // evidence that a disclosure to a model vendor happened, or (for a `capability_unavailable` row) that
  // it did not — so destroying the rows would destroy the record THAT the disclosure occurred, which is
  // the opposite of what a destruction certificate is for. The erase destroys the CIPHERTEXT on that
  // patient's invocation rows instead: the NOT NULL `prompt_payload_cipher` is overwritten with the empty
  // -bytea shred sentinel and the two optional ciphers are nulled, which is the OUTCOME §3.7 specifies
  // ("the rows remain; the encrypted payloads become unreadable") by the only means a PER-PATIENT
  // certificate has — shredding the per-tenant DEK would destroy every other patient's rows too, and that
  // whole-org path is M34's tenant-offboarding operation, not this one. The 0116 immutability trigger
  // permits exactly this edit and no other cipher write, so the destruction path needs no privileged
  // bypass. TWO classes because M4's registry is single-keyed and §3.7 maps M32's provenance onto the
  // distinct classes M22 (intake) and M8 (clinical record) already use; the split is by capability, and
  // the halves are disjoint, so running both is not a double-shred. NEVER touched: `ai_token_ledger`
  // (no PHI, append-only, and erasing it would corrupt the tenant's own billing history),
  // `ai_hallucination_report` (deliberately carries no patient column — a per-patient certificate cannot
  // identify the report, and joining through `invocation_id` would reach reports it never named) and the
  // platform-shared governance surface. `subjectId` is the patient being destroyed.
  /** `doclens_*` invocations — the patient's INTAKE documents (the M22 half). */
  | "intake_ai_provenance"
  /** Every other capability — the patient's CHART (the M8 half). */
  | "clinical_record_ai_provenance"
  // M28 (FHIR Gateway) per-TENANT gateway footprint (§3.7). Registered in M28-T02 (the schema task) so the
  // contract exists from the moment the tables do; the REAL eraser binds through the composition-root hook
  // over the Phase-0 deny-stub in M28-T08. NOT a delete — a targeted shred that keeps every row: it zeroes
  // `tenant_fhir_config.cursor_signing_key_cipher`, destroys the `fhir_client_credential` ciphers (keeping
  // the `fingerprint`), purges the `fhir_bulk_export_artifact` MinIO objects, soft-deletes `fhir_client`
  // (`status='revoked'`) and `fhir_bulk_export_job` (`status='expired'`), and replaces
  // `fhir_inbound_resource.payload` with the `{"_destroyed":true}` sentinel — while every row's status,
  // approvals, `baa_contract_reference`, `payload_sha256` and timestamps survive, because those rows ARE
  // the §164.528 accounting-of-disclosures evidence (what PHI was disclosed to which external client, under
  // which BAA, when). `fhir_client_session` rows are fully destructible (no PHI, routine-purged past 90
  // days) and `fhir_capability_snapshot` is never touched (platform-shared, no PHI). Unlike the per-patient
  // classes above, `subjectId` is the ORG being offboarded — the M28 named it `fhir_gateway` in M28-T01.
  | "fhir_gateway"
  // M31 (Patient/Family Portal & Telehealth) per-patient portal footprint: the patient's `telehealth_visit`
  // rows (aborted + their vendor-room ciphers shredded), the `portal_access_grant` rows to the patient
  // (revoked with `revoke_cascade_source='destruction'`), and any `portal_account` that the revocation left
  // with no active grant to ANY patient (flipped to `revoked`, contact ciphers shredded). Erased by M31's
  // registered eraser (M31-T06) under an M4 destruction certificate (§3.7 / D15); the recording BYTES in
  // MinIO are crypto-erased by M22's own `telehealth_recording`/`documents` eraser — M31 stores only the
  // refs, which it shreds. `subjectId` is the patient being destroyed.
  | "portal_record"
  // M29 (External Interfaces) per-TENANT interface footprint (§3.7). Registered in M29-T02 (the schema
  // task) so the contract exists from the moment the tables do; the REAL eraser binds through the
  // composition-root hook over the Phase-0 deny-stub in a later M29 task. NOT a delete — a targeted shred
  // that keeps every row: it destroys the per-tenant DEK so every `*_cipher` column (the raw HL7 payloads,
  // the `external_feed_credential.secret_cipher` channel secret, the ack payloads) becomes unrecoverable,
  // re-encrypts `hl7_inbound_proposal.proposed_patient_candidate` to null, tombstones the feed
  // (`status='revoked'`, `revoked_at` set) and cascades `lab_observation → lab_observation_value /
  // lab_observation_inbound_link` — while every ROW survives with its status, decision, `payload_sha256`
  // and timestamps intact, because those rows ARE the §164.528 accounting-of-disclosures evidence (an
  // inbound HL7 message is a receipt-of-disclosure; a lab surfaced to an operator or projected to M28 for
  // FHIR egress is itself a disclosure). The platform-shared `nppes_provider` / `nppes_sync_run` are the
  // public CMS directory (rebuildable from a re-sync) and are never touched. Unlike the per-patient classes
  // above, `subjectId` is the ORG being offboarded — M29-T01 named it `external_interfaces`.
  | "external_interfaces"
  // M37-T11: a patient's IPU record (ipu_admission subtree + gip/irc/restraint/iv-overlay/body-release/
  // visitor/meal satellites + per-patient visitor restrictions). M37 registers the REAL eraser via the
  // composition-root hook over this deny-stub — under an M4 destruction certificate it deletes the subtree
  // in FK order (§7.7 / D8); aggregate census snapshots survive (no patient_id, D14). `subjectId` = patient.
  | "ipu_record"
  // TASK-003 follow-up — the seven classes below were registered through `as DataClass` casts (each
  // module's registrar invented its literal outside this union, so validateErasers never required
  // them and a typo'd class was indistinguishable from a new one). Now first-class:
  // M30 quality: tenant-offboarding operational-row cleanup; compliance/survey evidence
  // destruction-blocked (count-only). `subjectId` = org.
  | "quality_class"
  // M27 cost report: operational-config cleanup; submitted/accepted cost reports are survey
  // evidence, elevated-cert-gated. `subjectId` = org.
  | "cost_report_class"
  // M23: per-PATIENT billing destruction (in-flight/surveyor-hold guarded); MAC-secret shred is the
  // org-destruction path.
  | "billing_record"
  // M25: per-PATIENT patient-responsibility-ledger destruction (835 line history rolls off via the
  // M4 partition manager, not per patient).
  | "remittance"
  // M24: per-PATIENT redact-to-shred (PHI free text + KMS ciphers); the FK chain survives.
  | "medicaid_billing_record"
  // M26: per-PATIENT redact-to-sentinel (D14 — aggregates survive so CMS cap reconciliation stays
  // reproducible).
  | "cap";
