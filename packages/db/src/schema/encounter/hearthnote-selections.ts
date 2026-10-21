// @chartwarden/db — `hearthnote_selection` (M8 §3.3). The structured selection tree a clinician builds against
// a HearthNote template (the Layer-1 deterministic-assembly input). PHI-bearing → three-column tenancy
// rule (denormalized from the parent encounter/addendum). Belongs to exactly one parent (encounter XOR
// addendum). `free_text_cipher` holds the only free-text annotations, encrypted per-tenant DEK (PHI
// minimization; crypto-erased on destruction, §3.6). RLS + the M4 write-audit trigger land in migration
// 0031 (M8-T03).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounterAddenda } from "./encounter-addenda";
import { encounters } from "./encounters";

export const hearthnoteSelections = pgTable(
  "hearthnote_selection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0225 (#114), for the reason 0128 relaxed the same pair on the parent
    // `encounter`: this is DENORMALIZED siting, and the draft route captures neither column, so a child
    // cannot require what its parent may not have.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
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
    // Genuinely UNIQUE since mig 0225 (#114). 0030 created both as PLAIN partial indexes whose names say
    // unique, so "one selection row per parent" was enforced by nothing — harmless while no code wrote a
    // row, and not harmless the moment one does: the authoring upsert needs a conflict target.
    encounterUnique: uniqueIndex("hearthnote_selection_encounter_unique_idx")
      .on(t.encounterId)
      .where(sql`encounter_id IS NOT NULL`),
    addendumUnique: uniqueIndex("hearthnote_selection_addendum_unique_idx")
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
