// @wardenx/db — `missed_dose` (M13 §3.3 / §2.5 D4). 1:1 with a `scheduled_dose` that lapsed its grace window
// (detected by sweep) or was intentionally held / refused. PHI-bearing (patient_id) → the three-column tenancy
// rule (provider_entity_id + location_id NOT NULL). Non-partitioned (§3.5). Cross-module refs (M5 patient, M6
// admission, M12 medication_order) are plain uuid app-validated; `scheduled_dose_id` is M13-owned but kept loose
// (no SQL FK) — the 1:1 is enforced by a unique index. RLS + grants + the M4 write-audit trigger (missed_reason
// denylisted, §3.6) land in the RLS migration.
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { missedDoseKind } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const missedDoses = pgTable(
  "missed_dose",
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

    scheduledDoseId: uuid("scheduled_dose_id").notNull(), // 1:1 with scheduled_dose (loose; no FK)

    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    medicationOrderId: uuid("medication_order_id").notNull(),

    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    missedKind: missedDoseKind("missed_kind").notNull(),
    missedReason: text("missed_reason"), // DENYLISTED

    recordedByMembershipId: uuid("recorded_by_membership_id"), // null when detected by sweep
    isControlledSubstance: boolean("is_controlled_substance").notNull().default(false),

    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byScheduledDose: uniqueIndex("missed_dose_scheduled_dose_uk").on(t.scheduledDoseId),
    byPatientByTime: index("missed_dose_patient_time_idx").on(
      t.organizationId,
      t.patientId,
      t.detectedAt.desc(),
    ),
    byOrderByTime: index("missed_dose_order_time_idx").on(
      t.organizationId,
      t.medicationOrderId,
      t.detectedAt.desc(),
    ),
    unacknowledged: index("missed_dose_unacknowledged_idx")
      .on(t.organizationId, t.detectedAt.desc())
      .where(sql`acknowledged_at IS NULL`),
  }),
);

export type MissedDose = typeof missedDoses.$inferSelect;
export type NewMissedDose = typeof missedDoses.$inferInsert;
