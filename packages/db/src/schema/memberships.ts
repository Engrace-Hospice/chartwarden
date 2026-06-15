// @wardenx/db — `membership` (M1 Foundation §3.7). The (user, organization) join:
// unlike `user`, a membership IS org-scoped, so it carries organization_id and is
// subject to the three-column rule / RLS (check-tenancy.ts). At most one non-revoked
// membership per (user, org) — enforced by a partial unique index.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { membershipStatus } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const memberships = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: membershipStatus("status").notNull().default("pending"),
    defaultLocationIds: jsonb("default_location_ids").notNull().default([]),
    defaultProviderEntityId: uuid("default_provider_entity_id"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    userOrgIdx: index("membership_user_org_idx").on(t.userId, t.organizationId),
    // Only one non-revoked membership per (user, org) at a time.
    activeUniqueIdx: uniqueIndex("membership_active_unique_idx")
      .on(t.userId, t.organizationId)
      .where(sql`${t.status} != 'revoked'`),
    statusIdx: index("membership_status_idx").on(t.status),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
