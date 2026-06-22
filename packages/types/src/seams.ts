// @wardenx/types — Boot-registered SEAM contracts (Phase 0 skeleton).
//
// Per ADR-0005 D1, cross-module consumption via a boot-registered seam needs NO
// dependsOn import edge: the INTERFACE lives here in a leaf package, and the
// IMPLEMENTATION is injected at boot and validated by validateSeams(). This file is
// the leaf-typed home for those interfaces. Phase 1 fills in real method shapes per
// each producer module's published seam contract; Phase 0 ships the minimal shape the
// bootstrap registry needs to compile and self-validate.
import type { StepUpFactor } from "./policy/step-up-policy";
import type { PatientMutator, PatientReader } from "./patient";
import type {
  AdmissionCensusReader,
  AdmissionStatusReader,
  CertificationReader,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCareReader,
} from "./admission";
import type { CarePlanReader } from "./care-plan";
import type {
  BillableEncounterReader,
  EncounterCreator,
  EvvBracketResolver,
  MileagePayrollReader,
  SignedEncountersReader,
} from "./encounter";

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
  | "PatientMutator" // M5 — apply an M29-proposal/amendment field diff (§4.9; D12 strip)
  | "DocumentRenderer" // M22 — render a typed payload to a stored document
  | "ConsentEvaluator" // M39 — disclosure/redaction gate
  | "SessionContextResolver" // M2 — authenticated, org-scoped request context (actor + step-up state)
  | "AuditorSessionMinter" // M2 — mint a time-boxed auditor magic-link session (M3 calls it)
  | "TerminologyProvider" // M38 — version-aware code/value-set resolution (every clinical/billing module)
  | "AlertEmitter" // M36 — emit an event; M36 resolves rules + recipients + fan-out (every module)
  | "MessagingProvider" // M36 — channel/message surface (DEK-encrypted bodies; PHI read surface)
  | "MdmEntityProvider" // M40 — master-data read surface (physician/facility/payer; merge-aware)
  | "BaaStatusProvider" // M40 — focused §7.7 BAA disclosure gate (as-of; M22/M28/M29 import this)
  // M6 (Admission, Election & Certification) reader seams (§4.7) — leaf-typed read-only DTO surfaces
  // every downstream clinical/billing module consumes instead of importing M6's schema. Interfaces
  // live in ./admission (this leaf), so — unlike the opaque rich-seams above — they are typed here.
  | "ElectionPeriodReader" // M6 — M23 binds a NOE/NOTR claim to the correct benefit period/sequence
  | "CertificationReader" // M6 — recert gating: the active CTI for a period + whether it is signed
  | "FaceToFaceReader" // M6 — recert gating: the attested F2F for a period + whether one exists
  | "LevelOfCareReader" // M6 — current LOC + LOC-days by level over a range (M26 aggregate cap)
  | "AdmissionStatusReader" // M6 — admission state projection (M14 queues, M30 dashboard)
  | "AdmissionCensusReader" // M6 — active-admission census/list (M30 dashboards, M22 form prep)
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
  | "EvvBracketResolver"; // M18 — authoritative EVV bracket for an encounter's visit at finalize (D9)

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

/** Map from seam name → its interface type, so the registry is type-safe. */
export interface SeamContracts {
  CaseloadProvider: CaseloadProvider;
  PatientReader: PatientReader;
  PatientMutator: PatientMutator;
  DocumentRenderer: DocumentRenderer;
  // M39's `ConsentEvaluator` is OPAQUE (`unknown`) here — the rich §4.3 interface lives in
  // @wardenx/consent (rich-seam pattern, see the note above the interface block). Consumers that
  // list `39` in `dependsOn` import the real type from @wardenx/consent and resolve via the
  // module-39 typed accessor; the M1 registry holds/validates the instance fail-closed.
  ConsentEvaluator: unknown;
  SessionContextResolver: SessionContextResolver;
  AuditorSessionMinter: AuditorSessionMinter;
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
  | "encounter_record";
