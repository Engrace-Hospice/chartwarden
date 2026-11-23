// @chartwarden/db — `encounter_idg_action_item_link` (ADR-0114 S5b, migration 1545). Joins an `idg_followup` encounter to the ONE M14 IDG action item it
// follows up, soft-removed like `encounter_discipline_plan_link` (the application role holds DELETE on no M8 table). A live row means "the author linked
// this visit to that team follow-up", never "the visit completed it": M14's own auto-close does not read this table. PHI-bearing → three-column tenancy
// rule (denormalized from the parent encounter). The action item id is an M14 id (logical; app-validated, no cross-module FK).
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const encounterIdgActionItemLinks = pgTable(
  "encounter_idg_action_item_link",
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
    actionItemId: uuid("action_item_id").notNull(), // M14 idg_action_item (logical)
    linkedByMembershipId: uuid("linked_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    /** No default: the writer states it. A Part 2 row files under the Part 2 class (no audit image names the action item, for any row). */
    part2Derived: boolean("part2_derived").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByMembershipId: uuid("removed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    orgEncounterIdx: index("encounter_idg_action_item_link_org_encounter_idx").on(
      t.organizationId,
      t.encounterId,
    ),
    encounterIdx: index("encounter_idg_action_item_link_encounter_idx").on(t.encounterId),
    liveUniq: uniqueIndex("encounter_idg_action_item_link_live_uniq")
      .on(t.encounterId)
      .where(sql`removed_at IS NULL`),
    removalConsistent: check(
      "encounter_idg_action_item_link_removal_consistent",
      sql`(removed_at IS NULL) = (removed_by_membership_id IS NULL)`,
    ),
  }),
);

export type EncounterIdgActionItemLink = typeof encounterIdgActionItemLinks.$inferSelect;
export type NewEncounterIdgActionItemLink = typeof encounterIdgActionItemLinks.$inferInsert;
