// @chartwarden/db — `encounter_amendment` (M8, migration 1523, ADR-0114 VN-D30 / VN-D12). One row per (addendum, section the addendum names).
// INSERTed when the addendum is created (the naming), UPDATEd once by the addendum's author when they resolve the section (`confirmed` against
// the content hash they saw, or `deselected`): the same columns and audit shape as `encounter_draft_confirmation`, keyed by the addendum. A row
// with no resolution is a named section nobody has resolved yet (sign refuses until it is). The resolution columns are all set or all null. The
// guard trigger freezes a row once its addendum is signed or voided. PHI-bearing, three-column tenancy copied from the encounter. RLS + grants +
// audit trigger (scrubs `content_hash`; a Part 2 row also withholds `source_refs`) + guard land in migration 1523.
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
import { encounterAddenda } from "./encounter-addenda";
import type { DraftSourceRef } from "./encounter-draft-confirmations";
import { encounters } from "./encounters";

export const encounterAmendments = pgTable(
  "encounter_amendment",
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
    addendumId: uuid("addendum_id")
      .notNull()
      .references(() => encounterAddenda.id, { onDelete: "cascade" }),
    sectionId: text("section_id").notNull(),
    resolution: text("resolution", { enum: ["confirmed", "deselected"] }),
    contentHash: text("content_hash"),
    corpusVersion: text("corpus_version"),
    edited: boolean("edited"),
    /** The compiler's Part 2 verdict on the section when it was resolved; a Part 2 row's audit image withholds its source ids. */
    part2Derived: boolean("part2_derived"),
    sourceRefs: jsonb("source_refs")
      .$type<readonly DraftSourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    resolvedByMembershipId: uuid("resolved_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addendumSectionUniq: unique("encounter_amendment_addendum_section_uniq").on(
      t.addendumId,
      t.sectionId,
    ),
    encounterIdx: index("encounter_amendment_encounter_idx").on(t.encounterId),
    orgEncounterIdx: index("encounter_amendment_org_encounter_idx").on(
      t.organizationId,
      t.encounterId,
    ),
    resolutionCheck: check(
      "encounter_amendment_resolution_check",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('confirmed', 'deselected')`,
    ),
    resolvedTogether: check(
      "encounter_amendment_resolved_together",
      sql`(${t.resolution} IS NULL) = (${t.contentHash} IS NULL) AND (${t.resolution} IS NULL) = (${t.corpusVersion} IS NULL) AND (${t.resolution} IS NULL) = (${t.edited} IS NULL) AND (${t.resolution} IS NULL) = (${t.part2Derived} IS NULL) AND (${t.resolution} IS NULL) = (${t.resolvedByMembershipId} IS NULL) AND (${t.resolution} IS NULL) = (${t.resolvedAt} IS NULL)`,
    ),
    contentHashCheck: check(
      "encounter_amendment_content_hash_check",
      sql`${t.contentHash} IS NULL OR ${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceRefsArray: check(
      "encounter_amendment_source_refs_array",
      sql`jsonb_typeof(${t.sourceRefs}) = 'array'`,
    ),
  }),
);

export type EncounterAmendment = typeof encounterAmendments.$inferSelect;
export type NewEncounterAmendment = typeof encounterAmendments.$inferInsert;
