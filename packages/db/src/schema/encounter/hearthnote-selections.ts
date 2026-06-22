// @wardenx/db — `hearthnote_selection` (M8 §3.3). The structured selection tree a clinician builds against
// a HearthNote template (the Layer-1 deterministic-assembly input). PHI-bearing → three-column tenancy
// rule (denormalized from the parent encounter/addendum). Belongs to exactly one parent (encounter XOR
// addendum). `free_text_cipher` holds the only free-text annotations, encrypted per-tenant DEK (PHI
// minimization; crypto-erased on destruction, §3.6). RLS + the M4 write-audit trigger land in migration
// 0031 (M8-T03).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { encounters } from "./encounters";
import { encounterAddenda } from "./encounter-addenda";

export const hearthnoteSelections = pgTable(
  "hearthnote_selection",
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
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "cascade" }),
    addendumId: uuid("addendum_id").references(() => encounterAddenda.id, { onDelete: "cascade" }),

    templateKey: text("template_key").notNull(), // e.g. 'rn_routine_visit_v3'
    templateVersion: text("template_version").notNull(),

    selections: jsonb("selections").notNull().default({}), // structured selection tree per template sections
    freeTextCipher: text("free_text_cipher"), // encrypted: free-text annotations only (PHI minimization)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    encounterUnique: index("hearthnote_selection_encounter_unique_idx")
      .on(t.encounterId)
      .where(sql`encounter_id IS NOT NULL`),
    addendumUnique: index("hearthnote_selection_addendum_unique_idx")
      .on(t.addendumId)
      .where(sql`addendum_id IS NOT NULL`),
    parentXor: check(
      "hearthnote_selection_parent_xor",
      sql`(encounter_id IS NOT NULL) <> (addendum_id IS NOT NULL)`,
    ),
  }),
);

export type HearthnoteSelection = typeof hearthnoteSelections.$inferSelect;
export type NewHearthnoteSelection = typeof hearthnoteSelections.$inferInsert;
