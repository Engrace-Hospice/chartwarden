// @wardenx/db — `membership_credential` (M17 §1.1 D8, GAP-093). The clinical-license/certification
// roster the D8 `clinician_credentials_active` pre-schedule-gate predicate reads — a row per
// (membership × discipline) credential grant, e.g. "this membership's RN license is active from
// 2024-01-01, no expiry recorded." Distinct from `discipline_matches_visit` (the M3 RBAC role
// grant): a clinician can hold the "rn" ROLE while their actual nursing LICENSE has lapsed or been
// suspended — role membership and active licensure are orthogonal facts the spec (§1.1 D8) checks
// separately, this table backs the latter.
//
// Tenancy (ADR-0010 / ARCH-011): this is a STAFF-compliance row, not a patient row — no patient/
// admission reference, so it carries organization_id only (the three-column rule scopes PHI-bearing
// tables; the M15 `volunteer_compliance_gate` precedent is the same shape for the same reason).
// RLS keys on app.org_id. Not partitioned (O(memberships × disciplines)).
import { sql } from "drizzle-orm";
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { credentialDiscipline, credentialStatus } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const membershipCredentials = pgTable(
  "membership_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    credentialType: credentialDiscipline("credential_type").notNull(),
    status: credentialStatus("status").notNull().default("active"),

    effectiveAt: date("effective_at").notNull(),
    expiresAt: date("expires_at"), // null = non-expiring (e.g. a lifetime certification)
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"), // audit-denylisted (§3.6)

    issuingBody: text("issuing_body"), // e.g. "Oregon State Board of Nursing" — non-PHI metadata
    grantedByMembershipId: uuid("granted_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "At most one CURRENT row per (membership, discipline)" — mirrors volunteer_compliance_gate's
    // current-row uniqueness; the revoked/superseded history stays in place as the audit trail.
    currentUq: uniqueIndex("membership_credential_current_uq")
      .on(t.organizationId, t.membershipId, t.credentialType)
      .where(sql`revoked_at IS NULL`),
    // The D8 gate's hot-path lookup: "is membership X active in discipline Y as of date Z?"
    activeLookupIdx: index("membership_credential_active_lookup_idx")
      .on(t.organizationId, t.membershipId, t.credentialType, t.status)
      .where(sql`revoked_at IS NULL`),
    validWindow: index("membership_credential_valid_window_idx").on(
      t.organizationId,
      t.effectiveAt,
      t.expiresAt,
    ),
  }),
);

export type MembershipCredential = typeof membershipCredentials.$inferSelect;
export type NewMembershipCredential = typeof membershipCredentials.$inferInsert;
