// @chartwarden/db — `portal_invitation` (M31 §3.3; migration 0424, GAP-092). The magic-link invitation that creates a
// portal account + its per-patient grant. The token is stored ONLY as a SHA-256 digest (`token_hash`, audit-denylisted).
// Patient-bearing, so it carries the ARCH-011 provider_entity_id NOT NULL + location_id (nullable), resolved from the
// patient's admission. `caregiver_id` (M5) and `bereaved_contact_id` (M16) are logical FKs (app-validated).
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { portalAccessGrantKind, portalAccountRelationship } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { portalAccounts } from "./portal-accounts";

export const portalInvitations = pgTable(
  "portal_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    portalAccountId: uuid("portal_account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient
    relationship: portalAccountRelationship("relationship").notNull(),
    grantKind: portalAccessGrantKind("grant_kind").notNull(),
    tokenHash: text("token_hash").notNull(), // §3.6 audit-denylisted
    proposedScopeOverlay: jsonb("proposed_scope_overlay"),
    caregiverId: uuid("caregiver_id"), // logical FK → M5 caregiver
    bereavedContactId: uuid("bereaved_contact_id"), // logical FK → M16 bereaved_contact
    invitedByUserId: uuid("invited_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("portal_invitation_token_hash_uq").on(t.tokenHash),
    orgIdx: index("portal_invitation_org_idx").on(t.organizationId, t.createdAt),
    patientIdx: index("portal_invitation_patient_idx").on(t.patientId),
  }),
);

export type PortalInvitationRow = typeof portalInvitations.$inferSelect;
export type NewPortalInvitationRow = typeof portalInvitations.$inferInsert;
