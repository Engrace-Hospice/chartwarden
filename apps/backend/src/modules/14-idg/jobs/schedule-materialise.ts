// apps/backend/src/modules/14-idg/jobs/schedule-materialise.ts — §2.2/§7.1 W-SCH-01 the recurring-policy
// meeting-schedule materialization worker (F-171, #248). A genuine PREREQUISITE for the packet-build
// worker in `packet-build.ts`: `idg_meeting` had exactly ONE INSERT site anywhere in this codebase before
// this file (`rescheduleMeeting`'s successor row, `idg-route-service-db.ts`) — no route or worker ever
// creates the FIRST meeting for a brand-new `idg_recurring_policy`, confirmed by a repo-wide grep for
// `insert(MTG)`/`.insert(schema.idgMeeting)`. Without this worker, `runPacketBuildCron` (packet-build.ts)
// would be provably dead code — there would never be a `scheduled` meeting for it to find. Pure M14, no
// cross-module seam: it only reads `idg_recurring_policy` and writes `idg_meeting`, both M14-owned.
//
// Deliberately NOT the §2.2 D3 `tenant_quorum_snapshot` re-derivation from a live per-tenant quorum config
// surface — no such surface exists anywhere in the codebase (M3 D4 registers `IDG_REQUIRED_QUORUM` as a
// platform-floor constant, never a per-tenant override table); every materialized meeting snapshots the
// platform-floor `IDG_REQUIRED_QUORUM` verbatim, which is correct for every tenant that has not built a
// (currently nonexistent) tightening surface.
import { type DbClient, schema } from "@wardenx/db";
import { IDG_REQUIRED_QUORUM } from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq } from "drizzle-orm";
import type { ActiveOrgListPort } from "./index";

const MTG = schema.idgMeeting;
const POL = schema.idgRecurringPolicy;

/** §7.1 — "creates 7 future `idg_meeting` rows ... for the next ~90 days" is read as the WINDOW the worker
 *  keeps materialized ahead of `now`, re-run daily (§7.1's own "job runs at 02:00" cadence) rather than a
 *  one-shot count — a daily re-run that only tops up the window is what keeps a policy 90 days materialized
 *  indefinitely, matching the file's own idempotent-INSERT design (a day where the window is already full
 *  materializes nothing new). */
const MATERIALIZE_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** The whole-minute UTC offset (ms) of `timeZone` at `utcMs` — the `@wardenx/scheduling` `atOrgLocalTime`
 *  technique, copied inline per this arc's "duplicated per-module rather than shared" convention
 *  (`cron-workers.ts`'s own backoff-parser header) rather than adding a new `apps/backend` package
 *  dependency for one function. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const localMinute = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
  );
  return localMinute - Math.floor(utcMs / 60_000) * 60_000;
}

/** The UTC instant for `HH:MM` location-local wall time on UTC calendar day `dateUtcMidnightMs`. */
function atLocalTime(dateUtcMidnightMs: number, timeOfDay: string, timeZone: string): Date {
  const [hh, mm] = timeOfDay.split(":");
  const wallUtc = dateUtcMidnightMs + Number(hh) * 3_600_000 + Number(mm) * 60_000;
  return new Date(wallUtc - tzOffsetMs(wallUtc, timeZone));
}

/** One materialized-or-to-be-materialized occurrence's UTC calendar-day anchor (midnight UTC). */
function nextWeekdayOnOrAfter(fromUtcMidnightMs: number, weekdayIndex: number): number {
  const fromWeekday = new Date(fromUtcMidnightMs).getUTCDay();
  const delta = (weekdayIndex - fromWeekday + 7) % 7;
  return fromUtcMidnightMs + delta * DAY_MS;
}

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface MaterialisePolicyRow {
  readonly id: string;
  readonly locationId: string;
  readonly cadenceDays: number;
  readonly dayOfWeekAnchor: string;
  readonly startTimeLocal: string;
  readonly durationMinutes: number;
  readonly defaultCoordinatorMembershipId: string;
}

/** Compute every occurrence-day (UTC midnight anchors) for `policy` from `windowStart` through
 *  `windowEnd`, inclusive — pure, no IO. The FIRST occurrence is the next `dayOfWeekAnchor` on/after
 *  `anchorFromMs` (the latest already-materialized meeting's day, or `windowStart` when none exists);
 *  subsequent occurrences step by `cadenceDays`. */
export function computeOccurrenceDays(
  policy: Pick<MaterialisePolicyRow, "cadenceDays" | "dayOfWeekAnchor">,
  anchorFromMs: number,
  windowEndMs: number,
): readonly number[] {
  const weekdayIndex = WEEKDAY_INDEX[policy.dayOfWeekAnchor.toLowerCase()];
  if (weekdayIndex === undefined) return [];
  const days: number[] = [];
  let day = nextWeekdayOnOrAfter(anchorFromMs, weekdayIndex);
  const step = Math.max(policy.cadenceDays, 1) * DAY_MS;
  while (day <= windowEndMs) {
    days.push(day);
    day += step;
  }
  return days;
}

