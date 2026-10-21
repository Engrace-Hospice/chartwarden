// apps/backend/src/modules/16-bereavement/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable Queue
// construction for M16's §4.9 time-driven crons (GAP-048; the M20/M9/M25 `jobs/cron-workers.ts` template).
//
//   · `m16-close-13mo`            → `closeAt13Months` for every active/paused plan whose 13-month window has
//                                    elapsed (death_date + 396 days, D4). Closure row (`auto`) + cancelled
//                                    future outreach + `plan_closed_completed` in ONE tx.
//   · `m16-miss-deadline`         → `missDeadline` for every `scheduled` outreach whose `late_grace_until`
//                                    passed; `outreach_missed` outbox + best-effort M36 alert in the same tx.
//   · `m16-anniversary-lookahead` → `anniversary_due_in_14_days` for each unfired reminder landing in the next
//                                    14 days; `alert_fired_at` is stamped in the SAME tx as the outbox write.
//   · `m16-unreachable-detector` → PROPOSES `markUnreachable` (§2.3 / §4.9) for each active contact of an active
//                                    plan whose newest 3 touchpoint-log rows are all `no_response`: stamps
//                                    `unreachable_proposed_through_at` and emits
//                                    `m16.bereavement.contact_unreachable_proposed` in ONE tx. It never changes
//                                    the contact's status — the counselor decides (route 17).
//
// WORKERS ARE NOT REQUESTS. Each tick enumerates active orgs (M2 enumerator under `withPlatformContext`),
// then opens one `withOrgContext` tx per org to LIST candidates and a fresh tx PER ROW to apply, so one bad
// row (or a lost race) never aborts the rest of the org's batch. The 13-month and miss paths are
// optimistic-concurrency / status guarded (`UPDATE … WHERE version = ?` / `WHERE status = 'scheduled'`
// `RETURNING`), so two overlapping ticks cannot both win (SD-060: worker-side idempotency by DB state).
// The outbox publisher is the real catalog-validating tx publisher (callerModule `m16`) injected at boot.
import {
  BEREAVEMENT_WINDOW_DAYS,
  UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD,
  isWithinBereavementWindow,
} from "@chartwarden/bereavement";
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavementAnniversaryMark,
  BereavementOutreachKind,
  IsoInstant,
} from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { transitionBereavementOutreach, transitionBereavementPlan } from "../lifecycle/index";
import { runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import {
  M16_ANNIVERSARY_LOOKAHEAD_DAYS,
  M16_CRON_BATCH_LIMIT,
  M16_JOB_NAMES,
  M16_JOB_SCHEDULES,
  M16_QUEUES,
  M16_QUEUE_PARAMS,
} from "./index";

const PLAN = schema.bereavementPlan;
const OUTREACH = schema.bereavementOutreach;
const CLOSURE = schema.bereavementPlanClosure;
const REMINDER = schema.bereavementAnniversaryReminder;
const CONTACT = schema.bereavedContact;
const LOG = schema.bereavementContactLog;

const MS_PER_DAY = 86_400_000;

/** §3.3 — a cron-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention: an empty
 *  string reads back as SQL NULL through the audit trigger's actor lookup, which the `user` FK accepts). */
const M16_WORKER_SYSTEM_USER_ID = "";

/** The M2 active-org enumerator the cron fan-out reads (the M9/M20 `ActiveOrgListPort` shape, restated
 *  locally so this module takes no bootstrap import edge). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M16WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly activeOrgs?: ActiveOrgListPort;
  now?: () => Date;
}

function activeOrgsOf(deps: M16WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        Promise.reject(
          new Error(
            "M16_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — bind the M2 active-org enumerator under withPlatformContext",
          ),
        ),
    }
  );
}

/** Build the {@link M16WorkerDeps} from the composition-root primitives (the M9/M20 `buildMxWorkerDeps` shape). */
export function buildM16WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: WriteOutboxPort;
  alerts?: AlertPort;
  activeOrgs?: ActiveOrgListPort;
}): M16WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

