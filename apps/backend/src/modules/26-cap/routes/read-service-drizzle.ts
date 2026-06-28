// apps/backend/src/modules/26-cap/routes/read-service-drizzle.ts — the Drizzle-backed M26 READ service.
// Every method opens `withOrgContext(db, {organizationId, userId}, tx => …)` so Postgres RLS scopes each
// statement to the acting org. Projection reads take the LATEST snapshot per scope (computed_at DESC);
// accrual-line paging is keyset over (posted_at DESC, id DESC). numeric() columns arrive as strings →
// coerced to number at the edge; bigint(mode:'number') arrive as numbers.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { decodeCursor, type CursorPage, toPage } from "./concurrency";
import type {
  AccrualLineView,
  DashboardView,
  InpatientAccrualView,
  M26ReadService,
  PatientAccrualView,
  PeriodView,
  PlatformConstantView,
  ProjectionView,
  PsrImportView,
  PsrVarianceView,
  SettlementView,
  ThresholdEventFilters,
  ThresholdEventView,
} from "./read-service";

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const num = (v: string | number | null): number => (v === null ? 0 : typeof v === "number" ? v : Number(v));
const numN = (v: string | number | null): number | null => (v === null ? null : num(v));

export function buildDrizzleM26ReadService(db: DbClient): M26ReadService {
  const P = schema.capPeriod;
  const ML = schema.capPeriodMethodologyLock;
  const BA = schema.capBeneficiaryAccrual;
  const BAL = schema.capBeneficiaryAccrualLine;
  const IA = schema.capInpatientAccrual;
  const PS = schema.capProjectionSnapshot;
  const TE = schema.capThresholdEvent;
  const PI = schema.capPsrImport;
  const PR = schema.capPsrReconciliation;
  const ST = schema.capSettlement;
  const PC = schema.capPeriodPlatformConstant;

  const toPeriod = (r: typeof P.$inferSelect, lockedAt: Date | string | null): PeriodView => ({
    id: r.id,
    capYear: r.capYear,
    ccn: r.ccn,
    startDate: iso(r.startsOn).slice(0, 10),
    endDate: iso(r.endsOn).slice(0, 10),
    status: r.status,
    methodology: r.methodology ?? null,
    methodologyLockedAt: isoN(lockedAt),
    graceWindowDays: r.graceWindowDays,
    aggregateCapAmountCents: r.aggregateCapAmountCents,
    inpatientCapPct: num(r.inpatientCapPct),
    openedAt: iso(r.openedAt),
  });

  const toProjection = (r: typeof PS.$inferSelect): ProjectionView => ({
    id: r.id,
    capPeriodId: r.capPeriodId,
    scope: r.scope,
    patientId: r.patientId ?? null,
    methodology: r.methodology,
    paidYtdCents: r.paidYtdCents,
    outstandingBilledCents: r.outstandingBilledCents,
    projectedYearEndCents: r.projectedYearEndCents,
    capAmountCents: r.capAmountCents ?? null,
    inpatientDaysYtd: r.inpatientDaysYtd ?? null,
    inpatientPctYtd: numN(r.inpatientPctYtd),
    pctOfCap: num(r.pctOfCap),
    alertBand: r.alertBand,
    beneficiaryCount: r.beneficiaryCount ?? null,
    computedAt: iso(r.computedAt),
    computedBy: r.computedBy,
  });

  const toEvent = (r: typeof TE.$inferSelect): ThresholdEventView => ({
    id: r.id,
    capPeriodId: r.capPeriodId,
    scope: r.scope,
    patientId: r.patientId ?? null,
    priorBand: r.priorBand,
    currentBand: r.currentBand,
    raisedAt: iso(r.raisedAt),
    acknowledgedAt: isoN(r.acknowledgedAt),
    resolvedAt: isoN(r.resolvedAt),
  });

  /** Latest snapshot for a scope (+ optional patient) in a period. */
  async function latestSnapshot(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    periodId: string,
    scope: string,
    patientId?: string,
  ): Promise<ProjectionView | null> {
    const conds = [eq(PS.capPeriodId, periodId), eq(PS.scope, scope as typeof PS.scope.enumValues[number])];
    if (patientId) conds.push(eq(PS.patientId, patientId));
    const rows = await tx
      .select()
      .from(PS)
      .where(and(...conds))
      .orderBy(desc(PS.computedAt))
      .limit(1);
    return rows[0] ? toProjection(rows[0]) : null;
  }

  return {
    async listPeriods(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(P).orderBy(desc(P.capYear));
        const locks = await tx.select({ id: ML.capPeriodId, at: ML.lockedAt }).from(ML);
        const lockMap = new Map(locks.map((l) => [l.id, l.at]));
        return rows.map((r) => toPeriod(r, lockMap.get(r.id) ?? null));
      });
    },

    async getPeriod(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(P).where(eq(P.id, periodId)).limit(1);
        if (!rows[0]) return null;
        const lock = await tx.select({ at: ML.lockedAt }).from(ML).where(eq(ML.capPeriodId, periodId)).limit(1);
        return toPeriod(rows[0], lock[0]?.at ?? null);
      });
    },

    async listProjections(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const out: ProjectionView[] = [];
        for (const scope of ["agency_aggregate", "inpatient"] as const) {
          const s = await latestSnapshot(tx, periodId, scope);
          if (s) out.push(s);
        }
        return out;
      });
    },

    async getAgencyProjection(actor, periodId) {
      return withOrgContext(db, actor, (tx) => latestSnapshot(tx, periodId, "agency_aggregate"));
    },
    async getPatientProjection(actor, periodId, patientId) {
      return withOrgContext(db, actor, (tx) => latestSnapshot(tx, periodId, "patient_aggregate", patientId));
    },
    async getInpatientProjection(actor, periodId) {
      return withOrgContext(db, actor, (tx) => latestSnapshot(tx, periodId, "inpatient"));
    },

    async getPatientAccrual(actor, periodId, patientId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(BA)
          .where(and(eq(BA.capPeriodId, periodId), eq(BA.patientId, patientId)))
          .limit(1);
        const r = rows[0];
        if (!r) return null;
        return {
          patientId: r.patientId,
          capPeriodId: r.capPeriodId,
          paidCents: r.paidCents,
          outstandingBilledCents: r.outstandingBilledCents,
          firstElectionInPeriod: iso(r.firstElectionInPeriod).slice(0, 10),
          lastPaidThrough: r.lastPaidThrough ? iso(r.lastPaidThrough).slice(0, 10) : null,
        } satisfies PatientAccrualView;
      });
    },

    async listAccrualLines(actor, periodId, patientId, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [eq(BAL.capPeriodId, periodId), eq(BAL.patientId, patientId)];
        if (c)
          conds.push(
            or(
              lt(BAL.postedAt, new Date(c.ts)),
              and(eq(BAL.postedAt, new Date(c.ts)), lt(BAL.id, c.id)),
            )!,
          );
        const rows = await tx
          .select()
          .from(BAL)
          .where(and(...conds))
          .orderBy(desc(BAL.postedAt), desc(BAL.id))
          .limit(limit + 1);
        return toPage<typeof rows[number], AccrualLineView>(
          rows,
          limit,
          (r) => ({ ts: iso(r.postedAt), id: r.id }),
          (r) => ({
            id: r.id,
            sourceKind: r.sourceKind,
            sourceId: r.sourceId,
            amountCents: r.amountCents,
            serviceFrom: iso(r.serviceFrom).slice(0, 10),
            serviceTo: iso(r.serviceTo).slice(0, 10),
            postedAt: iso(r.postedAt),
          }),
        ) satisfies CursorPage<AccrualLineView>;
      });
    },

    async getInpatientAccrual(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(IA).where(eq(IA.capPeriodId, periodId)).limit(1);
        const r = rows[0];
        if (!r) return null;
        return {
          capPeriodId: r.capPeriodId,
          gipDays: r.gipDays,
          ircDays: r.ircDays,
          totalPatientDays: r.totalPatientDays,
          inpatientPct: num(r.inpatientPct),
        } satisfies InpatientAccrualView;
      });
    },

    async listThresholdEvents(actor, filters) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          filters.capPeriodId ? eq(TE.capPeriodId, filters.capPeriodId) : undefined,
          filters.scope ? eq(TE.scope, filters.scope as typeof TE.scope.enumValues[number]) : undefined,
          filters.band ? eq(TE.currentBand, filters.band as typeof TE.currentBand.enumValues[number]) : undefined,
          filters.unacknowledgedOnly ? isNull(TE.acknowledgedAt) : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(TE)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(TE.raisedAt))
          .limit(200);
        return rows.map(toEvent);
      });
    },

    async getPsrImport(actor, importId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(PI).where(eq(PI.id, importId)).limit(1);
        const r = rows[0];
        if (!r) return null;
        return {
          id: r.id,
          capPeriodId: r.capPeriodId,
          macRegion: r.macRegion,
          psrPeriodFrom: iso(r.psrPeriodFrom).slice(0, 10),
          psrPeriodTo: iso(r.psrPeriodTo).slice(0, 10),
          parseStatus: r.parseStatus,
          parseError: r.parseError ?? null,
          beneficiaryCountPsr: r.beneficiaryCountPsr ?? null,
          paidTotalCentsPsr: r.paidTotalCentsPsr ?? null,
          importedAt: iso(r.importedAt),
        } satisfies PsrImportView;
      });
    },

    async listPsrReconciliation(actor, importId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(PR)
          .where(eq(PR.psrImportId, importId))
          .orderBy(desc(PR.raisedAt))
          .limit(500);
        return rows.map(
          (r): PsrVarianceView => ({
            id: r.id,
            scope: r.scope,
            patientId: r.patientId ?? null,
            m26AccrualCents: r.m26AccrualCents ?? null,
            psrAmountCents: r.psrAmountCents ?? null,
            varianceCents: r.varianceCents ?? null,
            varianceReason: r.varianceReason ?? null,
            status: r.status,
          }),
        );
      });
    },

    async getSettlement(actor, periodId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(ST).where(eq(ST.capPeriodId, periodId)).limit(1);
        const r = rows[0];
        if (!r) return null;
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
          proposedAt: iso(r.proposedAt),
          finalizedAt: isoN(r.finalizedAt),
        } satisfies SettlementView;
      });
    },

    async getDashboard(actor) {
      return withOrgContext(db, actor, async (tx): Promise<DashboardView> => {
        const active = await tx
          .select()
          .from(P)
          .where(or(eq(P.status, "active"), eq(P.status, "open"), eq(P.status, "reopened")))
          .orderBy(desc(P.capYear))
          .limit(1);
        const period = active[0];
        if (!period) {
          return { period: null, agency: null, inpatient: null, topPatients: [], recentEvents: [], openVarianceCount: 0 };
        }
        const agency = await latestSnapshot(tx, period.id, "agency_aggregate");
        const inpatient = await latestSnapshot(tx, period.id, "inpatient");
        const topRows = await tx
          .select()
          .from(PS)
          .where(and(eq(PS.capPeriodId, period.id), eq(PS.scope, "patient_aggregate")))
          .orderBy(desc(PS.pctOfCap), desc(PS.computedAt))
          .limit(10);
        const eventRows = await tx
          .select()
          .from(TE)
          .where(eq(TE.capPeriodId, period.id))
          .orderBy(desc(TE.raisedAt))
          .limit(14);
        const variance = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(PR)
          .where(and(eq(PR.capPeriodId, period.id), or(eq(PR.status, "open"), eq(PR.status, "investigating"))));
        const lock = await tx.select({ at: ML.lockedAt }).from(ML).where(eq(ML.capPeriodId, period.id)).limit(1);
        return {
          period: toPeriod(period, lock[0]?.at ?? null),
          agency,
          inpatient,
          topPatients: topRows.map(toProjection),
          recentEvents: eventRows.map(toEvent),
          openVarianceCount: variance[0]?.n ?? 0,
        };
      });
    },

    async listPlatformConstants() {
      // Platform-shared, read-all (no org context needed — USING(true) policy, §3.5/D3).
      const rows = await db.select().from(PC).orderBy(desc(PC.capYear));
      return rows.map(
        (r): PlatformConstantView => ({
          capYear: r.capYear,
          aggregateCapAmountCents: r.aggregateCapAmountCents ?? null,
          inpatientCapPct: num(r.inpatientCapPct),
          sourceUrl: r.sourceUrl ?? null,
          firstTenantUseAt: isoN(r.firstTenantUseAt),
          recordedAt: iso(r.recordedAt),
        }),
      );
    },
  };
}
