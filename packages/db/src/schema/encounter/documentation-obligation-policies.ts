// @chartwarden/db — `documentation_obligation_policy` (M8, migration 1510, ADR-0113). A tenant's rule for one kind of
// documentation duty: what an overdue note does (off | warn | block) and how many hours the clinician has. One row per
// (organization, obligation kind); an absent row means warn / 24 hours, applied in code. `enforce_from` is set by the
// service whenever the mode moves to block, so notes that are already overdue get a fresh window instead of locking
// clinicians out on the switch. Org-level configuration with no patient and no PHI: organization_id only (like
// tenant_sbar_policy). RLS + grants + audit trigger land in migration 1510.
import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { documentationObligationKind, documentationObligationMode } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";

export const documentationObligationPolicies = pgTable(
  "documentation_obligation_policy",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    obligationKind: documentationObligationKind("obligation_kind").notNull(),
    mode: documentationObligationMode("mode").notNull().default("warn"),
    thresholdHours: integer("threshold_hours").notNull().default(24),
    enforceFrom: timestamp("enforce_from", { withTimezone: true }),
    configuredByUserId: uuid("configured_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: "documentation_obligation_policy_pk",
      columns: [t.organizationId, t.obligationKind],
    }),
    thresholdBounds: check(
      "documentation_obligation_policy_threshold",
      sql`${t.thresholdHours} BETWEEN 1 AND 168`,
    ),
  }),
);

export type DocumentationObligationPolicyRow = typeof documentationObligationPolicies.$inferSelect;
export type NewDocumentationObligationPolicyRow =
  typeof documentationObligationPolicies.$inferInsert;
