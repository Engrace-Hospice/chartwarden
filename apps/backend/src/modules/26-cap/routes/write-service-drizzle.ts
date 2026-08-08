// apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts — the Drizzle-backed M26 WRITE service.
// Each command runs under withOrgContext (RLS), validates the §2.2 cap-period transition via the pure state
// machine (@wardenx/cap-management lifecycle), stamps the acting user, and emits the §4.10 outbox event on
// the caller's tx (transactional outbox). A bad transition → INVALID_TRANSITION (409); a missing row →
// NOT_FOUND. Projection/settlement math is the pure domain — this layer only reads accruals, persists
// snapshots, and emits. Money is BIGINT cents; no MBI/PHI enters an outbox payload (D13).
import { createHash } from "node:crypto";
import {
  type AlertBand,
  type Methodology,
  agencyAllocatedCap,
  assertTransition,
  capYearWindow,
  computeAggregateProjection,
  computeInpatientProjection,
  computeSettlement,
  isEscalation,
  settlementDirection,
  statusOnFirstAccrual,
} from "@wardenx/cap-management";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import type { M26WriteActor } from "./actor";
import type { PeriodView, ProjectionView, SettlementView } from "./read-service";
import type {
  AcknowledgeInput,
  AmendConstantInput,
  FinalizeInput,
  ImportPsrInput,
  LockMethodologyInput,
  M26WriteService,
  OpenPeriodInput,
  PublishConstantInput,
  ReopenInput,
  ResolveVarianceInput,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

class ConflictError extends WardenXError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);
const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export function buildDrizzleM26WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
): M26WriteService {
  const P = schema.capPeriod;
  const ML = schema.capPeriodMethodologyLock;
  const BA = schema.capBeneficiaryAccrual;
  const IA = schema.capInpatientAccrual;
  const PS = schema.capProjectionSnapshot;
  const TE = schema.capThresholdEvent;
  const PI = schema.capPsrImport;
  const PR = schema.capPsrReconciliation;
  const ST = schema.capSettlement;
  const PC = schema.capPeriodPlatformConstant;

  async function loadPeriod(tx: Tx, periodId: string) {
    const rows = await tx.select().from(P).where(eq(P.id, periodId)).limit(1);
    if (!rows[0]) throw new NotFoundError("cap period not found");
    return rows[0];
  }

  function toPeriodView(r: typeof P.$inferSelect, lockedAt: Date | string | null): PeriodView {
    return {
      id: r.id,
      capYear: r.capYear,
      ccn: r.ccn,
      startDate: iso(r.startsOn).slice(0, 10),
      endDate: iso(r.endsOn).slice(0, 10),
      status: r.status,
      methodology: r.methodology ?? null,
      methodologyLockedAt: lockedAt ? iso(lockedAt) : null,
      graceWindowDays: r.graceWindowDays,
      aggregateCapAmountCents: r.aggregateCapAmountCents,
      inpatientCapPct: Number(r.inpatientCapPct),
      openedAt: iso(r.openedAt),
    };
  }

  return {
    async openPeriod(actor, input: OpenPeriodInput) {
      return withOrgContext(db, actor, async (tx) => {
        // Snapshot the platform constant for the cap year (must be published, D3).
        const pc = await tx.select().from(PC).where(eq(PC.capYear, input.capYear)).limit(1);
        const constant = pc[0];
        if (!constant)
          throw new ConflictError(
            "CAP_CONSTANT_UNPUBLISHED",
            `no platform cap constant for ${input.capYear}`,
          );
        if (constant.aggregateCapAmountCents == null)
          throw new ConflictError(
            "CAP_AMOUNT_UNPUBLISHED",
            `the ${input.capYear} per-beneficiary cap amount is not yet published`,
          );
        const window = capYearWindow(input.capYear);
        // CCN is resolved from M40 canonicalCcnForOrg when bound; default sentinel until then (§4.4 fallback).
        const ccn = "000000";
        const inserted = await tx
          .insert(P)
          .values({
            organizationId: actor.organizationId,
            ccn,
            capYear: input.capYear,
            startsOn: window.startsOn,
            endsOn: window.endsOn,
            aggregateCapAmountCents: constant.aggregateCapAmountCents,
            inpatientCapPct: constant.inpatientCapPct,
            methodology: input.methodology ?? null,
            status: "open",
            openedBy: actor.userId,
            graceWindowDays: input.graceWindowDays ?? 30,
          })
          .returning();
        const period = inserted[0]!;
        // Create the dedicated LIST partition leaf per high-volume table (archival-ready; §3.2).
        for (const fn of [
          "create_cap_beneficiary_accrual_line_partition",
          "create_cap_inpatient_day_line_partition",
          "create_cap_projection_snapshot_partition",
        ]) {
          await tx.execute(sql.raw(`SELECT ${fn}('${period.id}'::uuid)`));
        }
        await outbox.publish(tx, {
          eventName: "m26.cap.year_opened",
          organizationId: actor.organizationId,
          aggregateKind: "cap_period",
          aggregateId: period.id,
          payload: {
            organizationId: actor.organizationId,
            capPeriodId: period.id,
            capYear: period.capYear,
            methodologyHint: period.methodology ?? null,
          },
        });
        return toPeriodView(period, null);
      });
    },

    async lockMethodology(actor, periodId, input: LockMethodologyInput) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        if (period.methodology)
          throw new ConflictError(
            "METHODOLOGY_LOCKED",
            "methodology is already set for this period",
          );
        await tx.insert(ML).values({
          capPeriodId: periodId,
          organizationId: actor.organizationId,
          methodology: input.methodology,
          lockedBy: actor.userId,
          reason: input.reason,
          stepUpSessionId: actor.userId, // bound to the step-up assertion at the route layer (D12)
        });
        const updated = await tx
          .update(P)
          .set({ methodology: input.methodology })
          .where(eq(P.id, periodId))
          .returning();
        return toPeriodView(updated[0]!, new Date());
      });
    },

    async closePeriod(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        assertTransition(period.status, "in_settlement");
        const updated = await tx
          .update(P)
          .set({ status: "in_settlement", closedAt: new Date(), closedBy: actor.userId })
          .where(eq(P.id, periodId))
          .returning();
        await outbox.publish(tx, {
          eventName: "m26.cap.year_closing",
          organizationId: actor.organizationId,
          aggregateKind: "cap_period",
          aggregateId: periodId,
          payload: {
            organizationId: actor.organizationId,
            capPeriodId: periodId,
            capYear: period.capYear,
            transitionsToSettlement: true,
          },
        });
        return toPeriodView(updated[0]!, null);
      });
    },

    async reopenPeriod(actor, periodId, _input: ReopenInput) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        assertTransition(period.status, "reopened");
        const updated = await tx
          .update(P)
          .set({ status: "reopened" })
          .where(eq(P.id, periodId))
          .returning();
        // Roll a finalized settlement back to reviewed for re-proposal (§4.5 step 5).
        await tx
          .update(ST)
          .set({ status: "reviewed", finalizedAt: null, finalizedBy: null })
          .where(and(eq(ST.capPeriodId, periodId), eq(ST.status, "final")));
        return toPeriodView(updated[0]!, null);
      });
    },

    async recompute(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        const methodology: Methodology = (period.methodology as Methodology) ?? "streamlined";
        const perBenCap = period.aggregateCapAmountCents;
        const asOf = today();
        const results: ProjectionView[] = [];

        // ── Agency aggregate ──
        const accr = await tx
          .select({
            paid: BA.paidCents,
            outstanding: BA.outstandingBilledCents,
            weight: BA.methodologyWeight,
          })
          .from(BA)
          .where(eq(BA.capPeriodId, periodId));
        const paidYtd = accr.reduce((s, a) => s + a.paid, 0);
        const outstanding = accr.reduce((s, a) => s + a.outstanding, 0);
        const weights = accr.map((a) => Number(a.weight));
        const { capCents } = agencyAllocatedCap(
          perBenCap,
          methodology,
          weights.length ? weights : [],
        );
        const agencyProj = computeAggregateProjection({
          paidYtdCents: paidYtd,
          outstandingBilledCents: outstanding,
          capAmountCents: capCents,
          capYear: period.capYear,
          asOf,
          methodology,
        });
        results.push(
          await persistSnapshot(
            tx,
            outbox,
            actor.organizationId,
            periodId,
            "agency_aggregate",
            null,
            methodology,
            {
              paidYtdCents: agencyProj.paidYtdCents,
              outstandingBilledCents: agencyProj.outstandingBilledCents,
              projectedYearEndCents: agencyProj.projectedYearEndCents,
              capAmountCents: agencyProj.capAmountCents,
              pctOfCap: agencyProj.pctOfCap,
              alertBand: agencyProj.alertBand,
              beneficiaryCount: weights.length,
            },
          ),
        );

        // ── Inpatient ──
        const ia = await tx.select().from(IA).where(eq(IA.capPeriodId, periodId)).limit(1);
        if (ia[0]) {
          const inp = computeInpatientProjection({
            gipDays: ia[0].gipDays,
            ircDays: ia[0].ircDays,
            totalPatientDays: ia[0].totalPatientDays,
            capYear: period.capYear,
            asOf,
          });
          results.push(
            await persistSnapshot(
              tx,
              outbox,
              actor.organizationId,
              periodId,
              "inpatient",
              null,
              methodology,
              {
                paidYtdCents: 0,
                outstandingBilledCents: 0,
                projectedYearEndCents: 0,
                capAmountCents: null,
                pctOfCap: inp.inpatientPctProjected,
                alertBand: inp.alertBand,
                inpatientDaysYtd: inp.inpatientDaysYtd,
                inpatientPctYtd: inp.inpatientPctYtd,
              },
            ),
          );
        }

        // Promote open → active on first projection with accruals.
        if (period.status === "open" && paidYtd > 0) {
          await tx
            .update(P)
            .set({ status: statusOnFirstAccrual("open") })
            .where(eq(P.id, periodId));
        }
        return results;
      });
    },

    async acknowledgeEvent(actor, eventId, input: AcknowledgeInput) {
      await withOrgContext(db, actor, async (tx) => {
        const updated = await tx
          .update(TE)
          .set({
            acknowledgedBy: actor.userId,
            acknowledgedAt: new Date(),
            notes: input.notes ?? null,
          })
          .where(eq(TE.id, eventId))
          .returning({ id: TE.id });
        if (!updated[0]) throw new NotFoundError("threshold event not found");
      });
    },

    async importPsr(actor, periodId, input: ImportPsrInput) {
      return withOrgContext(db, actor, async (tx) => {
        await loadPeriod(tx, periodId);
        const bytes = Buffer.from(input.fileBase64, "base64");
        const sha = createHash("sha256").update(bytes).digest("hex");
        // Dedup by file hash (§2.6): a re-upload returns the prior import.
        const existing = await tx
          .select({ id: PI.id })
          .from(PI)
          .where(and(eq(PI.capPeriodId, periodId), eq(PI.fileSha256, sha)))
          .limit(1);
        if (existing[0]) return { importId: existing[0].id };
        const inserted = await tx
          .insert(PI)
          .values({
            organizationId: actor.organizationId,
            capPeriodId: periodId,
            macRegion: input.macRegion as (typeof PI.macRegion.enumValues)[number],
            psrPeriodFrom: input.psrPeriodFrom,
            psrPeriodTo: input.psrPeriodTo,
            // The raw CSV is stored DEK-encrypted via MinIO when the storage seam binds (§3.3); the key is
            // deterministic on the import id until then.
            fileStorageKey: `psr/${actor.organizationId}/${sha}.csv`,
            fileSha256: sha,
            importedBy: actor.userId,
            parseStatus: "queued",
          })
          .returning({ id: PI.id });
        return { importId: inserted[0]!.id };
      });
    },

    async resolveVariance(actor, lineId, input: ResolveVarianceInput) {
      await withOrgContext(db, actor, async (tx) => {
        const updated = await tx
          .update(PR)
          .set({
            status: "resolved",
            varianceReason: input.varianceReason as (typeof PR.varianceReason.enumValues)[number],
            resolutionNotes: input.resolutionNotes,
            resolvedBy: actor.userId,
            resolvedAt: new Date(),
          })
          .where(eq(PR.id, lineId))
          .returning({ id: PR.id });
        if (!updated[0]) throw new NotFoundError("reconciliation line not found");
      });
    },

    async proposeSettlement(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        if (period.status !== "in_settlement")
          throw new ConflictError(
            "PERIOD_NOT_IN_SETTLEMENT",
            "the cap period is not in settlement",
          );
        if (!period.methodology)
          throw new ConflictError(
            "METHODOLOGY_UNSET",
            "lock a methodology before proposing a settlement",
          );
        const accr = await tx
          .select({ paid: BA.paidCents, weight: BA.methodologyWeight })
          .from(BA)
          .where(eq(BA.capPeriodId, periodId));
        const ia = await tx.select().from(IA).where(eq(IA.capPeriodId, periodId)).limit(1);
        const result = computeSettlement({
          perBeneficiaryCapCents: period.aggregateCapAmountCents,
          methodology: period.methodology as Methodology,
          beneficiaryWeights: accr.map((a) => Number(a.weight)),
          paidTotalCents: accr.reduce((s, a) => s + a.paid, 0),
          inpatientDays: ia[0] ? ia[0].gipDays + ia[0].ircDays : 0,
          totalPatientDays: ia[0]?.totalPatientDays ?? 0,
          inpatientCapPct: Number(period.inpatientCapPct),
        });
        const values = {
          organizationId: actor.organizationId,
          capPeriodId: periodId,
          paidTotalCents: accr.reduce((s, a) => s + a.paid, 0),
          beneficiaryCount: result.beneficiaryCount,
          aggregateCapAmountCents: result.aggregateCapAmountCents,
          aggregateOverageCents: result.aggregateOverageCents,
          inpatientTotalDays: result.inpatientTotalDays,
          inpatientOverageDays: result.inpatientOverageDays,
          inpatientOverageCents: result.inpatientOverageCents,
          status: "proposed" as const,
          proposedBy: actor.userId,
        };
        const upserted = await tx
          .insert(ST)
          .values(values)
          .onConflictDoUpdate({
            target: ST.capPeriodId,
            set: { ...values, proposedAt: new Date() },
          })
          .returning();
        const row = upserted[0]!;
        await outbox.publish(tx, {
          eventName: "m26.cap.settlement_proposed",
          organizationId: actor.organizationId,
          aggregateKind: "cap_period",
          aggregateId: periodId,
          payload: {
            organizationId: actor.organizationId,
            capPeriodId: periodId,
            settlementId: row.id,
            direction: result.direction,
            varianceAmountCents: result.aggregateOverageCents,
          },
        });
        return toSettlementView(row, result.direction);
      });
    },

    async finalizeSettlement(actor, periodId, _input: FinalizeInput) {
      return withOrgContext(db, actor, async (tx) => {
        const period = await loadPeriod(tx, periodId);
        const sRows = await tx.select().from(ST).where(eq(ST.capPeriodId, periodId)).limit(1);
        const settlement = sRows[0];
        if (!settlement)
          throw new ConflictError("NO_SETTLEMENT", "propose a settlement before finalizing");
        if (settlement.status === "final")
          throw new ConflictError("ALREADY_FINAL", "the settlement is already final");
        assertTransition(period.status, "settled");
        const finalizedAt = new Date();
        const updated = await tx
          .update(ST)
          .set({
            status: "final",
            finalizedAt,
            finalizedBy: actor.userId,
            stepUpSessionId: actor.userId,
          })
          .where(eq(ST.capPeriodId, periodId))
          .returning();
        await tx
          .update(P)
          .set({ status: "settled", settledAt: finalizedAt, settledBy: actor.userId })
          .where(eq(P.id, periodId));
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m26.cap.settlement_finalized",
          organizationId: actor.organizationId,
          aggregateKind: "cap_period",
          aggregateId: periodId,
          payload: {
            organizationId: actor.organizationId,
            capPeriodId: periodId,
            settlementId: row.id,
            finalizedAt: finalizedAt.toISOString(),
            finalizedBy: actor.userId,
          },
        });
        await outbox.publish(tx, {
          eventName: "m26.cap.year_closed",
          organizationId: actor.organizationId,
          aggregateKind: "cap_period",
          aggregateId: periodId,
          payload: {
            organizationId: actor.organizationId,
            capPeriodId: periodId,
            capYear: period.capYear,
            finalSettlementId: row.id,
          },
        });
        return toSettlementView(row, settlementDirection(row.aggregateOverageCents));
      });
    },

    async publishConstant(actor, input: PublishConstantInput) {
      // Platform-shared write — §3.5/0089 REVOKEs INSERT/UPDATE/DELETE on this table from wardenx_app
      // (BYPASSRLS bypasses row-level security, not this separate GRANT-level revoke), so the write
      // routes through the SECURITY DEFINER function migration 0189 grants wardenx_app EXECUTE on —
      // the same platform-writer pattern migrations 0186-0188 use for outbox_event/audit_event/
      // report_run/materialized_view_metadata. No org context (platform table).
      await db.execute(sql`
        SELECT cap_platform_loader_publish_constant(
          ${input.capYear},
          ${input.aggregateCapAmountCents},
          ${String(input.inpatientCapPct ?? 0.2)},
          ${input.sourceUrl ?? null},
          ${actor.userId}
        )
      `);
    },

    async amendConstant(actor, capYear, input: AmendConstantInput) {
      // Amend allowed ONLY before first tenant use (D3) — guard lives in the SECURITY DEFINER function
      // (migration 0189), same reason as publishConstant above.
      const updated = await db.execute<{ cap_year: string }>(sql`
        SELECT cap_year FROM cap_platform_loader_amend_constant(
          ${capYear},
          ${input.aggregateCapAmountCents},
          ${input.sourceUrl ?? null},
          ${actor.userId}
        )
      `);
      if (!updated.rows[0])
        throw new ConflictError(
          "CONSTANT_IN_USE",
          "cannot amend a cap amount already referenced by a tenant period",
        );
    },
  };
}

