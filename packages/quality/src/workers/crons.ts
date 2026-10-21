// @chartwarden/quality · workers — the four §4.8 PURE cron processors (the M33 `nightly-cron` precedent).
//
// The boot scheduler (the backend `m30-crons` adapter) owns the cron tick at the §4.8 UTC times
// ({@link import("./params").M30_JOB_SCHEDULES}); each handler here owns the WORK. All four run a
// PLATFORM-scoped enumeration of the active orgs, then fan ORG-scoped jobs out onto the §4.8 work queues
// (or, for the SRA reminder calendar, emit the M36 alert directly). PURE port-injected: the org list, the
// per-org enqueue, the candidate fetch, and the alert/outbox emit are injected ports; the decision cores
// ({@link decideSraReminder}, {@link priorCalendarMonthPeriod}) are total functions unit-asserted apart
// from the I/O. No clock-derived scheduling here — the cron cadence is the boot scheduler's job.
import type { M30AlertPayloadType } from "@chartwarden/types";
import {
  type CahpsSampleCandidate,
  type CahpsSamplePeriod,
  type SampledDecedent,
  sampleDecedents,
} from "../cahps/sampler";
import type { ActiveOrgListPort } from "./ports";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── 1) m30.nightly_recompute (03:15 daily) ──────────────────────────────────────────────────────────────

/** Enqueues a full-org HQRP recompute fan-out for one org (the per-(measure,provider,period) jobs). The
 *  backend binds this over the M40 provider list × the active measure catalog × the resolved periods. */
export interface OrgRecomputeEnqueuePort {
  enqueueForOrg(orgId: string, asOf: Date): Promise<{ readonly enqueued: number }>;
}

/** The ports the nightly-recompute cron composes over. */
export interface NightlyRecomputeCronPorts {
  readonly orgs: ActiveOrgListPort;
  readonly enqueue: OrgRecomputeEnqueuePort;
  now(): Date;
}

/** What one nightly-recompute pass enqueued (the cron tick's telemetry). */
export interface NightlyRecomputeReport {
  readonly evaluatedAt: string;
  readonly orgsProcessed: number;
  readonly totalEnqueued: number;
  readonly perOrg: readonly { readonly organizationId: string; readonly enqueued: number }[];
}

/** The `m30.nightly_recompute` cron processor — enqueue a full recompute for every active org (§7.1 WF-01). */
export function nightlyRecomputeCronProcessor(
  ports: NightlyRecomputeCronPorts,
): () => Promise<NightlyRecomputeReport> {
  return () => runNightlyRecompute(ports);
}

/** Run one nightly-recompute pass: walk the active orgs and fan a per-org recompute out across each. */
export async function runNightlyRecompute(
  ports: NightlyRecomputeCronPorts,
): Promise<NightlyRecomputeReport> {
  const asOf = ports.now();
  const orgs = await ports.orgs.listActiveOrgs();
  const perOrg: { organizationId: string; enqueued: number }[] = [];
  let totalEnqueued = 0;
  for (const org of orgs) {
    const { enqueued } = await ports.enqueue.enqueueForOrg(org.organizationId, asOf);
    totalEnqueued += enqueued;
    perOrg.push({ organizationId: org.organizationId, enqueued });
  }
  return { evaluatedAt: asOf.toISOString(), orgsProcessed: orgs.length, totalEnqueued, perOrg };
}

// ── 2) m30.cahps_monthly_sample (02:00 day-2 of month) ──────────────────────────────────────────────────

/**
 * The prior COMPLETED calendar month as a CAHPS sample period (PURE). Day-2-of-month fire ⇒ the sample is
 * the whole previous month: `[YYYY-MM-01, YYYY-MM-<last day>]` inclusive, UTC. E.g. a 2026-03-02 tick →
 * `[2026-02-01, 2026-02-28]`.
 */
export function priorCalendarMonthPeriod(asOf: Date): CahpsSamplePeriod {
  const firstOfThisMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const lastOfPrev = new Date(firstOfThisMonth.getTime() - MS_PER_DAY);
  const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
  return { start: isoDate(firstOfPrev), end: isoDate(lastOfPrev) };
}

