// @chartwarden/db — `discipline_intervention` (M15 §3.3). The per-discipline intervention: what will be done,
// how often, by whom. `goal_refs` is a jsonb array of intra-module `discipline_goal` ids (many-to-many
// without a join table — the plan is authored and read as one document, §2.2.3). §2.2.3 lifecycle
// active → discontinued | completed; discontinuation REQUIRES a reason (CHECK + service guard).
//
// `frequency_value` carries M7's machine-readable frequency triple (`<count>:<unit>:<period>`) so M17 can
// propose visit frequencies from the plan without parsing prose — the pattern is DB-enforced.
//
// Tenancy (M15-F05): patient-bearing → organization_id + provider_entity_id + location_id NOT NULL.
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { disciplineInterventionStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const disciplineIntervention = pgTable(
  "discipline_intervention",
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

    parentInterventionId: uuid("parent_intervention_id"), // logical FK → M7 IPOC intervention
    goalRefs: jsonb("goal_refs").notNull().default(sql`'[]'::jsonb`), // discipline_goal ids (intra-module)

    scopeText: text("scope_text").notNull(), // audit-denylisted (§3.6)
    frequencyText: text("frequency_text").notNull(),
    frequencyValue: text("frequency_value").notNull(), // '<count>:<unit>:<period>'
    discipline: text("discipline").notNull(),
    responsibleRoles: jsonb("responsible_roles").notNull().default(sql`'[]'::jsonb`),

    status: disciplineInterventionStatus("status").notNull().default("active"),
    discontinuationReason: text("discontinuation_reason"), // audit-denylisted (§3.6)

    addedByMembershipId: uuid("added_by_membership_id").notNull(), // logical FK → M2 membership
    addedByDiscipline: text("added_by_discipline").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planIdx: index("discipline_intervention_plan_idx").on(t.organizationId, t.planId, t.status),
    parentInterventionIdx: index("discipline_intervention_parent_intervention_idx").on(
      t.parentInterventionId,
    ),
    frequencyPattern: check(
      "discipline_intervention_frequency_value_ck",
      sql`frequency_value ~ '^([0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn))$'`,
    ),
    discontinuedRequiresReason: check(
      "discipline_intervention_discontinued_reason_ck",
      sql`status <> 'discontinued' OR discontinuation_reason IS NOT NULL`,
    ),
  }),
);

export type DisciplineIntervention = typeof disciplineIntervention.$inferSelect;
export type NewDisciplineIntervention = typeof disciplineIntervention.$inferInsert;
