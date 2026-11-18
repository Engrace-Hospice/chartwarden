// @chartwarden/db — `documentation_obligation_override` (M8, migration 1510, ADR-0113). A supervisor lifts the BLOCK for one
// clinician and one obligation kind for at most 24 hours; alerts and deadlines are unchanged. Append-only: the application
// role inserts a grant and may only stamp the two revocation columns, it has no DELETE. `reason` is free text a supervisor
// typed (40 to 500 chars) and is scrubbed from the row's own audit snapshot (the screened text rides only on the explicit grant event). No patient column: organization_id only (like
// tenant_sbar_policy). RLS + grants + audit trigger land in migration 1510.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { documentationObligationKind } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const documentationObligationOverrides = pgTable(
  "documentation_obligation_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subjectMembershipId: uuid("subject_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    grantedByMembershipId: uuid("granted_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    obligationKind: documentationObligationKind("obligation_kind").notNull(),
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    activeIdx: index("documentation_obligation_override_active_idx")
      .on(t.organizationId, t.subjectMembershipId, t.obligationKind, t.expiresAt)
      .where(sql`revoked_at IS NULL`),
    reasonLen: check(
      "documentation_obligation_override_reason_len",
      sql`char_length(btrim(${t.reason})) >= 40 AND char_length(${t.reason}) <= 500`,
    ),
    expiryWindow: check(
      "documentation_obligation_override_expiry_window",
      sql`${t.expiresAt} > ${t.grantedAt} AND ${t.expiresAt} - ${t.grantedAt} <= interval '24 hours'`,
    ),
    notSelf: check(
      "documentation_obligation_override_not_self",
      sql`${t.subjectMembershipId} <> ${t.grantedByMembershipId}`,
    ),
    revocationPair: check(
      "documentation_obligation_override_revocation_pair",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedByMembershipId} IS NULL)`,
    ),
  }),
);

export type DocumentationObligationOverrideRow =
  typeof documentationObligationOverrides.$inferSelect;
export type NewDocumentationObligationOverrideRow =
  typeof documentationObligationOverrides.$inferInsert;
