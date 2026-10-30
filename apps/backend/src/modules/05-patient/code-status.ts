// apps/backend/src/modules/05-patient/code-status.ts — the M5 patient code-status port (ADR-0104): the shapes, the
// typed precondition errors the routes map to HTTP, and the port the Drizzle impl (code-status-db.ts) satisfies.
import type { PatientCodeStatus } from "@chartwarden/types";

export interface CodeStatusView {
  readonly id: string;
  readonly patientId: string;
  readonly codeStatus: PatientCodeStatus;
  readonly reason: string;
  readonly sourceDocumentId: string | null;
  readonly recordedByMembershipId: string;
  readonly recordedAt: string;
  /** Set when a clinician retracted the entry; such a row is history only, never "current". */
  readonly enteredInErrorAt: string | null;
}

/** `current` = the newest entry that is not entered-in-error; `null` = nothing recorded (NOT Full Code). */
export interface CodeStatusList {
  readonly current: CodeStatusView | null;
  readonly history: readonly CodeStatusView[];
}

export interface SetCodeStatusInput {
  readonly codeStatus: PatientCodeStatus;
  readonly reason: string;
  readonly sourceDocumentId?: string;
}

export interface CodeStatusActor {
  readonly userId: string;
  readonly membershipId: string;
}

export interface PatientCodeStatusPort {
  /** `null` = no such patient in the org. */
  list(organizationId: string, patientId: string): Promise<CodeStatusList | null>;
  set(
    organizationId: string,
    patientId: string,
    input: SetCodeStatusInput,
    actor: CodeStatusActor,
  ): Promise<CodeStatusView>;
  enterInError(
    organizationId: string,
    patientId: string,
    entryId: string,
    input: { readonly reason: string },
    actor: CodeStatusActor,
  ): Promise<CodeStatusView>;
}

export class CodeStatusPatientNotFoundError extends Error {
  constructor() {
    super("patient not found");
    this.name = "CodeStatusPatientNotFoundError";
  }
}
export class CodeStatusEntryNotFoundError extends Error {
  constructor() {
    super("code status entry not found");
    this.name = "CodeStatusEntryNotFoundError";
  }
}
export class CodeStatusAlreadyEnteredInErrorError extends Error {
  constructor() {
    super("code status entry is already marked entered-in-error");
    this.name = "CodeStatusAlreadyEnteredInErrorError";
  }
}
export class CodeStatusSourceDocumentInvalidError extends Error {
  constructor() {
    super("source document must be this patient's code-status directive");
    this.name = "CodeStatusSourceDocumentInvalidError";
  }
}
