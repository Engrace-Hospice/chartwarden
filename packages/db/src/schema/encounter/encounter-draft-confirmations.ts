// @chartwarden/db — `encounter_draft_confirmation` (M8, migration 1517, ADR-0114 VN-D7 / VN-D12). One row per (encounter, drafted
// section): how the clinician resolved it (`confirmed` against the content hash they saw, or `deselected`), the corpus version it was
// compiled under, whether the section carried the clinician's own text (`edited`), and the ids of its sources (ids only, never text; they
// reach the audit trail through the row trigger, except for a Part 2 row, whose audit image withholds them; the content hash is never audited). A re-confirmation upserts on (encounter_id, section_id). PHI-bearing, three-column
// tenancy copied from the encounter (the siting pair is nullable, like every satellite since mig 0128). RLS + grants + audit trigger +
// org guard land in migration 1517.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

/** A drafted section's source: the kind of record and its id. Ids only, never text. */
export interface DraftSourceRef {
  readonly kind: string;
  readonly id: string;
}

export const encounterDraftConfirmations = pgTable(
  "encounter_draft_confirmation",
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
    sectionId: text("section_id").notNull(),
    resolution: text("resolution", { enum: ["confirmed", "deselected"] }).notNull(),
    contentHash: text("content_hash").notNull(),
    corpusVersion: text("corpus_version").notNull(),
    edited: boolean("edited").notNull(),
    /** The compiler's Part 2 verdict on the section (no default: the writer decides, fail closed); a Part 2 row's audit image withholds its source ids. */
    part2Derived: boolean("part2_derived").notNull(),
    sourceRefs: jsonb("source_refs")
      .$type<readonly DraftSourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    resolvedByMembershipId: uuid("resolved_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterSectionUniq: unique("encounter_draft_confirmation_encounter_section_uniq").on(
      t.encounterId,
      t.sectionId,
    ),
    orgEncounterIdx: index("encounter_draft_confirmation_org_encounter_idx").on(
      t.organizationId,
      t.encounterId,
    ),
    resolutionCheck: check(
      "encounter_draft_confirmation_resolution_check",
      sql`${t.resolution} IN ('confirmed', 'deselected')`,
    ),
    contentHashCheck: check(
      "encounter_draft_confirmation_content_hash_check",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceRefsArray: check(
      "encounter_draft_confirmation_source_refs_array",
      sql`jsonb_typeof(${t.sourceRefs}) = 'array'`,
    ),
  }),
);

export type EncounterDraftConfirmation = typeof encounterDraftConfirmations.$inferSelect;
export type NewEncounterDraftConfirmation = typeof encounterDraftConfirmations.$inferInsert;
