// apps/backend/src/modules/15-discipline-care-plans/jobs/cron-workers.ts — GAP-044 (spec §4.6).
//
// The live BullMQ runtime for the five M15 crons that had no code at all (supervisory overdue, MSW and
// chaplain initial overdue, volunteer gate-watcher, volunteer hour aggregator). Pattern follows M6/M8:
// active-org fan-out -> `withOrgContext` -> store read -> PURE planner (`./index`) -> in-transaction
// outbox publish. A tick is NOT a request, so nothing here touches the ambient request context: every
// tenant read/write opens its own org-explicit envelope.
//
// `userId: ""` is the established system-write idiom (see M6's F-178b note): the audit triggers on the
// tables the gate-watcher / aggregator write read `app.user_id` as NULL, whereas a synthetic uuid would
// 23503 on the audit `user` FK.
//
// PER-ORG FAN-OUT (retry idempotency). The repeatable "scheduled" job only ENUMERATES: it enqueues one job
// per due org with a deterministic jobId (`<cron>__<org>__<hour bucket>`), and the per-org job does the work
// in ONE org transaction (state flips, stamps and outbox publishes commit or roll back together). A BullMQ
// retry after a partial multi-org failure therefore re-runs only the orgs that failed — an org that already
// committed is never re-run, and re-adding the same jobIds is a no-op. The hourly tick also applies the
// org-local-hour gate (see `./index`). The `run*Cron(deps)` all-orgs entry points remain for direct
// invocation (tests / manual replay) and isolate failures per org, rethrowing one summary at the end.
import { type DbClient, organizationTimezone } from "@chartwarden/db";
import { fiscalYearFor } from "@chartwarden/discipline-plans";
import { withOrgContext } from "@chartwarden/tenancy";
import type { EncounterId, IsoInstant, MembershipId, PatientId } from "@chartwarden/types";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { computeStaffPatientCareTally } from "../consumers/patient-care-hours";
import { resolveVolunteerVisitCandidates } from "../consumers/volunteer-visits";
import type { WriteOutboxPort } from "../routes/write-service";
import {
  type VolunteerVisitCandidate,
  aggregateVolunteerHours,
  computeVolunteerHourRatio,
  decideExpireGate,
  decideInactivateAssignmentsForGate,
} from "../volunteer/index";
import { denominatorFromTally } from "../volunteer/patient-care-hours";
import {
  flipGateStatus,
  inactivateAssignments,
  insertLedgerEntries,
  ledgerEntries,
  liveGatesForOrg,
  lockLedger,
  openAssignmentsForVolunteer,
  overdueSupervisoryPlansForOrg,
  servedPatientsByProviderEntity,
  setLedgerPatientCare,
  setLedgerTotal,
  stampGateNotice,
  unsatisfiedInitialClockPlansForOrg,
} from "./cron-store";
import {
  M15_JOB_SCHEDULES,
  M15_LOCAL_HOURS,
  M15_QUEUES,
  M15_QUEUE_PARAMS,
  expiryCascades,
  localHourIn,
  planGateWatcher,
  planInitialOverdue,
  planMswInitialAlerts,
  planSupervisoryOverdue,
} from "./index";

const SYSTEM_ACTOR = { userId: "" } as const;

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M15WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  now?: () => Date;
}

export function buildM15WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  activeOrgs?: ActiveOrgListPort;
  log?: M15WorkerDeps["log"];
}): M15WorkerDeps {
  return { ...deps, now: () => new Date() };
}

function activeOrgsOf(deps: M15WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        Promise.reject(
          new Error("M15_WORKER_PORT_UNBOUND: activeOrgs — bind the M2 active-org enumerator"),
        ),
    }
  );
}

const clock = (deps: M15WorkerDeps): Date => (deps.now ?? (() => new Date()))();

/** Run `fn` for every active org, isolating failures; rethrow one summary error after the last org. */
async function forEachActiveOrg(
  deps: M15WorkerDeps,
  label: string,
  fn: (organizationId: string) => Promise<void>,
): Promise<void> {
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const failures: string[] = [];
  for (const { organizationId } of orgs) {
    try {
      await fn(organizationId);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`M15_CRON_PARTIAL_FAILURE ${label}: ${failures.join("; ")}`);
  }
}

/** One org's transaction under the system actor. */
const inOrg = <T>(deps: M15WorkerDeps, organizationId: string, fn: (t: DbClient) => Promise<T>) =>
  withOrgContext(deps.db, { organizationId, ...SYSTEM_ACTOR }, (tx) =>
    fn(tx as unknown as DbClient),
  );

