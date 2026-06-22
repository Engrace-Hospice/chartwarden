// @wardenx/db — `standing_order` (M11 §3.3 / §2.4 D5). A signed template that spawns concrete
// `order_record` rows on a cadence (daily / weekly / biweekly / monthly / prn); the service layer limits
// `kind` to lab / supply / ancillary_service. PHI-bearing (patient/admission-scoped) → the three-column
// tenancy rule (provider_entity_id + location_id NOT NULL). Low-volume (typically <10 per admission),
// non-partitioned (§3.7). Cross-module refs (M5 patient, M6 admission, M40 ordering physician) are plain
// uuid app-validated, NOT cross-module FKs; actor refs go to M1 `membership`. The spawn cron + spawn
// history live in `standing_order_instance`. RLS + grants + M4 write-audit trigger
// (template_data / indication_text denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orderKind, standingOrderCadence, standingOrderStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const standingOrders = pgTable(
  "standing_order",
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
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)

    kind: orderKind("kind").notNull(), // service-level limits to lab / supply / ancillary_service
    kindVersion: text("kind_version").notNull(),
    templateData: jsonb("template_data").notNull(),
    indicationText: text("indication_text"), // denylisted

    cadence: standingOrderCadence("cadence").notNull(),
    cadenceDetail: jsonb("cadence_detail").notNull().default(sql`'{}'::jsonb`),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    maxSpawns: integer("max_spawns"),
    spawnCount: integer("spawn_count").notNull().default(0),
    nextSpawnAt: timestamp("next_spawn_at", { withTimezone: true }),

    orderingPhysicianMdmId: uuid("ordering_physician_mdm_id").notNull(), // M40 (app-validated; no FK)
    signedByMembershipId: uuid("signed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    signedAt: timestamp("signed_at", { withTimezone: true }),

    status: standingOrderStatus("status").notNull().default("active"),
    discontinuedAt: timestamp("discontinued_at", { withTimezone: true }),
    discontinuedReason: text("discontinued_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeByNextSpawn: index("standing_order_active_next_spawn_idx")
      .on(t.organizationId, t.nextSpawnAt)
      .where(sql`status = 'active' AND next_spawn_at IS NOT NULL`),
    byPatientStatus: index("standing_order_patient_status_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
    ),
  }),
);

export type StandingOrder = typeof standingOrders.$inferSelect;
export type NewStandingOrder = typeof standingOrders.$inferInsert;
