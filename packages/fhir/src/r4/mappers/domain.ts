// @wardenx/fhir — domain-input shapes for the synchronous single-entity mappers (M28-T04).
//
// The DiagnosticReport is a multi-source read-time PROJECTION (§4.11); the other Phase-1 read resources
// are single-entity MAPPINGS — the reader seam loads ONE owner-module row, the mapper shapes it. These
// are the MINIMAL row contracts each mapper consumes, kept LOCAL to `packages/fhir` (the T03/T04 idiom)
// until T06 binds the real readers. `PatientRow` (the Patient subject) is reused from `./deps`.

/** M6 / M8 encounter row → us-core-encounter. */
export interface EncounterDomain {
  readonly id: string;
  readonly patientId: string;
  readonly status: "planned" | "in-progress" | "onleave" | "finished" | "cancelled";
  /** The v3-ActCode class (e.g. `HH` home health, `AMB` ambulatory). */
  readonly classCode: string;
  readonly classDisplay?: string;
  readonly typeCode?: string;
  readonly typeSystem?: string;
  readonly typeText?: string;
  readonly practitionerMdmId?: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
}

/** M6 diagnosis row → us-core-condition. */
export interface ConditionDomain {
  readonly id: string;
  readonly patientId: string;
  readonly icd10Code?: string | null;
  readonly icd10Text?: string | null;
  readonly snomedCode?: string | null;
  readonly clinicalStatus:
    | "active"
    | "recurrence"
    | "relapse"
    | "inactive"
    | "remission"
    | "resolved";
  readonly verificationStatus?:
    | "unconfirmed"
    | "provisional"
    | "differential"
    | "confirmed"
    | "refuted"
    | "entered-in-error";
  readonly categoryCode?: "problem-list-item" | "encounter-diagnosis" | "health-concern";
  readonly onsetDateTime?: string | null;
  readonly recordedDate?: string | null;
}

/** M7 goal row → us-core-goal. */
export interface GoalDomain {
  readonly id: string;
  readonly patientId: string;
  readonly lifecycleStatus:
    | "proposed"
    | "planned"
    | "accepted"
    | "active"
    | "on-hold"
    | "completed"
    | "cancelled"
    | "entered-in-error"
    | "rejected";
  readonly description: string;
  readonly achievementStatus?:
    | "in-progress"
    | "improving"
    | "worsening"
    | "no-change"
    | "achieved"
    | "sustaining"
    | "not-achieved"
    | "no-progress"
    | "not-attainable";
  readonly targetDueDate?: string | null;
}

/** M7 care-plan row → us-core-careplan. */
export interface CarePlanDomain {
  readonly id: string;
  readonly patientId: string;
  readonly status:
    | "draft"
    | "active"
    | "on-hold"
    | "revoked"
    | "completed"
    | "entered-in-error"
    | "unknown";
  readonly intent: "proposal" | "plan" | "order" | "option";
  readonly title?: string | null;
  readonly description?: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly goalIds?: ReadonlyArray<string>;
  readonly addressesConditionIds?: ReadonlyArray<string>;
}

/** M12 medication-order row → us-core-medicationrequest. */
export interface MedicationRequestDomain {
  readonly id: string;
  readonly patientId: string;
  readonly status:
    | "active"
    | "on-hold"
    | "cancelled"
    | "completed"
    | "entered-in-error"
    | "stopped"
    | "draft"
    | "unknown";
  readonly intent: "proposal" | "plan" | "order" | "original-order";
  readonly rxnormCode?: string | null;
  readonly rxnormText?: string | null;
  readonly medicationText?: string | null;
  readonly authoredOn?: string | null;
  readonly requesterMdmId?: string | null;
  readonly dosageText?: string | null;
  readonly routeCode?: string | null;
  readonly routeText?: string | null;
}

/** M12 medication-history row → MedicationStatement. */
export interface MedicationStatementDomain {
  readonly id: string;
  readonly patientId: string;
  readonly status:
    | "active"
    | "completed"
    | "entered-in-error"
    | "intended"
    | "stopped"
    | "on-hold"
    | "unknown"
    | "not-taken";
  readonly rxnormCode?: string | null;
  readonly rxnormText?: string | null;
  readonly medicationText?: string | null;
  readonly effectiveStart?: string | null;
  readonly effectiveEnd?: string | null;
  readonly dateAsserted?: string | null;
  readonly dosageText?: string | null;
}
