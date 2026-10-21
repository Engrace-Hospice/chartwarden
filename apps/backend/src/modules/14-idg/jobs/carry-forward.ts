// apps/backend/src/modules/14-idg/jobs/carry-forward.ts — M14 §2.7 / D8 / §7.6 `idg.carry-forward`
// (`compute-carry-forward`): carry every overdue, still-open action item onto the NEXT upcoming meeting of its
// location's agenda, count it, and escalate at the third carry.
//
// SEMANTICS (per org, one `withOrgContext` tx per org — a thrown outbox validation error rolls the whole
// org's tick back, so a tick is all-or-nothing and safe to retry):
//   • Candidate items: `idg_action_item` with `status IN ('open','in_progress')` and `due_date < now`
//     (no due date ⇒ can never be overdue).
//   • Target meeting: per LOCATION, the earliest `scheduled | packets_building | packets_ready` meeting with
//     `now < scheduled_start <= now + CARRY_FORWARD_LOOKAHEAD_MS`. The item's location is its own
//     `location_id`, falling back to the ORIGIN meeting's location (caseload-wide items carry none).
//     The origin meeting itself, and any meeting that does not start after the origin, is never a target.
//   • For each (item, target): INSERT one `idg_agenda_item` (kind `carry_forward`, `carried_from_action_item_id`,
//     three-column location from the meeting, patient from the item) and RE-DERIVE
//     `meeting_carry_forward_count` (distinct NON-cancelled meetings carried into — carry-forward-count.ts; a
//     cancelled/rescheduled meeting is never counted) — iff the insert actually created the row.
//   • The count CROSSING the threshold (`isComplianceCrossing`: stored prior < 3 and derived count ≥ 3) ⇒
//     `isComplianceAlert` on the `m14.action_item.carry_forward` outbox event. The alert fires on the crossing
//     only, not on every later carry. M36's `m36.idg-carry-forward-compliance-alert` consumer turns it into the
//     typed alert (one per action item, ever — correlation id), resolving compliance / supervisor / coordinator
//     recipients in M36; M14 emits a PHI-free id-only payload.
//
// IDEMPOTENCY (the reason this cron was deferred: the double-increment risk). The `idg_agenda_item` row IS the
// "item X was carried into meeting Y" marker. Migration 0285's partial UNIQUE index on
// `(organization_id, idg_meeting_id, carried_from_action_item_id) WHERE kind='carry_forward'` makes the insert
// `ON CONFLICT DO NOTHING`; the count is incremented, and the outbox event published, ONLY when that insert
// returned a row, inside the same tx. So re-runs, retries, concurrent ticks and on-demand packet rebuilds
// (`packet-build.ts` only READS the count) can never increment twice for one (item, meeting) pair, and the
// alert fires on the crossing only. Agenda rows have no DELETE grant, so the marker cannot
// vanish and re-arm the increment.
//
// AUDIT ACTOR: the tx runs with `userId: ""` (like `packet-build.ts` / `schedule-materialise.ts`) — the M4
// write-audit triggers resolve `app.user_id` to `audit_event.actor_user_id`, which FKs to `"user"`; the worker
// pseudo-user id the review-clock sweep once used (`…000000000014`) has no `user` row, so a PHI write under it fails the FK
// (proven live). An empty actor records a system write (actor NULL).
import { type DbClient, schema } from "@chartwarden/db";
import { isComplianceCrossing } from "@chartwarden/idg";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import { recomputeCarryForwardCounts } from "./carry-forward-count";
import type { ActiveOrgListPort } from "./index";

const MTG = schema.idgMeeting;
const AGD = schema.idgAgendaItem;
const ACT = schema.idgActionItem;

/** A meeting starting within this window of `now` is the carry target. Wider than the packet builder's 24h
 * (`BUILD_LOOKAHEAD_MS`) on purpose: the hourly carry-forward tick (minute :30) must always run BEFORE the
 * packet build for the same meeting so the packet's `carryForwardCount` already includes this meeting. */
export const CARRY_FORWARD_LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

const TARGET_STATUSES = ["scheduled", "packets_building", "packets_ready"] as const;

export interface OverdueActionItem {
  readonly id: string;
  readonly patientId: string | null;
  /** The item's own location, else the origin meeting's. */
  readonly locationId: string;
  readonly originMeetingId: string;
  readonly originMeetingStart: Date;
  readonly dueDate: Date;
  readonly count: number;
}

