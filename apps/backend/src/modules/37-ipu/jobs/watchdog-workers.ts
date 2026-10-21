// apps/backend/src/modules/37-ipu/jobs/watchdog-workers.ts — GAP-105 (#174): the five remaining §4.8 crons
// (irc-cap-watchdog, census-snapshot-builder, restraint-reassessment-watchdog, bed-cleaning-sla-watchdog,
// gip-criteria-staleness-sweep), each a plain async function over the same dep bag as the rn-coverage
// watchdog so the live suite drives them directly and `cron-workers.ts` only binds them to BullMQ.
//
// Every cron is (1) PER-ORG — one `withOrgContext` tx per org, tenant = the enumerated org, never ambient;
// (2) BOUNDED — a per-org row cap, so one tenant cannot hold a worker; (3) IDEMPOTENT — a re-run on the same
// data writes nothing and publishes nothing new (derived targets / existence checks) or raises an alert whose
// deterministic correlation id collapses into the one already raised; and (4) ISOLATED — one org's failure is
// collected and rethrown AFTER the others ran, so the job still fails into the DLQ without denying every org
// that sorts after it. Events go through the transactional outbox in the SAME tx as the write they announce.
import { type DbClient, organizationTimezone } from "@chartwarden/db";
import { buildCensusSnapshotPayload } from "@chartwarden/inpatient";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { withOrgContext } from "@chartwarden/tenancy";
import type { WriteOutboxPort } from "../routes/service-drizzle";
import {
  M37_WATCHDOG_QUEUES,
  M37_WATCHDOG_QUEUE_PARAMS,
  M37_WATCHDOG_SCHEDULES,
  addDaysToIsoDate,
  planBedCleaningOverdue,
  planGipStaleness,
  planIrcCatchUp,
  planRestraintReassessmentDue,
} from "./watchdog-plans";
import {
  activeRestraints,
  advanceIrcEpisode,
  bedsAwaitingTurnover,
  censusBuckets,
  gipAdmissionsForSweep,
  insertCensusSnapshotIfAbsent,
  openIrcEpisodes,
  serviceDateBounds,
  unitIncidentCounts,
} from "./watchdog-store";

/**
 * The dep bag a watchdog tick needs — structurally what `cron-workers.ts`'s `M37WorkerDeps` carries (declared
 * here rather than imported so the two files do not import each other).
 */
export interface M37WorkerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly activeOrgs?: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** M8's org-explicit signed-encounter read, for the nursing-note shift watchdog (`lifecycle-workers.ts`). */
  readonly signedEncounters?: SignedEncountersPort;
  now?: () => Date;
}

/**
 * M8's `SignedEncountersReader.signedEncountersForPatientSince`, structurally and org-explicit — M37 reads no
 * M8 table (`arch:tables`); the composition root adapts the registered seam to this shape.
 */
export interface SignedEncountersPort {
  signedEncountersForPatientSince(
    organizationId: string,
    patientId: string,
    sinceIso: string,
  ): Promise<readonly { readonly signedAt: string; readonly signedByMembershipId: string }[]>;
}

/** Audit attribution for the cron's tx. The empty string is the established system-write idiom: the session
 *  GUC then reads as NULL, where a synthetic uuid would 23503 on the PHI audit trigger's FK into `user.id`
 *  (the M6 F-178b finding). */
const SYSTEM_USER_ID = "";

/** Per-org row caps (bounded work per tick). A tenant over the cap is caught up on the following ticks. */
export const M37_WATCHDOG_ROW_LIMIT = 2_000;
/** The census re-checks this many closed service dates, so a day lost to an outage is rebuilt, not skipped. */
export const CENSUS_BACKFILL_DAYS = 3;

export type Tx = DbClient;

