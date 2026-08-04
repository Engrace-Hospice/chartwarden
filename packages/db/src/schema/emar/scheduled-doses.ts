// @wardenx/db — `scheduled_dose` (M13 §3.3 / §2.3 D2). Precomputed administration slots materialized from
// M12's sigStructured over the materialization window: one row per (order, due_at). PHI-bearing (patient_id)
// → the three-column tenancy rule (provider_entity_id + location_id NOT NULL, denormalized from the admission
// at materialization). Non-partitioned (§3.5 — bounded by active-orders × window). Cross-module refs (M5
// patient, M6 admission, M12 medication_order) are plain uuid app-validated, NOT cross-module FKs (M13
// dependsOn [12,36,38]). RLS + grants + the M4 write-audit trigger land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { scheduledDoseCancellationReason, scheduledDoseStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const scheduledDoses = pgTable(
  "scheduled_dose",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    medicationOrderId: uuid("medication_order_id").notNull(), // M12 (resolved through seam; no FK)

    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    graceWindowMinutes: integer("grace_window_minutes").notNull(),
    expectedDoseAmount: numeric("expected_dose_amount", { precision: 12, scale: 4 }).notNull(),
    expectedDoseUnit: text("expected_dose_unit").notNull(),
    expectedRoute: text("expected_route").notNull(),

    status: scheduledDoseStatus("status").notNull().default("pending"),
    administeredAt: timestamp("administered_at", { withTimezone: true }),
    missedDoseId: uuid("missed_dose_id"), // back-ref (loose; no FK — circular with missed_dose)
    cancellationReason: scheduledDoseCancellationReason("cancellation_reason"),
    cancellationSourceEventId: uuid("cancellation_source_event_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    // For deduplication of materialization across reactive + cron paths.
    materializationSequence: integer("materialization_sequence").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPatientByTime: index("sched_dose_patient_time_idx").on(
      t.organizationId,
      t.patientId,
      t.dueAt.asc(),
    ),
    byOrderByTime: index("sched_dose_order_time_idx").on(
      t.organizationId,
      t.medicationOrderId,
      t.dueAt.asc(),
    ),
    pendingByTimeSweep: index("sched_dose_pending_sweep_idx")
      .on(t.dueAt.asc())
      .where(sql`status = 'pending'`),
    // A given order cannot have two scheduled doses at the exact same due_at (materialization idempotency).
    uniqueByOrderDue: uniqueIndex("sched_dose_order_due_uk").on(
      t.organizationId,
      t.medicationOrderId,
      t.dueAt,
    ),
  }),
);

export type ScheduledDose = typeof scheduledDoses.$inferSelect;
export type NewScheduledDose = typeof scheduledDoses.$inferInsert;
