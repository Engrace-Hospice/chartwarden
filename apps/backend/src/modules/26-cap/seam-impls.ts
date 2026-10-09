// apps/backend/src/modules/26-cap/seam-impls.ts — the six §4.3 published seam implementations over the M26
// READ service + db. Each seam takes an `orgId` (cross-module callers: M23/M27/M30/M33/M36) and wraps it in
// a synthetic system actor so withOrgContext scopes the reads under RLS. Money crosses as cents-as-STRING
// (the seam contract: consumers must never parse to a lossy float). The composition root registers these
// into the M1 SeamRegistry once M26's keys are M1 SeamContracts members (deferred — until then M26 is
// reachable cross-module via its §4.10 outbox events, the M27 posture).
import {
  type AgencyProjectionView,
  type CapAccrualReader,
  type CapAlertSubscriberProvider,
  type CapMetricsProvider,
  type CapMetricsView,
  type CapProjectionProvider,
  type CapSettlementProvider,
  type CapSettlementView,
  type InpatientCapProvider,
  type InpatientProjectionView,
  type PatientProjectionView,
  type ProjectionAtDateView,
  asPercent,
  capYearForDate,
  computeCostReportCapAggregate,
  toAggregateBandLabel,
  toInpatientBandLabel,
} from "@wardenx/cap-management";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, sql } from "drizzle-orm";
import { selectCapPeriodForCcn } from "./cap-period-selection";
import type { M26ReadActor } from "./routes/actor";
import type { M26ReadService } from "./routes/read-service";

const systemActor = (orgId: string): M26ReadActor => ({
  organizationId: orgId,
  userId: "system",
  roles: [],
});
const cents = (n: number | null): string => String(n ?? 0);

export interface M26SeamImpls {
  readonly projection: CapProjectionProvider;
  readonly inpatient: InpatientCapProvider;
  readonly accrual: CapAccrualReader;
  readonly settlement: CapSettlementProvider;
  readonly subscribers: CapAlertSubscriberProvider;
  readonly metrics: CapMetricsProvider;
}

