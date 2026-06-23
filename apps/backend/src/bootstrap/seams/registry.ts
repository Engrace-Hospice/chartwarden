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
  billableEncounterReaderDenyStub,
  carePlanReaderDenyStub,
  caseloadDenyStub,
  certificationReaderDenyStub,
  consentEvaluatorDenyStub,
  documentReaderDenyStub,
  documentRendererDenyStub,
  documentStorageProviderDenyStub,
  electionPeriodReaderDenyStub,
  extractionProvenanceReaderDenyStub,
  intakeMetricsProviderDenyStub,
  portalDocumentReaderDenyStub,
  renderedDocumentProviderDenyStub,
  encounterCreatorDenyStub,
  evvAggregatorReferenceReaderDenyStub,
  evvBracketResolverDenyStub,
  evvComplianceReaderDenyStub,
  evvLocationProviderDenyStub,
  evvMetricsProviderDenyStub,
  evvVerificationProviderDenyStub,
  faceToFaceReaderDenyStub,
  hopeJ2051ProviderDenyStub,
  hopeSubmissionProviderDenyStub,
  hopeTimepointProviderDenyStub,
  idgDecisionProviderDenyStub,
  idgPacketProviderDenyStub,
  idgScheduleProviderDenyStub,
  latestAssessmentProviderDenyStub,
  levelOfCareReaderDenyStub,
  mdmEntityProviderDenyStub,
  medicationAdministrationProviderDenyStub,
  medicationOrderProviderDenyStub,
  messagingProviderDenyStub,
  mileagePayrollReaderDenyStub,
  orderProviderDenyStub,
  orderSignatureProviderDenyStub,
  patientMutatorDenyStub,
  patientReaderDenyStub,
  portalVisitReaderDenyStub,
  reconciliationProviderDenyStub,
  refillInboxProviderDenyStub,
  scaleSeriesProviderDenyStub,
  sessionContextResolverDenyStub,
  signedEncountersReaderDenyStub,
  supervisoryCadenceReaderDenyStub,
  terminologyProviderDenyStub,
  visitAssignmentReaderDenyStub,
  visitMetricsProviderDenyStub,
  visitReaderDenyStub,
  volunteerComplianceProviderDenyStub,
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
  // M5 (§4.9) — applies an M29-proposal/amendment field diff (D12 strip). PHI write surface;
  // boot-validated and fail-closed until M5 registers the real mutator (M5-T08).
  { key: "PatientMutator", ownerModule: 5, phi: true, denyStub: patientMutatorDenyStub },
  // M22 (Documents) write-side seams (§4.3 / §7.2 W2). `DocumentRenderer` is the render-from-typed-payload
  // handshake M5/M6/M8/M11/M12/M13/M14/M15/M16/M17/M18/M23/M39 consume (returns the new document id its backref
  // path stamps); `DocumentStorageProvider` is the per-tenant object-storage port the renderer + the §1.3
  // Signed-URL Service write rendered bytes / presign downloads through. Both touch patient-bound documents →
  // phi: true; boot-validated and fail-closed until M22 registers the real impls (M22-T04).
  { key: "DocumentRenderer", ownerModule: 22, phi: true, denyStub: documentRendererDenyStub },
  { key: "DocumentStorageProvider", ownerModule: 22, phi: true, denyStub: documentStorageProviderDenyStub },
  // M22 (Documents) §4.3 published READER seams. All READ-only DTO surfaces over M22's `document` / `document_version`
  // / `extraction_*` / `intake_upload_batch` tables, consumed by M28 (FHIR DocumentReference/Provenance), M30/M33
  // (HQRP + reporting measures), M31 (portal) in later waves instead of importing M22's schema. `RenderedDocumentProvider`
  // / `DocumentReader` / `PortalDocumentReader` / `ExtractionProvenanceReader` are patient/document-linked → phi: true;
  // `IntakeMetricsProvider` is an org-level throughput aggregate with no patient linkage → phi: false. Boot-validated
  // and fail-closed until M22 registers the real impls (M22-T05).
  { key: "RenderedDocumentProvider", ownerModule: 22, phi: true, denyStub: renderedDocumentProviderDenyStub },
  { key: "DocumentReader", ownerModule: 22, phi: true, denyStub: documentReaderDenyStub },
  { key: "PortalDocumentReader", ownerModule: 22, phi: true, denyStub: portalDocumentReaderDenyStub },
  { key: "IntakeMetricsProvider", ownerModule: 22, phi: false, denyStub: intakeMetricsProviderDenyStub },
  { key: "ExtractionProvenanceReader", ownerModule: 22, phi: true, denyStub: extractionProvenanceReaderDenyStub },
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
  // M40 (MDM) — the focused §7.7 BAA disclosure gate (as-of time-travel + sending-facility
  // resolution), registered separately from the omnibus above. M22/M28/M29 consult it before any
  // PHI leaves the perimeter. BAA status metadata, not a patient record → not PHI; fail-closed.
  {
    key: "BaaStatusProvider",
    ownerModule: 40,
    phi: false,
    denyStub: baaStatusProviderDenyStub,
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
  // M15 (Discipline Care Plans, Phase 2) seams M17 CONSUMES (§4.4). Boot-validated and FAIL-CLOSED behind their
  // deny-stubs until M15 ships (M17-F06/ADR-0009 — M17 Phase 1 no longer hard-requires Phase-2 M15). The
  // volunteer gate is patient-agnostic staff compliance (phi: false); the supervisory cadence is admission-linked
  // (phi: true). The volunteer deny-stub denies LOUDLY only when a `volunteer_visit` is scheduled before M15 lands.
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
