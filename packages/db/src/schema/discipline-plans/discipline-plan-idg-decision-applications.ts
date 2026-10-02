// @wardenx/db — `discipline_plan_idg_decision_application` (M15, migration 0306; F-234 / #248). The durable,
// idempotent record that M15's IDG-decision consumer handled one `idg.decision_recorded` of kind
// `discipline_plan_update` (M15 spec §1.1 / §7.7; idempotency key `idgDecisionId`, §4.5). UNIQUE
// (organization_id, idg_decision_id): a redelivery finds the row and is a no-op. `applied` rows carry the open
// draft `idg_review` version the mutations landed on; `refused` rows are the terminal verdict for a contract
// violation retrying cannot fix (nothing applied, no event published). Metadata only — the narrative lives on
// discipline_goal / discipline_intervention. `patient_id` / `idg_*` ids are logical uuids (no cross-module FK).
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlanVersion } from "./discipline-care-plan-versions";
import { disciplineCarePlan } from "./discipline-care-plans";

export const disciplinePlanIdgDecisionApplication = pgTable(
  "discipline_plan_idg_decision_application",
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
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    planId: uuid("plan_id")
      .notNull()
      .references(() => disciplineCarePlan.id, { onDelete: "restrict" }),
    versionId: uuid("version_id").references(() => disciplineCarePlanVersion.id, {
      onDelete: "restrict",
    }),
    idgDecisionId: uuid("idg_decision_id").notNull(), // logical FK → M14
    idgMeetingId: uuid("idg_meeting_id").notNull(), // logical FK → M14
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    status: text("status").notNull(), // 'applied' | 'refused' (CHECK)
    mutationsApplied: integer("mutations_applied").notNull().default(0),
    refusalReason: text("refusal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUq: uniqueIndex("discipline_plan_idg_decision_application_decision_uq").on(
      t.organizationId,
      t.idgDecisionId,
    ),
    planIdx: index("discipline_plan_idg_decision_application_plan_idx").on(
      t.organizationId,
      t.planId,
      t.status,
    ),
  }),
);

export type DisciplinePlanIdgDecisionApplication =
  typeof disciplinePlanIdgDecisionApplication.$inferSelect;
export type NewDisciplinePlanIdgDecisionApplication =
  typeof disciplinePlanIdgDecisionApplication.$inferInsert;
