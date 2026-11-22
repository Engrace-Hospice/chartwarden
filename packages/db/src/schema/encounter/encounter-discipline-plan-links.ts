// @chartwarden/db — `encounter_discipline_plan_link` (ADR-0114 S4b, migration 1535). Joins an encounter to the M15 goals and interventions its
// drafted plan keeps: one element per row, soft-removed like `encounter_care_plan_link` (the application role holds DELETE on no M8 table).
// A live row means "kept in this visit's statement of the plan", never "the visit addressed it". PHI-bearing → three-column tenancy rule
// (denormalized from the parent encounter). The goal and intervention ids are M15 working-row ids (logical; app-validated, no cross-module FK).
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const encounterDisciplinePlanLinks = pgTable(
  "encounter_discipline_plan_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id"), // M15 discipline goal (logical)
    interventionId: uuid("intervention_id"), // M15 discipline intervention (logical)
    /** No default: the writer states it. A Part 2 row withholds its element ids from the audit image and files under the Part 2 class. */
    part2Derived: boolean("part2_derived").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByMembershipId: uuid("removed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    orgEncounterIdx: index("encounter_discipline_plan_link_org_encounter_idx").on(
      t.organizationId,
      t.encounterId,
    ),
    encounterIdx: index("encounter_discipline_plan_link_encounter_idx").on(t.encounterId),
    liveGoalUniq: uniqueIndex("encounter_discipline_plan_link_live_goal_uniq")
      .on(t.encounterId, t.goalId)
      .where(sql`removed_at IS NULL AND goal_id IS NOT NULL`),
    liveInterventionUniq: uniqueIndex("encounter_discipline_plan_link_live_intervention_uniq")
      .on(t.encounterId, t.interventionId)
      .where(sql`removed_at IS NULL AND intervention_id IS NOT NULL`),
    oneElement: check(
      "encounter_discipline_plan_link_one_element",
      sql`(goal_id IS NOT NULL) <> (intervention_id IS NOT NULL)`,
    ),
    removalConsistent: check(
      "encounter_discipline_plan_link_removal_consistent",
      sql`(removed_at IS NULL) = (removed_by_membership_id IS NULL)`,
    ),
  }),
);

export type EncounterDisciplinePlanLink = typeof encounterDisciplinePlanLinks.$inferSelect;
export type NewEncounterDisciplinePlanLink = typeof encounterDisciplinePlanLinks.$inferInsert;
