import { randomUUID } from "node:crypto";
import {
  type AllocationInputs,
  ComplianceWindowRepository,
  CostReportRepository,
  CostReportSnapshotRepository,
  type CostReportState,
  type CostReportTransitionEvent,
  CostReportWorksheetRepository,
  DEFAULT_RULE_SET_VERSION,
  DEFAULT_VALIDATION_RULES,
  EcrSubmissionRepository,
  ImportsRepository,
  NGS_J6_RULES,
  type PerDiemResult,
  type RuleDef,
  StatisticDataRepository,
  type StepDownAllocateResult,
  type ValidationContext,
  ValidationRepository,
  ValidationRuleRepository,
  type WorksheetCode,
  allocationResultsToWorksheets,
  applyTransition,
  buildEcrArtifacts,
  buildPerDiemInput,
  calculatePerDiem,
  canTransition,
  contentHashSha256,
  runValidation,
  stepDownAllocate,
} from "@wardenx/cost-report";
// apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts — M27 LIVE BullMQ wiring for the §4.8 jobs.
//
// The thin, infra-touching adapter that turns the @wardenx/cost-report PURE domain (the lifecycle reducer,
// the allocation/apportionment/settlement chain, the ECR/PI writers, the validation rule engine, the
// snapshot content hash) into running BullMQ `Worker`s + the cron-schedule `Queue`s. Unlike @wardenx/quality
// (which ships its §4.8 processors in the package), @wardenx/cost-report ships NO processors and NO queue
// catalog (P1 was "no BullMQ"), so this file BOTH constructs the workers AND carries the processor LOGIC —
// each processor orchestrates the M27 repositories + the pure domain functions + the consumed seams, exactly
// the way the M30 `m30-jobs.ts` precedent binds repos + pure processors + seams.
//
// Mirrors apps/backend/src/modules/30-quality/jobs/m30-jobs.ts file-for-file in posture:
//   • `new Worker(queue, processor, { connection, concurrency })` + `new Queue(...)`; injected connection;
//     the caller owns lifecycle/close. Nothing runs at import (constructing a Worker is what opens the
//     Valkey connection — that happens only inside these functions, never in tests / at module load).
//   • per-job `withOrgContext(orgId)` RLS envelope (every §4.8 work queue is ORG-scoped, F09): the worker
//     opens the tx on the org from the job payload and REBUILDS the repos over that tx so every write carries
//     `app.org_id` (without it the RLS WITH CHECK denies the insert).
//   • THE M34 EAGER-BIND GOTCHA: a still-missing port is bound to a LAZY `() => unboundWorkerPort(...)` thunk
//     so the throw happens only when a JOB RUNS — never at port-bundle construction; the host boots clean
//     even when an adapter is absent.
//   • RULE 4 (the M30 worker precedent): the consumed seams are reached at RUN time via the resolved seam
//     readers the composition root binds (over `getSeam`). M6/M8/M12/M13/M40 are LIVE-if-bound; M23/M26 are
//     forward-seam DENY-STUBS — absent ⇒ the dependent path SKIPS (returns a skip flag), never fabricates.
//   • RULE 3a/3b/3e: the §4.10 transactional-outbox emit, the per-tenant DEK envelope-encrypt (the
//     Xero/Gusto raw-payload cipher), and the §4.9 M36 alert dispatch are genuinely-unlanded platform infra
//     → LAZY fail-closed thunks (deny + fail rather than emit/persist un-encrypted).
//
// M27 carries NO PHI (D18) — every payload is IDs + aggregate financial/statistical facts only; money is
// INTEGER CENTS (D8). The actor id a §4.8 worker's `withOrgContext` carries is the empty-string system
// sentinel the M4 write-audit trigger maps to a NULL actor (a background job has no acting user).
import type { DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type M27CronQueueName,
  M27_CRON_QUEUES,
  M27_JOB_SCHEDULES,
  M27_QUEUES,
  M27_QUEUE_PARAMS,
} from "./queues";

// ── the fail-closed unbound-port thunk (the @wardenx/quality `unboundWorkerPort` precedent, local copy) ──

/**
 * Throw a typed `M27WorkerPortUnbound` for a still-missing infra/seam port. Called LAZILY inside a port
 * method body so the throw happens only when a JOB RUNS — never at port-bundle construction (the M34
 * eager-bind gotcha). NEVER fails open; a missing port denies + fails the job rather than fabricating data.
 */
export function unboundWorkerPort(portName: string, hint: string): never {
  throw new Error(`M27WorkerPortUnbound: ${portName} — ${hint}`);
}

// The M27 jsonb payload helper types live on the `@wardenx/db` `schema` namespace (the schema barrel
// re-exports `./cost-report/types`); alias them locally so the port/processor signatures stay readable.
type NormalizedAccount = schema.NormalizedAccount;
type NormalizedWageRow = schema.NormalizedWageRow;
type StatisticMonthlyBreakdown = schema.StatisticMonthlyBreakdown;
type VisitCountsByDiscipline = schema.VisitCountsByDiscipline;
type FteCalculations = schema.FteCalculations;
type BereavementCensus = schema.BereavementCensus;

// ── §4.8 job payloads (the producer fans these onto the WORK queues) ────────────────────────────────────
//
// INTEGRATION CONTRACT: the already-built `routes/write-service-drizzle.ts` producer enqueues the cost-report
// payload WITHOUT `organizationId` (its dedupe key `…:${org}:${costReportId}` carries it). Because every §4.8
// work queue is ORG-scoped (the worker opens `withOrgContext(orgId)`), the composition-root `RecomputeEnqueuePort`
// adapter MUST enrich each job's `data` with `organizationId` (parse it from the dedupe key) before `Queue.add`.
// The workers below read `organizationId` from `job.data` and fail-closed when it is absent.