/** Render a `Date` as an ISO-8601 `YYYY-MM-DD` calendar date in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The org's active CAHPS vendor binding (the vendor-of-record stamped on each sampled row). */
export interface ActiveCahpsBinding {
  readonly vendorBindingId: string;
  readonly vendor: string;
}

/** Enumerates the prior-month decedents for an org (the death-feed candidates the sampler classifies). */
export interface DecedentCandidateReadPort {
  listPriorMonthDecedents(
    orgId: string,
    period: CahpsSamplePeriod,
  ): Promise<readonly CahpsSampleCandidate[]>;
}

/** Persists a classified sample row + reads the org's active vendor binding. */
export interface CahpsSampleWritePort {
  activeVendorBinding(orgId: string): Promise<ActiveCahpsBinding | null>;
  insertSampled(orgId: string, sampled: SampledDecedent, vendorBindingId: string): Promise<void>;
}

/** The §4.10 `m30.cahps.sample_ready` outbox emit (M36 `cahps_sample_ready` info to the QAPI Coordinator). */
export interface CahpsSampleReadyOutboxPort {
  emitSampleReady(payload: {
    readonly orgId: string;
    readonly samplePeriod: { start: string; end: string };
    readonly decedentCount: number;
    readonly vendor: string;
  }): Promise<void>;
}

/** The ports the cahps-monthly-sample cron composes over. */
export interface CahpsMonthlySampleCronPorts {
  readonly orgs: ActiveOrgListPort;
  readonly candidates: DecedentCandidateReadPort;
  readonly samples: CahpsSampleWritePort;
  readonly outbox: CahpsSampleReadyOutboxPort;
  now(): Date;
}

/** Per-org disposition the cahps-monthly-sample cron reports. */
export interface CahpsSampleDisposition {
  readonly organizationId: string;
  readonly outcome: "sampled" | "no_active_vendor";
  readonly sampled?: number;
}

/** What one cahps-monthly-sample pass built. */
export interface CahpsMonthlySampleReport {
  readonly evaluatedAt: string;
  readonly samplePeriod: { start: string; end: string };
  readonly dispositions: readonly CahpsSampleDisposition[];
}

/** The `m30.cahps_monthly_sample` cron processor — build the prior-month decedent sample per org (§7.2 WF-04). */
export function cahpsMonthlySampleCronProcessor(
  ports: CahpsMonthlySampleCronPorts,
): () => Promise<CahpsMonthlySampleReport> {
  return () => runCahpsMonthlySample(ports);
}

/**
 * Run one cahps-monthly-sample pass: for every active org with a bound vendor, enumerate the prior month's
 * decedents, classify them with the PURE {@link sampleDecedents} (CMS exclusion rules), persist the rows,
 * and emit `m30.cahps.sample_ready` once. An org with no active binding is skipped (no vendor of record).
 */
export async function runCahpsMonthlySample(
  ports: CahpsMonthlySampleCronPorts,
): Promise<CahpsMonthlySampleReport> {
  const now = ports.now();
  const period = priorCalendarMonthPeriod(now);
  const orgs = await ports.orgs.listActiveOrgs();
  const dispositions: CahpsSampleDisposition[] = [];

  for (const org of orgs) {
    const binding = await ports.samples.activeVendorBinding(org.organizationId);
    if (binding === null) {
      dispositions.push({ organizationId: org.organizationId, outcome: "no_active_vendor" });
      continue;
    }
    const candidates = await ports.candidates.listPriorMonthDecedents(org.organizationId, period);
    const sampled = sampleDecedents(candidates, period);
    for (const row of sampled) {
      await ports.samples.insertSampled(org.organizationId, row, binding.vendorBindingId);
    }
    await ports.outbox.emitSampleReady({
      orgId: org.organizationId,
      samplePeriod: { start: period.start, end: period.end },
      decedentCount: sampled.length,
      vendor: binding.vendor,
    });
    dispositions.push({
      organizationId: org.organizationId,
      outcome: "sampled",
      sampled: sampled.length,
    });
  }

  return {
    evaluatedAt: now.toISOString(),
    samplePeriod: { start: period.start, end: period.end },
    dispositions,
  };
}