/** §7.1 — one org: one `m15.aide_supervisory.overdue` per breached 418.76(h) clock. */
export async function runSupervisoryOverdueForOrg(
  deps: M15WorkerDeps,
  organizationId: string,
): Promise<void> {
  const now = clock(deps);
  await inOrg(deps, organizationId, async (t) => {
    const rows = await overdueSupervisoryPlansForOrg(t, organizationId, now);
    for (const e of planSupervisoryOverdue(rows, now.toISOString())) {
      await deps.outbox.publish(t, {
        organizationId,
        eventName: "m15.aide_supervisory.overdue",
        payload: { planId: e.planId, hoursOverdue: e.hoursOverdue, severity: e.severity },
        aggregateKind: "discipline_care_plan",
        aggregateId: e.planId,
      });
    }
  });
}

/**
 * §7.2 — one org: `m15.msw.assessment_initial_overdue` on the ladder `warn` (day 3 until the clock lapses) →
 * `critical` (day 5+, CoP 418.54(c)); see {@link planMswInitialAlerts} for the spec citation.
 */
export async function runMswInitialOverdueForOrg(
  deps: M15WorkerDeps,
  organizationId: string,
): Promise<void> {
  const now = clock(deps);
  await inOrg(deps, organizationId, async (t) => {
    const rows = await unsatisfiedInitialClockPlansForOrg(t, organizationId, "msw_plan");
    for (const e of planMswInitialAlerts(rows, now.toISOString())) {
      await deps.outbox.publish(t, {
        organizationId,
        eventName: "m15.msw.assessment_initial_overdue",
        payload: {
          planId: e.planId,
          admissionId: e.admissionId,
          daysOverdue: e.daysOverdue,
          severity: e.severity,
        },
        aggregateKind: "discipline_care_plan",
        aggregateId: e.planId,
      });
    }
  });
}

/** §7.3 — one org: `m15.chaplain.assessment_initial_overdue`; a recorded declination satisfies the clock. */
export async function runChaplainInitialOverdueForOrg(
  deps: M15WorkerDeps,
  organizationId: string,
): Promise<void> {
  const now = clock(deps);
  await inOrg(deps, organizationId, async (t) => {
    const rows = await unsatisfiedInitialClockPlansForOrg(t, organizationId, "spiritual_plan");
    for (const e of planInitialOverdue(rows, now.toISOString())) {
      await deps.outbox.publish(t, {
        organizationId,
        eventName: "m15.chaplain.assessment_initial_overdue",
        payload: { planId: e.planId, admissionId: e.admissionId, daysOverdue: e.daysOverdue },
        aggregateKind: "discipline_care_plan",
        aggregateId: e.planId,
      });
    }
  });
}

/**
 * §7.5 — one org's gate watcher, in ONE transaction: flip elapsed gates to `expired` (emitting
 * `m15.volunteer.gate_expired` and, for a blocking kind with open assignments, inactivating them and emitting
 * `m15.volunteer.assignment_inactivated`), mark gates entering the 30-day lead-in `expiring_soon`, and emit
 * `m15.volunteer.gate_expiring` for the tightest ladder mark crossed and not yet notified, stamping
 * `last_expiry_notice_days_out` in the same transaction (a missed run still sends the right notice once; a
 * replay sends nothing). Status flips and the stamp are guarded, so only the winning replica emits.
 */