export interface TrialBalancePullJob {
  readonly organizationId: string;
  readonly costReportId: string;
  readonly source: string;
}
export interface WageDataPullJob {
  readonly organizationId: string;
  readonly costReportId: string;
}
export interface StatisticsRefreshJob {
  readonly organizationId: string;
  readonly costReportId: string;
}
export interface CostAllocationRecomputeJob {
  readonly organizationId: string;
  readonly costReportId: string;
  /** Present for a single-worksheet recompute (`computeWorksheet`); absent for a full `allocate`. */
  readonly worksheetCode?: WorksheetCode;
}
export interface ValidationRunJob {
  readonly organizationId: string;
  readonly costReportId: string;
  readonly validationId: string;
  readonly ruleSetVersion: number;
}
export interface EcrGenerationJob {
  readonly organizationId: string;
  readonly costReportId: string;
  readonly submissionId: string;
  readonly snapshotId: string;
}
export interface SnapshotBuilderJob {
  readonly organizationId: string;
  readonly costReportId: string;
  readonly version: number;
  readonly reason: schema.CostReportSnapshot["reason"];
  readonly createdByMembershipId: string;
}

// ── injected ports (the composition root binds; the genuinely-missing carry a lazy fail-closed thunk) ───

/** The §4.10 `m27.*` transactional-outbox emitter (writes the `outbox_event` row on the worker's tx). */
export interface WorkerOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The §4.9 M36 typed-alert dispatcher (alerts ship as defs + fire through M36; RULE 3e). */
export interface WorkerAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

/** The per-tenant DEK envelope-encrypt for the Xero/Gusto `raw_payload_cipher` (RULE 3b; §3.6). */
export interface WorkerDekPort {
  encrypt(
    organizationId: string,
    plaintext: unknown,
  ): Promise<schema.TrialBalanceImport["rawPayloadCipher"]>;
}

/** The Xero trial-balance pull seam (M27's own `XeroClientFactory`, resolved + adapted at the comp. root). */
export interface TrialBalancePullSeam {
  pull(input: {
    readonly organizationId: string;
    readonly costReportId: string;
    readonly fromDate: string;
    readonly toDate: string;
  }): Promise<{
    readonly normalizedAccounts: readonly NormalizedAccount[];
    readonly rawPayload: unknown;
    readonly totalDebitsCents: number;
    readonly totalCreditsCents: number;
    readonly balanced: boolean;
  }>;
}

/** The Gusto wage-data pull seam (M27's own `GustoClientFactory`, resolved + adapted at the comp. root). */
export interface WageDataPullSeam {
  pull(input: {
    readonly organizationId: string;
    readonly costReportId: string;
    readonly fromDate: string;
    readonly toDate: string;
  }): Promise<{
    readonly normalizedWageRows: readonly NormalizedWageRow[];
    readonly rawPayload: unknown;
    readonly employeeCount: number;
    readonly totalPaidHours: number;
    readonly totalSalaryCents: number;
  }>;
}

/** The fiscal window of a report (the M6/M8 seam reads scope to it). */
export interface StatisticsSeamScope {
  readonly organizationId: string;
  /** The report being refreshed — the FTE source (its wage import) is keyed by it. */
  readonly costReportId?: string;
  readonly providerEntityId: string;
  readonly fiscalYearStartDate: string;
  readonly fiscalYearEndDate: string;
}

/**
 * The §4.5 statistics fan-in seams (LIVE-if-bound): the M6 service census (`LevelOfCarePeriodReader` /
 * `AdmissionCensusReader`) + the M8 `EncounterStatisticsProvider`. Each returns the aggregate jsonb the
 * `statistic_data` row persists — AGGREGATE-ONLY (D18). The M23 `PatientDaysProvider` (billed days) + the
 * M26 cap readers are the DENY-STUB forward seams: when absent the worker SKIPS them (sets the skip flag on
 * the `m27.statistics.refreshed` event), never fabricating a billed-day census.
 */
export interface StatisticsSeams {
  serviceMonthlyBreakdown(scope: StatisticsSeamScope): Promise<StatisticMonthlyBreakdown>;
  visitCountsByDiscipline(scope: StatisticsSeamScope): Promise<VisitCountsByDiscipline>;
  fteByDiscipline(scope: StatisticsSeamScope): Promise<FteCalculations>;
  bereavementCensus(scope: StatisticsSeamScope): Promise<BereavementCensus>;
}

/**
 * The validation-run context builder (the ONE fail-closed shaping seam for `validation-run`, the M30
 * `resolveInput` precedent). It assembles the aggregate, PHI-free {@link ValidationContext} the pure
 * `runValidation` evaluates against — the M40 MAC jurisdiction, the materialized worksheet/statistics/
 * mapping/bad-debt state, the §2.2 deadline window, and the live seam-binding flags (M23/M26 deny-stubs ⇒
 * the dependent rules `skip`). Bound by the composition root over the read repos + `getSeam`.
 */
export interface ValidationContextBuilder {
  build(input: {
    readonly organizationId: string;
    readonly costReportId: string;
    readonly tx: DbClient;
  }): Promise<ValidationContext>;
}

/**
 * The allocation-input builder (the fail-closed shaping seam for `cost-allocation-recompute`). It turns the
 * materialized Worksheet A / S-3 / mapping state (the untyped `cost_report_worksheet.data` jsonb) into the
 * typed inputs the four pure allocation hops consume. Bound by the composition root; until then a recompute
 * fails closed on RUN (the pure fns ARE referenced + called below — only the jsonb→input shaping is lazy).
 */
export interface AllocationInputBuilder {
  build(input: {
    readonly organizationId: string;
    readonly costReportId: string;
    readonly tx: DbClient;
  }): Promise<AllocationInputs>;
}

/** The platform active-org enumerator the filing-deadline cron fans its per-org window scan across (M2). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

// ── the dep bag the composition root injects ────────────────────────────────────────────────────────────

/**
 * The dependencies the live M27 worker wiring binds the §4.8 worker/cron ports over. The bindable infra
 * (the Valkey connection + the org-scoped Drizzle client + the M27 repos) is wired to real adapters; the
 * still-missing cross-module/platform infra (the outbox dispatcher, the DEK helper, the M36 alert router,
 * the Xero/Gusto pull seams, the M6/M8 statistics seams, the validation-context + allocation-input shapers,
 * the active-org enumerator) carries a LAZY fail-closed thunk default until the integrator binds it.
 */
