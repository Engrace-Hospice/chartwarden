// dosespot_sync_queue — M12's §2.6 D4 / §2.8 D10 DoseSpot job queue (M12 `handlers-unbound` group, #248;
// migration 0253). Moved here from `apps/backend/src/modules/12-dosespot/jobs/schema.ts` so `arch:tenancy`'s
// Rule 1 (the three-column tenancy scan, which walks `packages/db/src/schema` only) covers it and
// `schema.dosespotSyncQueue` is available platform-wide like every other table — the
// `measure-recompute-queue.ts` precedent (F-150, #248).
//
// ONE PENDING ROW PER (organization_id, kind, patient_id) — a partial-unique index (the
// `measure_recompute_queue` / migration 0062 precedent, F-150 #248) debounces repeated triggers for the
// same patient onto the one still-pending job: two demographic updates in quick succession, or a
// redelivery of the same outbox event, collapse rather than duplicate. `admission_id` is NOT part of the
// debounce key deliberately — a second admission-driven MedHx pull for a patient whose sync is already
// pending needs no separate row, since the pull is patient-scoped, not admission-scoped, at the DoseSpot
// side.
//
// `patient_id`/`admission_id` are PLAIN uuid with NO cross-module FK — the `medication_order.patient_id`/
// `refill_request.patient_id` precedent (both commented "M5 (app-validated; no cross-module FK)") applied
// a third time; every consumed event name in `consumers/sync-triggers.ts` is a string literal, so this
// table gains M12 no new `dependsOn` edge either.
import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** The two job kinds this queue carries — §2.6 D4 patient-sync, §2.8 D10 MedHx-fetch. */
export type DosespotSyncQueueKind = "patient_sync" | "medhx_fetch";

/** The triggering reason — kind-partitioned (enforced by the migration's CHECK constraint). */
export type DosespotSyncQueueReason =
  | "created"
  | "updated"
  | "address_changed"
  | "payer_changed"
  | "admission_activated"
  | "recertification";

export type DosespotSyncQueueStatus = "pending" | "processing" | "completed" | "failed";

export const dosespotSyncQueue = pgTable(
  "dosespot_sync_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: text("kind").$type<DosespotSyncQueueKind>().notNull(),
    reason: text("reason").$type<DosespotSyncQueueReason>().notNull(),
    patientId: uuid("patient_id").notNull(), // M5 (app-validated; no cross-module FK)
    admissionId: uuid("admission_id"), // M6 (app-validated; no cross-module FK); required iff kind=medhx_fetch
    invalidateRxBenefitCache: boolean("invalidate_rx_benefit_cache").notNull().default(false),
    status: text("status").$type<DosespotSyncQueueStatus>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    triggeringEventOutboxId: uuid("triggering_event_outbox_id"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    // Debounce: one PENDING row per (org, kind, patient) — a redelivery or a second close-together
    // trigger for the same patient collapses onto the still-pending row (F-150 `measure_recompute_queue`
    // precedent).
    uniqPending: uniqueIndex("dosespot_sync_queue_pending_uq")
      .on(t.organizationId, t.kind, t.patientId)
      .where(sql`status = 'pending'`),
  }),
);

export type DosespotSyncQueueRow = typeof dosespotSyncQueue.$inferSelect;
export type NewDosespotSyncQueueRow = typeof dosespotSyncQueue.$inferInsert;
