// @wardenx/db — `intervention` (M7 §3.3). A discipline-owned action under a problem, linking to one or
// more goals (`goalRefs` uuid[] in jsonb). PHI-bearing → three-column tenancy rule. `scopeText` +
// `frequencyText` + `discontinueReason` are free-text → denylisted in the M4 write-audit trigger (§3.5).
// `linkedOrderId` is an M11 order soft-ref (app-validated, no cross-module FK). `version` carries
// optimistic concurrency (§7.7). addedBy references M1 `membership`. RLS + trigger land in migration
// 0029 (M7-T02).
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { interventionDiscipline, interventionStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { carePlans } from "./care-plans";
import { problems } from "./problems";

export const interventions = pgTable(
  "intervention",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Denormalized siting; nullable — inherited from the plan, which may be unsited (mig 0127).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    problemId: uuid("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    goalRefs: jsonb("goal_refs").notNull().default([]), // uuid[]
    scopeText: text("scope_text").notNull(),
    frequencyText: text("frequency_text").notNull(),
    frequencyValue: text("frequency_value").notNull(), // e.g. '2:visit:week'
    discipline: interventionDiscipline("discipline").notNull(),
    responsibleRole: text("responsible_role"),
    linkedOrderId: uuid("linked_order_id"), // M11 order soft-ref (app-validated; no FK)
    status: interventionStatus("status").notNull().default("active"),
    discontinueReason: text("discontinue_reason"),
    addedByMembershipId: uuid("added_by_membership_id").references(() => memberships.id),
    addedByDiscipline: text("added_by_discipline"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planProblemIdx: index("intervention_plan_problem_idx").on(t.carePlanId, t.problemId),
    disciplineIdx: index("intervention_discipline_idx").on(t.carePlanId, t.discipline),
    statusIdx: index("intervention_status_idx").on(t.carePlanId, t.status),
  }),
);

export type Intervention = typeof interventions.$inferSelect;
export type NewIntervention = typeof interventions.$inferInsert;