export interface M27WorkerDeps {
  /** The Valkey/Redis connection the `Worker`/`Queue` open over (injected, the M30 reporting-jobs shape). */
  readonly connection: ConnectionOptions;
  /** The Drizzle client the repos run under (wrapped per-job in `withOrgContext` by the worker). */
  readonly db: DbClient;
  /** The active rule-set version a `validation-run` pins to (defaults to `DEFAULT_RULE_SET_VERSION`). */
  readonly ruleSetVersion?: number;
  /** Injected clock (deterministic in tests; every instant is stamped through this). */
  now?: () => Date;
  // ── bindable cross-module/platform ports (lazy fail-closed default until bound) ──
  readonly outbox?: WorkerOutboxPort;
  readonly alerts?: WorkerAlertPort;
  readonly dek?: WorkerDekPort;
  readonly trialBalanceSeam?: TrialBalancePullSeam;
  readonly wageDataSeam?: WageDataPullSeam;
  readonly statisticsSeams?: StatisticsSeams;
  readonly validationContext?: ValidationContextBuilder;
  readonly allocationInputs?: AllocationInputBuilder;
  readonly activeOrgs?: ActiveOrgListPort;
  /**
   * Whether the M23 `PatientDaysProvider` is bound (drives `m27.statistics.refreshed.claimProviderSkipped`).
   * False under the D12 forward-seam deny-stub — the worker skips the billed-day census, never fabricates it.
   */
  readonly patientDaysProviderBound?: boolean;
  /** Whether the M26 cap readers are bound (drives `m27.statistics.refreshed.capProviderSkipped`). D13. */
  readonly capProviderBound?: boolean;
}

/** The empty-string system sentinel `withOrgContext` carries — the M4 trigger NULLIFs it (no acting user). */
const M27_WORKER_SYSTEM_USER_ID = "";

// ── the bound port bundles (bind what we can; lazy throw-on-call for the genuinely-missing infra) ───────

function outboxOf(deps: M27WorkerDeps): WorkerOutboxPort {
  return (
    deps.outbox ?? {
      publish: () =>
        unboundWorkerPort(
          "outbox.publish",
          "bind to the live transactional-outbox dispatcher (every §4.10 m27.* emit)",
        ),
    }
  );
}

function alertsOf(deps: M27WorkerDeps): WorkerAlertPort {
  return (
    deps.alerts ?? {
      dispatch: () =>
        unboundWorkerPort(
          "alerts.dispatch",
          "bind to the live M36 alert router (the §4.9 filing-deadline tier alerts)",
        ),
    }
  );
}

function dekOf(deps: M27WorkerDeps): WorkerDekPort {
  return (
    deps.dek ?? {
      encrypt: () =>
        unboundWorkerPort(
          "dek.encrypt",
          "bind to the M1 per-tenant DEK envelope-encrypt for trial_balance/wage_data raw_payload_cipher (§3.6)",
        ),
    }
  );
}

function trialBalanceSeamOf(deps: M27WorkerDeps): TrialBalancePullSeam {
  return (
    deps.trialBalanceSeam ?? {
      pull: () =>
        unboundWorkerPort(
          "trialBalanceSeam.pull",
          "bind the M27 XeroClientFactory pull (resolve via getSeam at the composition root; @wardenx/xero-client)",
        ),
    }
  );
}

function wageDataSeamOf(deps: M27WorkerDeps): WageDataPullSeam {
  return (
    deps.wageDataSeam ?? {
      pull: () =>
        unboundWorkerPort(
          "wageDataSeam.pull",
          "bind the M27 GustoClientFactory pull (resolve via getSeam at the composition root; @wardenx/gusto-client)",
        ),
    }
  );
}

function statisticsSeamsOf(deps: M27WorkerDeps): StatisticsSeams {
  return (
    deps.statisticsSeams ?? {
      serviceMonthlyBreakdown: () =>
        unboundWorkerPort(
          "statisticsSeams.serviceMonthlyBreakdown",
          "bind `statisticsSeams` (buildM27StatisticsSeams — the M6 service census + M5 payer program ports)",
        ),
      visitCountsByDiscipline: () =>
        unboundWorkerPort(
          "statisticsSeams.visitCountsByDiscipline",
          "bind `statisticsSeams` (buildM27StatisticsSeams — the M8 visit-count port)",
        ),
      fteByDiscipline: () =>
        unboundWorkerPort(
          "statisticsSeams.fteByDiscipline",
          "bind `statisticsSeams` (buildM27StatisticsSeams — FTE from the wage import)",
        ),
      bereavementCensus: () =>
        unboundWorkerPort(
          "statisticsSeams.bereavementCensus",
          "bind `statisticsSeams` (buildM27StatisticsSeams — the M16 bereavement census port)",
        ),
    }
  );
}

function validationContextOf(deps: M27WorkerDeps): ValidationContextBuilder {
  return (
    deps.validationContext ?? {
      build: () =>
        unboundWorkerPort(
          "validationContext.build",
          "bind the ValidationContext shaper (M40 MAC + materialized worksheet/statistics/mapping/bad-debt + deadline + seam flags)",
        ),
    }
  );
}

function allocationInputsOf(deps: M27WorkerDeps): AllocationInputBuilder {
  return (
    deps.allocationInputs ?? {
      build: () =>
        unboundWorkerPort(
          "allocationInputs.build",
          "bind the allocation-input shaper (Worksheet A/S-3/mapping jsonb → step-down/ancillary/program/settlement inputs)",
        ),
    }
  );
}

