// apps/backend/src/modules/19-oncall/jobs/shift-cron.ts — the §4.8 Tier-1 `m19.shift-open.cron` and
// `m19.shift-close.cron` ticks (GAP-057). `activateShift`/`completeShift` (`../roster/shift-machine.ts`) had
// exactly one caller — the manual `POST /shifts/:id/open|close` routes — so a shift only ever opened if a
// human clicked "go on shift", and M36's `on_call` channel membership (which rides `m19.oncall_shift.activated`
// / `.completed`) never moved on its own. These two ticks are the schedule that was missing.
//
// SAME TRANSITION, SAME EVENT AS THE ROUTE. Each shift is its own org-scoped transaction: the machine's guard,
// the optimistic-version UPDATE, the D7 policy-snapshot pin and the `m19.oncall_shift.*` outbox row (real
// catalog-validating publisher) commit together or not at all. One shift's failure rolls back only that shift
// and never stops the rest of the tick or the other orgs (an `AggregateError` at the end records the tick).
//
// BOUNDED + IDEMPOTENT. At most {@link MAX_SHIFTS_PER_ORG_PER_TICK} shifts per org per tick (a backlog drains
// over the next ticks, oldest window first). Re-running is a no-op: the due predicate is the status itself, the
// UPDATE is guarded on `(status, version)`, and a shift another worker/route moved first is skipped, not failed.
//
// A MISSED WINDOW IS CANCELLED, NOT OPENED (spec silent; the conservative reading). A `scheduled` shift whose
// `shift_ends_at` is already past was never active; opening it would assert coverage that did not happen — the
// exact claim a CoP 418.100(c)(2) survey reads — only to close it a tick later. It is cancelled with a
// system reason, which is the truthful record, emits nothing (M36 never added the actor), and the gap it
// leaves is the coverage-gap watchdog's to report.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, MembershipId } from "@chartwarden/types";
import { and, asc, eq, lte } from "drizzle-orm";
import { type OnCallShiftFacts, activateShift, completeShift } from "../roster/shift-machine";
import type { WriteOutboxPort } from "../routes/write-service";
import type { ActiveOrgListPort } from "./worker";

const SHIFT = schema.onCallShift;
const POLICY = schema.tenantOncallPolicy;

/** §3.3 — a worker-driven transition names no acting membership (restated locally per this directory). */
export const M19_SHIFT_CRON_USER_ID = "";

/** The most shifts one org's tick will open/close; the rest drain on the next tick, oldest first. */
export const MAX_SHIFTS_PER_ORG_PER_TICK = 100;

/** The reason stamped on a window that elapsed without ever opening. */
export const MISSED_WINDOW_CANCELLATION_REASON =
  "system: window elapsed before the shift-open cron could open it";

export interface M19ShiftCronDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  /** The real catalog-validating publisher (`callerModule` pinned to `m19`) — never `NOOP_OUTBOX`. */
  readonly outbox: WriteOutboxPort;
  now?: () => Date;
}

