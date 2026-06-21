// @wardenx/db — `encounter_care_plan_link` (M8 §3.3). Joins an encounter to the M7 care-plan elements
// it addressed (problem / goal / intervention). PHI-bearing → three-column tenancy rule (denormalized
// from the parent encounter). The problem/goal/intervention refs are M7 (logical; app-validated, no
// cross-module FK). RLS + the M4 write-audit trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { encounters } from "./encounters";

export const encounterCarePlanLinks = pgTable(
  "encounter_care_plan_link",
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
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "cascade" }),
    problemId: uuid("problem_id"), // M7 problem (logical)
    goalId: uuid("goal_id"), // M7 goal (logical)
    interventionId: uuid("intervention_id"), // M7 intervention (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterIdx: index("encounter_care_plan_link_encounter_idx").on(t.encounterId),
    atLeastOneRef: check(
      "encounter_care_plan_link_at_least_one",
      sql`(problem_id IS NOT NULL) OR (goal_id IS NOT NULL) OR (intervention_id IS NOT NULL)`,
    ),
  }),
);

export type EncounterCarePlanLink = typeof encounterCarePlanLinks.$inferSelect;
export type NewEncounterCarePlanLink = typeof encounterCarePlanLinks.$inferInsert;
