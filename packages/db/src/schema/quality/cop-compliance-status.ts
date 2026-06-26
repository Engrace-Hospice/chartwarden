// @wardenx/db — `cop_compliance_status` (M30 §3.3; non-partitioned; retention class `compliance`).
// The self-assessed Condition-of-Participation compliance posture per (provider_entity, CoP citation),
// with evidence document refs and review cadence. ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS). provider_entity_id is a logical FK to M40. No PHI; no audit denylist.
import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m30CopStatus = pgEnum("m30_cop_status", ["compliant", "at_risk", "deficient"]);

export const copComplianceStatus = pgTable(
  "cop_compliance_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    copCitation: text("cop_citation").notNull(), // V-19 — e.g. '418.58'
    status: m30CopStatus("status").notNull(),
    evidenceDocumentIds: jsonb("evidence_document_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    selfAssessmentNotes: text("self_assessment_notes"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }).notNull(),
    lastReviewedByMembershipId: uuid("last_reviewed_by_membership_id").notNull(),
    nextReviewDueAt: timestamp("next_review_due_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqCitation: uniqueIndex("uq_cop_compliance_citation").on(t.providerEntityId, t.copCitation),
  }),
);

export type CopComplianceStatus = typeof copComplianceStatus.$inferSelect;
export type NewCopComplianceStatus = typeof copComplianceStatus.$inferInsert;