/** Persist a projection snapshot, evaluate the band transition, and emit projection_updated/threshold_crossed. */
async function persistSnapshot(
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
  },
): Promise<ProjectionView> {
  const PS = schema.capProjectionSnapshot;
  const TE = schema.capThresholdEvent;
  // Prior latest band for this scope (transition detection).
  const prior = await tx
    .select({ band: PS.alertBand })
    .from(PS)
    .where(and(eq(PS.capPeriodId, capPeriodId), eq(PS.scope, scope)))
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
      computedBy: "manual_recompute",
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

function toSettlementView(
  r: typeof schema.capSettlement.$inferSelect,
  direction: string,
): SettlementView {
  return {
    id: r.id,
    capPeriodId: r.capPeriodId,
    status: r.status,
    paidTotalCents: r.paidTotalCents,
    beneficiaryCount: r.beneficiaryCount,
    aggregateCapAmountCents: r.aggregateCapAmountCents,
    aggregateOverageCents: r.aggregateOverageCents,
    inpatientTotalDays: r.inpatientTotalDays,
    inpatientOverageDays: r.inpatientOverageDays,
    inpatientOverageCents: r.inpatientOverageCents,
    proposedAt:
      r.proposedAt instanceof Date
        ? r.proposedAt.toISOString()
        : new Date(r.proposedAt).toISOString(),
    finalizedAt: r.finalizedAt
      ? r.finalizedAt instanceof Date
        ? r.finalizedAt.toISOString()
        : new Date(r.finalizedAt).toISOString()
      : null,
  };
}
