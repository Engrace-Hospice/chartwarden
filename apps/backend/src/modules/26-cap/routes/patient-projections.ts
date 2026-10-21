// apps/backend/src/modules/26-cap/routes/patient-projections.ts — the per-patient (`patient_aggregate`)
// projection pass of a cap recompute (GAP-037). Pure math lives in `projectPatient`; `persistPatientProjections`
// batch-loads each patient's prior band and writes one snapshot per accrual row through `persistSnapshot`, so a
// band escalation raises the same cap_threshold_event + m26.cap.threshold_crossed as the agency/inpatient scopes.
import {
  type AlertBand,
  type Methodology,
  capYearWindow,
  computeAggregateProjection,
  perBeneficiaryAllocatedCap,
} from "@chartwarden/cap-management";
import { schema } from "@chartwarden/db";
import { and, eq, sql } from "drizzle-orm";
import { type ProjectionTrigger, type SnapshotTx, persistSnapshot } from "./persist-snapshot";
import type { WriteOutboxPort } from "./write-service";

/** One `cap_beneficiary_accrual` row, as the projection reads it. */
export interface PatientAccrualRow {
  readonly patientId: string;
  readonly paidCents: number;
  readonly outstandingBilledCents: number;
  /** numeric(7,6) as the driver returns it (string). */
  readonly methodologyWeight: string;
  /** `yyyy-mm-dd` — set by the m5.patient.deceased consumer (freeze-at-death). */
  readonly deceasedAt: string | null;
}

export interface PatientProjectionInput {
  readonly capYear: string;
  readonly perBeneficiaryCapCents: number;
  readonly methodology: Methodology;
  /** `yyyy-mm-dd` extrapolation reference. */
  readonly asOf: string;
}

/**
 * One patient's projection. The cap denominator is the methodology-allocated per-beneficiary cap (weight
 * applies under proportional only). A patient who died on or before `asOf` is frozen: there are no further
 * days to extrapolate, so the year is treated as fully elapsed and the projection equals the paid-to-date.
 */
export function projectPatient(row: PatientAccrualRow, input: PatientProjectionInput) {
  const frozen = row.deceasedAt !== null && row.deceasedAt <= input.asOf;
  return computeAggregateProjection({
    paidYtdCents: row.paidCents,
    outstandingBilledCents: row.outstandingBilledCents,
    capAmountCents: perBeneficiaryAllocatedCap(
      input.perBeneficiaryCapCents,
      input.methodology,
      Number(row.methodologyWeight),
    ),
    capYear: input.capYear,
    asOf: frozen ? capYearWindow(input.capYear).endsOn : input.asOf,
    methodology: input.methodology,
  });
}

/** The latest persisted band per patient for the period (one DISTINCT ON read, not one query per patient). */
async function loadPriorBands(
  tx: SnapshotTx,
  periodId: string,
): Promise<ReadonlyMap<string, AlertBand>> {
  const PS = schema.capProjectionSnapshot;
  const rows = await tx
    .selectDistinctOn([PS.patientId], { patientId: PS.patientId, band: PS.alertBand })
    .from(PS)
    .where(and(eq(PS.capPeriodId, periodId), eq(PS.scope, "patient_aggregate")))
    .orderBy(PS.patientId, sql`${PS.computedAt} DESC`);
  return new Map(rows.flatMap((r) => (r.patientId ? [[r.patientId, r.band as AlertBand]] : [])));
}

export interface PersistPatientProjectionsArgs extends PatientProjectionInput {
  readonly tx: SnapshotTx;
  readonly outbox: WriteOutboxPort;
  readonly organizationId: string;
  readonly periodId: string;
  readonly accruals: readonly PatientAccrualRow[];
  readonly trigger: ProjectionTrigger;
}

/** Write one patient_aggregate snapshot per accrual row; returns how many were written. */
export async function persistPatientProjections(
  args: PersistPatientProjectionsArgs,
): Promise<number> {
  const { tx, outbox, organizationId, periodId, accruals, trigger, ...input } = args;
  if (accruals.length === 0) return 0;
  const priorBands = await loadPriorBands(tx, periodId);
  for (const row of accruals) {
    const proj = projectPatient(row, input);
    await persistSnapshot(
      tx,
      outbox,
      organizationId,
      periodId,
      "patient_aggregate",
      row.patientId,
      input.methodology,
      {
        paidYtdCents: proj.paidYtdCents,
        outstandingBilledCents: proj.outstandingBilledCents,
        projectedYearEndCents: proj.projectedYearEndCents,
        capAmountCents: proj.capAmountCents,
        pctOfCap: proj.pctOfCap,
        alertBand: proj.alertBand,
        capYear: input.capYear,
        priorBand: priorBands.get(row.patientId) ?? "safe",
      },
      trigger,
    );
  }
  return accruals.length;
}
