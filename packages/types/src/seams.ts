// @wardenx/types — Boot-registered SEAM contracts (Phase 0 skeleton).
//
// Per ADR-0005 D1, cross-module consumption via a boot-registered seam needs NO
// dependsOn import edge: the INTERFACE lives here in a leaf package, and the
// IMPLEMENTATION is injected at boot and validated by validateSeams(). This file is
// the leaf-typed home for those interfaces. Phase 1 fills in real method shapes per
// each producer module's published seam contract; Phase 0 ships the minimal shape the
// bootstrap registry needs to compile and self-validate.
import type { StepUpFactor } from "./policy/step-up-policy";

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
  | "PatientReader" // M5 — patient identity/demographics reads
  | "DocumentRenderer" // M22 — render a typed payload to a stored document
  | "ConsentEvaluator" // M39 — disclosure/redaction gate
  | "SessionContextResolver" // M2 — authenticated, org-scoped request context (actor + step-up state)
  | "AuditorSessionMinter"; // M2 — mint a time-boxed auditor magic-link session (M3 calls it)

/** M5/M17 — resolves an actor's caseload (the patient ids they may access). */
export interface CaseloadProvider {
  patientsForActor(scope: OrgScope, membershipId: string): Promise<readonly string[]>;
}

/** M5 — minimal patient identity reader other modules consume by seam. */
export interface PatientReader {
  exists(scope: OrgScope, patientId: string): Promise<boolean>;
}

/** M22 — render a typed payload to a stored document (forward-seam for M39 etc.). */
export interface DocumentRenderer {
  render(scope: OrgScope, templateKey: string, payload: unknown): Promise<{ documentId: string }>;
}

/** M39 — consent/redaction gate consulted on egress. */
export interface ConsentEvaluator {
  evaluateForDisclosure(scope: OrgScope, patientId: string, recipientId: string): Promise<boolean>;
}

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
  DocumentRenderer: DocumentRenderer;
  ConsentEvaluator: ConsentEvaluator;
  SessionContextResolver: SessionContextResolver;
  AuditorSessionMinter: AuditorSessionMinter;
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
  | "identity";
