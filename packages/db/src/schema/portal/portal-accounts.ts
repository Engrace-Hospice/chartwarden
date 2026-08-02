// @wardenx/db — `portal_account` (M31 §3.3, M31-T02). D2's account root: one row per (org, backing M2
// user, relationship) — the caregiver/DPOA/personal-representative/bereaved identity that logs into the
// portal. Per-patient access is a SEPARATE `portal_access_grant` row (an account may reach several
// patients), so the account itself is NOT patient-scoped and carries no provider_entity_id/location_id —
// the three-column rule (ARCH-011) applies to PHI-bearing rows, and the patient linkage lives on the grant.
//
// The three `*_cipher` columns (display name, email, phone) are DEK envelope-encrypted at the application
// layer (M34 key ring) and are §3.6 audit-denylisted — free-text contact PHI whose plaintext must never
// enter `audit_event.before/after` (mirrors `M31_AUDIT_DENYLIST.portal_account` in @wardenx/types).
//
// TENANCY: organization_id NOT NULL; RLS keys on app.org_id ALONE (0139). CROSS-MODULE FK POLICY: only
// organization_id (M1 core) and user_id (M2 `user`) carry real FKs — both are foundation tables. The
// per-request session binding (`app.portal_account_id`) and the M39 consent linkage live on the grant /
// session, not here.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { portalAccountRelationship, portalAccountStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";

export const portalAccounts = pgTable(
  "portal_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    relationship: portalAccountRelationship("relationship").notNull(),
    status: portalAccountStatus("status").notNull().default("invited"),

    // Envelope-encrypted contact PHI — never plaintext at rest; §3.6 audit-denylisted.
    displayNameCipher: text("display_name_cipher").notNull(),
    emailCipher: text("email_cipher").notNull(),
    phoneCipher: text("phone_cipher"),

    preferredLanguageIso639: text("preferred_language_iso639").notNull().default("en"),
    twoFactorEnrolled: boolean("two_factor_enrolled").notNull().default(false),
    passkeyEnrolled: boolean("passkey_enrolled").notNull().default(false),

    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),

    version: integer("version").notNull().default(0), // §2.5 If-Match
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("portal_account_org_idx").on(t.organizationId),
    userIdx: index("portal_account_user_idx").on(t.userId),
    // A single (org, user, relationship) is unique WHILE not revoked — the same user may re-enroll
    // after revocation (§3.3 partial unique).
    activeOrgUserRelUnique: uniqueIndex("portal_account_active_org_user_rel_unique")
      .on(t.organizationId, t.userId, t.relationship)
      .where(sql`revoked_at IS NULL`),
    activatedRequiresInvited: check(
      "portal_account_activated_requires_invited",
      sql`activated_at IS NULL OR invited_at IS NOT NULL`,
    ),
    revokedTerminal: check(
      "portal_account_revoked_terminal",
      sql`revoked_at IS NULL OR status = 'revoked'`,
    ),
  }),
);

export type PortalAccountRow = typeof portalAccounts.$inferSelect;
export type NewPortalAccountRow = typeof portalAccounts.$inferInsert;
