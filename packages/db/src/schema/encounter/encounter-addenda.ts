// @wardenx/db — `encounter_addendum` (M8 §3.3). A correction/amendment drafted on a signed encounter
// (§2.4). PHI-bearing → three-column tenancy rule (provider_entity_id + location_id NOT NULL,
// denormalized from the parent encounter). `reason` is clinician free-text → denylisted in the M4
// write-audit trigger (M8-T03). RLS + trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { encounterStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { encounters } from "./encounters";

export const encounterAddenda = pgTable(
  "encounter_addendum",
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
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),

    authoredByMembershipId: uuid("authored_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),

    status: encounterStatus("status").notNull().default("draft"),
    signedAt: timestamp("signed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    encounterIdx: index("encounter_addendum_encounter_idx").on(t.encounterId, t.createdAt),
    reasonLen: check("encounter_addendum_reason_len", sql`char_length(reason) >= 20`),
    statusAllowed: check(
      "encounter_addendum_status_allowed",
      sql`status IN ('draft','signed','voided')`,
    ),
    signedHasTime: check(
      "encounter_addendum_signed_has_time",
      sql`(status <> 'signed') OR (signed_at IS NOT NULL)`,
    ),
  }),
);

export type EncounterAddendum = typeof encounterAddenda.$inferSelect;
export type NewEncounterAddendum = typeof encounterAddenda.$inferInsert;