export async function runVolunteerGateWatcherForOrg(
  deps: M15WorkerDeps,
  organizationId: string,
): Promise<void> {
  const now = clock(deps);
  const nowIso = now.toISOString();
  await inOrg(deps, organizationId, async (t) => {
    const gates = await liveGatesForOrg(t, organizationId);
    const facts = gates.map((g) => ({
      ...g,
      gateId: g.gateId as never,
      volunteerMembershipId: g.volunteerMembershipId as MembershipId,
    }));
    const plan = planGateWatcher(facts, nowIso);

    for (const g of plan.toExpire) {
      const decision = decideExpireGate(g, nowIso);
      if (decision.status !== "expired") continue;
      if (!(await flipGateStatus(t, organizationId, g.gateId, "expired", now))) continue;
      const cascade = expiryCascades(g)
        ? decideInactivateAssignmentsForGate({
            volunteerMembershipId: g.volunteerMembershipId,
            gateKind: g.gateKind,
            openAssignments: await openAssignmentsForVolunteer(
              t,
              organizationId,
              g.volunteerMembershipId,
            ),
            at: nowIso,
          })
        : null;
      const reason = cascade?.inactivations[0]?.inactivationReason ?? "";
      if (cascade && cascade.inactivations.length > 0) {
        await inactivateAssignments(
          t,
          organizationId,
          cascade.inactivations.map((i) => i.assignmentId),
          reason,
          now,
        );
      }
      await deps.outbox.publish(t, {
        organizationId,
        eventName: "m15.volunteer.gate_expired",
        payload: {
          volunteerMembershipId: g.volunteerMembershipId,
          gateKind: g.gateKind,
          expiredAt: nowIso,
          openAssignmentsCount: cascade?.openAssignmentsCount ?? 0,
        },
        aggregateKind: "volunteer_compliance_gate",
        aggregateId: g.gateId,
      });
      if (cascade && cascade.inactivations.length > 0) {
        await deps.outbox.publish(t, {
          organizationId,
          eventName: "m15.volunteer.assignment_inactivated",
          payload: {
            volunteerMembershipId: g.volunteerMembershipId,
            affectedPlanIds: [...cascade.affectedPlanIds],
            reason,
          },
          aggregateKind: "volunteer_compliance_gate",
          aggregateId: g.gateId,
        });
      }
    }

    for (const g of plan.toMarkExpiringSoon) {
      await flipGateStatus(t, organizationId, g.gateId, "expiring_soon", now);
    }

    for (const n of plan.notices) {
      if (!(await stampGateNotice(t, organizationId, n.gateId, n.daysOut, now))) continue;
      await deps.outbox.publish(t, {
        organizationId,
        eventName: "m15.volunteer.gate_expiring",
        payload: {
          volunteerMembershipId: n.volunteerMembershipId,
          gateKind: n.gateKind,
          validUntil: n.validUntil,
          daysOut: n.daysOut,
          severity: n.severity,
        },
        aggregateKind: "volunteer_compliance_gate",
        aggregateId: n.gateId,
      });
    }
  });
}

/** Resolve one PE's signed volunteer visits; each candidate carries M8's digest `durationMinutes` (null = unresolved). */
async function visitCandidatesFor(
  organizationId: string,
  served: ReadonlyArray<{ patientId: string; volunteerMembershipId: string }>,
  since: IsoInstant,
): Promise<ReadonlyArray<VolunteerVisitCandidate>> {
  return resolveVolunteerVisitCandidates({
    orgId: organizationId,
    servedPatients: served.map((s) => ({
      patientId: s.patientId as PatientId,
      volunteerMembershipId: s.volunteerMembershipId as MembershipId,
    })),
    since,
  });
}

/**
 * §7.6 — one org's volunteer-hour aggregator. Per (provider entity × fiscal year) bucket that has signed
 * volunteer visits: lock the ledger row, append `volunteer_hour_entry` rows for visits not yet ledgered
 * (idempotent on `source_encounter_id`), refresh the ledger total, and emit `m15.volunteer.ratio_recomputed`
 * when the pass changed anything. Visits whose duration cannot be resolved are logged, never counted as 0.
 * The current and previous fiscal year are both scanned so a visit signed after the year turned still
 * lands in the year it was served. Each bucket commits in its own transaction and is idempotent, so a retry
 * of this org's job re-does nothing that already landed.
 */
export async function runVolunteerHourAggregatorForOrg(
  deps: M15WorkerDeps,
  organizationId: string,
): Promise<void> {
  const now = clock(deps);
  const currentFy = fiscalYearFor(now.toISOString());
  const since = `${currentFy - 1}-01-01T00:00:00.000Z`;
  const served = await inOrg(deps, organizationId, (t) =>
    servedPatientsByProviderEntity(t, organizationId),
  );
  const byPe = new Map<string, { patientId: string; volunteerMembershipId: string }[]>();
  for (const s of served) {
    byPe.set(s.providerEntityId, [...(byPe.get(s.providerEntityId) ?? []), s]);
  }
  for (const [providerEntityId, servedForPe] of byPe) {
    const candidates = await visitCandidatesFor(organizationId, servedForPe, since);
    // The current year is always refreshed so the persisted denominator exists even before any volunteer
    // visit is ledgered (a 0-volunteer-minutes ratio against real staff hours is a genuine red, not unavailable).
    // A provider entity with plans but NO volunteer assignment is not enumerated here (documented limitation).
    const fiscalYears = [
      ...new Set([currentFy, ...candidates.map((c) => fiscalYearFor(c.occurredAt))]),
    ];
    for (const fiscalYear of fiscalYears) {
      await aggregateBucket(deps, now, {
        organizationId,
        providerEntityId,
        fiscalYear,
        candidates,
      });
    }
  }
}

