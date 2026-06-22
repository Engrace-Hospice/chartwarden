// @wardenx/db — `significant_change_event` (M9 §3.3, §2.4 D2). One row per detected threshold-crossing
// (PPS drop, ESAS-r increase, PAINAD ≥ 4, etc.): the rule, the delta vs threshold, and the
// ack/escalation lifecycle. PHI-adjacent → the three-column tenancy rule (PE/location denormalized from
// the triggering assessment). The clinical_assessment links are plain uuid (the parent is partitioned).
// Actor ref goes to M1 `membership`. RLS + grants + the M4 write-audit trigger (acknowledgment_note
// denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { significantChangeRuleId, significantChangeStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const significantChangeEvents = pgTable(
  "significant_change_event",
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

    clinicalAssessmentId: uuid("clinical_assessment_id").notNull(), // M9 clinical_assessment (logical; parent is partitioned)
    priorAssessmentId: uuid("prior_assessment_id"), // M9 clinical_assessment (logical; nullable)
    ruleId: significantChangeRuleId("rule_id").notNull(),
    deltaValue: numeric("delta_value", { precision: 8, scale: 2 }),
    thresholdValue: numeric("threshold_value", { precision: 8, scale: 2 }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    status: significantChangeStatus("status").notNull().default("open"),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id").references(
      () => memberships.id,
    ),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgmentNote: text("acknowledgment_note"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  },
  (t) => ({
    openPatientIdx: index("significant_change_open_patient_idx")
      .on(t.organizationId, t.clinicalAssessmentId)
      .where(sql`status = 'open'`),
    detectedIdx: index("significant_change_detected_idx").on(t.detectedAt),
  }),
);

export type SignificantChangeEvent = typeof significantChangeEvents.$inferSelect;
export type NewSignificantChangeEvent = typeof significantChangeEvents.$inferInsert;
