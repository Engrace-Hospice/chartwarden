// @wardenx/types — Boot-registered SEAM contracts (Phase 0 skeleton).
//
// Per ADR-0005 D1, cross-module consumption via a boot-registered seam needs NO
// dependsOn import edge: the INTERFACE lives here in a leaf package, and the
// IMPLEMENTATION is injected at boot and validated by validateSeams(). This file is
// the leaf-typed home for those interfaces. Phase 1 fills in real method shapes per
// each producer module's published seam contract; Phase 0 ships the minimal shape the
// bootstrap registry needs to compile and self-validate.

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
  | "ConsentEvaluator"; // M39 — disclosure/redaction gate

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

/** Map from seam name → its interface type, so the registry is type-safe. */
export interface SeamContracts {
  CaseloadProvider: CaseloadProvider;
  PatientReader: PatientReader;
  DocumentRenderer: DocumentRenderer;
  ConsentEvaluator: ConsentEvaluator;
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
  | "telehealth_recording";
