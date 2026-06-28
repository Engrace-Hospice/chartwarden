// apps/backend/src/modules/26-cap/routes/read-service.ts — the M26 READ service interface (the §4.1 GET
// surface). The Drizzle implementation lives in read-service-drizzle.ts; a route test may bind an in-memory
// stand-in. Money crosses as integer cents; the seam read-views (seam-impls.ts) convert to cents-as-string.
import type { M26ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

export interface PeriodView {
  id: string;
  capYear: string;
  ccn: string;
  startDate: string;
  endDate: string;
  status: string;
  methodology: string | null;
  methodologyLockedAt: string | null;
  graceWindowDays: number;
  aggregateCapAmountCents: number;
  inpatientCapPct: number;
  openedAt: string;
}

export interface ProjectionView {
  id: string;
  capPeriodId: string;
  scope: string;
  patientId: string | null;
  methodology: string;
  paidYtdCents: number;
  outstandingBilledCents: number;
  projectedYearEndCents: number;
  capAmountCents: number | null;
  inpatientDaysYtd: number | null;
  inpatientPctYtd: number | null;
  pctOfCap: number;
  alertBand: string;
  beneficiaryCount: number | null;
  computedAt: string;
  computedBy: string;
}

export interface PatientAccrualView {
  patientId: string;
  capPeriodId: string;
  paidCents: number;
  outstandingBilledCents: number;
  firstElectionInPeriod: string;
  lastPaidThrough: string | null;
}

export interface AccrualLineView {
  id: string;
  sourceKind: string;
  sourceId: string;
  amountCents: number;
  serviceFrom: string;
  serviceTo: string;
  postedAt: string;
}

export interface InpatientAccrualView {
  capPeriodId: string;
  gipDays: number;
  ircDays: number;
  totalPatientDays: number;
  inpatientPct: number;
}

export interface ThresholdEventView {
  id: string;
  capPeriodId: string;
  scope: string;
  patientId: string | null;
  priorBand: string;
  currentBand: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface PsrImportView {
  id: string;
  capPeriodId: string;
  macRegion: string;
  psrPeriodFrom: string;
  psrPeriodTo: string;
  parseStatus: string;
  parseError: string | null;
  beneficiaryCountPsr: number | null;
  paidTotalCentsPsr: number | null;
  importedAt: string;
}

export interface PsrVarianceView {
  id: string;
  scope: string;
  patientId: string | null;
  m26AccrualCents: number | null;
  psrAmountCents: number | null;
  varianceCents: number | null;
  varianceReason: string | null;
  status: string;
}

export interface SettlementView {
  id: string;
  capPeriodId: string;
  status: string;
  paidTotalCents: number;
  beneficiaryCount: number;
  aggregateCapAmountCents: number;
  aggregateOverageCents: number;
  inpatientTotalDays: number;
  inpatientOverageDays: number;
  inpatientOverageCents: number;
  proposedAt: string;
  finalizedAt: string | null;
}

export interface PlatformConstantView {
  capYear: string;
  aggregateCapAmountCents: number | null;
  inpatientCapPct: number;
  sourceUrl: string | null;
  firstTenantUseAt: string | null;
  recordedAt: string;
}

export interface ThresholdEventFilters {
  capPeriodId?: string;
  scope?: string;
  band?: string;
  unacknowledgedOnly?: boolean;
}

export interface DashboardView {
  period: PeriodView | null;
  agency: ProjectionView | null;
  inpatient: ProjectionView | null;
  topPatients: ProjectionView[];
  recentEvents: ThresholdEventView[];
  openVarianceCount: number;
}

export interface M26ReadService {
  listPeriods(actor: M26ReadActor): Promise<PeriodView[]>;
  getPeriod(actor: M26ReadActor, periodId: string): Promise<PeriodView | null>;
  listProjections(actor: M26ReadActor, periodId: string): Promise<ProjectionView[]>;
  getAgencyProjection(actor: M26ReadActor, periodId: string): Promise<ProjectionView | null>;
  getPatientProjection(
    actor: M26ReadActor,
    periodId: string,
    patientId: string,
  ): Promise<ProjectionView | null>;
  getInpatientProjection(actor: M26ReadActor, periodId: string): Promise<ProjectionView | null>;
  getPatientAccrual(
    actor: M26ReadActor,
    periodId: string,
    patientId: string,
  ): Promise<PatientAccrualView | null>;
  listAccrualLines(
    actor: M26ReadActor,
    periodId: string,
    patientId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<AccrualLineView>>;
  getInpatientAccrual(actor: M26ReadActor, periodId: string): Promise<InpatientAccrualView | null>;
  listThresholdEvents(
    actor: M26ReadActor,
    filters: ThresholdEventFilters,
  ): Promise<ThresholdEventView[]>;
  getPsrImport(actor: M26ReadActor, importId: string): Promise<PsrImportView | null>;
  listPsrReconciliation(actor: M26ReadActor, importId: string): Promise<PsrVarianceView[]>;
  getSettlement(actor: M26ReadActor, periodId: string): Promise<SettlementView | null>;
  getDashboard(actor: M26ReadActor): Promise<DashboardView>;
  listPlatformConstants(): Promise<PlatformConstantView[]>;
}