export function buildM26SeamImpls(db: DbClient, read: M26ReadService): M26SeamImpls {
  const projection: CapProjectionProvider = {
    async getAgencyProjection(orgId, capPeriodId) {
      const actor = systemActor(orgId);
      const [snap, period] = await Promise.all([
        read.getAgencyProjection(actor, capPeriodId),
        read.getPeriod(actor, capPeriodId),
      ]);
      if (!period) return null;
      return toAgencyView(period.capYear, snap, period);
    },
    async getPatientProjection(orgId, capPeriodId, patientId) {
      const actor = systemActor(orgId);
      const [snap, period] = await Promise.all([
        read.getPatientProjection(actor, capPeriodId, patientId),
        read.getPeriod(actor, capPeriodId),
      ]);
      // GAP-037 — no per-patient snapshot means the patient is not projected (not on the cap ledger yet): answer
      // null, never a fabricated "safe, 0%" view that would make M23's pre-submission rule see a safe patient.
      if (!period || !snap) return null;
      const base = toAgencyView(period.capYear, snap, period);
      return {
        ...base,
        patientId,
        perBeneficiaryAllocatedCap: cents(snap.capAmountCents ?? period.aggregateCapAmountCents),
        contributionToAgency: cents(snap.paidYtdCents),
        methodology: (period.methodology ?? "streamlined") as "streamlined" | "proportional",
      } satisfies PatientProjectionView;
    },
    async getProjectionForServiceDate(orgId, serviceDate, scope, patientId) {
      const actor = systemActor(orgId);
      const capYear = capYearForDate(serviceDate);
      const periods = await read.listPeriods(actor);
      const period = periods.find((p) => p.capYear === capYear);
      if (!period) return null;
      const base =
        scope === "patient_aggregate" && patientId
          ? await projection.getPatientProjection(orgId, period.id, patientId)
          : await projection.getAgencyProjection(orgId, period.id);
      if (!base) return null;
      return {
        ...base,
        isFrozenSnapshot: period.status === "settled",
      } satisfies ProjectionAtDateView;
    },
    async getInpatientProjectionForServiceDate(orgId, serviceDate) {
      const actor = systemActor(orgId);
      const capYear = capYearForDate(serviceDate);
      const periods = await read.listPeriods(actor);
      const period = periods.find((p) => p.capYear === capYear);
      if (!period) return null;
      return inpatient.getInpatientProjection(orgId, period.id);
    },
  };

  const inpatient: InpatientCapProvider = {
    async getInpatientProjection(orgId, capPeriodId) {
      const actor = systemActor(orgId);
      const [snap, acc] = await Promise.all([
        read.getInpatientProjection(actor, capPeriodId),
        read.getInpatientAccrual(actor, capPeriodId),
      ]);
      if (!snap) return null;
      return {
        capPeriodId,
        inpatientDayCount: snap.inpatientDaysYtd ?? 0,
        // GAP-038 - the all-level-of-care denominator the utilisation was computed over (was a hard-coded 0).
        totalDayCount: acc?.totalPatientDays ?? 0,
        utilizationPct: asPercent(snap.pctOfCap),
        band: toInpatientBandLabel(snap.alertBand),
        computedAt: snap.computedAt,
      } satisfies InpatientProjectionView;
    },
    async getInpatientDayCount(orgId, capPeriodId) {
      const acc = await read.getInpatientAccrual(systemActor(orgId), capPeriodId);
      if (!acc) return null;
      return {
        inpatientDays: acc.gipDays + acc.ircDays,
        totalDays: acc.totalPatientDays,
        computedAt: new Date().toISOString(),
      };
    },
  };

  const accrual: CapAccrualReader = {
    async aggregateForCostReport(orgId, capYear, ccn) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const P = schema.capPeriod;
        const BA = schema.capBeneficiaryAccrual;
        const IA = schema.capInpatientAccrual;
        const ST = schema.capSettlement;
        // RLS scopes to orgId. GAP-149: a cap period is unique per (org, CCN, capYear), so the CCN selects it
        // (see cap-period-selection.ts for the not-yet-CCN-bound sentinel); several CCNs with no CCN given are
        // ambiguous and answer null rather than an arbitrary CCN's figures.
        const periods = await tx.select().from(P).where(eq(P.capYear, capYear)).limit(50);
        const period = selectCapPeriodForCcn(periods, ccn);
        if (!period) return null;
        const accrAgg = await tx
          .select({
            paid: sql<string>`coalesce(sum(${BA.paidCents}), 0)::bigint`,
            n: sql<number>`count(*)::int`,
          })
          .from(BA)
          .where(eq(BA.capPeriodId, period.id));
        const ia = await tx.select().from(IA).where(eq(IA.capPeriodId, period.id)).limit(1);
        const st = await tx.select().from(ST).where(eq(ST.capPeriodId, period.id)).limit(1);
        const settled = st[0]?.status === "final" ? st[0] : null;
        const result = computeCostReportCapAggregate({
          capYear,
          perBeneficiaryCapCents: period.aggregateCapAmountCents,
          beneficiaryCount: Number(accrAgg[0]?.n ?? 0),
          paidTotalCents: Number(accrAgg[0]?.paid ?? 0),
          gipDays: ia[0]?.gipDays ?? 0,
          ircDays: ia[0]?.ircDays ?? 0,
          totalPatientDays: ia[0]?.totalPatientDays ?? 0,
          settledAggregateCapCents: settled ? settled.aggregateCapAmountCents : null,
          settledPaidTotalCents: settled ? settled.paidTotalCents : null,
        });
        return {
          capYear: result.capYear,
          beneficiaryCount: result.beneficiaryCount,
          aggregateCapCents: cents(result.aggregateCapCents),
          aggregatePaymentsCents: cents(result.aggregatePaymentsCents),
          inpatientDays: result.inpatientDays,
          totalMedicareDays: result.totalMedicareDays,
        };
      });
    },
    async getPatientAccrual(orgId, capPeriodId, patientId) {
      const a = await read.getPatientAccrual(systemActor(orgId), capPeriodId, patientId);
      if (!a) return null;
      return {
        patientId,
        capPeriodId,
        totalPaid: cents(a.paidCents),
        lineCount: 0,
        firstPostingDate: null,
        lastPostingDate: a.lastPaidThrough,
      };
    },
    async listAccrualLines(orgId, capPeriodId, patientId, cursor) {
      const page = await read.listAccrualLines(
        systemActor(orgId),
        capPeriodId,
        patientId,
        cursor,
        50,
      );
      return {
        items: page.items.map((l) => ({
          id: l.id,
          remittanceId: l.sourceId,
          claimId: l.sourceId,
          paidAmount: cents(l.amountCents),
          postingDate: l.postedAt,
          serviceFromDate: l.serviceFrom,
          serviceThruDate: l.serviceTo,
        })),
        nextCursor: page.nextCursor,
      };
    },
  };

  const settlement: CapSettlementProvider = {
    async getSettlement(orgId, capPeriodId) {
      const s = await read.getSettlement(systemActor(orgId), capPeriodId);
      if (!s) return null;
      const direction =
        s.aggregateOverageCents > 0
          ? "overpayment_owed_to_cms"
          : s.aggregateOverageCents < 0
            ? "underpayment_owed_to_provider"
            : "balanced";
      return {
        id: s.id,
        capPeriodId,
        status: s.status as CapSettlementView["status"],
        totalPaidFinal: cents(s.paidTotalCents),
        totalCapFinal: cents(s.aggregateCapAmountCents),
        varianceAmount: cents(s.aggregateOverageCents),
        direction,
        finalizedAt: s.finalizedAt,
      } satisfies CapSettlementView;
    },
  };

  // Recipient resolution for M36's generic AlertEmitter (M36-F03). GAP-040: cap alerts are delivered by M36's own
  // `cap-threshold-alerts` consumer against the seeded platform `alert_rule`s, whose audience is M36's generic
  // `permission_holders` resolver over `cap.event.read` (org administrators as the floor; a breach adds
  // compliance_officer / org_admin). That resolution lives in M36 (it reads M3's grants, which M26 cannot), so this
  // seam is not on the delivery path and nothing consumes it. It stays empty rather than inventing per-user band
  // subscriptions: a per-user band choice is M36's notification preferences / severity floor, not a cap fact.
  const subscribers: CapAlertSubscriberProvider = {
    async listSubscribers() {
      return [];
    },
  };

  const metrics: CapMetricsProvider = {
    async getMetrics(orgId, capPeriodId): Promise<CapMetricsView> {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const PS = schema.capProjectionSnapshot;
        // Count distinct patients by latest band (a coarse count over the period's patient snapshots).
        const rows = await tx
          .select({ band: PS.alertBand, n: sql<number>`count(distinct ${PS.patientId})::int` })
          .from(PS)
          .where(and(eq(PS.capPeriodId, capPeriodId), eq(PS.scope, "patient_aggregate")))
          .groupBy(PS.alertBand);
        const byBand = new Map(rows.map((r) => [r.band, r.n]));
        const agency = await read.getAgencyProjection(systemActor(orgId), capPeriodId);
        const inp = await read.getInpatientProjection(systemActor(orgId), capPeriodId);
        return {
          capPeriodId,
          patientsInWatchBand: byBand.get("watch_90") ?? 0,
          patientsInWarnBand: byBand.get("warn_95") ?? 0,
          patientsInBreachBand: byBand.get("breach_100") ?? 0,
          agencyBand: toAggregateBandLabel(agency?.alertBand ?? "safe"),
          inpatientBand: toInpatientBandLabel(inp?.alertBand ?? "inpatient_safe"),
          projectedOveragePct: agency ? Math.max(0, asPercent(agency.pctOfCap) - 100) : 0,
          computedAt: new Date().toISOString(),
        };
      });
    },
  };

  return { projection, inpatient, accrual, settlement, subscribers, metrics };
}

function toAgencyView(
  capYear: string,
  snap: {
    paidYtdCents: number;
    outstandingBilledCents: number;
    capAmountCents: number | null;
    pctOfCap: number;
    alertBand: string;
    computedAt: string;
  } | null,
  period: { id: string; aggregateCapAmountCents: number },
): AgencyProjectionView {
  return {
    capPeriodId: period.id,
    capYear,
    paidToDate: cents(snap?.paidYtdCents ?? 0),
    outstandingBilled: cents(snap?.outstandingBilledCents ?? 0),
    totalAllocatedCap: cents(snap?.capAmountCents ?? period.aggregateCapAmountCents),
    utilizationPct: asPercent(snap?.pctOfCap ?? 0),
    band: toAggregateBandLabel(snap?.alertBand ?? "safe"),
    computedAt: snap?.computedAt ?? new Date().toISOString(),
  };
}