export interface CarryTargetMeeting {
  readonly meetingId: string;
  readonly locationId: string;
  readonly scheduledStart: Date;
  readonly coordinatorMembershipId: string;
}

export interface CarryForwardPlan {
  readonly item: OverdueActionItem;
  readonly target: CarryTargetMeeting;
}

/** Pure — the earliest eligible upcoming meeting per location. */
export function pickTargetMeetings(
  meetings: readonly (CarryTargetMeeting & { readonly status: string })[],
  now: Date,
  lookaheadMs: number = CARRY_FORWARD_LOOKAHEAD_MS,
): ReadonlyMap<string, CarryTargetMeeting> {
  const out = new Map<string, CarryTargetMeeting>();
  const horizon = now.getTime() + lookaheadMs;
  for (const m of meetings) {
    if (!(TARGET_STATUSES as readonly string[]).includes(m.status)) continue;
    const t = m.scheduledStart.getTime();
    if (t <= now.getTime() || t > horizon) continue;
    const cur = out.get(m.locationId);
    if (!cur || t < cur.scheduledStart.getTime()) out.set(m.locationId, m);
  }
  return out;
}

/** Pure — which (item, target) carries are still to be made. `alreadyCarried` holds `"<itemId>:<meetingId>"`
 * keys; it is a fast pre-filter only — the DB unique index is the authority (a stale set is harmless). */
export function planCarryForwards(
  items: readonly OverdueActionItem[],
  targets: ReadonlyMap<string, CarryTargetMeeting>,
  alreadyCarried: ReadonlySet<string>,
  now: Date,
): readonly CarryForwardPlan[] {
  const plans: CarryForwardPlan[] = [];
  for (const item of items) {
    if (item.dueDate.getTime() >= now.getTime()) continue; // not overdue
    const target = targets.get(item.locationId);
    if (!target) continue;
    if (target.meetingId === item.originMeetingId) continue; // raised AT that meeting — already on its agenda
    if (target.scheduledStart.getTime() <= item.originMeetingStart.getTime()) continue;
    if (alreadyCarried.has(`${item.id}:${target.meetingId}`)) continue;
    plans.push({ item, target });
  }
  return plans.sort(
    (a, b) =>
      a.item.dueDate.getTime() - b.item.dueDate.getTime() || a.item.id.localeCompare(b.item.id),
  );
}

export interface CarryForwardWorkerDeps {
  readonly db: DbClient;
  readonly outbox: IdgWriteOutboxPort;
  readonly activeOrgs: ActiveOrgListPort;
  readonly now?: () => Date;
}

export interface CarryForwardOrgResult {
  readonly carried: number;
  readonly complianceAlerts: number;
}

