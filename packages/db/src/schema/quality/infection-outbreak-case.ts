// @wardenx/db — `infection_outbreak_case` (M30 §3.3; non-partitioned; retention class `compliance`).
// A detected outbreak cluster (server-created only, V-18) over a (pathogen, body_site, time-window),
// with IDG-review and containment lifecycle. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id
// RLS). provider_entity_id is a logical FK to M40. No PHI (aggregate cluster, no patient_id); no
// eraser, no audit denylist.
import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m30OutbreakStatus = pgEnum("m30_outbreak_status", [
  "open",
  "idg_reviewed",
  "contained",
  "closed",
]);

export const infectionOutbreakCase = pgTable(
  "infection_outbreak_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    pathogen: text("pathogen").notNull(),
    bodySite: text("body_site").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    triggeringEventCount: integer("triggering_event_count").notNull(),
    status: m30OutbreakStatus("status").notNull().default("open"),
    idgReviewRequiredAt: timestamp("idg_review_required_at", { withTimezone: true }),
    idgReviewedAt: timestamp("idg_reviewed_at", { withTimezone: true }),
    containedAt: timestamp("contained_at", { withTimezone: true }),
    containedAttestationMembershipId: uuid("contained_attestation_membership_id"),
    nextMonitoringDueAt: timestamp("next_monitoring_due_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOutbreakWindow: uniqueIndex("uq_outbreak_window").on(
      t.providerEntityId,
      t.pathogen,
      t.bodySite,
      t.windowStart,
      t.windowEnd,
    ), // V-18 + concurrency idempotency
  }),
);

export type InfectionOutbreakCase = typeof infectionOutbreakCase.$inferSelect;
export type NewInfectionOutbreakCase = typeof infectionOutbreakCase.$inferInsert;