// ── 3) m30.risk_register_refresh (04:00 daily) ──────────────────────────────────────────────────────────

/** Enqueues an `m30.risk_register_refresh` job (force=true) for one org, deduped on `(orgId, dateBucket)`. */
export interface RiskRefreshEnqueuePort {
  enqueueRefresh(orgId: string, dateBucket: string): Promise<{ readonly enqueued: boolean }>;
}

/** The ports the risk-register-refresh cron composes over. */
export interface RiskRegisterRefreshCronPorts {
  readonly orgs: ActiveOrgListPort;
  readonly enqueue: RiskRefreshEnqueuePort;
  now(): Date;
}

/** What one risk-register-refresh pass enqueued. */
export interface RiskRegisterRefreshCronReport {
  readonly evaluatedAt: string;
  readonly dateBucket: string;
  readonly orgsProcessed: number;
  readonly enqueued: number;
}

/** The `m30.risk_register_refresh` cron processor — force-refresh the view for every org (§7.9). */
export function riskRegisterRefreshCronProcessor(
  ports: RiskRegisterRefreshCronPorts,
): () => Promise<RiskRegisterRefreshCronReport> {
  return () => runRiskRegisterRefreshCron(ports);
}

/** Run one risk-register-refresh pass: enqueue a force-refresh per active org (day-bucketed dedup). */
export async function runRiskRegisterRefreshCron(
  ports: RiskRegisterRefreshCronPorts,
): Promise<RiskRegisterRefreshCronReport> {
  const now = ports.now();
  const dateBucket = isoDate(now);
  const orgs = await ports.orgs.listActiveOrgs();
  let enqueued = 0;
  for (const org of orgs) {
    const outcome = await ports.enqueue.enqueueRefresh(org.organizationId, dateBucket);
    if (outcome.enqueued) enqueued += 1;
  }
  return { evaluatedAt: now.toISOString(), dateBucket, orgsProcessed: orgs.length, enqueued };
}

// ── 4) m30.sra_reminders (09:00 daily) ──────────────────────────────────────────────────────────────────

/** The §4.9 SRA reminder-calendar milestones (days before the anniversary the cron fires a reminder on). */
export const SRA_REMINDER_MILESTONE_DAYS = [90, 60, 30, 7] as const;

/** One open SRA cycle the platform scan returns, with its anniversary (`sra_cycle.due_at`). */
export interface OpenSraCycle {
  readonly organizationId: string;
  readonly cycleId: string;
  /** The SRA anniversary / due date the reminder calendar counts down to. */
  readonly dueAt: Date;
}

/** Lists every OPEN (un-closed) SRA cycle across all orgs with its `due_at` (platform-scoped cron scan). */
export interface OpenSraCycleReadPort {
  listOpenCyclesWithDue(): Promise<readonly OpenSraCycle[]>;
}

/** Dispatches one §4.9 SRA alert payload into M36 (via the outbox). FAIL-CLOSED until the live M36 alert
 *  router / transactional-outbox lands (the M33 precedent: alerts ship as defs, fire through the outbox). */
export interface SraReminderAlertPort {
  dispatch(payloadType: M30AlertPayloadType, payload: Record<string, unknown>): Promise<void>;
}

/** The ports the sra-reminders cron composes over. */
export interface SraRemindersCronPorts {
  readonly cycles: OpenSraCycleReadPort;
  readonly alerts: SraReminderAlertPort;
  now(): Date;
}

/** The reminder decision for one open cycle: which §4.9 alert (if any) fires at `now`. */
export type SraReminderDecision =
  /** Past the anniversary, cycle still open → the daily `sra_overdue` escalation. */
  | {
      readonly kind: "overdue";
      readonly payloadType: "m30.alerts.sra_overdue";
      readonly daysOverdue: number;
    }
  /** A milestone day before the anniversary → the matching `sra_due_*` reminder. */
  | {
      readonly kind: "milestone";
      readonly milestoneDays: number;
      readonly payloadType: M30AlertPayloadType;
      readonly daysRemaining: number;
    }
  /** Not a milestone day and not overdue → nothing fires this tick. */
  | { readonly kind: "none" };