export function nowOf(deps: M37WorkerDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/**
 * Run `work` once per active org in its own tenancy tx, isolating failures. Rethrows an AggregateError after
 * the loop when any org failed (so BullMQ retries/DLQs the job) — never mid-loop.
 */
export async function forEachOrg(
  deps: M37WorkerDeps,
  label: string,
  work: (tx: Tx, organizationId: string) => Promise<void>,
): Promise<void> {
  if (!deps.activeOrgs) {
    throw new Error(
      `M37_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — ${label} needs the M2 active-org enumerator`,
    );
  }
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
        await work(scoped as unknown as Tx, organizationId);
      });
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `${label}: ${failures.length} of ${orgs.length} org(s) failed — ${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

// ── irc-cap-watchdog (§2.5 D6) ───────────────────────────────────────────────────────────────────────────

/**
 * Advance every open IRC episode to the tenant-local day it is today and raise `cap_approaching` (day 4) /
 * `cap_breached` (day 5+) on state ENTRY. Before this cron nothing advanced an episode, so
 * `consecutive_day_count` stayed 1, the episode never left `active`, and the day-6+ billing gate
 * (`m37.irc_episode.within_cap`) could never close.
 */
export async function runIrcCapWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const now = nowOf(deps);
  await forEachOrg(deps, "M37_IRC_CAP_WATCHDOG", async (tx, organizationId) => {
    const timezone = await organizationTimezone(tx, organizationId);
    const today = localDateInTimeZone(now, timezone);
    const episodes = await openIrcEpisodes(tx, organizationId, timezone, M37_WATCHDOG_ROW_LIMIT);
    for (const episode of episodes) {
      const plan = planIrcCatchUp(episode, today);
      if (!plan) continue;
      const applied = await advanceIrcEpisode(tx, episode, plan);
      if (!applied) continue; // lost an optimistic race with an override; the next tick re-derives
      for (const e of plan.events) {
        await deps.outbox.publish(tx, {
          eventName: e.event,
          payload: {
            ipuAdmissionId: episode.ipuAdmissionId,
            organizationId,
            consecutiveDayCount: e.consecutiveDayCount,
          },
          organizationId,
          aggregateKind: "irc_episode",
          aggregateId: episode.id,
        });
      }
    }
  });
}

// ── census-snapshot-builder (§2.13 D14, D15) ─────────────────────────────────────────────────────────────

/**
 * Build `ipu_census_snapshot` for each CLOSED tenant-local service date (yesterday and the previous
 * {@link CENSUS_BACKFILL_DAYS}-1 days) per own unit and per arranged remote facility, and publish
 * `m37.census.snapshot_taken` once per row written. A key that already has a snapshot is skipped and emits
 * nothing, so an hourly cadence, a retry and a backfill all converge on one row and one event.
 *
 * Fall / infection counts are 0: they are M30 incident-report projections and M37 owns no seam to read them
 * (the spec's "M37 rows + M30 projections"); the M37-owned counts (turnover, restraint) are real.
 */
export async function runCensusSnapshotBuilderCron(deps: M37WorkerDeps): Promise<void> {
  const now = nowOf(deps);
  await forEachOrg(deps, "M37_CENSUS_SNAPSHOT_BUILDER", async (tx, organizationId) => {
    const timezone = await organizationTimezone(tx, organizationId);
    const today = localDateInTimeZone(now, timezone);
    for (let back = 1; back <= CENSUS_BACKFILL_DAYS; back++) {
      await buildCensusForDate(deps, tx, organizationId, timezone, addDaysToIsoDate(today, -back));
    }
  });
}

async function buildCensusForDate(
  deps: M37WorkerDeps,
  tx: Tx,
  organizationId: string,
  timezone: string,
  serviceDate: string,
): Promise<void> {
  const bounds = await serviceDateBounds(tx, serviceDate, timezone);
  const buckets = await censusBuckets(tx, organizationId, bounds);
  for (const bucket of buckets) {
    const incidents = bucket.unitId
      ? await unitIncidentCounts(tx, organizationId, bucket.unitId, bounds)
      : {
          roomTurnoverCount: 0,
          restraintIncidentCount: 0,
          fallIncidentCount: 0,
          infectionSurveillanceEventCount: 0,
        };
    const payload = buildCensusSnapshotPayload(
      {
        organizationId,
        providerEntityId: bucket.providerEntityId,
        serviceDate,
        unitId: bucket.unitId,
        remoteFacilityId: bucket.remoteFacilityId,
      },
      bucket.admissions,
      incidents,
    );
    const written = await insertCensusSnapshotIfAbsent(tx, payload);
    if (!written) continue;
    await deps.outbox.publish(tx, {
      eventName: "m37.census.snapshot_taken",
      payload: { ...payload },
      organizationId,
      aggregateKind: "ipu_census_snapshot",
      aggregateId: bucket.unitId ?? (bucket.remoteFacilityId as string),
    });
  }
}

// ── restraint-reassessment-watchdog (§2.10 D11) ──────────────────────────────────────────────────────────

/** Raise `m37.restraint.reassessment_due` for every active restraint past its interval, once per nag cycle. */
export async function runRestraintReassessmentWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_RESTRAINT_WATCHDOG", async (tx, organizationId) => {
    const restraints = await activeRestraints(tx, organizationId, M37_WATCHDOG_ROW_LIMIT);
    for (const due of planRestraintReassessmentDue(restraints, nowMs)) {
      await deps.outbox.publish(tx, {
        eventName: "m37.restraint.reassessment_due",
        payload: {
          organizationId,
          restraintEventId: due.restraintEventId,
          ipuAdmissionId: due.ipuAdmissionId,
          dueAt: new Date(due.dueAtMs).toISOString(),
          reminderCycle: due.cycle,
        },
        organizationId,
        aggregateKind: "ipu_restraint_event",
        aggregateId: due.restraintEventId,
      });
    }
  });
}

// ── bed-cleaning-sla-watchdog (§2.12 D13) ────────────────────────────────────────────────────────────────

/** Raise `m37.bed.cleaning_overdue` for each bed past its unit's turnover SLA, once per SLA period. */
export async function runBedCleaningSlaWatchdogCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_BED_CLEANING_WATCHDOG", async (tx, organizationId) => {
    const beds = await bedsAwaitingTurnover(tx, organizationId, M37_WATCHDOG_ROW_LIMIT);
    for (const overdue of planBedCleaningOverdue(beds, nowMs)) {
      await deps.outbox.publish(tx, {
        eventName: "m37.bed.cleaning_overdue",
        payload: {
          bedId: overdue.bedId,
          organizationId,
          unitId: overdue.unitId,
          dischargedDirtyAt: new Date(overdue.dischargedDirtyAtMs).toISOString(),
          slaMinutes: overdue.slaMinutes,
          reminderCycle: overdue.cycle,
        },
        organizationId,
        aggregateKind: "ipu_bed",
        aggregateId: overdue.bedId,
      });
    }
  });
}

// ── gip-criteria-staleness-sweep (§2.4 D5) ───────────────────────────────────────────────────────────────

/**
 * Raise `m37.gip_criteria.reassessment_due` for each active GIP admission with no reassessment in 72 hours.
 *
 * The spec also says "despite ongoing encounters" — i.e. the sweep is the backstop for the
 * `m8.encounter.signed` trigger. M37 reads no M8 table and has no encounter seam, so the encounter half is
 * NOT applied: the sweep is conservative the other way (it flags a stale GIP stay whether or not visits are
 * being made, which is the more cautious reading for a CoP 418.108 criterion). Nightly, so the daily
 * correlation key makes a stale admission one alert per night rather than one per run.
 */
export async function runGipCriteriaStalenessSweepCron(deps: M37WorkerDeps): Promise<void> {
  const nowMs = nowOf(deps).getTime();
  await forEachOrg(deps, "M37_GIP_STALENESS_SWEEP", async (tx, organizationId) => {
    const admissions = await gipAdmissionsForSweep(tx, organizationId, M37_WATCHDOG_ROW_LIMIT);
    for (const stale of planGipStaleness(admissions, nowMs)) {
      await deps.outbox.publish(tx, {
        eventName: "m37.gip_criteria.reassessment_due",
        payload: {
          ipuAdmissionId: stale.ipuAdmissionId,
          organizationId,
          triggeredByEncounterId: null,
          lastAssessedAt: new Date(stale.lastAssessedAtMs).toISOString(),
          staleHours: stale.staleHours,
          sweepDate: new Date(nowMs).toISOString().slice(0, 10),
        },
        organizationId,
        aggregateKind: "ipu_admission",
        aggregateId: stale.ipuAdmissionId,
      });
    }
  });
}

// ── the §4.8 job table (read by `cron-workers.ts`, which owns the BullMQ construction) ───────────────────

/** One watchdog cron: its queue, repeat pattern, BullMQ parameters and the function a tick runs. */
export interface M37WatchdogJob {
  readonly queue: string;
  readonly schedule: string;
  readonly params: {
    readonly priority: number;
    readonly attempts: number;
    readonly backoff: string;
    readonly concurrency: number;
  };
  readonly run: (deps: M37WorkerDeps) => Promise<void>;
}

export const M37_WATCHDOG_JOBS: readonly M37WatchdogJob[] = [
  {
    queue: M37_WATCHDOG_QUEUES.ircCapWatchdog,
    schedule: M37_WATCHDOG_SCHEDULES.ircCapWatchdog,
    params: M37_WATCHDOG_QUEUE_PARAMS.ircCapWatchdog,
    run: runIrcCapWatchdogCron,
  },
  {
    queue: M37_WATCHDOG_QUEUES.censusSnapshotBuilder,
    schedule: M37_WATCHDOG_SCHEDULES.censusSnapshotBuilder,
    params: M37_WATCHDOG_QUEUE_PARAMS.censusSnapshotBuilder,
    run: runCensusSnapshotBuilderCron,
  },
  {
    queue: M37_WATCHDOG_QUEUES.restraintReassessmentWatchdog,
    schedule: M37_WATCHDOG_SCHEDULES.restraintReassessmentWatchdog,
    params: M37_WATCHDOG_QUEUE_PARAMS.restraintReassessmentWatchdog,
    run: runRestraintReassessmentWatchdogCron,
  },
  {
    queue: M37_WATCHDOG_QUEUES.bedCleaningSlaWatchdog,
    schedule: M37_WATCHDOG_SCHEDULES.bedCleaningSlaWatchdog,
    params: M37_WATCHDOG_QUEUE_PARAMS.bedCleaningSlaWatchdog,
    run: runBedCleaningSlaWatchdogCron,
  },
  {
    queue: M37_WATCHDOG_QUEUES.gipCriteriaStalenessSweep,
    schedule: M37_WATCHDOG_SCHEDULES.gipCriteriaStalenessSweep,
    params: M37_WATCHDOG_QUEUE_PARAMS.gipCriteriaStalenessSweep,
    run: runGipCriteriaStalenessSweepCron,
  },
];
