// @wardenx/db — `organization_invitation` (M2 Identity §3.5). Invite-by-email before an
// account exists: single-use, time-bound tokens (only the token HASH is stored). Unlike
// the user-owned auth tables, an invitation belongs to an organization, so it IS
// org-scoped — it carries `organization_id`, lives under `app.org_id` RLS (the M1 RLS
// generator), and gets a write-audit trigger (phi-guards). It is NOT PHI (no patient
// reference), so the three-column rule's provider_entity_id/location_id do not apply.
// `proposed_role_keys` is carried through for Module 3 to consume on acceptance.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { invitationStatus } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const organizationInvitations = pgTable(
  "organization_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: invitationStatus("status").notNull().default("pending"),
    // store only the hash of the single-use token
    tokenHash: text("token_hash").notNull(),
    inviterId: uuid("inviter_id").references(() => users.id, { onDelete: "set null" }),
    // proposed scope applied on acceptance -> membership.default_location_ids
    proposedDefaultLocationIds: jsonb("proposed_default_location_ids").notNull().default([]),
    proposedDefaultProviderEntityId: uuid("proposed_default_provider_entity_id"),
    // Module 3 reads this on acceptance to assign roles; M2 only carries it through.
    proposedRoleKeys: jsonb("proposed_role_keys").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("org_invitation_org_idx").on(t.organizationId),
    tokenIdx: uniqueIndex("org_invitation_token_idx").on(t.tokenHash),
    // at most one pending invite per (org, email)
    pendingUnique: uniqueIndex("org_invitation_pending_unique")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export type OrganizationInvitation = typeof organizationInvitations.$inferSelect;
export type NewOrganizationInvitation = typeof organizationInvitations.$inferInsert;