/** One org's tick, inside the caller's tenant tx. Returns what it newly carried. */
export async function carryForwardForOrg(
  tx: DbClient,
  outbox: IdgWriteOutboxPort,
  organizationId: string,
  now: Date,
): Promise<CarryForwardOrgResult> {
  const meetingRows = await tx
    .select({
      meetingId: MTG.id,
      locationId: MTG.locationId,
      scheduledStart: MTG.scheduledStart,
      coordinatorMembershipId: MTG.coordinatorMembershipId,
      status: MTG.status,
    })
    .from(MTG)
    .where(
      and(
        eq(MTG.organizationId, organizationId),
        inArray(MTG.status, [...TARGET_STATUSES] as never),
        gt(MTG.scheduledStart, now),
        lte(MTG.scheduledStart, new Date(now.getTime() + CARRY_FORWARD_LOOKAHEAD_MS)),
      ),
    );
  const targets = pickTargetMeetings(
    meetingRows.map((m) => ({ ...m, scheduledStart: new Date(m.scheduledStart) })),
    now,
  );
  if (targets.size === 0) return { carried: 0, complianceAlerts: 0 };

  const itemRows = await tx
    .select({
      id: ACT.id,
      patientId: ACT.patientId,
      ownLocationId: ACT.locationId,
      originMeetingId: ACT.idgMeetingId,
      originLocationId: MTG.locationId,
      originStart: MTG.scheduledStart,
      dueDate: ACT.dueDate,
      count: ACT.meetingCarryForwardCount,
    })
    .from(ACT)
    .innerJoin(MTG, eq(MTG.id, ACT.idgMeetingId))
    .where(
      and(
        eq(ACT.organizationId, organizationId),
        inArray(ACT.status, ["open", "in_progress"] as never),
        isNotNull(ACT.dueDate),
        lt(ACT.dueDate, now),
      ),
    );
  const items: OverdueActionItem[] = itemRows.map((r) => ({
    id: r.id,
    patientId: r.patientId,
    locationId: r.ownLocationId ?? r.originLocationId,
    originMeetingId: r.originMeetingId,
    originMeetingStart: new Date(r.originStart),
    dueDate: new Date(r.dueDate as Date),
    count: r.count,
  }));

  const targetIds = [...targets.values()].map((t) => t.meetingId);
  const existing = await tx
    .select({
      meetingId: AGD.idgMeetingId,
      itemId: AGD.carriedFromActionItemId,
      sortOrder: AGD.sortOrder,
    })
    .from(AGD)
    .where(and(eq(AGD.organizationId, organizationId), inArray(AGD.idgMeetingId, targetIds)));
  const alreadyCarried = new Set(
    existing.filter((e) => e.itemId !== null).map((e) => `${e.itemId}:${e.meetingId}`),
  );
  const nextSort = new Map<string, number>();
  for (const e of existing) {
    nextSort.set(e.meetingId, Math.max(nextSort.get(e.meetingId) ?? 0, e.sortOrder + 1));
  }

  let carried = 0;
  let complianceAlerts = 0;
  for (const { item, target } of planCarryForwards(items, targets, alreadyCarried, now)) {
    const sortOrder = nextSort.get(target.meetingId) ?? 0;
    const [agenda] = await tx
      .insert(AGD)
      .values({
        organizationId,
        locationId: target.locationId, // three-column rule: location from the meeting
        idgMeetingId: target.meetingId,
        patientId: item.patientId,
        sortOrder,
        // Constant title: free text (the action item's own title) lives in the audit-denylisted `body_text`.
        title: "Carried-forward action item",
        bodyText: `Overdue since ${item.dueDate.toISOString().slice(0, 10)}; carried forward from an earlier meeting.`,
        kind: "carry_forward" as never,
        carriedFromActionItemId: item.id,
        addedByMembershipId: target.coordinatorMembershipId,
      })
      .onConflictDoNothing({
        target: [AGD.organizationId, AGD.idgMeetingId, AGD.carriedFromActionItemId],
        where: sql`${AGD.kind} = 'carry_forward' AND ${AGD.carriedFromActionItemId} IS NOT NULL`,
      })
      .returning({ id: AGD.id });
    if (!agenda) continue; // already carried into this meeting (a concurrent/earlier tick) — NO increment
    nextSort.set(target.meetingId, sortOrder + 1);

    // The count is RE-DERIVED (distinct non-cancelled meetings carried into), not blindly incremented — see
    // carry-forward-count.ts. `previous` is the stored count the crossing is judged against.
    const change = (await recomputeCarryForwardCounts(tx, organizationId, [item.id], now)).get(
      item.id,
    );
    if (!change) throw new Error(`M14_CARRY_FORWARD: action item ${item.id} vanished mid-tick`);
    // Judge the crossing on the derived values (prior stored → derived) so the flag and the stored count can
    // never disagree, even when a cancelled meeting dropped out of the count.
    const isComplianceAlert = isComplianceCrossing(change.previous, change.current);
    await outbox.publish(tx, {
      eventName: "m14.action_item.carry_forward",
      payload: {
        priorActionItemId: item.id,
        newAgendaItemId: agenda.id,
        carryForwardCount: change.current,
        isComplianceAlert,
        // The target meeting's coordinator — the compliance alert's meeting-scoped audience (M36 resolves it to a user).
        coordinatorMembershipId: target.coordinatorMembershipId,
      },
      organizationId,
      aggregateKind: "idg_action_item",
      aggregateId: item.id,
    });
    carried += 1;
    if (isComplianceAlert) complianceAlerts += 1;
  }
  return { carried, complianceAlerts };
}

/** `idg.carry-forward` (§4.9.1 `compute-carry-forward`) — fan out over the active orgs; one org's failure
 * never blocks a sibling org (collected + rethrown together, the `runReviewClockSweepCron` shape). */
export async function runCarryForwardCron(deps: CarryForwardWorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
        carryForwardForOrg(tx as unknown as DbClient, deps.outbox, organizationId, now),
      );
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M14_CARRY_FORWARD: ${failures.length} of ${orgs.length} org(s) failed — ` +
        `${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}
