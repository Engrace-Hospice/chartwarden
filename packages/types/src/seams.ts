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
  | "BaaStatusProvider"; // M40 — focused §7.7 BAA disclosure gate (as-of; M22/M28/M29 import this)

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
  | "mdm_tenant_overlays";
