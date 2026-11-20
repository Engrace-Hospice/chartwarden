// @chartwarden/db — `addendum_cosignature_request` (M8, migration 1523, ADR-0114 VN-D30). The cosignature request an AMENDING addendum opens when
// its parent note needed one: a sibling of `cosignature_request` (same columns and lifecycle), not a column on it, because that table is
// `UNIQUE (encounter_id)` and relaxing that is a contract migration. `routed_at` is the addendum's own clock; the parent's request and clock are
// untouched. One request per addendum. PHI-bearing, three-column tenancy copied from the encounter. RLS + grants + audit trigger (scrubs
// `supervisor_released_reason`) + org guard land in migration 1523.
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cosignatureStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounterAddenda } from "./encounter-addenda";
import { encounters } from "./encounters";

export const addendumCosignatureRequests = pgTable(
  "addendum_cosignature_request",
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
      .references(() => encounters.id, { onDelete: "restrict" }),
    addendumId: uuid("addendum_id")
      .notNull()
      .references(() => encounterAddenda.id, { onDelete: "restrict" })
      .unique("addendum_cosignature_request_addendum_uniq"),

    routedToMembershipId: uuid("routed_to_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    status: cosignatureStatus("status").notNull().default("pending"),

    routedAt: timestamp("routed_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    hardCapAt: timestamp("hard_cap_at", { withTimezone: true }),
    supervisorReleasedAt: timestamp("supervisor_released_at", { withTimezone: true }),
    supervisorReleasedBy: uuid("supervisor_released_by").references(() => memberships.id, {
      onDelete: "set null",
    }),
    supervisorReleasedReason: text("supervisor_released_reason"),
    signedAt: timestamp("signed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    encounterIdx: index("addendum_cosignature_request_encounter_idx").on(t.encounterId),
    routedToIdx: index("addendum_cosignature_request_routed_to_idx").on(
      t.organizationId,
      t.routedToMembershipId,
      t.status,
    ),
    releasedByIdx: index("addendum_cosignature_request_released_by_idx").on(t.supervisorReleasedBy),
    supervisorReleaseConsistency: check(
      "addendum_cosignature_request_supervisor_release_consistency",
      sql`(status <> 'supervisor_released')
          OR (supervisor_released_at IS NOT NULL AND supervisor_released_by IS NOT NULL
              AND supervisor_released_reason IS NOT NULL AND char_length(supervisor_released_reason) >= 40)`,
    ),
  }),
);

export type AddendumCosignatureRequest = typeof addendumCosignatureRequests.$inferSelect;
export type NewAddendumCosignatureRequest = typeof addendumCosignatureRequests.$inferInsert;