/**
 * Map a pre-anniversary milestone to its §4.9 alert payload type (PURE). The payload catalog
 * (`packages/types`) defines `sra_due_90 | sra_due_60 | sra_due_30` + `sra_overdue` — there is NO
 * `sra_due_7`, so the 7-day milestone folds into the HIGH `sra_due_30` escalation (the closest existing
 * pre-anniversary alert); the payload still carries the true `daysRemaining=7`.
 */
function milestoneToPayloadType(milestoneDays: number): M30AlertPayloadType {
  switch (milestoneDays) {
    case 90:
      return "m30.alerts.sra_due_90";
    case 60:
      return "m30.alerts.sra_due_60";
    default:
      // 30 and the 7-day near-anniversary milestone both fire the HIGH `sra_due_30` escalation.
      return "m30.alerts.sra_due_30";
  }
}

/**
 * Decide the SRA reminder for one open cycle at `now` (PURE, total). Overdue (past `dueAt`) fires the daily
 * `sra_overdue`; otherwise a reminder fires only when the whole-day count down to the anniversary lands
 * exactly on a {@link SRA_REMINDER_MILESTONE_DAYS} milestone (a daily cron hits each milestone once).
 */
export function decideSraReminder(dueAt: Date, now: Date): SraReminderDecision {
  const daysRemaining = Math.floor((dueAt.getTime() - now.getTime()) / MS_PER_DAY);
  if (daysRemaining < 0) {
    return { kind: "overdue", payloadType: "m30.alerts.sra_overdue", daysOverdue: -daysRemaining };
  }
  for (const milestone of SRA_REMINDER_MILESTONE_DAYS) {
    if (daysRemaining === milestone) {
      return {
        kind: "milestone",
        milestoneDays: milestone,
        payloadType: milestoneToPayloadType(milestone),
        daysRemaining,
      };
    }
  }
  return { kind: "none" };
}

/** Per-cycle disposition the sra-reminders cron reports. */
export interface SraReminderDisposition {
  readonly organizationId: string;
  readonly cycleId: string;
  readonly payloadType: M30AlertPayloadType;
}

/** What one sra-reminders pass dispatched. */
export interface SraRemindersReport {
  readonly evaluatedAt: string;
  readonly cyclesEvaluated: number;
  readonly dispatched: readonly SraReminderDisposition[];
}

/** The `m30.sra_reminders` cron processor — evaluate the 90/60/30/7-day reminder calendar (§4.9 / W-M30-30). */
export function sraRemindersCronProcessor(
  ports: SraRemindersCronPorts,
): () => Promise<SraRemindersReport> {
  return () => runSraReminders(ports);
}

/**
 * Run one sra-reminders pass: walk every open SRA cycle, decide its reminder (pure), and dispatch the §4.9
 * alert for the cycles that hit a milestone / are overdue. The build of the PHI-free payload is inline; the
 * actual M36 dispatch is the injected (fail-closed) alert port.
 */
export async function runSraReminders(ports: SraRemindersCronPorts): Promise<SraRemindersReport> {
  const now = ports.now();
  const cycles = await ports.cycles.listOpenCyclesWithDue();
  const dispatched: SraReminderDisposition[] = [];

  for (const cycle of cycles) {
    const decision = decideSraReminder(cycle.dueAt, now);
    if (decision.kind === "none") continue;

    const payload =
      decision.kind === "overdue"
        ? {
            organizationId: cycle.organizationId,
            cycleId: cycle.cycleId,
            anniversaryAt: cycle.dueAt.toISOString(),
            daysOverdue: decision.daysOverdue,
          }
        : {
            organizationId: cycle.organizationId,
            cycleId: cycle.cycleId,
            anniversaryAt: cycle.dueAt.toISOString(),
            daysRemaining: decision.daysRemaining,
          };

    await ports.alerts.dispatch(decision.payloadType, payload);
    dispatched.push({
      organizationId: cycle.organizationId,
      cycleId: cycle.cycleId,
      payloadType: decision.payloadType,
    });
  }

  return { evaluatedAt: now.toISOString(), cyclesEvaluated: cycles.length, dispatched };
}
