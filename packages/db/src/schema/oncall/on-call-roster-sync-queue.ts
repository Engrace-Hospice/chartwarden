// @wardenx/db — `on_call_roster_sync_queue` (M19 §4.5 path 1 / §4.8 `m19.shift-sync.debounced`, the m19
// `handlers-unbound` group, #248 — F-155's own finding, now built). `reconcileOnCallRoster`
// (`apps/backend/src/modules/19-oncall/roster/shift-sync.ts`) and `decideRosterSyncTrigger` have been a
// complete, pure, well-documented reconciliation core since M19-T04 with NO caller anywhere: M19 shipped
// with no `jobs/` directory at all, so the `m19.shift-sync.debounced` queue the spec names (§4.8 — 2 per
// org, 3 attempts, exponential backoff, its own DLQ, "debounced 30 s on `m17.visit.assigned`") existed in
// no form, and the periodic "shift cron tick" catch-up the spec's §4.5 text also names had nowhere to run
// either.
//
// TRUE DEBOUNCE NEEDS A `run_after` COLUMN, NOT ONLY A PARTIAL-UNIQUE DEDUPE. The
// `dosespot_sync_queue`/`measure_recompute_queue` precedent (migrations 0253/0062, F-150/#248) collapses
// repeated triggers onto one PENDING row via `ON CONFLICT ... DO NOTHING` — sufficient for THOSE queues,
// where a second trigger while one is already pending needs no separate row. M19's spec is stricter: the
// debounce must RESET on every new trigger ("debounced 30 s" means 30 s of QUIET, not "at most one pending
// row") — a scheduling burst of fifty `m17.visit.assigned` events 200 ms apart must not let the FIRST
// trigger's 30-second timer elapse while the fiftieth is still arriving. BullMQ's own `jobId` dedupe
// cannot express this at all (it is a string comparison at `.add()` time with no reset primitive once a
// job exists), so `run_after` is a real column this queue's siblings do not carry: `enqueueOrBumpDebounce`
// (`../../../../apps/backend/src/modules/19-oncall/jobs/repository.ts`) is an
// `INSERT ... ON CONFLICT (organization_id) WHERE status = 'pending' DO UPDATE SET run_after = ...` that
// pushes the deadline forward on EVERY trigger, and the drain worker only ever claims a row whose
// `run_after <= now()` — the debounce window is enforced by the claim predicate, not by the enqueue.
//
// ONE PENDING ROW PER ORGANIZATION, not per ProviderEntity — `shift-sync.ts`'s own
// `decideRosterSyncTrigger` keys its debounce on the ORG (`m19.shift-sync:${organizationId}`), because
// M17's `tonightsOnCallRoster` seam read is ORG-keyed and the reconciler fans out over every PE in the org
// from the drained row, so two visit-assignment events for two different ProviderEntities in the same org
// 200 ms apart must collapse onto ONE reconciliation pass, not two. The partial-unique index on
// `organization_id` alone (mirroring the shape, not the grain, of `dosespot_sync_queue_pending_uq`) is
// what makes that collapse a database guarantee rather than an application convention.
//
// THE PERIODIC CATCH-UP TRIGGER SHARES THIS SAME TABLE RATHER THAN A SEPARATE MECHANISM, DELIBERATELY.
// The spec names two triggers ("at every shift cron tick + on every `m17.visit.assigned` outbox event")
// for the ONE reconciliation, and a naive reading might stand up two independent code paths — but two
// independent writers to `on_call_shift` racing the same ProviderEntity is exactly the hazard this queue's
// per-org claim (`FOR UPDATE SKIP LOCKED`, one row per org) exists to prevent. `ensureCatchUpPending`
// (the periodic worker's only action) INSERTs a `reason = 'cron_catchup'` row with `run_after = now()`
// only `ON CONFLICT DO NOTHING` — it never bumps an existing pending row's `run_after` the way an
// `m17.visit.assigned` trigger does, so a catch-up tick arriving while a debounce window is already
// counting down for that org is a genuine no-op, not a second competing schedule. Reconciliation for a
// given org therefore only ever runs through this ONE table's claim, whichever reason woke it.
import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** `m17_visit_assigned` — a real `m17.visit.assigned` delivery bumped the debounce window forward.
 *  `cron_catchup` — the periodic worker seeded this row because no debounce was already in flight for
 *  the org (the §4.5 "shift cron tick" catch-up path, for an org an assignment event never touched, or
 *  whose event was lost/dropped upstream). */
export type OnCallRosterSyncQueueReason = "m17_visit_assigned" | "cron_catchup";

export type OnCallRosterSyncQueueStatus = "pending" | "processing" | "completed" | "failed";

export const onCallRosterSyncQueue = pgTable(
  "on_call_roster_sync_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reason: text("reason").$type<OnCallRosterSyncQueueReason>().notNull(),
    status: text("status").$type<OnCallRosterSyncQueueStatus>().notNull().default("pending"),
    /** The debounce deadline — bumped forward by every `m17_visit_assigned` trigger; set once, to
     *  `now()`, by a `cron_catchup` seed. The drain worker's claim predicate is `run_after <= now()`. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    /** The LAST `m17.visit.assigned` outbox event id that bumped this row — logical uuid, no cross-module
     *  FK (the `dosespot_sync_queue.triggering_event_outbox_id` precedent). Null on a `cron_catchup` row
     *  no event ever touched. */
    triggeringEventOutboxId: uuid("triggering_event_outbox_id"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    // Debounce: one PENDING row per organization — the org grain `decideRosterSyncTrigger`'s own
    // debounce key already commits to (see the file header on why this is org-, not PE-, scoped).
    uniqPending: uniqueIndex("on_call_roster_sync_queue_pending_uq")
      .on(t.organizationId)
      .where(sql`status = 'pending'`),
  }),
);

export type OnCallRosterSyncQueueRow = typeof onCallRosterSyncQueue.$inferSelect;
export type NewOnCallRosterSyncQueueRow = typeof onCallRosterSyncQueue.$inferInsert;
