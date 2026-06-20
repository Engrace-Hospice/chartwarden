// apps/backend/src/modules/05-patient/deceased.ts — the record-death cascade (M5-T11, §7.8, D7).
// Recording a death flips `patient.status='deceased'` + sets `deceased_date`, then emits
// `m5.patient.deceased` in the SAME outbox-published transaction — the fan-out that seeds M16
// bereavement, flips the M23 final-claim eligibility, projects the M28 FHIR `deceasedDateTime`, and
// alerts the M36 IDG channel. The chart becomes read-only except for the M16 bereavement + amendment
// workflows. Pure orchestration over injected ports; the cascade targets mirror the
// `m5.patient.deceased` declaredConsumers (the outbox dispatches; this engine records + emits).

/** The downstream consumers a death fans out to (= m5.patient.deceased declaredConsumers, §4.6). */
export const DECEASED_CASCADE_TARGETS = ["m16", "m23", "m28", "m36"] as const;

/** Ports the cascade binds (Drizzle status write + outbox emit), bound at app boot. */
export interface DeceasedCascadePorts {
  /** Flip status→deceased + set deceased_date (and lock the chart read-only) in one transaction. */
  markDeceased(organizationId: string, patientId: string, deceasedDate: string): Promise<void>;
  /** Emit `m5.patient.deceased` (outbox; fans out to {@link DECEASED_CASCADE_TARGETS}). */
  emitDeceased(organizationId: string, patientId: string, deceasedDate: string): Promise<void>;
}

/** What recordDeath reported. */
export interface RecordDeathResult {
  readonly patientId: string;
  readonly status: "deceased";
  readonly deceasedDate: string;
  /** The cascade consumers the emitted event fans out to (§7.8). */
  readonly cascadeTargets: readonly string[];
}

/** Error thrown when a death is recorded with a future `deceased_date` (the patient CHECK mirror). */
export class InvalidDeceasedDateError extends Error {
  constructor(readonly deceasedDate: string) {
    super(`deceased_date '${deceasedDate}' is in the future`);
    this.name = "InvalidDeceasedDateError";
  }
}

/**
 * Record a patient's death (§7.8): validate the date isn't future (relative to the injected `today`),
 * flip status→deceased + set deceased_date, then emit `m5.patient.deceased` so the cascade fans out.
 * Pure over ports; deterministic (the clock is injected). The route gates this on `patient.record_death`
 * + step-up (M5-T09); this engine owns the state transition + cascade emission.
 */
export async function recordDeath(
  input: { organizationId: string; patientId: string; deceasedDate: string; today: string },
  ports: DeceasedCascadePorts,
): Promise<RecordDeathResult> {
  if (input.deceasedDate > input.today) throw new InvalidDeceasedDateError(input.deceasedDate);
  await ports.markDeceased(input.organizationId, input.patientId, input.deceasedDate);
  await ports.emitDeceased(input.organizationId, input.patientId, input.deceasedDate);
  return {
    patientId: input.patientId,
    status: "deceased",
    deceasedDate: input.deceasedDate,
    cascadeTargets: [...DECEASED_CASCADE_TARGETS],
  };
}
