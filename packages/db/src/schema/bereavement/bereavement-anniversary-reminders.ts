// @wardenx/db — `bereavement_anniversary_reminder` (M16 §3.3.6). One row per (plan × D4 milestone): the
// daily 14-day-lookahead worker's ledger, so the M36 counselor alert for a given mark fires exactly once
// (`alert_fired_at`) no matter how often the cron re-runs or catches up after an outage (§9.7).
//
// `outreach_ids` is the per-contact fan-out this mark produced — a jsonb ARRAY of uuids rather than a join
// table, because the only read is "show me what this mark spawned" and the cardinality is the roster size.
// `nine_month_high_risk_only` rows exist only on the moderate-and-above cadence (D4).
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location (M1 core) + the intra-M16 plan parent carry real FKs.
import { sql } from "drizzle-orm";
import { date, index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bereavementAnniversaryMark } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavementPlan } from "./bereavement-plans";

export const bereavementAnniversaryReminder = pgTable(
  "bereavement_anniversary_reminder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),

    mark: bereavementAnniversaryMark("mark").notNull(),
    targetDate: date("target_date").notNull(), // plan.death_date + the mark's D4 offset
    alertFiredAt: timestamp("alert_fired_at", { withTimezone: true }), // NULL = the M36 alert has not gone out

    outreachIds: jsonb("outreach_ids").notNull().default(sql`'[]'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One reminder per milestone per plan — this is what makes the lookahead worker idempotent.
    uniquePlanMark: uniqueIndex("berv_anniv_plan_mark_unique").on(t.planId, t.mark),
    targetIdx: index("berv_anniv_target_idx").on(t.organizationId, t.targetDate),
    // The lookahead scan: "unfired marks landing in the next 14 days".
    pendingIdx: index("berv_anniv_pending_idx")
      .on(t.organizationId, t.targetDate)
      .where(sql`alert_fired_at IS NULL`),
  }),
);

export type BereavementAnniversaryReminderRow = typeof bereavementAnniversaryReminder.$inferSelect;
export type NewBereavementAnniversaryReminderRow =
  typeof bereavementAnniversaryReminder.$inferInsert;