// ── pure helpers (unit-tested) ─────────────────────────────────────────────────────────────────────────

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Plans whose `death_date <= cutoff` have `now >= death_date + BEREAVEMENT_WINDOW_DAYS` (D4: UTC-midnight anchor). */
export function closeCutoffDate(now: Date): string {
  const todayMidnight = Date.parse(`${utcDate(now.getTime())}T00:00:00.000Z`);
  return utcDate(todayMidnight - BEREAVEMENT_WINDOW_DAYS * MS_PER_DAY);
}

/** The inclusive `[today, today + 14d]` window of reminder `target_date`s the lookahead alerts on. */
export function anniversaryLookaheadRange(now: Date): { from: string; to: string } {
  const todayMidnight = Date.parse(`${utcDate(now.getTime())}T00:00:00.000Z`);
  return {
    from: utcDate(todayMidnight),
    to: utcDate(todayMidnight + M16_ANNIVERSARY_LOOKAHEAD_DAYS * MS_PER_DAY),
  };
}

const log = (msg: string, meta: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console -- standalone cron workers log via console (M9/M20 precedent).
  console.log(msg, meta);
};

/** Thrown inside a per-row tx to roll it back when another tick already handled the row. */
class LostRaceError extends Error {}

/** Run `apply` for one row in its own org-scoped tx, treating a lost race as a logged skip. */
async function inRowTx(
  deps: M16WorkerDeps,
  organizationId: string,
  what: string,
  rowId: string,
  apply: (tx: DbClient) => Promise<void>,
): Promise<boolean> {
  try {
    await runWithRequestContext({ organizationId, userId: M16_WORKER_SYSTEM_USER_ID }, () =>
      withOrgContext(
        deps.db,
        { organizationId, userId: M16_WORKER_SYSTEM_USER_ID },
        async (handle) => apply(handle as DbClient),
      ),
    );
    return true;
  } catch (err) {
    if (err instanceof LostRaceError) {
      log(`m16.${what}: row already handled elsewhere — skipped`, { organizationId, rowId });
      return false;
    }
    throw err;
  }
}

/** Run `list` in an org-scoped tx. */
function listInOrg<T>(
  deps: M16WorkerDeps,
  organizationId: string,
  list: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return withOrgContext(
    deps.db,
    { organizationId, userId: M16_WORKER_SYSTEM_USER_ID },
    async (handle) => list(handle as DbClient),
  );
}

// ── m16-close-13mo ────────────────────────────────────────────────────────────────────────────────────

