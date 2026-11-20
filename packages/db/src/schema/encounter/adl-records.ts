// @chartwarden/db — `encounter_adl` (M8, WF09). The functional status (activities of daily living) a clinician
// records on ONE visit: an assistance level per ADL item, bladder/bowel continence and the devices in use. One row per
// encounter (unique), replaced whole while the encounter is an editable draft. PHI-bearing → three-column tenancy rule
// (denormalized from the parent encounter, nullable like every M8 satellite since mig 0128). RLS + the write-audit trigger
// land in migration 1528.
//
// Value sets are text + CHECK (no pg enum): they mirror the `ADL_*` / `CONTINENCE_LEVELS` constants of
// @chartwarden/hearthnote, which this package cannot import. adl-parity in apps/backend/__tests__/findings-schema-parity.test.ts
// fails when either side drifts.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

const ADL_LEVEL_VALUES = [
  "independent",
  "supervision",
  "limited_assist",
  "extensive_assist",
  "total_dependence",
  "did_not_occur",
] as const;
const CONTINENCE_LEVEL_VALUES = [
  "continent",
  "occasionally_incontinent",
  "frequently_incontinent",
  "incontinent",
  "catheter_or_ostomy",
] as const;
const ADL_DEVICE_VALUES = [
  "cane",
  "walker",
  "wheelchair",
  "hospital_bed",
  "mechanical_lift",
  "bedside_commode",
] as const;

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
/** A nullable text column that must hold one of `values` (NULL = not assessed). */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IS NULL OR ${column} IN (${quoted(values)})`);

export const encounterAdlRecords = pgTable(
  "encounter_adl",
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

    bathing: text("bathing"),
    dressing: text("dressing"),
    grooming: text("grooming"),
    toileting: text("toileting"),
    transferring: text("transferring"),
    ambulation: text("ambulation"),
    eating: text("eating"),
    bladder: text("bladder"),
    bowel: text("bowel"),
    devices: text("devices").array().notNull().default(sql`'{}'::text[]`),

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
    index("encounter_adl_org_ix").on(t.organizationId, t.createdAt),
    check("encounter_adl_bathing_level", oneOf("bathing", ADL_LEVEL_VALUES)),
    check("encounter_adl_dressing_level", oneOf("dressing", ADL_LEVEL_VALUES)),
    check("encounter_adl_grooming_level", oneOf("grooming", ADL_LEVEL_VALUES)),
    check("encounter_adl_toileting_level", oneOf("toileting", ADL_LEVEL_VALUES)),
    check("encounter_adl_transferring_level", oneOf("transferring", ADL_LEVEL_VALUES)),
    check("encounter_adl_ambulation_level", oneOf("ambulation", ADL_LEVEL_VALUES)),
    check("encounter_adl_eating_level", oneOf("eating", ADL_LEVEL_VALUES)),
    check("encounter_adl_bladder_level", oneOf("bladder", CONTINENCE_LEVEL_VALUES)),
    check("encounter_adl_bowel_level", oneOf("bowel", CONTINENCE_LEVEL_VALUES)),
    check(
      "encounter_adl_devices_known",
      sql.raw(`devices <@ ARRAY[${quoted(ADL_DEVICE_VALUES)}]::text[]`),
    ),
  ],
);

export type EncounterAdlRecord = typeof encounterAdlRecords.$inferSelect;
export type NewEncounterAdlRecord = typeof encounterAdlRecords.$inferInsert;
