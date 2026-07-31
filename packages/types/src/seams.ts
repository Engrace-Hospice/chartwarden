import type {
  AdmissionCensusReader,
  AdmissionStatusReader,
  CertificationReader,
  DeathDischargeReader,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCareReader,
} from "./admission";
import type { LatestAssessmentProvider, ScaleSeriesProvider } from "./assessment";
import type { CarePlanReader } from "./care-plan";
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
  HopeJ2051Provider,
  HopeOrgRollupProvider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
} from "./hope";
import type { IdgDecisionProvider, IdgPacketProvider, IdgScheduleProvider } from "./idg";
import type { OrderProvider, OrderSignatureProvider } from "./orders";
import type { PatientCoverageReader, PatientMutator, PatientReader } from "./patient";
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
  PortalVisitReader,
  SupervisoryCadenceReader,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
  VolunteerComplianceProvider,
} from "./scheduling";

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
  | "PatientReader" // M5 — patient identity/demographics reads (§4.8; M29 cascade)
  | "PatientCoverageReader" // M5 — §3.4 coverage list; M23/M24 resolve which payer a claim bills
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
  | "TenantOrgCreationProvider" // M2 — create/attach the per-tenant org M34's provision worker needs (§7.1)
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
  | "DeathDischargeReader" // M6 — death-discharge census for a period (M30 HVLDL measure denominator, §4.11)
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
  // M15 (Discipline Care Plans, Phase 2) owned seams M17 CONSUMES (§4.4) — leaf-typed in ./scheduling (M15 has no
  // types file yet) so M17's D8 pre-schedule gate (predicate 6) + day-view advisory compile against the real
  // contract. Both fail-closed deny-stub until M15 ships (M17-F06/ADR-0009); the volunteer gate denies LOUDLY
  // exactly when a `volunteer_visit` is scheduled before M15 lands. No `dependsOn` edge (registry is M1-owned).
  | "VolunteerComplianceProvider" // M15 — per-membership volunteer-compliance status (gate predicate 6, VOLUNTEER_GATE_UNMET)
  | "SupervisoryCadenceReader" // M15 — next-due RN supervisory visit per admission (day-view advisory + propose-from-frequency)
  | "CapAccrualReader" // M26 — cap-period aggregate for the M27 cost-report Worksheet-E cap calc (aggregate $/days, no PHI)
  | "CapProjectionProvider" // M26 — agency/patient/inpatient cap projection for the M23 §11.A pre-submission cap rules
  // M23/M25 → M27 cost-report validation binds. M23 is the FIRST module to publish into the typed M1
  // registry (it was outbox-only before); M25 follows. All three are aggregate, FY-scoped, PHI-free (D18):
  | "PatientDaysProvider" // M23 — billed-and-accepted census patient-days for a FY (M27 stats.patient_days_reconcile)
  | "DrugCostBillingReader" // M12 — drug-cost basis for a FY, M27 Worksheet-A pharmacy cross-check (drug_cost.billed_reconciles). RESERVATION: degrades until M12 materializes med-order cost (no cost column today)
  | "ClaimSettlementProvider" // M25 — actual interim Medicare payments (835 CLP04) for a FY (M27 settlement.e1_ties_to_d)
  | "ClaimLineReader" // M23 — per-LOC billed claim-line day rollup for a window (M30 HCI claims-derived indicators)
  | "CostReportFilingStatusReader" // M27 — cost-report filing posture per FY (M30 CoP 418.310 failure-to-file indicator)
  // M30 (HQRP & Quality) §4.3 — the five READ-ONLY seams M30 publishes. Before these, M30 was reachable
  // cross-module ONLY through its §4.10 outbox events, so M22's quality report, M28's FHIR MeasureReport /
  // AdverseEvent, M33's executive dashboards and M34's FY-rollover tenant gate had no read path at all.
  | "QualityMeasureProvider" // M30 — HQRP measure values/series/snapshot + the FY measure catalog (aggregate-only)
  | "IncidentRegisterProvider" // M30 — incident register (PHI: patient-scoped rows require caller patient scope)
  | "QapiProjectProvider" // M30 — QAPI projects/PIPs by phase (M22 minutes, M33 dashboards)
  | "ComplianceStatusProvider" // M30 — CoP compliance status per condition (M34 tenant gate, M33 dashboards)
  | "SecurityRiskAssessmentReader"; // M30 — SRA cycle posture (§164.308(a)(1)(ii)(A) attestation surface)

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

// M5's `PatientReader` (§4.8) + `PatientMutator` (§4.9) interfaces live in ./patient (alongside
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
 */
export interface ResolvedActor {
  readonly userId: string;
  readonly membershipId: string | null;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

/** The membership + active role keys for an actor in one org (the actor-context fields M3 owns). */
export interface ActorEnrichment {
  /** `membership.id` for the actor's ACTIVE membership in the scope org (null when none). */
  readonly membershipId: string | null;
  /** The actor's current (enabled, non-expired) role keys in the scope org. */
  readonly roles: readonly string[];
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
 * M2 — resolves an authenticated, org-scoped request (by session id) to its actor identity
 * and step-up state. Consumed by M3 (`step_up_recent`), M4 (actor for the audit trail), and
 * every module that needs an authenticated request context (§4.7). Resolution is org-scoped:
 * a session whose org ≠ `scope.orgId` resolves to null (no cross-tenant leak through the seam).
 */
export interface SessionContextResolver {
  resolveActor(scope: OrgScope, sessionId: string): Promise<ResolvedActor | null>;
  resolveStepUpState(scope: OrgScope, sessionId: string): Promise<SessionStepUpFields | null>;
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

/** Map from seam name → its interface type, so the registry is type-safe. */
export interface SeamContracts {
  CaseloadProvider: CaseloadProvider;
  PatientReader: PatientReader;
  PatientCoverageReader: PatientCoverageReader;
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
  // M2 — LEAF-TYPED: M34's provision worker (CONSUMER) and M2 (PRODUCER) can't import each other's
  // package, so the contract lives here. M2 registers the real Drizzle-backed provider over the deny-stub.
  TenantOrgCreationProvider: TenantOrgCreationProvider;
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
  // M6's death-discharge census reader (§4.11) is LEAF-TYPED too — interface in ./admission. M6 registers the
  // real Drizzle-backed reader over the deny-stub; M30's HVLDL measure-recompute worker (which lists `6` in its
  // manifest `dependsOn`) resolves it through the typed accessor with no schema import edge.
  DeathDischargeReader: DeathDischargeReader;
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
  // M15's consumed-by-M17 seams (§4.4) are LEAF-TYPED too — interfaces live in ./scheduling (M15 has no types
  // file yet, Phase 2). The registry holds the deny-stub until M15 registers the real impls (M17-F06/ADR-0009);
  // M17 resolves them through the module-17 consumed-seam accessors with no schema import edge.
  VolunteerComplianceProvider: VolunteerComplianceProvider;
  SupervisoryCadenceReader: SupervisoryCadenceReader;
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
export interface DataEraser {
  /** Erase/redact the rows this data class owns for the given subject. */
  erase(scope: OrgScope, subjectId: string): Promise<{ erased: number }>;
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
  | "reporting_class";