/** Apply `closeAt13Months` to one plan inside `tx` (the `cosignClose` write sequence, system-driven). */
async function closeOnePlan(
  tx: DbClient,
  deps: M16WorkerDeps,
  organizationId: string,
  planId: string,
  now: Date,
): Promise<void> {
  const [plan] = await tx.select().from(PLAN).where(eq(PLAN.id, planId)).limit(1);
  if (!plan) throw new LostRaceError(); // vanished
  // SD-060 idempotency: only active/paused plans without a hold are closable.
  if ((plan.status !== "active" && plan.status !== "paused") || plan.legalHoldId !== null) {
    throw new LostRaceError();
  }
  const at = now.toISOString() as IsoInstant;
  const transition = transitionBereavementPlan(plan.status, {
    type: "closeAt13Months",
    at,
    windowElapsed: !isWithinBereavementWindow(plan.deathDate, at),
    legalHoldActive: false,
  });

  // Version-guarded UPDATE first: a concurrent tick/route loses here and this whole tx rolls back.
  const updated = await tx
    .update(PLAN)
    .set({
      status: transition.to,
      closedAt: now,
      version: plan.version + 1,
      updatedAt: now,
    })
    .where(and(eq(PLAN.id, plan.id), eq(PLAN.version, plan.version)))
    .returning({ id: PLAN.id });
  if (updated.length !== 1) throw new LostRaceError();

  // `cancel_future_outreach` (plan scope) — future-dated scheduled rows only, the route-path parity.
  await tx
    .update(OUTREACH)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancellationReasonRedacted: "plan closed at 13 months",
      version: sql`${OUTREACH.version} + 1`, // §2.5 (GAP-194)
      updatedAt: now,
    })
    .where(
      and(eq(OUTREACH.planId, plan.id), eq(OUTREACH.status, "scheduled"), gte(OUTREACH.dueAt, now)),
    );

  const [outreach] = await tx
    .select({
      completed: sql<number>`count(*) filter (where ${OUTREACH.status} in ('completed','declined'))::int`,
      missed: sql<number>`count(*) filter (where ${OUTREACH.status} = 'missed')::int`,
    })
    .from(OUTREACH)
    .where(eq(OUTREACH.planId, plan.id));
  const [contacts] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${CONTACT.status} = 'active')::int`,
      optedOut: sql<number>`count(*) filter (where ${CONTACT.status} = 'opted_out')::int`,
    })
    .from(CONTACT)
    .where(eq(CONTACT.planId, plan.id));
  const stats = {
    completedCount: outreach?.completed ?? 0,
    missedCount: outreach?.missed ?? 0,
    contactsActiveCount: contacts?.active ?? 0,
    contactsOptedOutCount: contacts?.optedOut ?? 0,
  };

  await tx.insert(CLOSURE).values({
    organizationId: plan.organizationId,
    providerEntityId: plan.providerEntityId,
    locationId: plan.locationId,
    planId: plan.id,
    reason: "thirteen_month_completion",
    closedAt: now,
    closedByUserId: null,
    closeKind: "auto",
    outreachCompletedCount: stats.completedCount,
    outreachMissedCount: stats.missedCount,
    contactsActiveCount: stats.contactsActiveCount,
    contactsOptedOutCount: stats.contactsOptedOutCount,
  });

  await runEffects(tx, transition.effects, {
    organizationId,
    at: now,
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads: {
      "m16.bereavement.plan_closed_completed": {
        planId: plan.id,
        closedAt: at,
        outreachStats: stats,
      },
    },
  });
}

/** §4.9 `m16-close-13mo` — fan out over active orgs; close every plan past its 13-month window. */
export async function runClose13MonthsCron(deps: M16WorkerDeps): Promise<{ closed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = closeCutoffDate(now);
  let closed = 0;
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    const planIds = await listInOrg(deps, organizationId, async (tx) =>
      (
        await tx
          .select({ id: PLAN.id })
          .from(PLAN)
          .where(
            and(
              eq(PLAN.organizationId, organizationId),
              inArray(PLAN.status, ["active", "paused"]),
              isNull(PLAN.legalHoldId),
              lte(PLAN.deathDate, cutoff),
            ),
          )
          .orderBy(asc(PLAN.deathDate))
          .limit(M16_CRON_BATCH_LIMIT)
      ).map((r) => r.id),
    );
    for (const planId of planIds) {
      const won = await inRowTx(deps, organizationId, "close-13mo", planId, (tx) =>
        closeOnePlan(tx, deps, organizationId, planId, now),
      );
      if (won) closed += 1;
    }
  }
  return { closed };
}

// ── m16-miss-deadline ─────────────────────────────────────────────────────────────────────────────────

async function missOneOutreach(
  tx: DbClient,
  deps: M16WorkerDeps,
  organizationId: string,
  outreachId: string,
  now: Date,
): Promise<void> {
  const [row] = await tx.select().from(OUTREACH).where(eq(OUTREACH.id, outreachId)).limit(1);
  if (!row || row.status !== "scheduled") throw new LostRaceError();
  const [plan] = await tx
    .select({ status: PLAN.status, counselor: PLAN.assignedCounselorUserId })
    .from(PLAN)
    .where(eq(PLAN.id, row.planId))
    .limit(1);
  if (!plan || plan.status !== "active") throw new LostRaceError();

  const at = now.toISOString() as IsoInstant;
  const transition = transitionBereavementOutreach(row.status, {
    type: "missDeadline",
    at,
    lateGraceUntil: row.lateGraceUntil.toISOString() as IsoInstant,
  });
  const updated = await tx
    .update(OUTREACH)
    // §2.5 (GAP-194) — the miss slide bumps the version, so a counselor acting on the pre-miss row gets 412.
    .set({ status: transition.to, version: sql`${OUTREACH.version} + 1`, updatedAt: now })
    .where(and(eq(OUTREACH.id, row.id), eq(OUTREACH.status, "scheduled")))
    .returning({ id: OUTREACH.id });
  if (updated.length !== 1) throw new LostRaceError();

  const dueAt = row.dueAt.toISOString();
  await runEffects(tx, transition.effects, {
    organizationId,
    at: now,
    outbox: deps.outbox,
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    aggregateKind: "bereavement_plan",
    aggregateId: row.planId,
    payloads: {
      "m16.bereavement.outreach_missed": {
        planId: row.planId,
        contactId: row.bereavedContactId,
        outreachId: row.id,
        dueAt,
      },
    },
    alertPayloads: {
      outreach_missed: {
        planId: row.planId,
        contactId: row.bereavedContactId,
        outreachId: row.id,
        outreachKind: row.kind as BereavementOutreachKind,
        dueAt,
        counselorUserId: row.assigneeUserId ?? plan.counselor ?? null,
      },
    },
  });
}

/** §4.9 `m16-miss-deadline` — fan out over active orgs; mark every overdue `scheduled` outreach `missed`. */
export async function runMissDeadlineCron(deps: M16WorkerDeps): Promise<{ missed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  let missed = 0;
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    const ids = await listInOrg(deps, organizationId, async (tx) =>
      (
        await tx
          .select({ id: OUTREACH.id })
          .from(OUTREACH)
          .innerJoin(PLAN, eq(PLAN.id, OUTREACH.planId))
          .where(
            and(
              eq(OUTREACH.organizationId, organizationId),
              eq(OUTREACH.status, "scheduled"),
              lt(OUTREACH.lateGraceUntil, now),
              eq(PLAN.status, "active"),
            ),
          )
          .orderBy(asc(OUTREACH.lateGraceUntil))
          .limit(M16_CRON_BATCH_LIMIT)
      ).map((r) => r.id),
    );
    for (const outreachId of ids) {
      const won = await inRowTx(deps, organizationId, "miss-deadline", outreachId, (tx) =>
        missOneOutreach(tx, deps, organizationId, outreachId, now),
      );
      if (won) missed += 1;
    }
  }
  return { missed };
}

// ── m16-anniversary-lookahead ─────────────────────────────────────────────────────────────────────────

async function fireOneReminder(
  tx: DbClient,
  deps: M16WorkerDeps,
  organizationId: string,
  reminderId: string,
  now: Date,
): Promise<void> {
  // The partial-unique-style guard: stamp `alert_fired_at` only if still NULL, in the SAME tx as the outbox
  // write — a redelivered/overlapping tick matches zero rows and rolls back.
  const [reminder] = await tx
    .update(REMINDER)
    .set({ alertFiredAt: now })
    .where(and(eq(REMINDER.id, reminderId), isNull(REMINDER.alertFiredAt)))
    .returning();
  if (!reminder) throw new LostRaceError();
  const [plan] = await tx
    .select({
      status: PLAN.status,
      counselor: PLAN.assignedCounselorUserId,
      volunteer: PLAN.assignedVolunteerUserId,
    })
    .from(PLAN)
    .where(eq(PLAN.id, reminder.planId))
    .limit(1);
  if (!plan || plan.status !== "active") throw new LostRaceError(); // roll the stamp back; a resumed plan re-qualifies

  await deps.outbox.publish(tx, {
    organizationId,
    eventName: "m16.bereavement.anniversary_due_in_14_days",
    payload: {
      planId: reminder.planId,
      mark: reminder.mark,
      targetDate: reminder.targetDate,
      anniversaryReminderId: reminder.id,
    },
    aggregateKind: "bereavement_plan",
    aggregateId: reminder.planId,
  });

  // §3 D4 — `clinical_routine` nudge to the counselor and (if any) the volunteer; best-effort, never fails the tx.
  if (deps.alerts) {
    for (const recipient of [plan.counselor, plan.volunteer]) {
      if (!recipient) continue;
      await deps.alerts
        .emit({
          organizationId,
          kind: "anniversary_due_in_14_days",
          payload: {
            planId: reminder.planId,
            mark: reminder.mark as BereavementAnniversaryMark,
            targetDate: reminder.targetDate,
            counselorUserId: recipient,
          },
        })
        .catch(() => undefined);
    }
  }
}

/** §4.9 `m16-anniversary-lookahead` — fan out over active orgs; fire each unfired reminder due within 14 days. */
export async function runAnniversaryLookaheadCron(deps: M16WorkerDeps): Promise<{ fired: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const { from, to } = anniversaryLookaheadRange(now);
  let fired = 0;
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    const ids = await listInOrg(deps, organizationId, async (tx) =>
      (
        await tx
          .select({ id: REMINDER.id })
          .from(REMINDER)
          .innerJoin(PLAN, eq(PLAN.id, REMINDER.planId))
          .where(
            and(
              eq(REMINDER.organizationId, organizationId),
              isNull(REMINDER.alertFiredAt),
              gte(REMINDER.targetDate, from),
              lte(REMINDER.targetDate, to),
              eq(PLAN.status, "active"),
            ),
          )
          .orderBy(asc(REMINDER.targetDate))
          .limit(M16_CRON_BATCH_LIMIT)
      ).map((r) => r.id),
    );
    for (const reminderId of ids) {
      const won = await inRowTx(deps, organizationId, "anniversary-lookahead", reminderId, (tx) =>
        fireOneReminder(tx, deps, organizationId, reminderId, now),
      );
      if (won) fired += 1;
    }
  }
  return { fired };
}

// ── m16-unreachable-detector ──────────────────────────────────────────────────────────────────────────

/** The newest touchpoint-log rows of one contact, newest first (the §2.3 streak is read off these). */
async function latestOutcomes(
  tx: DbClient,
  contactId: string,
  limit: number,
): Promise<{ outcome: string; contactAt: Date }[]> {
  return tx
    .select({ outcome: LOG.outcome, contactAt: LOG.contactAt })
    .from(LOG)
    .where(eq(LOG.bereavedContactId, contactId))
    .orderBy(desc(LOG.contactAt))
    .limit(limit);
}

/** Consecutive newest `no_response` rows (the route-17 guard's count, so proposal and acceptance agree). */
export function noResponseStreak(newestFirst: readonly { outcome: string; contactAt: Date }[]): {
  streak: number;
  newestStrikeAt: Date | null;
} {
  let streak = 0;
  for (const row of newestFirst) {
    if (row.outcome !== "no_response") break;
    streak += 1;
  }
  return { streak, newestStrikeAt: streak > 0 ? (newestFirst[0]?.contactAt ?? null) : null };
}

/** Rows read to measure a streak (matches route 17's window). */
const STREAK_LOOKBACK = 20;

async function proposeOneUnreachable(
  tx: DbClient,
  deps: M16WorkerDeps,
  organizationId: string,
  contactId: string,
): Promise<void> {
  const [contact] = await tx.select().from(CONTACT).where(eq(CONTACT.id, contactId)).limit(1);
  // SD-060 idempotency: only an `active` contact is proposed — an already-`unreachable` one is skipped.
  if (!contact || contact.status !== "active") throw new LostRaceError();
  const [plan] = await tx
    .select({ status: PLAN.status })
    .from(PLAN)
    .where(eq(PLAN.id, contact.planId))
    .limit(1);
  if (!plan || plan.status !== "active") throw new LostRaceError();

  const { streak, newestStrikeAt } = noResponseStreak(
    await latestOutcomes(tx, contactId, STREAK_LOOKBACK),
  );
  if (streak < UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD || !newestStrikeAt) {
    throw new LostRaceError();
  }
  // Re-propose only on a strictly newer strike; the stamp rides the same tx as the outbox write, so a
  // concurrent/replayed run matches zero rows and rolls back.
  const stamped = await tx
    .update(CONTACT)
    .set({ unreachableProposedThroughAt: newestStrikeAt })
    .where(
      and(
        eq(CONTACT.id, contactId),
        eq(CONTACT.status, "active"),
        or(
          isNull(CONTACT.unreachableProposedThroughAt),
          lt(CONTACT.unreachableProposedThroughAt, newestStrikeAt),
        ),
      ),
    )
    .returning({ id: CONTACT.id });
  if (stamped.length !== 1) throw new LostRaceError();

  await deps.outbox.publish(tx, {
    organizationId,
    eventName: "m16.bereavement.contact_unreachable_proposed",
    payload: { planId: contact.planId, contactId, consecutiveNoResponseCount: streak },
    aggregateKind: "bereaved_contact",
    aggregateId: contactId,
  });

  // §4.10 `contact_unreachable` counselor alert — best-effort, never fails the tx (M36 also rides the event).
  if (deps.alerts) {
    await deps.alerts
      .emit({
        organizationId,
        kind: "contact_unreachable",
        payload: { planId: contact.planId, contactId, missedTouchpointCount: streak },
      })
      .catch(() => undefined);
  }
}

/** §4.9 `m16-unreachable-detector` — fan out over active orgs; propose `markUnreachable` at 3+ strikes. */
export async function runUnreachableDetectorCron(
  deps: M16WorkerDeps,
): Promise<{ proposed: number }> {
  const threshold = UNREACHABLE_CONSECUTIVE_NO_RESPONSE_THRESHOLD;
  let proposed = 0;
  for (const { organizationId } of await activeOrgsOf(deps).listActiveOrgs()) {
    // Candidates: active contacts of active plans whose NEWEST `threshold` log rows are all `no_response`
    // and whose newest strike is newer than the last proposal (the per-row tx re-verifies all of it).
    const ids = await listInOrg(deps, organizationId, async (tx) =>
      (
        await tx
          .select({ id: CONTACT.id })
          .from(CONTACT)
          .innerJoin(PLAN, eq(PLAN.id, CONTACT.planId))
          .where(
            and(
              eq(CONTACT.organizationId, organizationId),
              eq(CONTACT.status, "active"),
              eq(PLAN.status, "active"),
              sql`(select count(*) filter (where t.outcome = 'no_response')
                     from (select l.outcome from ${LOG} l
                            where l.bereaved_contact_id = ${CONTACT.id}
                            order by l.contact_at desc limit ${threshold}) t) = ${threshold}`,
              sql`(${CONTACT.unreachableProposedThroughAt} is null or ${CONTACT.unreachableProposedThroughAt} <
                     (select max(l.contact_at) from ${LOG} l where l.bereaved_contact_id = ${CONTACT.id}))`,
            ),
          )
          .orderBy(asc(CONTACT.updatedAt))
          .limit(M16_CRON_BATCH_LIMIT)
      ).map((r) => r.id),
    );
    for (const contactId of ids) {
      const won = await inRowTx(deps, organizationId, "unreachable-detector", contactId, (tx) =>
        proposeOneUnreachable(tx, deps, organizationId, contactId),
      );
      if (won) proposed += 1;
    }
  }
  return { proposed };
}

// ── BullMQ construction (the M20/M9 registerMxCronWorkers / scheduleMxJobs template) ───────────────────

/** Construct the four §4.9 cron `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM16CronWorkers(deps: M16WorkerDeps): Worker[] {
  const make = (
    queue: string,
    params: { concurrency: number },
    run: (d: M16WorkerDeps) => Promise<unknown>,
  ) =>
    new Worker(queue, async () => void (await run(deps)), {
      connection: deps.connection,
      concurrency: params.concurrency,
    });
  return [
    make(M16_QUEUES.close13Months, M16_QUEUE_PARAMS.close13Months, runClose13MonthsCron),
    make(
      M16_QUEUES.anniversaryLookahead,
      M16_QUEUE_PARAMS.anniversaryLookahead,
      runAnniversaryLookaheadCron,
    ),
    make(M16_QUEUES.missDeadline, M16_QUEUE_PARAMS.missDeadline, runMissDeadlineCron),
    make(
      M16_QUEUES.unreachableDetector,
      M16_QUEUE_PARAMS.unreachableDetector,
      runUnreachableDetectorCron,
    ),
  ];
}

/** Register the §4.9 repeatable schedules. Returns the `Queue`s so the composition root can `close()` them. */
export async function scheduleM16Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const entries = [
    ["close13Months"],
    ["anniversaryLookahead"],
    ["missDeadline"],
    ["unreachableDetector"],
  ] as const;
  const queues: Queue[] = [];
  for (const [key] of entries) {
    const queue = new Queue(M16_QUEUES[key], { connection });
    const params = M16_QUEUE_PARAMS[key];
    await queue.add(
      M16_JOB_NAMES[key],
      {},
      {
        repeat: { pattern: M16_JOB_SCHEDULES[key] },
        priority: params.priority,
        attempts: params.attempts,
        backoff: { type: params.backoff.type, delay: params.backoff.delay },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