async function activePoliciesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<MaterialisePolicyRow[]> {
  const rows = await tx
    .select({
      id: POL.id,
      locationId: POL.locationId,
      cadenceDays: POL.cadenceDays,
      dayOfWeekAnchor: POL.dayOfWeekAnchor,
      startTimeLocal: POL.startTimeLocal,
      durationMinutes: POL.durationMinutes,
      defaultCoordinatorMembershipId: POL.defaultCoordinatorMembershipId,
    })
    .from(POL)
    .where(and(eq(POL.organizationId, organizationId), eq(POL.active, true)));
  return rows;
}

async function latestScheduledStartForPolicy(
  tx: DbClient,
  organizationId: string,
  recurringPolicyId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ scheduledStart: MTG.scheduledStart })
    .from(MTG)
    .where(
      and(eq(MTG.organizationId, organizationId), eq(MTG.recurringPolicyId, recurringPolicyId)),
    )
    .orderBy(desc(MTG.scheduledStart))
    .limit(1);
  return row?.scheduledStart ?? null;
}

/** `location.timezone` (M1 §3.5) is M1-owned; M14 may not query `location` directly
 * (`scripts/check-table-ownership.ts`). Resolved through M1's published `FoundationSiteReader.
 * locationTimezone`, org-explicit here (the M13 `m12-medication-order-active.ts` consumer's own
 * `locationTimezone: (organizationId, locationId) => …` injection precedent) since a cron tick opens no
 * ambient request the reader's own `tx`-taking signature could otherwise ride. */
export interface Idg1LocationTimezonePort {
  locationTimezone(organizationId: string, locationId: string): Promise<string | null>;
}

async function timezoneForLocation(
  port: Idg1LocationTimezonePort,
  organizationId: string,
  locationId: string,
): Promise<string> {
  const tz = await port.locationTimezone(organizationId, locationId);
  return tz ?? "America/Los_Angeles"; // the platform default (M6/M10/M11 precedent)
}

/**
 * §7.1 W-SCH-01 — materialize `idg_meeting` rows for one policy through `windowEndMs`, idempotent: the
 * anchor for the next occurrence is the LATEST already-materialized meeting for this policy (never
 * re-derived from `now`, so a re-run never duplicates or skips one), or `now` when no meeting has ever
 * been materialized for it. Returns the count of rows actually inserted (0 when the window is already
 * full — the common case on every re-run but the first).
 */
async function materialisePolicy(
  tx: DbClient,
  organizationId: string,
  policy: MaterialisePolicyRow,
  now: Date,
  windowEndMs: number,
  locationTimezonePort: Idg1LocationTimezonePort,
): Promise<number> {
  const latest = await latestScheduledStartForPolicy(tx, organizationId, policy.id);
  const anchorFromMs = latest ? utcMidnight(latest) + DAY_MS : utcMidnight(now);
  const days = computeOccurrenceDays(policy, anchorFromMs, windowEndMs);
  if (days.length === 0) return 0;
  const timezone = await timezoneForLocation(
    locationTimezonePort,
    organizationId,
    policy.locationId,
  );
  let inserted = 0;
  for (const dayMidnightUtc of days) {
    const scheduledStart = atLocalTime(dayMidnightUtc, policy.startTimeLocal, timezone);
    const scheduledEnd = new Date(scheduledStart.getTime() + policy.durationMinutes * 60_000);
    await tx.insert(MTG).values({
      organizationId,
      locationId: policy.locationId,
      recurringPolicyId: policy.id,
      scheduledStart,
      scheduledEnd,
      status: "scheduled",
      coordinatorMembershipId: policy.defaultCoordinatorMembershipId,
      tenantQuorumSnapshot: IDG_REQUIRED_QUORUM,
    });
    inserted += 1;
  }
  return inserted;
}

export interface ScheduleMaterialiseDeps {
  readonly db: DbClient;
  readonly outbox: {
    publish(
      tx: unknown,
      emission: {
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
        readonly organizationId: string;
        readonly aggregateKind: string;
        readonly aggregateId: string;
      },
    ): Promise<void>;
  };
  readonly activeOrgs: ActiveOrgListPort;
  readonly locationTimezone: Idg1LocationTimezonePort;
  now?: () => Date;
}

/** `idg.schedule-materialise` (§4.8/§7.1 `materialise-future-meetings` — F-171, #248) — for each active
 *  org, top up every active `idg_recurring_policy`'s 90-day materialized window. One org's failure never
 *  blocks a sibling org's tick (the `runReviewClockSweepCron`/`runPacketBuildCron` shape). */
export async function runScheduleMaterialiseCron(deps: ScheduleMaterialiseDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const windowEndMs = utcMidnight(now) + MATERIALIZE_WINDOW_DAYS * DAY_MS;
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as unknown as DbClient;
        const policies = await activePoliciesForOrg(tx, organizationId);
        for (const policy of policies) {
          const meetingsCreated = await materialisePolicy(
            tx,
            organizationId,
            policy,
            now,
            windowEndMs,
            deps.locationTimezone,
          );
          if (meetingsCreated === 0) continue;
          await deps.outbox.publish(tx, {
            eventName: "m14.schedule.materialised",
            payload: {
              recurringPolicyId: policy.id,
              meetingsCreated,
              windowEndIso: new Date(windowEndMs).toISOString(),
            },
            organizationId,
            aggregateKind: "idg_recurring_policy",
            aggregateId: policy.id,
          });
        }
      });
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M14_SCHEDULE_MATERIALISE: ${failures.length} of ${orgs.length} org(s) failed — ` +
        `${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}