/** All-orgs entry points (direct invocation / manual replay); the live schedule fans out per org instead. */
export const runSupervisoryOverdueCron = (deps: M15WorkerDeps) =>
  forEachActiveOrg(deps, "supervisory-overdue", (o) => runSupervisoryOverdueForOrg(deps, o));
export const runMswInitialOverdueCron = (deps: M15WorkerDeps) =>
  forEachActiveOrg(deps, "msw-initial-overdue", (o) => runMswInitialOverdueForOrg(deps, o));
export const runChaplainInitialOverdueCron = (deps: M15WorkerDeps) =>
  forEachActiveOrg(deps, "chaplain-initial-overdue", (o) =>
    runChaplainInitialOverdueForOrg(deps, o),
  );
export const runVolunteerGateWatcherCron = (deps: M15WorkerDeps) =>
  forEachActiveOrg(deps, "volunteer-gate-watcher", (o) => runVolunteerGateWatcherForOrg(deps, o));
export const runVolunteerHourAggregatorCron = (deps: M15WorkerDeps) =>
  forEachActiveOrg(deps, "volunteer-hour-aggregator", (o) =>
    runVolunteerHourAggregatorForOrg(deps, o),
  );

async function aggregateBucket(
  deps: M15WorkerDeps,
  now: Date,
  args: {
    organizationId: string;
    providerEntityId: string;
    fiscalYear: number;
    candidates: ReadonlyArray<VolunteerVisitCandidate>;
  },
): Promise<void> {
  const { organizationId, providerEntityId, fiscalYear } = args;
  // M15-F04: the denominator is computed ONCE per (provider entity × fiscal year) here and persisted on the
  // ledger row (migration 0347); the read paths never re-walk the patients.
  const patientCare = await computeStaffPatientCareTally(
    deps.db,
    { organizationId, providerEntityId, fiscalYear },
    deps.log,
  );
  const staffPatientCareMinutes = denominatorFromTally(patientCare);
  await withOrgContext(deps.db, { organizationId, ...SYSTEM_ACTOR }, async (tx) => {
    const t = tx as unknown as DbClient;
    const { ledgerId, created } = await lockLedger(
      t,
      organizationId,
      providerEntityId,
      fiscalYear,
      now,
    );
    const existing = await ledgerEntries(t, organizationId, ledgerId);
    const aggregate = aggregateVolunteerHours({
      providerEntityId: providerEntityId as never,
      fiscalYear: fiscalYear as never,
      existingEntries: existing.map((e) => ({
        ...e,
        volunteerMembershipId: e.volunteerMembershipId as MembershipId,
        sourceEncounterId: e.sourceEncounterId as EncounterId | null,
        adjustedByMembershipId: e.adjustedByMembershipId as MembershipId | null,
      })),
      candidates: args.candidates,
      asOfAt: now.toISOString(),
    });
    if (aggregate.unresolvedDurationEncounterIds.length > 0) {
      deps.log?.warn(
        {
          organizationId,
          providerEntityId,
          fiscalYear,
          unresolved: aggregate.unresolvedDurationEncounterIds.length,
        },
        "M15 hour aggregator: volunteer visits skipped — duration unresolved (not counted as zero)",
      );
    }
    // Persisted on EVERY pass (even a no-new-visits one): staff visits keep signing after the volunteers'.
    await setLedgerPatientCare(
      t,
      organizationId,
      ledgerId,
      {
        minutes: staffPatientCareMinutes,
        counted: patientCare.resolvedCount,
        unresolved: patientCare.unresolvedCount,
      },
      now,
    );
    if (!created && aggregate.newEntries.length === 0) return;

    await insertLedgerEntries(t, organizationId, ledgerId, aggregate.newEntries);
    await setLedgerTotal(t, organizationId, ledgerId, aggregate.totalVolunteerHourMinutes, now);
    const ratio = computeVolunteerHourRatio({
      providerEntityId: providerEntityId as never,
      fiscalYear: fiscalYear as never,
      volunteerHourMinutes: aggregate.totalVolunteerHourMinutes,
      // M15-F04: signed hands-on staff visit minutes from M8's digests; `null` (⇒ `unavailable`) only when
      // none has a resolved duration.
      staffPatientCareMinutes,
    });
    await deps.outbox.publish(t, {
      organizationId,
      eventName: "m15.volunteer.ratio_recomputed",
      payload: {
        providerEntityId,
        fiscalYear,
        hoursMinutes: aggregate.totalVolunteerHourMinutes,
        status: ratio.status,
      },
      aggregateKind: "volunteer_hour_ledger",
      aggregateId: ledgerId,
    });
  });
}

