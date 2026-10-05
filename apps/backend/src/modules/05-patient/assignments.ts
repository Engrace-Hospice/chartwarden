// apps/backend/src/modules/05-patient/assignments.ts — the M5 §4.3 care-team assignment contract
// (GAP-015): the view, the inputs, the typed precondition errors, and the port the routes call.
// `assignments-db.ts` is the one Drizzle implementation; route tests inject an in-memory one.
//
// `patient_assignment` is M5's durable caseload source: an OPEN row (`unassigned_at IS NULL`) is what the
// CaseloadProvider (`caseload_membership` / `caseload_or_scope`) and the CareTeamProvider read.

/** One `patient_assignment` row as the routes serialize it. The clinician NAME is resolved client-side (M2). */
export interface AssignmentView {
  readonly id: string;
  readonly patientId: string;
  readonly clinicianUserId: string;
  readonly role: string;
  readonly assignedAt: string; // YYYY-MM-DD
  readonly unassignedAt: string | null; // YYYY-MM-DD; null = open
  readonly reason: string | null;
  readonly current: boolean; // unassignedAt IS NULL
}

export interface AssignClinicianInput {
  readonly clinicianUserId: string;
  readonly role: string;
  /** Defaults to today when omitted. */
  readonly assignedAt?: string;
  readonly reason?: string;
}

export interface EndAssignmentInput {
  /** Defaults to today when omitted. Must not precede the assignment's `assignedAt`. */
  readonly unassignedAt?: string;
}

export class AssignmentPatientNotFoundError extends Error {
  constructor(readonly patientId: string) {
    super(`patient '${patientId}' not found`);
    this.name = "AssignmentPatientNotFoundError";
  }
}

export class AssignmentNotFoundError extends Error {
  constructor(readonly assignmentId: string) {
    super(`assignment '${assignmentId}' not found`);
    this.name = "AssignmentNotFoundError";
  }
}

/** The clinician is not an active member of the acting organization. */
export class ClinicianNotInOrgError extends Error {
  constructor(readonly clinicianUserId: string) {
    super(`clinician '${clinicianUserId}' is not an active member of this organization`);
    this.name = "ClinicianNotInOrgError";
  }
}

/** An open row already exists for this (patient, clinician, role). */
export class AssignmentAlreadyOpenError extends Error {
  constructor(
    readonly clinicianUserId: string,
    readonly role: string,
  ) {
    super(
      `clinician '${clinicianUserId}' already has an open '${role}' assignment on this patient`,
    );
    this.name = "AssignmentAlreadyOpenError";
  }
}

/** Spec §4.3: at most one open `primary_rn` per patient. */
export class PrimaryRnAlreadyAssignedError extends Error {
  constructor(readonly patientId: string) {
    super(`patient '${patientId}' already has an open primary_rn assignment`);
    this.name = "PrimaryRnAlreadyAssignedError";
  }
}

export class AssignmentAlreadyEndedError extends Error {
  constructor(readonly assignmentId: string) {
    super(`assignment '${assignmentId}' is already ended`);
    this.name = "AssignmentAlreadyEndedError";
  }
}

export class AssignmentEndBeforeStartError extends Error {
  constructor(
    readonly assignedAt: string,
    readonly unassignedAt: string,
  ) {
    super(`unassignedAt ${unassignedAt} precedes assignedAt ${assignedAt}`);
    this.name = "AssignmentEndBeforeStartError";
  }
}

export interface PatientAssignmentsPort {
  /** Every assignment (open first, then newest), or null when the patient is absent / out of org. */
  list(organizationId: string, patientId: string): Promise<readonly AssignmentView[] | null>;
  assign(
    organizationId: string,
    patientId: string,
    input: AssignClinicianInput,
    actorUserId: string,
  ): Promise<AssignmentView>;
  end(
    organizationId: string,
    patientId: string,
    assignmentId: string,
    input: EndAssignmentInput,
    actorUserId: string,
  ): Promise<AssignmentView>;
}