function activeOrgsOf(deps: M27WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unboundWorkerPort(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the filing-deadline cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Drive the pure §2.2 lifecycle reducer for a worker-side transition; returns the resulting state or throws. */
function nextState(
  from: CostReportState,
  event: CostReportTransitionEvent,
  unresolvedBlockingFailures?: number,
): CostReportState {
  return applyTransition(from, event, { unresolvedBlockingFailures });
}

/** The §4.9 deadline tiers, ranked so an alert fires only when the tier ADVANCES past the last-emitted one. */
const TIER_RANK: Readonly<Record<schema.CostReportComplianceWindow["lastAlertTier"], number>> = {
  none: 0,
  t4_months: 1,
  t4_5_months: 2,
  t4_75_months: 3,
  past_deadline: 4,
};

/** Pure tier classifier: days-to-deadline → §4.9 tier (deadline = FYE + 5 months; tiers at ~30/15/7 days out). */
export function deadlineTierFor(
  daysToDeadline: number,
): schema.CostReportComplianceWindow["lastAlertTier"] {
  if (daysToDeadline < 0) return "past_deadline";
  if (daysToDeadline <= 7) return "t4_75_months";
  if (daysToDeadline <= 15) return "t4_5_months";
  if (daysToDeadline <= 30) return "t4_months";
  return "none";
}

/** Whole-day count from `now` to a `yyyy-mm-dd` deadline (negative when past). */
function daysToDeadline(deadlineDate: string, now: Date): number {
  const deadline = new Date(`${deadlineDate}T00:00:00.000Z`).getTime();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.round((deadline - today) / (24 * 60 * 60 * 1000));
}

// ── the eight §4.8 processors (each runs INSIDE the worker's per-job withOrgContext tx) ─────────────────

/**
 * `trial-balance-pull` (§4.5 / §4.8): create the in-flight `trial_balance_import`, pull from Xero via the
 * seam, DEK-encrypt the raw payload, persist the normalized accounts, and emit `m27.trial_balance.pulled`.
 * On any failure (seam unbound, Xero 5xx, DEK unbound) the row goes `status='failed'` + `m27.trial_balance
 * .pull_failed` is emitted (the §4.5 reconnect-prompt path) and the JOB COMPLETES rather than re-throwing —
 * this whole function runs inside the caller's `withOrgContext` transaction (`registerM27Workers`'s
 * `orgScoped` wrapper), so a re-thrown error would roll back the very "failed" bookkeeping this catch block
 * just wrote (WX-PR-013, caught by `m27-cost-report-workflow-slice.live.test.ts`'s "missing seam" case — the
 * row never actually persisted). Retrying via BullMQ would not help anyway while the seam is unbound (every
 * attempt fails identically); the durable, discoverable "failed + reconnect" state IS the terminal outcome
 * a human acts on, matching the M25 `postAdvice` precedent (mark-failed must survive the failure, not be
 * undone by it).
 */
export async function runTrialBalancePull(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: TrialBalancePullJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const imports = new ImportsRepository(tx);
  const reports = new CostReportRepository(tx);

  const report = await reports.findById(job.costReportId);
  if (!report) throw new Error(`cost_report ${job.costReportId} not found`);

  const pending = await imports.createTrialBalance({
    organizationId: job.organizationId,
    costReportId: job.costReportId,
    source: job.source as schema.TrialBalanceImport["source"],
    status: "pending",
  });

  try {
    const pulled = await trialBalanceSeamOf(deps).pull({
      organizationId: job.organizationId,
      costReportId: job.costReportId,
      fromDate: report.fiscalYearStartDate,
      toDate: report.fiscalYearEndDate,
    });
    const cipher = await dekOf(deps).encrypt(job.organizationId, pulled.rawPayload);
    const completed = await imports.completeTrialBalance(pending.id, {
      status: "complete",
      normalizedAccounts: [...pulled.normalizedAccounts],
      rawPayloadCipher: cipher,
    });
    await outbox.publish(tx, {
      eventName: "m27.trial_balance.pulled",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: {
        costReportId: job.costReportId,
        importId: completed.id,
        accountCount: pulled.normalizedAccounts.length,
        totalDebitsCents: pulled.totalDebitsCents,
        totalCreditsCents: pulled.totalCreditsCents,
        balanced: pulled.balanced,
      },
    });
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    await imports.completeTrialBalance(pending.id, { status: "failed", failureReason });
    await outbox.publish(tx, {
      eventName: "m27.trial_balance.pull_failed",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: {
        costReportId: job.costReportId,
        source: job.source,
        failureReason,
        requiresReconnect: true,
      },
    });
    // Deliberately NOT re-thrown — see the doc comment above (WX-PR-013).
  }
}

/** `wage-data-pull` (§4.5 / §4.8): the Gusto twin of {@link runTrialBalancePull} — same "mark failed and
 *  complete the job rather than re-throw" fix applies here for the identical reason (WX-PR-013). */
async function runWageDataPull(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: WageDataPullJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const imports = new ImportsRepository(tx);
  const reports = new CostReportRepository(tx);

  const report = await reports.findById(job.costReportId);
  if (!report) throw new Error(`cost_report ${job.costReportId} not found`);

  const pending = await imports.createWageData({
    organizationId: job.organizationId,
    costReportId: job.costReportId,
    source: "gusto",
    status: "pending",
  });

  try {
    const pulled = await wageDataSeamOf(deps).pull({
      organizationId: job.organizationId,
      costReportId: job.costReportId,
      fromDate: report.fiscalYearStartDate,
      toDate: report.fiscalYearEndDate,
    });
    const cipher = await dekOf(deps).encrypt(job.organizationId, pulled.rawPayload);
    const completed = await imports.completeWageData(pending.id, {
      status: "complete",
      normalizedWageRows: [...pulled.normalizedWageRows],
      rawPayloadCipher: cipher,
    });
    await outbox.publish(tx, {
      eventName: "m27.wage_data.pulled",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: {
        costReportId: job.costReportId,
        importId: completed.id,
        employeeCount: pulled.employeeCount,
        totalPaidHours: pulled.totalPaidHours,
        totalSalaryCents: pulled.totalSalaryCents,
      },
    });
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    await imports.completeWageData(pending.id, { status: "failed", failureReason });
    await outbox.publish(tx, {
      eventName: "m27.wage_data.pull_failed",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: { costReportId: job.costReportId, failureReason, requiresReconnect: true },
    });
    // Deliberately NOT re-thrown — see runTrialBalancePull's doc comment (WX-PR-013).
  }
}

/**
 * `statistics-refresh` (§4.5 / §4.8): re-aggregate the S-3 statistics from the M6/M8 seams (LIVE-if-bound)
 * into the single `statistic_data` row (upsert), counting how many month×LOC cells the service census
 * spans, and emit `m27.statistics.refreshed` with the M23/M26 deny-stub SKIP flags.
 */
export async function runStatisticsRefresh(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: StatisticsRefreshJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const reports = new CostReportRepository(tx);
  const statsRepo = new StatisticDataRepository(tx);
  const seams = statisticsSeamsOf(deps);

  const report = await reports.findById(job.costReportId);
  if (!report) throw new Error(`cost_report ${job.costReportId} not found`);
  const scope: StatisticsSeamScope = {
    organizationId: job.organizationId,
    costReportId: job.costReportId,
    providerEntityId: report.providerEntityId,
    fiscalYearStartDate: report.fiscalYearStartDate,
    fiscalYearEndDate: report.fiscalYearEndDate,
  };

  const monthlyBreakdown = await seams.serviceMonthlyBreakdown(scope);
  const visitCountsByDiscipline = await seams.visitCountsByDiscipline(scope);
  const fteCalculations = await seams.fteByDiscipline(scope);
  const bereavementCensus = await seams.bereavementCensus(scope);

  // Aggregate the service census into the §4.10 totals (sum patient-days across every month×LOC×program cell).
  let totalPatientDays = 0;
  for (const months of Object.values(monthlyBreakdown)) {
    for (const locs of Object.values(months)) {
      for (const cell of Object.values(locs)) totalPatientDays += cell.patientDays;
    }
  }
  const monthCount = Object.keys(monthlyBreakdown).length;
  const totalVisits = Object.values(visitCountsByDiscipline).reduce((a, b) => a + b, 0);

  const existing = await statsRepo.findByReport(job.organizationId, job.costReportId);
  if (existing) {
    await statsRepo.update(
      existing.id,
      { monthlyBreakdown, visitCountsByDiscipline, fteCalculations, bereavementCensus },
      existing.version,
    );
  } else {
    await statsRepo.create({
      organizationId: job.organizationId,
      costReportId: job.costReportId,
      monthlyBreakdown,
      visitCountsByDiscipline,
      fteCalculations,
      bereavementCensus,
    });
  }

  await outbox.publish(tx, {
    eventName: "m27.statistics.refreshed",
    organizationId: job.organizationId,
    aggregateKind: "cost_report",
    aggregateId: job.costReportId,
    payload: {
      costReportId: job.costReportId,
      monthCount,
      totalPatientDays,
      totalVisits,
      capProviderSkipped: deps.capProviderBound !== true,
      claimProviderSkipped: deps.patientDaysProviderBound !== true,
      // No completed wage import ⇒ the FTE map is empty (never fabricated); say so, so the worklist can ask for a pull.
      fteSourceMissing: Object.keys(fteCalculations).length === 0,
    },
  });
}

/**
 * `cost-allocation-recompute` (Form CMS-1984-14 §4320/§4330, D8 / §4.8): shape the materialized worksheet
 * state into the chain inputs (the fail-closed {@link AllocationInputBuilder} seam), run the deterministic
 * hospice chain — Worksheet B step-down (on the Worksheet B-1 statistical basis) → Worksheet C per-diem cost
 * by level of care — PERSIST the derived worksheet rows (`cost_report_worksheet` upsert, stamping
 * `computed_at`), and emit `m27.allocation.recomputed`. A full `allocate` writes B + C; a `computeWorksheet`
 * narrows to the one requested. The whole run is one org-scoped tx — writes + outbox emit commit together
 * (D8 / RULE 3a).
 */
export async function runCostAllocationRecompute(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: CostAllocationRecomputeJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const inputs = await allocationInputsOf(deps).build({
    organizationId: job.organizationId,
    costReportId: job.costReportId,
    tx,
  });

  // A → B step-down (overhead onto the four LOC centers), then B col.18 → C per-diem cost by level of care.
  const stepDown: StepDownAllocateResult = stepDownAllocate(inputs.stepDown);
  const perDiem: PerDiemResult = calculatePerDiem(buildPerDiemInput(stepDown, inputs.locDays));

  // Map the chain RESULTS back to the typed derived-worksheet `data` jsonb (the inverse of the input shaper).
  const payloads = allocationResultsToWorksheets({
    stepDown,
    perDiem,
    stepDownColumns: inputs.stepDownColumns,
  });

  // The full `allocate` recomputes B + C; a `computeWorksheet` narrows to the one requested (only the DERIVED
  // worksheets are produced — a non-derived `worksheetCode` recomputes nothing).
  const DERIVED = ["B", "C"] as const;
  const worksheetsRecomputed: WorksheetCode[] = job.worksheetCode
    ? DERIVED.filter((c) => c === job.worksheetCode)
    : [...DERIVED];

  const worksheets = new CostReportWorksheetRepository(tx);
  for (const code of worksheetsRecomputed as (typeof DERIVED)[number][]) {
    await upsertDerivedWorksheet(
      worksheets,
      job.organizationId,
      job.costReportId,
      code,
      payloads[code],
      now,
    );
  }

  await outbox.publish(tx, {
    eventName: "m27.allocation.recomputed",
    organizationId: job.organizationId,
    aggregateKind: "cost_report",
    aggregateId: job.costReportId,
    payload: {
      costReportId: job.costReportId,
      worksheetsRecomputed,
      totalAllocatedCents: stepDown.totalAllocatedToDirectCents,
    },
  });
}

/**
 * Upsert a DERIVED worksheet's recomputed `data` (B/C), stamping `computed_at`. Lazy-creates the row on
 * the first recompute; otherwise replaces `data` wholesale under §2.5 optimistic concurrency. A version
 * conflict (a concurrent recompute landed first) is retried ONCE against the fresh version; a second conflict
 * throws so BullMQ retries the whole job.
 */
async function upsertDerivedWorksheet(
  worksheets: CostReportWorksheetRepository,
  organizationId: string,
  costReportId: string,
  worksheetCode: WorksheetCode,
  payload: unknown,
  computedAt: Date,
): Promise<void> {
  const data = payload as schema.NewCostReportWorksheet["data"];
  const existing = await worksheets.findByReportAndCode(costReportId, worksheetCode);
  if (!existing) {
    await worksheets.create({ organizationId, costReportId, worksheetCode, data, computedAt });
    return;
  }
  const first = await worksheets.updateWithVersion(existing.id, existing.version, {
    data,
    computedAt,
  });
  if (first.ok) return;
  const fresh = await worksheets.findByReportAndCode(costReportId, worksheetCode);
  if (!fresh) throw new Error(`derived worksheet ${worksheetCode} vanished mid-recompute`);
  const retry = await worksheets.updateWithVersion(fresh.id, fresh.version, { data, computedAt });
  if (!retry.ok)
    throw new Error(`derived worksheet ${worksheetCode} recompute lost a concurrency race`);
}

/**
 * `validation-run` (§11.B / D9 / §4.8): finalize the in-flight `cost_report_validation` row the producer
 * opened — build the {@link ValidationContext} (the fail-closed shaper seam), run the pure rule library
 * (`DEFAULT_VALIDATION_RULES` + the NGS-J6 additive set) over it, persist the per-rule results, stamp the
 * rolled-up counts, drive the §2.2 lifecycle (`validation_complete_pass` → ready_for_review |
 * `validation_complete_fail` → populating), and emit the completed/ready/failed-to-run events. On a build/
 * run failure the run is marked `failed_to_run` (distinct from a rule failure) + `validation_failed_to_run`.
 */
export async function runValidationRun(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: ValidationRunJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const reports = new CostReportRepository(tx);
  const validations = new ValidationRepository(tx);
  const rulesRepo = new ValidationRuleRepository(tx);
  const now = deps.now ?? (() => new Date());

  const run = await validations.findRunById(job.validationId);
  if (!run) throw new Error(`cost_report_validation ${job.validationId} not found`);
  const report = await reports.findById(job.costReportId);
  if (!report) throw new Error(`cost_report ${job.costReportId} not found`);

  try {
    const ctx = await validationContextOf(deps).build({
      organizationId: job.organizationId,
      costReportId: job.costReportId,
      tx,
    });

    // The pure rule set (carries the `evaluate` predicates) is the platform-default + NGS-J6 additive set;
    // the DB rows carry the persistable rule id keyed by `rule_code` (the result FK). Run pure, persist by id.
    const pureRules: readonly RuleDef[] = [...DEFAULT_VALIDATION_RULES, ...NGS_J6_RULES];
    const dbRules = await rulesRepo.listEffective(job.organizationId, job.ruleSetVersion);
    const ruleIdByCode = new Map(dbRules.map((r) => [r.ruleCode, r.id]));

    const summary = runValidation(pureRules, ctx);

    const resultRows = summary.results
      .map((evaluated) => {
        const ruleId = ruleIdByCode.get(evaluated.ruleCode);
        if (!ruleId) return null; // the pure rule has no seeded DB row in this rule-set version — skip persistence
        return {
          organizationId: job.organizationId,
          validationId: job.validationId,
          ruleId,
          outcome: evaluated.result.outcome,
          // The pure RuleResultDetails (message/reason/observed/remediationHint) is PHI-free and structurally
          // a subset of the DB `ValidationResultDetails` (which carries an index signature); a local cast
          // bridges the two without an index-signature on the pure type (the M30 "quality_class" cast precedent).
          details: evaluated.result.details as unknown as schema.ValidationResultDetails,
        } satisfies schema.NewCostReportValidationResult;
      })
      .filter((r): r is schema.NewCostReportValidationResult => r !== null);
    await validations.createResults(resultRows);

    await validations.updateRun(job.validationId, {
      status: "complete",
      passedCount: summary.passedCount,
      failedCount: summary.failedCount,
      overriddenCount: summary.overriddenCount,
      warningCount: summary.warningCount,
      skippedCount: summary.skippedCount,
      runCompletedAt: now(),
    });

    await outbox.publish(tx, {
      eventName: "m27.cost_report.validation_completed",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: {
        costReportId: job.costReportId,
        validationId: job.validationId,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        warningCount: summary.warningCount,
        overriddenCount: summary.overriddenCount,
        skippedCount: summary.skippedCount,
        blockingRulesFailing: summary.results
          .filter((e) => e.regulatoryRequired && e.result.outcome === "fail" && !e.overridden)
          .map((e) => e.ruleCode),
      },
    });

    // §2.2 lifecycle: a clean blocking set advances to ready_for_review; otherwise back to populating.
    const event: CostReportTransitionEvent =
      summary.blockingRulesFailing === 0 ? "validation_complete_pass" : "validation_complete_fail";
    if (report.state === "validating" && canTransition(report.state, event)) {
      const to = nextState(report.state, event);
      await reports.updateWithVersion(report.id, report.version, { state: to });
      if (event === "validation_complete_pass") {
        await outbox.publish(tx, {
          eventName: "m27.cost_report.ready_for_review",
          organizationId: job.organizationId,
          aggregateKind: "cost_report",
          aggregateId: job.costReportId,
          payload: { costReportId: job.costReportId, validationId: job.validationId },
        });
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await validations.updateRun(job.validationId, {
      status: "failed_to_run",
      runCompletedAt: now(),
    });
    await outbox.publish(tx, {
      eventName: "m27.cost_report.validation_failed_to_run",
      organizationId: job.organizationId,
      aggregateKind: "cost_report",
      aggregateId: job.costReportId,
      payload: { costReportId: job.costReportId, validationId: job.validationId, reason },
    });
    throw err;
  }
}

/**
 * `snapshot-builder` (§2.4 / D10 / §4.8): freeze every worksheet `data` into a content-hashed
 * `cost_report_snapshot` row (insert-only; `prior_snapshot_id` chained from the report's current head) and
 * point `cost_report.latest_snapshot_id` at the new head. Fully real — repos + the pure `contentHashSha256`.
 */
async function runSnapshotBuilder(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: SnapshotBuilderJob,
): Promise<string> {
  const reports = new CostReportRepository(tx);
  const worksheetsRepo = new CostReportWorksheetRepository(tx);
  const snapshots = new CostReportSnapshotRepository(tx);

  const report = await reports.findById(job.costReportId);
  if (!report) throw new Error(`cost_report ${job.costReportId} not found`);

  const rows = await worksheetsRepo.listByReport(job.organizationId, job.costReportId);
  const worksheetSnapshot: Record<string, schema.WorksheetData> = {};
  for (const row of rows) worksheetSnapshot[row.worksheetCode] = row.data;

  const materializedInputs: schema.SnapshotMaterializedInputs = {
    builtAt: (deps.now ?? (() => new Date()))().toISOString(),
    version: job.version,
    reason: job.reason,
  };
  const contentHashSha256Value = contentHashSha256({ worksheetSnapshot, materializedInputs });

  const snapshot = await snapshots.create({
    organizationId: job.organizationId,
    costReportId: job.costReportId,
    priorSnapshotId: report.latestSnapshotId ?? null,
    contentHashSha256: contentHashSha256Value,
    materializedInputs,
    worksheetSnapshot,
    reason: job.reason,
    createdByMembershipId: job.createdByMembershipId,
  });
  await reports.updateWithVersion(report.id, report.version, { latestSnapshotId: snapshot.id });
  return snapshot.id;
}

/**
 * `ecr-generation` (§2.4 / D11 / §4.8): load the submission's frozen snapshot, render the ECR + PI artifact
 * strings via the pure {@link buildEcrArtifacts}, advance the `ecr_submission` to `generated`, and emit
 * `m27.artifact.render_requested` ×2 (ecr, pi) so M22 stores the bytes in MinIO + back-references the doc id.
 */
export async function runEcrGeneration(
  tx: DbClient,
  deps: M27WorkerDeps,
  job: EcrGenerationJob,
): Promise<void> {
  const outbox = outboxOf(deps);
  const submissions = new EcrSubmissionRepository(tx);
  const snapshots = new CostReportSnapshotRepository(tx);

  const submission = await submissions.findById(job.submissionId);
  if (!submission) throw new Error(`ecr_submission ${job.submissionId} not found`);
  const snapshot = await snapshots.findById(job.snapshotId);
  if (!snapshot) throw new Error(`cost_report_snapshot ${job.snapshotId} not found`);

  const artifacts = buildEcrArtifacts({
    worksheetSnapshot: snapshot.worksheetSnapshot,
    materializedInputs: snapshot.materializedInputs,
    contentHashSha256: snapshot.contentHashSha256,
  });

  await submissions.update(job.submissionId, { status: "generated" });

  for (const [artifactKind, payloadRef] of [
    ["ecr", artifacts.ecrText],
    ["pi", artifacts.piText],
  ] as const) {
    await outbox.publish(tx, {
      eventName: "m27.artifact.render_requested",
      organizationId: job.organizationId,
      aggregateKind: "ecr_submission",
      aggregateId: job.submissionId,
      payload: {
        costReportId: job.costReportId,
        submissionId: job.submissionId,
        artifactKind,
        payloadRef,
        retentionClass: "compliance",
      },
    });
  }
}

/**
 * `filing-deadline-scan` (§4.9 / D15 / §4.8 cron): the platform-scoped sweep — for each active org, list the
 * still-open compliance windows whose effective deadline is reached, classify the §4.9 tier, and when the
 * tier ADVANCES past the last-emitted one stamp it + emit `m27.compliance_window.tier_emitted` + dispatch the
 * M36 tiered alert. Pure tier math + repos are real; the org enumerator + outbox/alert are fail-closed thunks.
 */
async function runFilingDeadlineScan(deps: M27WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const outbox = outboxOf(deps);
  const alerts = alertsOf(deps);

  for (const { organizationId } of orgs) {
    await withOrgContext(
      deps.db,
      { organizationId, userId: M27_WORKER_SYSTEM_USER_ID },
      async (tx) => {
        const windows = new ComplianceWindowRepository(tx as unknown as DbClient);
        const due = await windows.listDueForScan(now, { organizationId });
        for (const window of due) {
          const days = daysToDeadline(window.currentEffectiveDeadlineDate, now);
          const tier = deadlineTierFor(days);
          if (tier === "none" || TIER_RANK[tier] <= TIER_RANK[window.lastAlertTier]) continue;

          await windows.update(window.id, { lastAlertTier: tier, lastAlertTierEmittedAt: now });
          await outbox.publish(tx, {
            eventName: "m27.compliance_window.tier_emitted",
            organizationId,
            aggregateKind: "cost_report",
            aggregateId: window.costReportId,
            payload: {
              costReportId: window.costReportId,
              tier,
              deadlineDate: window.currentEffectiveDeadlineDate,
              daysToDeadline: days,
            },
          });
          await alerts.dispatch({
            alertCode:
              tier === "past_deadline"
                ? "m27.filing_deadline.past_deadline"
                : `m27.filing_deadline.${tier}_due`,
            severity: tier === "t4_months" ? "info" : tier === "past_deadline" ? "high" : "warn",
            organizationId,
            payload: {
              costReportId: window.costReportId,
              deadlineDate: window.currentEffectiveDeadlineDate,
              daysToDeadline: days,
            },
          });
        }
      },
    );
  }
}

// ── live worker construction (the M30 m30-jobs.ts template) ──────────────────────────────────────────────

/**
 * Construct one BullMQ `Worker` per §4.8 WORK queue, each opening the per-job `withOrgContext(orgId)` RLS
 * envelope (every §4.8 work queue is ORG-scoped, F09) on the org from the job payload and running the matching
 * processor inside it over a tx-scoped repo set. Returns the workers so the composition root can `close()`
 * them on shutdown — the caller owns the lifecycle; nothing here runs at import (constructing a Worker opens
 * the Valkey connection, which must happen only in production wiring, never in tests).
 */
export function registerM27Workers(deps: M27WorkerDeps): Worker[] {
  const { connection } = deps;
  const orgScoped = <D extends { organizationId: string }, R>(
    queue: string,
    concurrency: number,
    run: (tx: DbClient, deps: M27WorkerDeps, data: D) => Promise<R>,
  ): Worker =>
    new Worker(
      queue,
      async (job) => {
        const data = job.data as D;
        return withOrgContext(
          deps.db,
          { organizationId: data.organizationId, userId: M27_WORKER_SYSTEM_USER_ID },
          (tx) => run(tx as unknown as DbClient, deps, data),
        );
      },
      { connection, concurrency },
    );

  return [
    orgScoped<TrialBalancePullJob, void>(
      M27_QUEUES.trialBalancePull,
      M27_QUEUE_PARAMS.trialBalancePull.concurrency,
      runTrialBalancePull,
    ),
    orgScoped<WageDataPullJob, void>(
      M27_QUEUES.wageDataPull,
      M27_QUEUE_PARAMS.wageDataPull.concurrency,
      runWageDataPull,
    ),
    orgScoped<StatisticsRefreshJob, void>(
      M27_QUEUES.statisticsRefresh,
      M27_QUEUE_PARAMS.statisticsRefresh.concurrency,
      runStatisticsRefresh,
    ),
    orgScoped<CostAllocationRecomputeJob, void>(
      M27_QUEUES.costAllocationRecompute,
      M27_QUEUE_PARAMS.costAllocationRecompute.concurrency,
      runCostAllocationRecompute,
    ),
    orgScoped<ValidationRunJob, void>(
      M27_QUEUES.validationRun,
      M27_QUEUE_PARAMS.validationRun.concurrency,
      runValidationRun,
    ),
    orgScoped<EcrGenerationJob, void>(
      M27_QUEUES.ecrGeneration,
      M27_QUEUE_PARAMS.ecrGeneration.concurrency,
      runEcrGeneration,
    ),
    orgScoped<SnapshotBuilderJob, string>(
      M27_QUEUES.snapshotBuilder,
      M27_QUEUE_PARAMS.snapshotBuilder.concurrency,
      runSnapshotBuilder,
    ),
  ];
}

/**
 * Construct the §4.8 CRON worker (the every-6h `filing-deadline-scan`). The cron tick carries no payload —
 * the processor reads its own ports (the active-org enumerator + the per-org compliance-window scan). The
 * per-org `withOrgContext` is opened INSIDE the processor (it fans across orgs), so the worker shell itself
 * runs platform-side. Concurrency 1 — a cron tick is a singleton. Returns the workers; the caller owns
 * `close()`. Mirrors `registerM27Workers`; nothing runs at import.
 */
export function registerM27CronWorkers(deps: M27WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M27_CRON_QUEUES.filingDeadlineScan, async () => runFilingDeadlineScan(deps), {
      connection,
      concurrency: M27_QUEUE_PARAMS.filingDeadlineScan.concurrency,
    }),
  ];
}

/**
 * Register the §4.8 repeatable cron schedule ({@link M27_JOB_SCHEDULES}) on its dedicated
 * {@link M27_CRON_QUEUES} — the filing-deadline scan every 6 hours (UTC). Returns the schedule `Queue`s so
 * the composition root can `close()` them. Mirrors `scheduleM30Jobs` (the repeatable-registration template):
 * one `Queue` per cron, `add('scheduled', {}, { repeat: { pattern } })`. Each tick is consumed by the
 * matching `registerM27CronWorkers` worker. Nothing runs at import.
 */
export async function scheduleM27Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M27CronQueueName, string][] = [
    [M27_CRON_QUEUES.filingDeadlineScan, M27_JOB_SCHEDULES.filingDeadlineScan],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}

/** Build the {@link M27WorkerDeps} from the composition-root primitives (the M30 `buildM30WorkerDeps` shape). */
export function buildM27WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  ruleSetVersion?: number;
  outbox?: WorkerOutboxPort;
  alerts?: WorkerAlertPort;
  dek?: WorkerDekPort;
  trialBalanceSeam?: TrialBalancePullSeam;
  wageDataSeam?: WageDataPullSeam;
  statisticsSeams?: StatisticsSeams;
  validationContext?: ValidationContextBuilder;
  allocationInputs?: AllocationInputBuilder;
  activeOrgs?: ActiveOrgListPort;
  patientDaysProviderBound?: boolean;
  capProviderBound?: boolean;
}): M27WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    ruleSetVersion: deps.ruleSetVersion ?? DEFAULT_RULE_SET_VERSION,
    outbox: deps.outbox,
    alerts: deps.alerts,
    dek: deps.dek,
    trialBalanceSeam: deps.trialBalanceSeam,
    wageDataSeam: deps.wageDataSeam,
    statisticsSeams: deps.statisticsSeams,
    validationContext: deps.validationContext,
    allocationInputs: deps.allocationInputs,
    activeOrgs: deps.activeOrgs,
    patientDaysProviderBound: deps.patientDaysProviderBound ?? false,
    capProviderBound: deps.capProviderBound ?? false,
    now: () => new Date(),
  };
}