type CronKey = keyof typeof M15_QUEUES;

const ORG_RUNNERS: Record<CronKey, (deps: M15WorkerDeps, organizationId: string) => Promise<void>> =
  {
    supervisoryOverdue: runSupervisoryOverdueForOrg,
    mswInitialOverdue: runMswInitialOverdueForOrg,
    chaplainInitialOverdue: runChaplainInitialOverdueForOrg,
    volunteerGateWatcher: runVolunteerGateWatcherForOrg,
    volunteerHourAggregator: runVolunteerHourAggregatorForOrg,
  };

const CRON_KEYS = Object.keys(ORG_RUNNERS) as CronKey[];

/** The job name of a per-org unit of work (the repeatable schedule's job is `scheduled`). */
export const M15_ORG_JOB_NAME = "org";

/**
 * The orgs a cron acts for on this tick: every active org for an always-on cron, otherwise those whose
 * org-local hour equals the cron's spec hour. An org whose zone cannot be read is reported (thrown after the
 * rest were evaluated), never silently skipped.
 */
export async function orgsDueNow(deps: M15WorkerDeps, key: CronKey): Promise<string[]> {
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const hour = M15_LOCAL_HOURS[key];
  if (hour === null) return orgs.map((o) => o.organizationId);
  const now = clock(deps);
  const due: string[] = [];
  const failures: string[] = [];
  for (const { organizationId } of orgs) {
    try {
      const zone = await inOrg(deps, organizationId, (t) =>
        organizationTimezone(t, organizationId),
      );
      if (localHourIn(now, zone) === hour) due.push(organizationId);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`M15_CRON_TZ_READ_FAILURE ${key}: ${failures.join("; ")}`);
  }
  return due;
}

/** The slice of a BullMQ Queue the fan-out needs (a fake in unit tests). */
export interface OrgJobQueue {
  addBulk(jobs: Parameters<Queue["addBulk"]>[0]): Promise<unknown>;
}

/**
 * The repeatable tick: enqueue ONE job per due org. The jobId is deterministic per (cron, org, hour bucket),
 * so re-running the tick (a retry of the fan-out job itself) adds nothing for an org already enqueued; the
 * per-org job's own retries then re-run only that org. Returns the orgs enqueued.
 */
export async function fanOutOrgJobs(
  deps: M15WorkerDeps,
  key: CronKey,
  queue: OrgJobQueue,
): Promise<string[]> {
  const due = await orgsDueNow(deps, key);
  const bucket = clock(deps).toISOString().slice(0, 13);
  const params = M15_QUEUE_PARAMS[key];
  await queue.addBulk(
    due.map((organizationId) => ({
      name: M15_ORG_JOB_NAME,
      data: { organizationId },
      opts: {
        // BullMQ rejects ":" in a custom job id.
        jobId: `${key}__${organizationId}__${bucket}`,
        priority: params.priority,
        attempts: params.attempts,
        backoff: params.backoff,
        removeOnComplete: { count: 200 },
        removeOnFail: false,
      },
    })),
  );
  return due;
}

/** Construct the five live M15 cron workers (one per §4.6 queue). */
export function registerM15CronWorkers(deps: M15WorkerDeps): Worker[] {
  return CRON_KEYS.map((key) => {
    const fanOutQueue = new Queue(M15_QUEUES[key], { connection: deps.connection });
    const worker = new Worker(
      M15_QUEUES[key],
      async (job: Job) => {
        if (job.name !== M15_ORG_JOB_NAME) {
          await fanOutOrgJobs(deps, key, fanOutQueue);
          return;
        }
        const organizationId = (job.data as { organizationId?: unknown }).organizationId;
        if (typeof organizationId !== "string" || organizationId.length === 0) {
          throw new Error(`M15_ORG_JOB_INVALID ${key}: missing organizationId`);
        }
        await ORG_RUNNERS[key](deps, organizationId);
      },
      { connection: deps.connection, concurrency: M15_QUEUE_PARAMS[key].concurrency },
    );
    worker.on("closed", () => {
      void fanOutQueue.close();
    });
    return worker;
  });
}

/** Register the five repeatable fan-out schedules (attempts/backoff/priority per §4.6). */
export async function scheduleM15Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const key of CRON_KEYS) {
    const queue = new Queue(M15_QUEUES[key], { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: M15_JOB_SCHEDULES[key] },
        priority: M15_QUEUE_PARAMS[key].priority,
        attempts: M15_QUEUE_PARAMS[key].attempts,
        backoff: M15_QUEUE_PARAMS[key].backoff,
        removeOnComplete: { count: 200 },
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
