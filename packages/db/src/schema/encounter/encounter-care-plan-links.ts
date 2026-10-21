// @chartwarden/db — `encounter_care_plan_link` (M8 §3.3). Joins an encounter to the M7 care-plan elements
// it addressed (problem / goal / intervention). PHI-bearing → three-column tenancy rule (denormalized
// from the parent encounter). The problem/goal/intervention refs are M7 (logical; app-validated, no
// cross-module FK). RLS + the M4 write-audit trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const encounterCarePlanLinks = pgTable(
  "encounter_care_plan_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0231 (F-064): 0128 relaxed this pair on every OTHER encounter satellite
    // because the draft route captures neither and the M6 admission may itself be unsited — this table
    // was left out, so its insert could never have succeeded. Stamped from the encounter when the
    // admission is sited; null rather than blocking when it is not.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "cascade" }),
    problemId: uuid("problem_id"), // M7 problem (logical)
    goalId: uuid("goal_id"), // M7 goal (logical)
    interventionId: uuid("intervention_id"), // M7 intervention (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // F-064 (mig 0231) — the soft invalidate. `chartwarden_app` holds DELETE on no M8 table (§3.6
    // append-only), so removing a mis-clicked link on a DRAFT encounter marks the row rather than
    // dropping it; the M4 write-audit trail is only as good as the rows it describes.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByMembershipId: uuid("removed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    encounterIdx: index("encounter_care_plan_link_encounter_idx").on(t.encounterId),
    liveIdx: index("encounter_care_plan_link_live_idx")
      .on(t.encounterId)
      .where(sql`removed_at IS NULL`),
    removalConsistent: check(
      "encounter_care_plan_link_removal_consistent",
      sql`(removed_at IS NULL) = (removed_by_membership_id IS NULL)`,
    ),
    atLeastOneRef: check(
      "encounter_care_plan_link_at_least_one",
      sql`(problem_id IS NOT NULL) OR (goal_id IS NOT NULL) OR (intervention_id IS NOT NULL)`,
    ),
  }),
);

export type EncounterCarePlanLink = typeof encounterCarePlanLinks.$inferSelect;
export type NewEncounterCarePlanLink = typeof encounterCarePlanLinks.$inferInsert;