// WX-PR-013 (2026-08-05) closed six of these seven items for real — see wiring.ts + index.ts:
//   • the live transactional-outbox dispatcher (`deps.outbox`) — BOUND (the pre-existing `m27OutboxPublisher`
//     is now passed into `buildM27WorkerDeps`; every §4.10 m27.* emit from a §4.8 processor lights up).
//   • the ValidationContext + allocation-input shapers — were already bound before this pass.
//   • the M2 active-org enumerator (`deps.activeOrgs`) — BOUND (`buildActiveOrgEnumerator` under
//     `withPlatformContext`, `wireM27Tenancy()` registers `M27_PLATFORM_JOB_ID` on the allowlist at boot).
//   • the M36 alert router (`deps.alerts`) — BOUND (the M25 `getSeam("AlertEmitter")` adapter pattern).
//   • the RecomputeEnqueuePort organizationId enrichment — DONE in `wiring.ts`'s `buildM27RecomputeEnqueue`
//     (parses the org id off the producer's existing dedupe-key convention; the producer call sites in
//     write-service-drizzle.ts were not touched).
// Still genuinely unbound (out of this slice's scope — see docs/audits/.../14-task-backlog.md WX-PR-013):
//   • the M1 per-tenant DEK envelope-encrypt (`deps.dek`) — needed only for the live Xero/Gusto pull path
//     (this slice's proven path, the manual trial-balance/wage-data import, never sets `raw_payload_cipher`,
//     so it does not need a DEK). RESOLVED UPSTREAM as of #105: the blocker was never M34's slice deny-stub
//     (`SLICE_MODULE_34_SEAM_DEPS` in `apps/backend/src/index.ts` — the db-less boot path, which this comment
//     named), it was the PRODUCTION path's unbound `kekUnwrap` port plus a key-ring read on a credential
//     whose SELECT is revoked. Both are bound now (`apps/backend/src/bootstrap/tenant-kek.ts`, ADR-0045), so
//     `getTenantKeyProvider().dekForOrg(orgId)` resolves and this port is a bind, not a build. What is still
//     genuinely missing for the live pull is the OAuth credential storage below, not the DEK.
//   • the M27 Xero/Gusto pull seams (`deps.trialBalanceSeam`/`deps.wageDataSeam`) — the @wardenx/xero-client
//     / @wardenx/gusto-client packages are real, structured clients, but binding a LIVE pull additionally
//     requires OAuth token storage (M34 tenant-onboarding infra) that does not exist yet — a separate,
//     larger project. `triggerTrialBalancePull`/`triggerWageDataPull` now enqueue for real (WX-PR-013) and
//     the worker fails closed with a typed `M27WorkerPortUnbound` + `status='failed'` + `*.pull_failed` when
//     it runs — never silently fabricating a pull (see `m27-cost-report-workflow-slice.live.test.ts`).
//   • the S-3 statistics seams (`deps.statisticsSeams`) — BOUND (GAP-080): `buildM27StatisticsSeams` over M6's org-explicit
//     service census, M5's payer program, M8's completed-visit counts, M16's bereavement census and M27's own wage import
//     (FTE), all injected at the composition root. An unbound `statisticsSeams` still fails closed with the typed error above.