export interface ShiftCronOrgResult {
  readonly changed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

type ShiftRow = typeof SHIFT.$inferSelect;
type ShiftTxOutcome = "changed" | "cancelled" | "skipped";

const iso = (d: Date): IsoInstant => d.toISOString() as IsoInstant;

function factsOf(row: ShiftRow): OnCallShiftFacts {
  return {
    status: row.status,
    version: row.version,
    shiftStartsAt: iso(row.shiftStartsAt),
    shiftEndsAt: iso(row.shiftEndsAt),
    discipline: row.discipline,
    primaryOnCallMembershipId: row.primaryOnCallMembershipId as MembershipId | null,
    externalActorId: row.externalActorId,
    openedAt: row.openedAt ? iso(row.openedAt) : null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
  };
}

async function loadShiftForUpdate(
  tx: DbClient,
  organizationId: string,
  shiftId: string,
): Promise<ShiftRow | undefined> {
  const [row] = await tx
    .select()
    .from(SHIFT)
    .where(and(eq(SHIFT.organizationId, organizationId), eq(SHIFT.id, shiftId)))
    .for("update")
    .limit(1);
  return row;
}

/** One shift's `scheduled → active` (or `→ cancelled` for a missed window), inside the caller's org tx. */
async function openOneShift(
  deps: M19ShiftCronDeps,
  tx: DbClient,
  organizationId: string,
  shiftId: string,
  at: Date,
): Promise<ShiftTxOutcome> {
  const row = await loadShiftForUpdate(tx, organizationId, shiftId);
  // Another worker / the manual route moved it first (or it is not yet due by the row's own clock).
  if (!row || row.status !== "scheduled" || row.shiftStartsAt > at) return "skipped";

  if (row.shiftEndsAt <= at) {
    await tx
      .update(SHIFT)
      .set({
        status: "cancelled",
        cancellationReason: MISSED_WINDOW_CANCELLATION_REASON,
        version: row.version + 1,
        updatedAt: at,
      })
      .where(and(eq(SHIFT.id, row.id), eq(SHIFT.version, row.version)));
    return "cancelled";
  }

  const [policy] = await tx
    .select()
    .from(POLICY)
    .where(
      and(
        eq(POLICY.organizationId, organizationId),
        eq(POLICY.providerEntityId, row.providerEntityId),
      ),
    )
    .limit(1);
  const transition = activateShift({ shift: factsOf(row), policySnapshot: policy, at: iso(at) });
  const updated = await tx
    .update(SHIFT)
    .set({
      status: transition.to,
      openedAt: at,
      policySnapshot: policy,
      version: row.version + 1,
      updatedAt: at,
    })
    .where(and(eq(SHIFT.id, row.id), eq(SHIFT.version, row.version)))
    .returning({ id: SHIFT.id });
  if (updated.length !== 1) return "skipped";
  await deps.outbox.publish(tx, {
    eventName: "m19.oncall_shift.activated",
    payload: {
      orgId: organizationId,
      providerEntityId: row.providerEntityId,
      occurredAt: iso(at),
      shiftId: row.id,
      discipline: row.discipline,
      membershipId: row.primaryOnCallMembershipId,
      externalActorId: row.externalActorId,
      openedAt: iso(at),
    },
    organizationId,
    aggregateKind: "on_call_shift",
    aggregateId: row.id,
  });
  return "changed";
}

/** One shift's `active → completed`, inside the caller's org tx. */
async function closeOneShift(
  deps: M19ShiftCronDeps,
  tx: DbClient,
  organizationId: string,
  shiftId: string,
  at: Date,
): Promise<ShiftTxOutcome> {
  const row = await loadShiftForUpdate(tx, organizationId, shiftId);
  if (!row || row.status !== "active" || row.shiftEndsAt > at) return "skipped";

  const transition = completeShift({ shift: factsOf(row), at: iso(at) });
  const updated = await tx
    .update(SHIFT)
    .set({ status: transition.to, closedAt: at, version: row.version + 1, updatedAt: at })
    .where(and(eq(SHIFT.id, row.id), eq(SHIFT.version, row.version)))
    .returning({ id: SHIFT.id });
  if (updated.length !== 1) return "skipped";
  await deps.outbox.publish(tx, {
    eventName: "m19.oncall_shift.completed",
    payload: {
      orgId: organizationId,
      providerEntityId: row.providerEntityId,
      occurredAt: iso(at),
      shiftId: row.id,
    },
    organizationId,
    aggregateKind: "on_call_shift",
    aggregateId: row.id,
  });
  return "changed";
}

type OneShiftFn = typeof openOneShift;

async function dueShiftIds(
  deps: M19ShiftCronDeps,
  organizationId: string,
  status: "scheduled" | "active",
  at: Date,
): Promise<readonly string[]> {
  return withOrgContext(
    deps.db,
    { organizationId, userId: M19_SHIFT_CRON_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const dueColumn = status === "scheduled" ? SHIFT.shiftStartsAt : SHIFT.shiftEndsAt;
      const rows = await tx
        .select({ id: SHIFT.id })
        .from(SHIFT)
        .where(
          and(
            eq(SHIFT.organizationId, organizationId),
            eq(SHIFT.status, status),
            lte(dueColumn, at),
          ),
        )
        .orderBy(asc(dueColumn), asc(SHIFT.id))
        .limit(MAX_SHIFTS_PER_ORG_PER_TICK);
      return rows.map((r) => r.id);
    },
  );
}

async function processOrg(
  deps: M19ShiftCronDeps,
  organizationId: string,
  status: "scheduled" | "active",
  transitionOne: OneShiftFn,
  at: Date,
): Promise<ShiftCronOrgResult> {
  const ids = await dueShiftIds(deps, organizationId, status, at);
  const failures: unknown[] = [];
  let changed = 0;
  let cancelled = 0;
  let skipped = 0;
  for (const shiftId of ids) {
    try {
      const outcome = await withOrgContext(
        deps.db,
        { organizationId, userId: M19_SHIFT_CRON_USER_ID },
        (handle) => transitionOne(deps, handle as DbClient, organizationId, shiftId, at),
      );
      if (outcome === "changed") changed++;
      else if (outcome === "cancelled") cancelled++;
      else skipped++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `M19_SHIFT_CRON: ${failures.length} shift(s) failed for org ${organizationId}`,
    );
  }
  return { changed, cancelled, skipped };
}

async function runShiftTick(
  deps: M19ShiftCronDeps,
  label: string,
  status: "scheduled" | "active",
  transitionOne: OneShiftFn,
): Promise<ReadonlyMap<string, ShiftCronOrgResult>> {
  const at = (deps.now ?? (() => new Date()))();
  const results = new Map<string, ShiftCronOrgResult>();
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      results.set(
        organizationId,
        await processOrg(deps, organizationId, status, transitionOne, at),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label}: ${failures.length} org failure(s)`);
  }
  return results;
}

/** §4.8 `m19.shift-open.cron` — open every `scheduled` shift whose `shift_starts_at <= now`, per org. */
export function runShiftOpenTick(
  deps: M19ShiftCronDeps,
): Promise<ReadonlyMap<string, ShiftCronOrgResult>> {
  return runShiftTick(deps, "M19_SHIFT_OPEN", "scheduled", openOneShift);
}

/** §4.8 `m19.shift-close.cron` — close every `active` shift whose `shift_ends_at <= now`, per org. */
export function runShiftCloseTick(
  deps: M19ShiftCronDeps,
): Promise<ReadonlyMap<string, ShiftCronOrgResult>> {
  return runShiftTick(deps, "M19_SHIFT_CLOSE", "active", closeOneShift);
}
