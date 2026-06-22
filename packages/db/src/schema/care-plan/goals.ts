// @wardenx/db — `goal` (M7 §3.3). A measurable goal under a problem. PHI-bearing → three-column
// tenancy rule. `originalText` preserves patient/family/agent-stated wording VERBATIM (D6); `revisedText`
// holds clinician revisions — both free-text, denylisted with `statusNote`/`measurableOutcome` in the
// M4 write-audit trigger (§3.5). `actingConsentId` is an M39 consent soft-ref (DPOA attribution for
// agent_stated goals; app-validated, no cross-module FK). `version` carries optimistic concurrency
// (§7.7). RLS + trigger land in migration 0029 (M7-T02).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { goalSource, goalStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { carePlans } from "./care-plans";
import { problems } from "./problems";

export const goals = pgTable(
  "goal",
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
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    problemId: uuid("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    originalText: text("original_text").notNull(),
    revisedText: text("revised_text"),
    source: goalSource("source").notNull(),
    actingConsentId: uuid("acting_consent_id"), // M39 consent soft-ref (app-validated; no FK)
    measurableOutcome: text("measurable_outcome"),
    targetAt: timestamp("target_at", { withTimezone: true }),
    status: goalStatus("status").notNull().default("not_started"),
    statusNote: text("status_note"),
    addedByMembershipId: uuid("added_by_membership_id").references(() => memberships.id),
    addedByDiscipline: text("added_by_discipline"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planProblemIdx: index("goal_plan_problem_idx").on(t.carePlanId, t.problemId),
    sourceIdx: index("goal_source_idx").on(t.carePlanId, t.source),
    statusIdx: index("goal_status_idx").on(t.carePlanId, t.status),
  }),
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
