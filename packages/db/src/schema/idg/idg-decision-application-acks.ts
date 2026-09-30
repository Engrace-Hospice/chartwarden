// @wardenx/db — `idg_decision_application_ack` (M14, migration 0305; F-232 / #248). The durable record that a
// downstream module APPLIED an emitted IDG decision: one row per (decision, acknowledging module). First
// writer is M14's `m14.m15-idg-decision-applied` consumer (`m15.idg_decision.applied`). Metadata only (ids, a
// count, instants); the three-column tenancy is nullable like the other M14 children. `plan_id` / `version_id`
// are the acknowledging module's ids (plain uuid, no cross-module FK). Append-only for the app role.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { idgDecision } from "./idg-decisions";

export const idgDecisionApplicationAck = pgTable(
  "idg_decision_application_ack",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id")
      .notNull()
      .references(() => idgDecision.id, { onDelete: "cascade" }),
    idgMeetingId: uuid("idg_meeting_id").notNull(),
    patientId: uuid("patient_id"),
    targetModule: text("target_module").notNull(), // CHECK IN ('m15')
    planId: uuid("plan_id"),
    versionId: uuid("version_id"),
    mutationsApplied: integer("mutations_applied").notNull().default(0),
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionModuleUq: uniqueIndex("idg_decision_application_ack_decision_module_uq").on(
      t.organizationId,
      t.idgDecisionId,
      t.targetModule,
    ),
    meetingIdx: index("idg_decision_application_ack_meeting_idx").on(
      t.organizationId,
      t.idgMeetingId,
    ),
  }),
);

export type IdgDecisionApplicationAck = typeof idgDecisionApplicationAck.$inferSelect;
export type NewIdgDecisionApplicationAck = typeof idgDecisionApplicationAck.$inferInsert;
