// @chartwarden/db — `visit_note_draft_policy` (M8, migration 1519, ADR-0114 VN-D17). The per-tenant switch for the deterministic visit-note
// draft and its sign gate: one row per organization, default OFF (an absent row is off, applied in code because main auto-deploys).
// `enabled_at` is stamped when the switch moves off -> on and is NULL while it is off (a CHECK pins the pairing). Org-level configuration
// with no patient and no PHI: organization_id only (like documentation_obligation_policy). RLS + grants + audit trigger land in migration 1519.
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const visitNoteDraftPolicies = pgTable(
  "visit_note_draft_policy",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    changedByMembershipId: uuid("changed_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    enabledAtPairing: check(
      "visit_note_draft_policy_enabled_at_check",
      sql`${t.enabled} = (${t.enabledAt} IS NOT NULL)`,
    ),
  }),
);

export type VisitNoteDraftPolicyRow = typeof visitNoteDraftPolicies.$inferSelect;
export type NewVisitNoteDraftPolicyRow = typeof visitNoteDraftPolicies.$inferInsert;
