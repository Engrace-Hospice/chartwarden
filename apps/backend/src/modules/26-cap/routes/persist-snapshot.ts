// apps/backend/src/modules/26-cap/routes/persist-snapshot.ts — persist one cap projection snapshot, detect the
// band transition against the PRIOR snapshot of the same scope (and patient), raise the cap_threshold_event and
// publish projection_updated / threshold_crossed on the caller's tx. Split out of write-service-drizzle.ts.
import type { AlertBand, Methodology } from "@chartwarden/cap-management";
import { isEscalation } from "@chartwarden/cap-management";
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ProjectionView } from "./read-service";
import type { WriteOutboxPort } from "./write-service";

export type SnapshotTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Tx = SnapshotTx;
export type ProjectionTrigger = "nightly_batch" | "remittance_trigger" | "manual_recompute";

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/** Persist a projection snapshot, evaluate the band transition, and emit projection_updated/threshold_crossed. */
export async function persistSnapshot(
  tx: Tx,
  outbox: WriteOutboxPort,
  organizationId: string,
  capPeriodId: string,
  scope: "agency_aggregate" | "patient_aggregate" | "inpatient",
  patientId: string | null,
  methodology: Methodology,
  m: {
    paidYtdCents: number;
    outstandingBilledCents: number;
    projectedYearEndCents: number;
    capAmountCents: number | null;
    pctOfCap: number;
    alertBand: AlertBand;
    beneficiaryCount?: number;
    inpatientDaysYtd?: number;
    inpatientPctYtd?: number;
    /** The cap year (`FYyyyy`) — carried on threshold_crossed so the alert consumer needs no M26 read. */
    capYear?: string;
    /** The prior snapshot's band when the caller already batch-loaded it (skips the per-snapshot lookup). */
    priorBand?: AlertBand;
  },
  computedBy: ProjectionTrigger = "manual_recompute",
): Promise<ProjectionView> {
  const PS = schema.capProjectionSnapshot;
  const TE = schema.capThresholdEvent;
  // Prior latest band for this scope — and this patient: patient_aggregate has one series per patient, so an
  // unfiltered lookup would compare a patient against some other patient's band (transition detection).
  const prior =
    m.priorBand !== undefined
      ? [{ band: m.priorBand }]
      : await tx
          .select({ band: PS.alertBand })
          .from(PS)
          .where(
            and(
              eq(PS.capPeriodId, capPeriodId),
              eq(PS.scope, scope),
              patientId === null ? isNull(PS.patientId) : eq(PS.patientId, patientId),
            ),
          )
          .orderBy(sql`${PS.computedAt} DESC`)
          .limit(1);
  const priorBand = (prior[0]?.band ??
    (scope === "inpatient" ? "inpatient_safe" : "safe")) as AlertBand;
  const inserted = await tx
    .insert(PS)
    .values({
      organizationId,
      capPeriodId,
      scope,
      patientId,
      methodology,
      paidYtdCents: m.paidYtdCents,
      outstandingBilledCents: m.outstandingBilledCents,
      projectedYearEndCents: m.projectedYearEndCents,
      capAmountCents: m.capAmountCents,
      inpatientDaysYtd: m.inpatientDaysYtd ?? null,
      inpatientPctYtd: m.inpatientPctYtd != null ? String(m.inpatientPctYtd) : null,
      pctOfCap: String(m.pctOfCap),
      alertBand: m.alertBand,
      beneficiaryCount: m.beneficiaryCount ?? null,
      computedBy,
    })
    .returning();
  const snap = inserted[0]!;
  await outbox.publish(tx, {
    eventName: "m26.cap.projection_updated",
    organizationId,
    aggregateKind: "cap_period",
    aggregateId: capPeriodId,
    payload: {
      organizationId,
      capPeriodId,
      scope,
      snapshotId: snap.id,
      band: m.alertBand,
      computedAt: iso(snap.computedAt),
    },
  });
  if (isEscalation(priorBand, m.alertBand)) {
    const ev = await tx
      .insert(TE)
      .values({
        organizationId,
        capPeriodId,
        scope,
        patientId,
        priorBand,
        currentBand: m.alertBand,
        snapshotId: snap.id,
      })
      .onConflictDoNothing()
      .returning({ id: TE.id });
    if (ev[0]) {
      await outbox.publish(tx, {
        eventName: "m26.cap.threshold_crossed",
        organizationId,
        aggregateKind: "cap_period",
        aggregateId: capPeriodId,
        payload: {
          organizationId,
          capPeriodId,
          scope,
          patientId,
          bandFrom: priorBand,
          bandTo: m.alertBand,
          eventId: ev[0].id,
          ...(m.capYear ? { capYear: m.capYear } : {}),
          pctOfCap: m.pctOfCap,
          paidYtdCents: m.paidYtdCents,
          ...(m.capAmountCents !== null ? { capAmountCents: m.capAmountCents } : {}),
        },
      });
    }
  }
  return {
    id: snap.id,
    capPeriodId,
    scope,
    patientId,
    methodology,
    paidYtdCents: snap.paidYtdCents,
    outstandingBilledCents: snap.outstandingBilledCents,
    projectedYearEndCents: snap.projectedYearEndCents,
    capAmountCents: snap.capAmountCents ?? null,
    inpatientDaysYtd: snap.inpatientDaysYtd ?? null,
    inpatientPctYtd: snap.inpatientPctYtd != null ? Number(snap.inpatientPctYtd) : null,
    pctOfCap: Number(snap.pctOfCap),
    alertBand: snap.alertBand,
    beneficiaryCount: snap.beneficiaryCount ?? null,
    computedAt: iso(snap.computedAt),
    computedBy: snap.computedBy,
  };
}
