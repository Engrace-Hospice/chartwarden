// @wardenx/db — `membership_role` (M3 Authorization §3.4). The M2<->M3 handshake: it
// realizes an accepted invitation's `proposedRoleKeys` as concrete role grants on a
// membership. M03-F05: a membership belongs to exactly one org, so organization_id is
// NOT NULL and the standard app.org_id RLS generator policy applies directly (M3-T04).
// `scope` jsonb narrows the grant below the role's default (specific PE/location ids);
// `expires_at` carries time-bound roles (e.g. on-call elevation, §7.2).
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships } from "./memberships";
import { organizations } from "./organizations";
import { roles } from "./roles";
import { users } from "./users";

export const membershipRoles = pgTable(
  "membership_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    scope: jsonb("scope").notNull().default({}), // narrower PE/location ids than role default
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // time-bound roles
  },
  (t) => ({
    memRoleUnique: uniqueIndex("membership_role_idx").on(t.membershipId, t.roleId),
    membershipIdx: index("membership_role_membership_idx").on(t.membershipId),
    orgIdx: index("membership_role_org_idx").on(t.organizationId),
  }),
);

export type MembershipRole = typeof membershipRoles.$inferSelect;
export type NewMembershipRole = typeof membershipRoles.$inferInsert;
