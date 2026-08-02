// @wardenx/db — `cosignature_request` (M8 §3.3). The D3 cosignature workflow row: one per encounter that
// requires a cosignature (e.g. LPN visit), tracking routing → acknowledge → escalate → 48h hard cap →
// supervisor release. PHI-bearing → three-column tenancy rule (denormalized from the parent encounter).
// One request per encounter (unique). RLS + the M4 write-audit trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cosignatureStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const cosignatureRequests = pgTable(
  "cosignature_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0128 (M8L-T02): denormalized siting backfills from the parent encounter.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" })
      .unique(),

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
    routedToIdx: index("cosignature_request_routed_to_idx").on(
      t.organizationId,
      t.routedToMembershipId,
      t.status,
    ),
    hardCapDueIdx: index("cosignature_request_hard_cap_due_idx")
      .on(t.organizationId, t.routedAt)
      .where(sql`status IN ('routed','escalated')`),
    supervisorReleaseConsistency: check(
      "cosignature_request_supervisor_release_consistency",
      sql`(status <> 'supervisor_released')
          OR (supervisor_released_at IS NOT NULL AND supervisor_released_by IS NOT NULL
              AND supervisor_released_reason IS NOT NULL AND char_length(supervisor_released_reason) >= 40)`,
    ),
  }),
);

export type CosignatureRequest = typeof cosignatureRequests.$inferSelect;
export type NewCosignatureRequest = typeof cosignatureRequests.$inferInsert;
