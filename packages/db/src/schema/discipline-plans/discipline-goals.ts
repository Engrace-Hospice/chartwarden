// @wardenx/db — `discipline_goal` (M15 §3.3). The per-discipline goal, optionally hung off an M7 IPOC
// problem/goal (`parent_problem_id` / `parent_goal_id`, LOGICAL uuid — M15 reads M7 through the
// `CarePlanReader` seam, never through its schema). §2.2.3 status lifecycle; `original_text` is IMMUTABLE
// after creation (M7 D6 pattern — DB length CHECK + service guard + audit-trigger refusal), revisions land
// in `revised_text`.
//
// D5 attribution: `source = 'agent_stated'` requires a non-null `acting_consent_id` naming the active
// dpoa_healthcare consent (M39) — enforced here as a CHECK and re-verified at write time via
// `consent.evaluate`.
//
// §7.8: `sud_related` is the column the SQL-level Part 2 filter keys on. The spec's §3.3 block omits it
// while §7.8 requires the redaction to be a WHERE clause rather than a UI hide — so the flag is stored,
// defaulting false, and the read path ANDs it against the `sud_disclosure_allowed` predicate (M15-T06).
//
// Tenancy (M15-F05): patient-bearing → organization_id + provider_entity_id + location_id NOT NULL.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { disciplineGoalSource, disciplineGoalStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const disciplineGoal = pgTable(
  "discipline_goal",
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
    planId: uuid("plan_id")
      .notNull()
      .references(() => disciplineCarePlan.id, { onDelete: "restrict" }),

    parentGoalId: uuid("parent_goal_id"), // logical FK → M7 IPOC goal
    parentProblemId: uuid("parent_problem_id"), // logical FK → M7 IPOC problem

    source: disciplineGoalSource("source").notNull(),
    status: disciplineGoalStatus("status").notNull().default("not_started"),

    originalText: text("original_text").notNull(), // immutable after insert (§2.3)
    revisedText: text("revised_text"),
    measurableOutcome: text("measurable_outcome"),
    targetAt: timestamp("target_at", { withTimezone: true }),
    frequencyText: text("frequency_text"),
    frequencyValue: text("frequency_value"), // M7 '2:visit:week' pattern
    modalityText: text("modality_text"),

    sudRelated: boolean("sud_related").notNull().default(false), // §7.8 SQL-level Part 2 filter
    actingConsentId: uuid("acting_consent_id"), // logical FK → M39; required when source='agent_stated'

    addedByMembershipId: uuid("added_by_membership_id").notNull(), // logical FK → M2 membership
    addedByDiscipline: text("added_by_discipline").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planIdx: index("discipline_goal_plan_idx").on(t.organizationId, t.planId, t.status),
    parentGoalIdx: index("discipline_goal_parent_goal_idx").on(t.parentGoalId),
    originalTextLen: check(
      "discipline_goal_original_text_len_ck",
      sql`length(original_text) > 0 AND length(original_text) <= 4000`,
    ),
    agentStatedRequiresConsent: check(
      "discipline_goal_agent_stated_consent_ck",
      sql`source <> 'agent_stated' OR acting_consent_id IS NOT NULL`,
    ),
  }),
);

export type DisciplineGoal = typeof disciplineGoal.$inferSelect;
export type NewDisciplineGoal = typeof disciplineGoal.$inferInsert;
