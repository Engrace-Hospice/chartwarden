// @chartwarden/db — `encounter_nutrition` (M8, WF09). The nutrition and hydration status a clinician records on ONE visit
// (appetite, share of meals eaten, fluid intake, swallowing, nutrition support). One row per encounter (unique), replaced whole
// while the encounter is an editable draft. PHI-bearing → three-column tenancy rule (denormalized from the parent encounter,
// nullable like every M8 satellite since mig 0128). RLS + the write-audit trigger land in migration 1529.
//
// Value sets are text + CHECK (no pg enum): they mirror the `*_LEVELS` / `NUTRITION_SUPPORTS` constants of
// @chartwarden/hearthnote, which this package cannot import. findings-schema-parity.test.ts fails when either side drifts.
import { sql } from "drizzle-orm";
import { check, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

const APPETITE_VALUES = ["good", "fair", "poor", "none"] as const;
const FLUID_INTAKE_VALUES = ["adequate", "decreased", "minimal"] as const;
const SWALLOWING_VALUES = [
  "no_difficulty",
  "difficulty_solids",
  "difficulty_liquids",
  "difficulty_solids_and_liquids",
  "unable_to_swallow",
] as const;
const SUPPORT_VALUES = ["none", "oral_supplements", "tube_feeding", "parenteral"] as const;

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
/** A nullable text column that must hold one of `values` (NULL = not assessed). */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IS NULL OR ${column} IN (${quoted(values)})`);

export const encounterNutritionRecords = pgTable(
  "encounter_nutrition",
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
      .references(() => encounters.id, { onDelete: "cascade" })
      .unique(),

    appetite: text("appetite"),
    mealIntakePercent: smallint("meal_intake_percent"), // a whole percent, 0..100
    fluidIntake: text("fluid_intake"),
    swallowing: text("swallowing"),
    support: text("support"),

    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    updatedByMembershipId: uuid("updated_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("encounter_nutrition_org_ix").on(t.organizationId, t.createdAt),
    check("encounter_nutrition_appetite_level", oneOf("appetite", APPETITE_VALUES)),
    check(
      "encounter_nutrition_meal_intake_percent_range",
      sql`meal_intake_percent IS NULL OR meal_intake_percent BETWEEN 0 AND 100`,
    ),
    check("encounter_nutrition_fluid_intake_level", oneOf("fluid_intake", FLUID_INTAKE_VALUES)),
    check("encounter_nutrition_swallowing_level", oneOf("swallowing", SWALLOWING_VALUES)),
    check("encounter_nutrition_support_level", oneOf("support", SUPPORT_VALUES)),
  ],
);

export type EncounterNutritionRecord = typeof encounterNutritionRecords.$inferSelect;
export type NewEncounterNutritionRecord = typeof encounterNutritionRecords.$inferInsert;
