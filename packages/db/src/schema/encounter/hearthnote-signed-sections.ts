// @chartwarden/db — `hearthnote_signed_section` (M8, migration 1518, ADR-0114 design 3.1). The sealed per-section rows written at sign
// next to `hearthnote_assembled_output.final_cipher`: section id, position, the rendered text SEALED (`text_cipher`, the same envelope
// string as `final_cipher`), a SHA-256 of the canonical text, whether the section is `part2_derived` (the writer decides; no default,
// fail closed) and the ids of its sources. APPEND-ONLY for the application role (SELECT + INSERT only; only the destruction role may
// shred and delete). PHI-bearing, three-column tenancy copied from the encounter. RLS + grants + audit trigger (scrubs `text_cipher`)
// + org guard land in migration 1518. No amends column: the amendment PR adds it.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import type { DraftSourceRef } from "./encounter-draft-confirmations";
import { encounters } from "./encounters";
import { hearthnoteAssembledOutputs } from "./hearthnote-assembled-outputs";

export const hearthnoteSignedSections = pgTable(
  "hearthnote_signed_section",
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
      .references(() => encounters.id, { onDelete: "cascade" }),
    assembledOutputId: uuid("assembled_output_id")
      .notNull()
      .references(() => hearthnoteAssembledOutputs.id, { onDelete: "cascade" }),
    sectionId: text("section_id").notNull(),
    position: integer("position").notNull(),
    textCipher: text("text_cipher").notNull(), // sealed: the same envelope as hearthnote_assembled_output.final_cipher
    contentHash: text("content_hash").notNull(),
    part2Derived: boolean("part2_derived").notNull(),
    sourceRefs: jsonb("source_refs")
      .$type<readonly DraftSourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    outputSectionUniq: unique("hearthnote_signed_section_output_section_uniq").on(
      t.assembledOutputId,
      t.sectionId,
    ),
    outputPositionUniq: unique("hearthnote_signed_section_output_position_uniq").on(
      t.assembledOutputId,
      t.position,
    ),
    encounterIdx: index("hearthnote_signed_section_encounter_idx").on(t.encounterId),
    orgEncounterIdx: index("hearthnote_signed_section_org_encounter_idx").on(
      t.organizationId,
      t.encounterId,
    ),
    positionCheck: check("hearthnote_signed_section_position_check", sql`${t.position} >= 0`),
    contentHashCheck: check(
      "hearthnote_signed_section_content_hash_check",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceRefsArray: check(
      "hearthnote_signed_section_source_refs_array",
      sql`jsonb_typeof(${t.sourceRefs}) = 'array'`,
    ),
  }),
);

export type HearthnoteSignedSection = typeof hearthnoteSignedSections.$inferSelect;
export type NewHearthnoteSignedSection = typeof hearthnoteSignedSections.$inferInsert;
